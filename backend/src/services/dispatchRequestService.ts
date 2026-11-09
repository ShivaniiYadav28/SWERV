import mongoose, { type ClientSession } from 'mongoose';
import { Agent, type AgentCapability } from '../models/Agent.js';
import {
  DispatchRequest,
  type DispatchPriority,
  type DispatchRequestStatus,
  type PackageCategory,
} from '../models/DispatchRequest.js';
import { DispatchRequestActivity, type DispatchActivityType } from '../models/DispatchRequestActivity.js';
import type { z } from 'zod';
import {
  createDispatchRequestSchema,
  updateDispatchRequestCoordinatesSchema,
} from '../utils/dispatchRequestValidation.js';
import { HttpError } from '../utils/httpError.js';
import { Customer } from '../models/Customer.js';
import { createAgentNotification, createUserNotifications, type NotificationPayload } from './notificationService.js';

export type CreateDispatchRequestInput = z.output<typeof createDispatchRequestSchema>;
export type UpdateDispatchRequestCoordinatesInput = z.output<typeof updateDispatchRequestCoordinatesSchema>;

export const dispatchStatusTransitions: Record<DispatchRequestStatus, DispatchRequestStatus[]> = {
  pending: ['assigned', 'cancelled'],
  assigned: ['picked_up', 'cancelled'],
  picked_up: ['in_transit', 'failed'],
  in_transit: ['delivered', 'failed'],
  delivered: [],
  cancelled: [],
  failed: [],
};

export function canTransitionDispatchStatus(
  current: DispatchRequestStatus,
  next: DispatchRequestStatus,
): boolean {
  return dispatchStatusTransitions[current].includes(next);
}

async function runTransaction<T>(work: (session: ClientSession) => Promise<T>): Promise<T> {
  const session = await mongoose.startSession();
  let result: T | undefined;
  try {
    await session.withTransaction(async () => {
      result = await work(session);
    });
  } finally {
    await session.endSession();
  }
  if (result === undefined) throw new Error('Dispatch request transaction did not complete.');
  return result;
}

async function recordActivity(
  session: ClientSession,
  dispatchRequestId: mongoose.Types.ObjectId,
  performedBy: string,
  eventType: DispatchActivityType,
  description: string,
  previousValue: unknown,
  newValue: unknown,
): Promise<void> {
  await DispatchRequestActivity.create([{
    dispatchRequestId,
    actorType: 'user',
    performedBy,
    eventType,
    description,
    previousValue,
    newValue,
  }], { session });
}

function assignmentCoordinateSnapshot(dispatchRequest: InstanceType<typeof DispatchRequest>) {
  return {
    pickup: {
      latitude: dispatchRequest.pickup.latitude ?? null,
      longitude: dispatchRequest.pickup.longitude ?? null,
    },
    destination: {
      latitude: dispatchRequest.delivery.latitude ?? null,
      longitude: dispatchRequest.delivery.longitude ?? null,
    },
  };
}

export async function listAgentDeliveries(agentId: string, history = false) {
  const filter: Record<string, unknown> = history
    ? { assignedAgent: agentId, status: 'delivered' }
    : { assignedAgent: agentId, status: { $in: ['assigned', 'picked_up', 'in_transit'] } };
  return DispatchRequest.find(filter).sort({ updatedAt: -1 }).lean();
}

export async function getAgentDelivery(agentId: string, id: string) {
  const dispatchRequest = await DispatchRequest.findOne({ _id: id, assignedAgent: agentId }).lean();
  if (!dispatchRequest) throw new HttpError(404, 'Delivery not found.');
  const activity = await DispatchRequestActivity.find({ dispatchRequestId: id })
    .sort({ createdAt: -1 }).limit(20)
    .populate('performedBy', 'name email')
    .populate('performedByAgent', 'name email agentCode')
    .lean();
  return { dispatchRequest, activity };
}

