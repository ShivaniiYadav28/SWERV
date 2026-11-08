import { createHash } from 'node:crypto';
import { Customer } from '../models/Customer.js';
import { DispatchRequest } from '../models/DispatchRequest.js';
import { HttpError } from '../utils/httpError.js';

export type CustomerInput = { name: string; email: string; phone: string };

function identityKey(input: CustomerInput): string {
  const normalizedName = input.name.trim().toLocaleLowerCase();
  const normalizedEmail = input.email.trim().toLowerCase();
  const normalizedPhone = input.phone.replace(/[^\d+]/g, '');
  return createHash('sha256')
    .update(`${normalizedName}\0${normalizedEmail}\0${normalizedPhone}`)
    .digest('hex');
}

function toSafeCustomer(customer: {
  id: string; name: string; email: string; phone: string; isActive: boolean;
  createdAt: Date; updatedAt: Date;
}) {
  return {
    id: customer.id,
    name: customer.name,
    email: customer.email,
    phone: customer.phone,
    isActive: customer.isActive,
    createdAt: customer.createdAt,
    updatedAt: customer.updatedAt,
  };
}

export async function createCustomer(input: CustomerInput) {
  const key = identityKey(input);
  const existing = await Customer.exists({ identityKey: key });
  if (existing) throw new HttpError(409, 'A customer with these contact details already exists.');
  const customer = await Customer.create({ ...input, identityKey: key });
  return toSafeCustomer(customer);
}

export async function listCustomers(options: {
  page: number; limit: number; search?: string; status?: 'active' | 'inactive';
}) {
  const filter: Record<string, unknown> = {};
  if (options.status) filter.isActive = options.status === 'active';
  if (options.search) {
    const escapedSearch = options.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const search = new RegExp(escapedSearch, 'i');
    filter.$or = [{ name: search }, { email: search }, { phone: search }];
  }
  const skip = (options.page - 1) * options.limit;
  const [customers, total] = await Promise.all([
    Customer.find(filter).sort({ createdAt: -1 }).skip(skip).limit(options.limit),
    Customer.countDocuments(filter),
  ]);
  return {
    customers: customers.map(toSafeCustomer),
    pagination: { page: options.page, limit: options.limit, total, pages: Math.ceil(total / options.limit) },
  };
}

export async function getCustomer(id: string) {
  const customer = await Customer.findById(id);
  if (!customer) throw new HttpError(404, 'Customer not found.');
  const dispatchRequests = await DispatchRequest.find({ customerId: customer._id })
    .sort({ createdAt: -1 })
    .limit(50)
    .populate('assignedAgent', 'agentCode name status vehicle')
    .lean();
  return { customer: toSafeCustomer(customer), dispatchRequests };
}

export async function updateCustomer(id: string, input: Partial<CustomerInput>) {
  const customer = await Customer.findById(id);
  if (!customer) throw new HttpError(404, 'Customer not found.');
  const updatedContact = {
    name: input.name ?? customer.name,
    email: input.email ?? customer.email,
    phone: input.phone ?? customer.phone,
  };
  customer.set({ ...input, identityKey: identityKey(updatedContact) });
  await customer.save();
  return toSafeCustomer(customer);
}

export async function changeCustomerStatus(id: string, isActive: boolean) {
  const customer = await Customer.findById(id);
  if (!customer) throw new HttpError(404, 'Customer not found.');
  customer.isActive = isActive;
  await customer.save();
  return toSafeCustomer(customer);
}

export async function ensureCustomerCollections(): Promise<void> {
  await Customer.init();
}
