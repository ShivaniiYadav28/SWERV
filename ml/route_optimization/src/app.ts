import express from 'express';
import helmet from 'helmet';
import type { ErrorRequestHandler, RequestHandler } from 'express';
import routeOptimizationRoutes from './routes/routeOptimizationRoutes.js';
import { HttpError } from './utils/httpError.js';

const app = express();

app.use(helmet());
app.use(express.json({ limit: '32kb' }));
app.use(routeOptimizationRoutes);

const notFoundHandler: RequestHandler = (_req, res) => {
  res.status(404).json({ success: false, message: 'Route not found.' });
};

const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
  if (error instanceof SyntaxError && 'body' in error) {
    res.status(400).json({ success: false, message: 'Invalid JSON request body.' });
    return;
  }
  if (error instanceof HttpError) {
    res.status(error.status).json({ success: false, message: error.message });
    return;
  }
  res.status(500).json({ success: false, message: 'Internal server error.' });
};

app.use(notFoundHandler);
app.use(errorHandler);

export default app;
