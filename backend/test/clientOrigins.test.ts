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

  it('rejects state-changing requests from an untrusted origin', async () => {
    const response = await request(app)
      .post('/api/auth/logout')
      .set('Origin', 'https://untrusted.example')
      .expect(403);

    expect(response.body).toMatchObject({
      success: false,
      message: 'Request origin is not allowed.',
    });
  });

  it('allows state-changing requests from the configured origin', async () => {
    await request(app)
      .post('/api/auth/login')
      .set('Origin', 'https://swerv-jet.vercel.app')
      .send({})
      .expect(400);
  });

  it('rejects origin-less cross-site requests carrying the user authentication cookie', async () => {
    await request(app)
      .post('/api/auth/logout')
      .set('Cookie', 'swerv_access=expired-token')
      .set('Sec-Fetch-Site', 'cross-site')
      .expect(403);
  });

  it('rejects origin-less same-site requests carrying the agent authentication cookie', async () => {
    await request(app)
      .post('/api/agent/attendance/check-in')
      .set('Cookie', 'swerv_agent_access=expired-token')
      .set('Sec-Fetch-Site', 'same-site')
      .expect(403);
  });

  it('rejects origin-less cross-site requests carrying the GPS session cookie', async () => {
    await request(app)
      .post('/api/agent-locations/browser')
      .set('Cookie', 'swerv_agent_gps=expired-token')
      .set('Sec-Fetch-Site', 'cross-site')
      .expect(403);
  });

  it('allows same-origin and non-browser cookie requests without an Origin header', async () => {
    await request(app)
      .post('/api/auth/logout')
      .set('Cookie', 'swerv_access=expired-token')
      .set('Sec-Fetch-Site', 'same-origin')
      .expect(200);
    await request(app)
      .post('/api/auth/logout')
      .set('Cookie', 'swerv_access=expired-token')
      .expect(200);
  });

  it('allows origin-less requests without cookies to reach non-browser authentication', async () => {
    await request(app).post('/api/agent-locations').expect(401);
  });

  it('does not reject safe methods based on their origin', async () => {
    await request(app)
      .options('/api/auth/login')
      .set('Origin', 'https://untrusted.example')
      .set('Access-Control-Request-Method', 'POST')
      .expect(204);
  });
});
