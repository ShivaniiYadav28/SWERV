import type { ErrorRequestHandler, RequestHandler } from 'express';

export const notFoundHandler: RequestHandler = (req, res) => {
  res.status(404).json({
    success: false,
    message: 'Route not found.',
  });
};

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err && typeof err === 'object' && 'code' in err && err.code === 11000) {
    res.status(409).json({
      success: false,
      message: 'A record with one of these unique values already exists.',
    });
    return;
  }

  const status = err && typeof err.status === 'number' ? err.status : 500;
  const isProduction = process.env.NODE_ENV === 'production';
  const isMalformedJson = err instanceof SyntaxError && 'body' in err;

  if (isMalformedJson) {
    res
      .status(400)
      .json({ success: false, message: 'Invalid JSON request body' });
    return;
  }

  res.status(status).json({
    success: false,
    message:
      status >= 500 && isProduction
        ? 'Internal server error'
        : err?.message || 'Request failed',
    ...(status >= 500 && !isProduction ? { detail: err?.message } : {}),
  });
};
