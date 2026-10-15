import Fastify, { type FastifyInstance } from 'fastify';
import { describe, expect, it, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';

type DbModule = typeof import('../../db/index.js');
type TokenRouterModule = typeof import('../../services/tokenRouter.js');

const { fetchMock, withSiteProxyRequestInitMock } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  withSiteProxyRequestInitMock: vi.fn(),
}));

vi.mock('undici', () => ({
  fetch: (...args: unknown[]) => fetchMock(...args),
}));

vi.mock('../../services/siteProxy.js', () => ({
  withSiteProxyRequestInit: (...args: unknown[]) => withSiteProxyRequestInitMock(...args),
}));

describe('GET /api/routes/:id/channels attaches channel quality', () => {
  let app: FastifyInstance;
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let TokenRouter: TokenRouterModule['TokenRouter'];
  let resetSiteRuntimeHealthState: TokenRouterModule['resetSiteRuntimeHealthState'];
  let dataDir = '';
  let idSeed = 0;

  const nextId = () => {
    idSeed += 1;
    return idSeed;
  };

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-channels-quality-'));
    process.env.DATA_DIR = dataDir;

    await import('../../db/migrate.js');
    const dbModule = await import('../../db/index.js');
    const routesModule = await import('./tokens.js');
    const tokenRouterModule = await import('../../services/tokenRouter.js');
    db = dbModule.db;
    schema = dbModule.schema;
    TokenRouter = tokenRouterModule.TokenRouter;
    resetSiteRuntimeHealthState = tokenRouterModule.resetSiteRuntimeHealthState;

    app = Fastify();
    await app.register(routesModule.tokensRoutes);
  });

  beforeEach(async () => {
    idSeed = 0;
    fetchMock.mockReset();
    withSiteProxyRequestInitMock.mockReset();
    withSiteProxyRequestInitMock.mockImplementation(async (_url: string, init: Record<string, unknown>) => init);
    await db.delete(schema.routeChannels).run();
    await db.delete(schema.tokenRoutes).run();
    await db.delete(schema.settings).run();
    await db.delete(schema.accountTokens).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
    resetSiteRuntimeHealthState();
  });

  afterAll(async () => {
    await app.close();
    resetSiteRuntimeHealthState();
    delete process.env.DATA_DIR;
  });

  async function createChannelFixture(modelPattern: string) {
    const route = await db.insert(schema.tokenRoutes).values({
      modelPattern,
      enabled: true,
    }).returning().get();
    const site = await db.insert(schema.sites).values({
      name: `quality-site-${nextId()}`,
      url: `https://quality-${nextId()}.example.com`,
      platform: 'new-api',
      status: 'active',
    }).returning().get();
    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: `quality-user-${nextId()}`,
      accessToken: `access-${nextId()}`,
      apiToken: `sk-${nextId()}`,
      status: 'active',
    }).returning().get();
    const token = await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: 'quality-token',
      token: `token-quality-${nextId()}`,
      enabled: true,
      isDefault: false,
    }).returning().get();
    const channel = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: account.id,
      tokenId: token.id,
      priority: 0,
      weight: 10,
      enabled: true,
    }).returning().get();
    return { route, site, account, token, channel };
  }

  it('returns the measured quality snapshot alongside each channel', async () => {
    const { route, channel } = await createChannelFixture('gpt-quality-api');
    const router = new TokenRouter();
    for (let index = 0; index < 3; index += 1) {
      await router.recordSuccess(channel.id, 3200, 0, 'gpt-quality-api', undefined, {
        firstByteLatencyMs: 250,
        completionTokens: 120,
        isStream: true,
      });
    }

    const response = await app.inject({
      method: 'GET',
      url: `/api/routes/${route.id}/channels`,
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.payload) as Array<Record<string, unknown>>;
    expect(Array.isArray(body)).toBe(true);
    const returned = body.find((item) => item.id === channel.id);
    expect(returned).toBeTruthy();
    const quality = returned?.quality as Record<string, unknown> | null | undefined;
    expect(quality).toBeTruthy();
    expect(quality?.firstByteEmaMs).toBe(250);
    expect(quality?.firstByteSampleCount).toBe(3);
    expect(quality?.tpsEma).toBeCloseTo((120 * 1000) / (3200 - 250), 3);
    expect(quality?.recentSuccessCount).toBeCloseTo(3, 0);
    expect(quality?.recentFailureCount).toBeCloseTo(0, 1);
    expect(quality?.recentSuccessRate).toBeCloseTo(4 / 5, 3);
  });

  it('returns an all-null quality object for channels without traffic', async () => {
    const { route, channel } = await createChannelFixture('gpt-quality-cold');

    const response = await app.inject({
      method: 'GET',
      url: `/api/routes/${route.id}/channels`,
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.payload) as Array<Record<string, unknown>>;
    const returned = body.find((item) => item.id === channel.id);
    const quality = returned?.quality as Record<string, unknown> | null | undefined;
    expect(quality).toBeTruthy();
    expect(quality?.firstByteEmaMs).toBeNull();
    expect(quality?.tpsEma).toBeNull();
    expect(quality?.recentSuccessCount).toBeNull();
    expect(quality?.recentFailureCount).toBeNull();
    expect(quality?.recentSuccessRate).toBeNull();
    expect(quality?.lastUpdatedAtMs).toBeNull();
  });
});