export async function changeAgentDeliveryStatus(agentId: string, id: string, status: DispatchRequestStatus) {
  if (!['picked_up', 'in_transit', 'delivered'].includes(status)) {
    throw new HttpError(400, 'Agents can only mark deliveries picked up, in transit, or delivered.');
  }
  if (status === 'delivered') {
    throw new HttpError(409, 'Submit verified proof of delivery to complete this delivery.');
  }
  return runTransaction(async (session) => {
    const dispatchRequest = await DispatchRequest.findOne({ _id: id, assignedAgent: agentId }).session(session);
    if (!dispatchRequest) throw new HttpError(404, 'Delivery not found.');
    if (!canTransitionDispatchStatus(dispatchRequest.status, status)) {
      throw new HttpError(400, `Status cannot change from ${dispatchRequest.status} to ${status}.`);
    }
    const previousStatus = dispatchRequest.status;
    dispatchRequest.status = status;
    await dispatchRequest.save({ session });
    await DispatchRequestActivity.create([{
      dispatchRequestId: dispatchRequest._id,
      eventType: 'status_changed',
      description: `Status changed from ${previousStatus} to ${status}.`,
      actorType: 'agent',
      performedByAgent: agentId,
      previousValue: { status: previousStatus },
      newValue: { status },
    }], { session });
    const notifications = status === 'picked_up' || status === 'in_transit'
      ? await createUserNotifications(session, ['admin', 'operator'], {
        eventType: 'dispatch_status_changed',
        title: 'Delivery status updated',
        message: `Dispatch #${dispatchRequest.id.slice(-8).toUpperCase()} is now ${status.replaceAll('_', ' ')}.`,
        relatedEntityType: 'dispatch',
        relatedEntityId: dispatchRequest._id,
      })
      : [];
    return { dispatchRequest, notifications };
  });
}

export function getRequiredAgentCapabilities(
  category: PackageCategory,
  priority: DispatchPriority,
): AgentCapability[] {
  const categoryCapability: Record<PackageCategory, AgentCapability> = {
    documents: 'document_delivery',
    food: 'food_delivery',
    heavy_goods: 'heavy_goods',
    parcel: 'parcel_delivery',
    fragile: 'parcel_delivery',
    other: 'parcel_delivery',
  };
  const required = [categoryCapability[category]];
  if (priority === 'express' || priority === 'urgent') {
    required.push('express_delivery');
  }
  return required;
}

const terminalStatuses: DispatchRequestStatus[] = ['delivered', 'cancelled', 'failed'];

export async function assignDispatchRequest(
  id: string,
  agentId: string,
  performedBy: string,
) {
  return runTransaction(async (session) => {
    const dispatchRequest = await DispatchRequest.findById(id).session(session);
    if (!dispatchRequest) throw new HttpError(404, 'Dispatch request not found.');
    if (dispatchRequest.status !== 'pending' && dispatchRequest.status !== 'assigned') {
      throw new HttpError(409, 'Only pending or assigned requests can be assigned.');
    }
    if (dispatchRequest.assignedAgent?.toString() === agentId) {
      throw new HttpError(409, 'This agent is already assigned to the request.');
    }

    const candidate = await Agent.findById(agentId).session(session);
    if (!candidate) throw new HttpError(404, 'Agent not found.');
    if (!candidate.isActive || candidate.status !== 'available') {
      throw new HttpError(409, 'Agent must be active and available.');
    }

    const missingCapabilities = getRequiredAgentCapabilities(
      dispatchRequest.package.category,
      dispatchRequest.priority,
    ).filter((capability) => !candidate.capabilities.includes(capability));
    if (missingCapabilities.length > 0) {
      throw new HttpError(
        400,
        `Agent is missing required capability: ${missingCapabilities.join(', ')}.`,
      );
    }

    const availableAgent = await Agent.findOneAndUpdate(
      {
        _id: agentId,
        isActive: true,
        status: 'available',
        $expr: {
          $lt: [
            { $ifNull: ['$activeDispatchCount', 0] },
            '$capacity.maxOrders',
          ],
        },
      },
      { $inc: { activeDispatchCount: 1 } },
      { returnDocument: 'after', session },
    );
    if (!availableAgent) {
      throw new HttpError(409, 'Agent is no longer available or has reached capacity.');
    }

    const previousAgentId = dispatchRequest.assignedAgent?.toString() ?? null;
    if (previousAgentId) {
      await Agent.updateOne(
        { _id: previousAgentId, activeDispatchCount: { $gt: 0 } },
        { $inc: { activeDispatchCount: -1 } },
        { session },
      );
    }

    const previousStatus = dispatchRequest.status;
    dispatchRequest.assignedAgent = availableAgent._id;
    if (previousStatus === 'pending') dispatchRequest.status = 'assigned';
    await dispatchRequest.save({ session });

    await recordActivity(
      session,
      dispatchRequest._id,
      performedBy,
      'assignment_changed',
      previousAgentId ? 'Dispatch request reassigned.' : 'Agent assigned to dispatch request.',
      { agentId: previousAgentId },
      {
        agentId: availableAgent.id,
        coordinates: assignmentCoordinateSnapshot(dispatchRequest),
      },
    );
    if (previousStatus === 'pending') {
      await recordActivity(
        session,
        dispatchRequest._id,
        performedBy,
        'status_changed',
        'Status changed from pending to assigned.',
        { status: 'pending' },
        { status: 'assigned' },
      );
    }
    const eventType = previousAgentId ? 'dispatch_reassigned' : 'dispatch_assigned';
    const reference = dispatchRequest.id.slice(-8).toUpperCase();
    const notifications: NotificationPayload[] = await createUserNotifications(session, ['admin', 'operator'], {
      eventType,
      title: previousAgentId ? 'Dispatch reassigned' : 'Dispatch assigned',
      message: previousAgentId
        ? `Dispatch #${reference} was reassigned to agent ${availableAgent.agentCode}.`
        : `Dispatch #${reference} was assigned to agent ${availableAgent.agentCode}.`,
      relatedEntityType: 'dispatch',
      relatedEntityId: dispatchRequest._id,
    });
    notifications.push(await createAgentNotification(session, availableAgent._id, {
      eventType,
      title: previousAgentId ? 'Delivery reassigned to you' : 'New delivery assigned',
      message: `Dispatch #${reference} is assigned to you.`,
      relatedEntityType: 'dispatch',
      relatedEntityId: dispatchRequest._id,
    }));
    if (previousAgentId) {
      notifications.push(await createAgentNotification(session, previousAgentId, {
        eventType: 'dispatch_reassigned',
        title: 'Delivery reassigned',
        message: `Dispatch #${reference} was reassigned to another agent.`,
        relatedEntityType: 'dispatch',
        relatedEntityId: dispatchRequest._id,
      }));
    }
    return { dispatchRequest, previousAgentId, notifications };
  });
}

