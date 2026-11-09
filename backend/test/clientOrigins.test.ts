import { afterAll, describe, expect, it } from 'vitest';
import request from 'supertest';

const originalClientUrl = process.env.CLIENT_URL;
process.env.CLIENT_URL = 'https://swerv-jet.vercel.app';
const { default: app } = await import('../src/app.js');

afterAll(() => {
  if (originalClientUrl === undefined) delete process.env.CLIENT_URL;
  else process.env.CLIENT_URL = originalClientUrl;
});

describe('client origin access', () => {
  it('allows the configured production origin with credentialed preflight', async () => {
    const response = await request(app)
      .options('/api/auth/login')
      .set('Origin', 'https://swerv-jet.vercel.app')
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'content-type')
      .expect(204);

    expect(response.headers['access-control-allow-origin']).toBe(
      'https://swerv-jet.vercel.app',
    );
    expect(response.headers['access-control-allow-credentials']).toBe('true');
  });

  it('continues to allow the local Vite origin', async () => {
    const response = await request(app)
      .get('/api/health')
      .set('Origin', 'http://localhost:5173')
      .expect(200);

    expect(response.headers['access-control-allow-origin']).toBe(
      'http://localhost:5173',
    );
    expect(response.headers['access-control-allow-credentials']).toBe('true');
  });

  it('does not allow an untrusted origin', async () => {
    const response = await request(app)
      .get('/api/health')
      .set('Origin', 'https://untrusted.example')
      .expect(200);

    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });
});
