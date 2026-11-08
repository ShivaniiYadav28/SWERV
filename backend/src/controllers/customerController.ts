import type { RequestHandler } from 'express';
import {
  changeCustomerStatus, createCustomer, getCustomer, listCustomers, updateCustomer,
} from '../services/customerService.js';
import {
  createCustomerSchema, customerListQuerySchema, customerStatusSchema,
  parseCustomerId, parseCustomerRequest, updateCustomerSchema,
} from '../utils/customerValidation.js';

export const createCustomerHandler: RequestHandler = async (req, res) => {
  const input = parseCustomerRequest(createCustomerSchema, req.body);
  const customer = await createCustomer(input);
  res.status(201).json({ success: true, message: 'Customer created successfully.', data: { customer } });
};

export const listCustomersHandler: RequestHandler = async (req, res) => {
  const query = parseCustomerRequest(customerListQuerySchema, req.query);
  const result = await listCustomers(query);
  res.json({ success: true, message: 'Customers retrieved successfully.', data: result });
};

export const getCustomerHandler: RequestHandler = async (req, res) => {
  const result = await getCustomer(parseCustomerId(req.params.id));
  res.json({ success: true, message: 'Customer retrieved successfully.', data: result });
};

export const updateCustomerHandler: RequestHandler = async (req, res) => {
  const id = parseCustomerId(req.params.id);
  const input = parseCustomerRequest(updateCustomerSchema, req.body);
  const customer = await updateCustomer(id, input);
  res.json({ success: true, message: 'Customer updated successfully.', data: { customer } });
};

export const changeCustomerStatusHandler: RequestHandler = async (req, res) => {
  const id = parseCustomerId(req.params.id);
  const { isActive } = parseCustomerRequest(customerStatusSchema, req.body);
  const customer = await changeCustomerStatus(id, isActive);
  res.json({ success: true, message: 'Customer status updated successfully.', data: { customer } });
};
