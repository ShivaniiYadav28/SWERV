import type { Request, Response } from 'express';

export function getHealth(_req: Request, res: Response): void {
  res.status(200).json({
    success: true,
    message: 'SWERV API is running',
    environment: process.env.NODE_ENV ?? 'development',
  });
}
