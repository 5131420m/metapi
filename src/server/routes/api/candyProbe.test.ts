import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

type DbModule = typeof import('../../db/index.js');

const {
  resolveUpstreamEndpointCandidatesMock,
  dispatchRuntimeRequestMock,
  withSiteRecordProxyRequestInitMock,
} = vi.hoisted(() => ({
  resolveUpstreamEndpointCandidatesMock: vi.fn(),
  dispatchRuntimeRequestMock: vi.fn(),
  withSiteRecordProxyRequestInitMock: vi.fn(),
}));

vi.mock('../../services/upstreamEndpointRuntime.js', async () => {
  const actual = await vi.importActual<typeof import('../../services/upstreamEndpointRuntime.js')>('../../services/upstreamEndpointRuntime.js');
  return {
    ...actual,
    resolveUpstreamEndpointCandidates: (...args: unknown[]) => resolveUpstreamEndpointCandidatesMock(...args),
  };
});

vi.mock('../../services/runtimeDispatch.js', () => ({
  dispatchRuntimeRequest: (...args: unknown[]) => dispatchRuntimeRequestMock(...args),
}));

vi.mock('../../services/siteProxy.js', () => ({
  resolveChannelProxyUrl: () => null,
  withSiteRecordProxyRequestInit: (...args: unknown[]) => withSiteRecordProxyRequestInitMock(...args),
}));

vi.mock('../../services/oauth/oauthAccount.js', () => ({
  getOauthInfoFromAccount: () => null,
}));

vi.mock('../../services/oauth/service.js', () => ({
  buildOauthProviderHeaders: () => ({}),
}));

describe('candy probe routes', () => {
  let app: FastifyInstance;
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let dataDir = '';
  let seedCounter = 0;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-candy-routes-'));
    process.env.DATA_DIR = dataDir;
    await import('../../db/migrate.js');
    const dbModule = await import('../../db/index.js');
    db = dbModule.db;
    schema = dbModule.schema;
    const candyModule = await import('./candyProbe.js');
    const tokensModule = await import('./tokens.js');
    const storeModule = await import('../../services/candyProbe/resultStore.js');

    app = Fastify();
    await app.register(candyModule.candyProbeRoutes);
    await app.register(tokensModule.tokensRoutes);
    storeModule.resetCandyProbeStoreForTests();
  });

  beforeEach(async () => {
    const storeModule = await import('../../services/candyProbe/resultStore.js');
    storeModule.resetCandyProbeStoreForTests();
    resolveUpstreamEndpointCandidatesMock.mockReset().mockResolvedValue(['chat']);
    dispatchRuntimeRequestMock.mockReset();
    withSiteRecordProxyRequestInitMock.mockReset().mockImplementation(async (_site: unknown, init: unknown) => init);
    await db.delete(schema.routeChannels).run();
    await db.delete(schema.tokenRoutes).run();
    await db.delete(schema.accountTokens).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
    await db.delete(schema.settings).run();
  });

  afterAll(async () => {
    await app.close();
    try {
      rmSync(dataDir, { recursive: true, force: true });
    } catch {
      // Windows keeps the SQLite handle open.
    }
    delete process.env.DATA_DIR;
  });

  async function seedChannel() {
    const seedId = ++seedCounter;
    const site = await db.insert(schema.sites).values({
      name: `candy-route-site-${seedId}`,
      url: `https://candy-route-${seedId}.example.com`,
      platform: 'new-api',
      status: 'active',
    }).returning().get();
    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: `candy-route-user-${seedId}`,
      accessToken: '',
      apiToken: `sk-candy-route-${seedId}`,
      status: 'active',
    }).returning().get();
    const route = await db.insert(schema.tokenRoutes).values({
      modelPattern: `claude-sonnet-4-5-route-${seedId}`,
      enabled: true,
    }).returning().get();
    const channel = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: account.id,
      tokenId: null,
      sourceModel: 'claude-sonnet-4-5',
      priority: 0,
      weight: 10,
      enabled: true,
    }).returning().get();
    return { site, account, route, channel };
  }

  it('rejects an unknown channel', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/channels/999/candy-probe',
      payload: {},
    });
    expect(response.statusCode).toBe(404);
    expect(JSON.parse(response.payload).message).toContain('不存在');
  });

  it('rejects an invalid fingerprint override', async () => {
    const { channel } = await seedChannel();
    const response = await app.inject({
      method: 'POST',
      url: `/api/channels/${channel.id}/candy-probe`,
      payload: { fingerprint: 'chrome' },
    });
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.payload).message).toContain('指纹');
  });

  it('rejects an out-of-range question count', async () => {
    const { channel } = await seedChannel();
    const response = await app.inject({
      method: 'POST',
      url: `/api/channels/${channel.id}/candy-probe`,
      payload: { questionCount: 99 },
    });
    expect(response.statusCode).toBe(400);
  });

  it('runs a probe and returns the verdict', async () => {
    const { channel } = await seedChannel();
    dispatchRuntimeRequestMock.mockResolvedValue(new Response(
      'data: {"choices":[{"delta":{"content":"1: 0\\n2: 0\\n3: 0"}}]}\n\ndata: [DONE]\n\n',
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    ));

    const response = await app.inject({
      method: 'POST',
      url: `/api/channels/${channel.id}/candy-probe`,
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.payload);
    expect(body.success).toBe(true);
    expect(body.result).toMatchObject({
      channelId: channel.id,
      verdict: 'fail',
      fingerprint: 'claude_code',
    });
  });

  it('reads back the last verdict, including per-question detail', async () => {
    const { channel } = await seedChannel();
    dispatchRuntimeRequestMock.mockResolvedValue(new Response(
      'data: {"choices":[{"delta":{"content":"1: 0\\n2: 0\\n3: 0"}}]}\n\ndata: [DONE]\n\n',
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    ));
    await app.inject({ method: 'POST', url: `/api/channels/${channel.id}/candy-probe`, payload: {} });

    const response = await app.inject({ method: 'GET', url: `/api/channels/${channel.id}/candy-probe` });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.payload);
    expect(body.result.verdict).toBe('fail');
    expect(Array.isArray(body.result.questions)).toBe(true);
    expect(body.result.questions).toHaveLength(3);
  });

  it('returns a null result when the channel was never probed', async () => {
    const { channel } = await seedChannel();
    const response = await app.inject({ method: 'GET', url: `/api/channels/${channel.id}/candy-probe` });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.payload)).toEqual({ success: true, result: null });
  });

  it('attaches the verdict to the route channel payload', async () => {
    const { route, channel } = await seedChannel();
    dispatchRuntimeRequestMock.mockResolvedValue(new Response(
      'data: {"choices":[{"delta":{"content":"1: 0\\n2: 0\\n3: 0"}}]}\n\ndata: [DONE]\n\n',
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    ));
    await app.inject({ method: 'POST', url: `/api/channels/${channel.id}/candy-probe`, payload: {} });

    const response = await app.inject({ method: 'GET', url: `/api/routes/${route.id}/channels` });
    expect(response.statusCode).toBe(200);
    const channels = JSON.parse(response.payload) as Array<Record<string, any>>;
    const returned = channels.find((item) => item.id === channel.id);
    expect(returned?.candyProbe).toMatchObject({
      channelId: channel.id,
      verdict: 'fail',
      fresh: true,
    });
    expect(returned?.candyProbe).not.toHaveProperty('questions');
  });
});