export async function changeDispatchRequestStatus(
  id: string,
  status: DispatchRequestStatus,
  performedBy: string,
) {
  if (status === 'delivered') {
    throw new HttpError(409, 'Submit verified proof of delivery to complete this delivery.');
  }
  return runTransaction(async (session) => {
    const dispatchRequest = await DispatchRequest.findById(id).session(session);
    if (!dispatchRequest) throw new HttpError(404, 'Dispatch request not found.');
    if (!canTransitionDispatchStatus(dispatchRequest.status, status)) {
      throw new HttpError(
        400,
        `Status cannot change from ${dispatchRequest.status} to ${status}.`,
      );
    }
    if (status === 'assigned' && !dispatchRequest.assignedAgent) {
      throw new HttpError(400, 'Assign an agent before marking the request assigned.');
    }

    const previousStatus = dispatchRequest.status;
    dispatchRequest.status = status;
    await dispatchRequest.save({ session });

    if (terminalStatuses.includes(status) && dispatchRequest.assignedAgent) {
      await Agent.updateOne(
        { _id: dispatchRequest.assignedAgent, activeDispatchCount: { $gt: 0 } },
        { $inc: { activeDispatchCount: -1 } },
        { session },
      );
    }

    await recordActivity(
      session,
      dispatchRequest._id,
      performedBy,
      'status_changed',
      `Status changed from ${previousStatus} to ${status}.`,
      { status: previousStatus },
      { status },
    );
    const notifications: NotificationPayload[] = [];
    if (dispatchRequest.assignedAgent && ['picked_up', 'in_transit', 'failed', 'cancelled'].includes(status)) {
      notifications.push(await createAgentNotification(session, dispatchRequest.assignedAgent, {
        eventType: 'dispatch_status_changed',
        title: 'Delivery status updated',
        message: `Dispatch #${dispatchRequest.id.slice(-8).toUpperCase()} is now ${status.replaceAll('_', ' ')}.`,
        relatedEntityType: 'dispatch',
        relatedEntityId: dispatchRequest._id,
      }));
    }
    if (status === 'failed' || status === 'cancelled') {
      notifications.push(...await createUserNotifications(session, ['admin', 'operator'], {
        eventType: 'dispatch_status_changed',
        title: status === 'failed' ? 'Delivery failed' : 'Dispatch cancelled',
        message: `Dispatch #${dispatchRequest.id.slice(-8).toUpperCase()} is now ${status}.`,
        relatedEntityType: 'dispatch',
        relatedEntityId: dispatchRequest._id,
      }));
    }
    return { dispatchRequest, notifications };
  });
}

