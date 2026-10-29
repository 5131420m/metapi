import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { runMock, getMock } = vi.hoisted(() => ({
  runMock: vi.fn(),
  getMock: vi.fn(),
}));

vi.mock('../../services/modelIdentityProbeService.js', () => {
  class IdentityProbeRequestError extends Error {
    readonly statusCode: number;
    constructor(message: string, statusCode = 400) {
      super(message);
      this.statusCode = statusCode;
    }
  }
  return {
    IdentityProbeRequestError,
    runChannelIdentityProbe: (...args: unknown[]) => runMock(...args),
    getIdentityProbeResultForChannel: (...args: unknown[]) => getMock(...args),
  };
});

describe('model identity probe routes', () => {
  let app: FastifyInstance;
  let errors: typeof import('../../services/modelIdentityProbeService.js');

  beforeAll(async () => {
    const routes = await import('./modelIdentityProbe.js');
    errors = await import('../../services/modelIdentityProbeService.js');
    app = Fastify();
    await app.register(routes.modelIdentityProbeRoutes);
    await app.ready();
  });

  beforeEach(() => {
    runMock.mockReset();
    getMock.mockReset();
  });

  afterAll(async () => {
    await app.close();
  });

  it('rejects an invalid channel id on both verbs', async () => {
    for (const method of ['GET', 'POST'] as const) {
      const response = await app.inject({ method, url: '/api/channels/abc/identity-probe' });
      expect(response.statusCode).toBe(400);
    }
    expect(runMock).not.toHaveBeenCalled();
  });

  it('runs one probe and returns its result', async () => {
    runMock.mockResolvedValue({ channelId: 5, verdict: 'match' });
    const response = await app.inject({ method: 'POST', url: '/api/channels/5/identity-probe' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ success: true, result: { channelId: 5, verdict: 'match' } });
    expect(runMock).toHaveBeenCalledWith(expect.objectContaining({ channelId: 5 }));
  });

  it('passes a valid clientIdentity through and rejects an invalid one', async () => {
    runMock.mockResolvedValue({ channelId: 5, verdict: 'model_match' });
    const ok = await app.inject({
      method: 'POST',
      url: '/api/channels/5/identity-probe',
      payload: { clientIdentity: 'sdk' },
    });
    expect(ok.statusCode).toBe(200);
    expect(runMock).toHaveBeenCalledWith(expect.objectContaining({ channelId: 5, clientIdentity: 'sdk' }));

    runMock.mockClear();
    const bad = await app.inject({
      method: 'POST',
      url: '/api/channels/5/identity-probe',
      payload: { clientIdentity: 'claude_code' },
    });
    expect(bad.statusCode).toBe(400);
    expect(runMock).not.toHaveBeenCalled();
  });

  it('maps a request error to its status code', async () => {
    runMock.mockRejectedValue(new errors.IdentityProbeRequestError('通道 #9 不存在', 404));
    const response = await app.inject({ method: 'POST', url: '/api/channels/9/identity-probe' });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ success: false, message: '通道 #9 不存在' });
  });

  it('reads back the last result (null when there is none)', async () => {
    getMock.mockReturnValue(null);
    const response = await app.inject({ method: 'GET', url: '/api/channels/5/identity-probe' });
    expect(response.json()).toEqual({ success: true, result: null });
    expect(getMock).toHaveBeenCalledWith(5);
  });
});
