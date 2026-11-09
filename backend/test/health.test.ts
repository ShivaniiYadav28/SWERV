import { describe, expect, it } from 'vitest';
import request from 'supertest';
import app from '../src/app.js';

describe('health endpoint', () => {
  it('returns a successful response without authentication', async () => {
    const response = await request(app).get('/health').expect(200);

    expect(response.body).toMatchObject({
      success: true,
      message: 'SWERV API is running',
    });
  });
});