export async function createDispatchRequest(
  input: CreateDispatchRequestInput,
  performedBy: string,
) {
  return runTransaction(async (session) => {
    let customer = input.customer;
    let customerId: string | null = null;
    if (input.customerId) {
      const linkedCustomer = await Customer.findOneAndUpdate(
        { _id: input.customerId, isActive: true },
        { $inc: { __v: 1 } },
        { returnDocument: 'after', session, timestamps: false },
      );
      if (!linkedCustomer) {
        const existingCustomer = await Customer.exists({ _id: input.customerId }).session(session);
        if (!existingCustomer) throw new HttpError(404, 'Customer not found.');
        throw new HttpError(409, 'Inactive customers cannot be linked to new dispatch requests.');
      }
      customer = {
        name: linkedCustomer.name,
        email: linkedCustomer.email,
        phone: linkedCustomer.phone,
      };
      customerId = linkedCustomer.id;
    }
    const dispatchRequest = new DispatchRequest({ ...input, customer, customerId });
    await dispatchRequest.save({ session });
    await recordActivity(
      session,
      dispatchRequest._id,
      performedBy,
      'request_created',
      'Dispatch request created.',
      null,
      { status: dispatchRequest.status },
    );
    const notifications = await createUserNotifications(session, ['admin', 'operator'], {
      eventType: 'new_dispatch',
      title: 'New dispatch request',
      message: `Dispatch #${dispatchRequest.id.slice(-8).toUpperCase()} is ready for assignment.`,
      relatedEntityType: 'dispatch',
      relatedEntityId: dispatchRequest._id,
    });
    return { dispatchRequest, notifications };
  });
}

export async function updateDispatchRequestCoordinates(
  id: string,
  input: UpdateDispatchRequestCoordinatesInput,
  performedBy: string,
) {
  return runTransaction(async (session) => {
    const dispatchRequest = await DispatchRequest.findById(id).session(session);
    if (!dispatchRequest) throw new HttpError(404, 'Dispatch request not found.');
    if (dispatchRequest.status !== 'pending' && dispatchRequest.status !== 'assigned') {
      throw new HttpError(409, 'Map locations can only be changed before pickup.');
    }

    if (input.pickup) {
      dispatchRequest.pickup.latitude = input.pickup.latitude;
      dispatchRequest.pickup.longitude = input.pickup.longitude;
    }
    if (input.delivery) {
      dispatchRequest.delivery.latitude = input.delivery.latitude;
      dispatchRequest.delivery.longitude = input.delivery.longitude;
    }
    await dispatchRequest.save({ session });

    await DispatchRequestActivity.create([{
      dispatchRequestId: dispatchRequest._id,
      eventType: 'locations_changed',
      description: 'Pickup and delivery map coordinates updated.',
      actorType: 'user',
      performedBy,
    }], { session });

    return dispatchRequest;
  });
}

export async function listDispatchRequests(
  page: number,
  limit: number,
  status?: DispatchRequestStatus,
  priority?: string,
) {
  const filter: Record<string, unknown> = {};
  if (status) filter.status = status;
  if (priority) filter.priority = priority;

  const skip = (page - 1) * limit;
  const [dispatchRequests, total] = await Promise.all([
    DispatchRequest.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate('assignedAgent', 'agentCode name status vehicle')
      .lean(),
    DispatchRequest.countDocuments(filter),
  ]);

  return {
    dispatchRequests,
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
  };
}

export async function getDispatchRequest(id: string) {
  const dispatchRequest = await DispatchRequest.findById(id)
    .populate('assignedAgent', 'agentCode name status vehicle')
    .lean();
  if (!dispatchRequest) throw new HttpError(404, 'Dispatch request not found.');

  const activity = await DispatchRequestActivity.find({ dispatchRequestId: id })
    .sort({ createdAt: -1 })
    .limit(20)
    .populate('performedBy', 'name email')
    .populate('performedByAgent', 'name email agentCode')
    .lean();

  return { dispatchRequest, activity };
}

export async function ensureDispatchRequestCollections(): Promise<void> {
  await Promise.all([DispatchRequest.init(), DispatchRequestActivity.init()]);
}
