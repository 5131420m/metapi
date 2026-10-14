import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { eq } from 'drizzle-orm';

type DbModule = typeof import('../../db/index.js');

/**
 * `clear-usage` is a statistics reset, not a routing override. Cooldown state is live
 * protection: wiping it here would release every channel still inside an upstream
 * rate-limit window at once, and the next request wave would re-trip that limit.
 * Releasing a cooldown stays an explicit operation owned by the dedicated endpoints.
 */
describe('POST /api/settings/maintenance/clear-usage', () => {
  let app: FastifyInstance;
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let dataDir = '';

  const COOLING_UNTIL = '2099-01-01T00:00:00.000Z';
  const LAST_FAIL_AT = '2026-01-01T00:00:00.000Z';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-settings-clear-usage-'));
    process.env.DATA_DIR = dataDir;

    await import('../../db/migrate.js');
    const dbModule = await import('../../db/index.js');
    const settingsRoutesModule = await import('./settings.js');

    db = dbModule.db;
    schema = dbModule.schema;

    app = Fastify();
    await app.register(settingsRoutesModule.settingsRoutes);
  });

  beforeEach(async () => {
    await db.delete(schema.routeChannels).run();
    await db.delete(schema.tokenRoutes).run();
    await db.delete(schema.proxyLogs).run();
    await db.delete(schema.accountTokens).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
    await db.delete(schema.events).run();
  });

  afterAll(async () => {
    await app.close();
    delete process.env.DATA_DIR;
  });

  const seedCoolingChannel = async () => {
    const site = await db.insert(schema.sites).values({
      name: 'clear-usage-site',
      url: 'https://clear-usage.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'clear-usage-user',
      accessToken: 'clear-usage-access-token',
      apiToken: 'clear-usage-api-token',
      status: 'active',
      balanceUsed: 42,
    }).returning().get();

    const route = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'gpt-4o-mini',
      enabled: true,
    }).returning().get();

    const channel = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: account.id,
      priority: 0,
      weight: 10,
      enabled: true,
      successCount: 11,
      failCount: 7,
      totalLatencyMs: 9_000,
      totalCost: 3.5,
      lastUsedAt: '2026-01-02T00:00:00.000Z',
      lastSelectedAt: '2026-01-03T00:00:00.000Z',
      lastFailAt: LAST_FAIL_AT,
      consecutiveFailCount: 2,
      cooldownLevel: 3,
      cooldownUntil: COOLING_UNTIL,
    }).returning().get();

    return { site, account, route, channel };
  };

  it('resets usage counters without releasing live cooldown state', async () => {
    const { account, channel } = await seedCoolingChannel();

    const response = await app.inject({
      method: 'POST',
      url: '/api/settings/maintenance/clear-usage',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ success: true });

    const refreshedChannel = await db.select().from(schema.routeChannels)
      .where(eq(schema.routeChannels.id, channel.id))
      .get();

    // Statistics are what this endpoint owns.
    expect(refreshedChannel).toMatchObject({
      successCount: 0,
      failCount: 0,
      totalLatencyMs: 0,
      totalCost: 0,
      lastUsedAt: null,
      lastSelectedAt: null,
    });

    // Cooldown bookkeeping is routing protection and must survive untouched.
    expect(refreshedChannel).toMatchObject({
      cooldownUntil: COOLING_UNTIL,
      cooldownLevel: 3,
      consecutiveFailCount: 2,
      lastFailAt: LAST_FAIL_AT,
    });

    const refreshedAccount = await db.select().from(schema.accounts)
      .where(eq(schema.accounts.id, account.id))
      .get();
    expect(refreshedAccount?.balanceUsed).toBe(0);
  });

  it('reports how many usage logs it deleted', async () => {
    const { account, channel, route } = await seedCoolingChannel();
    await db.insert(schema.proxyLogs).values([
      {
        routeId: route.id,
        channelId: channel.id,
        accountId: account.id,
        modelRequested: 'gpt-4o-mini',
        status: 'success',
      },
      {
        routeId: route.id,
        channelId: channel.id,
        accountId: account.id,
        modelRequested: 'gpt-4o-mini',
        status: 'failed',
      },
    ]).run();

    const response = await app.inject({
      method: 'POST',
      url: '/api/settings/maintenance/clear-usage',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ success: true, deletedProxyLogs: 2 });
    expect(await db.select().from(schema.proxyLogs).all()).toEqual([]);
  });

  it('leaves a channel still cooling after the reset ineligible for selection', async () => {
    const { channel } = await seedCoolingChannel();
    const { TokenRouter, invalidateTokenRouterCache } = await import('../../services/tokenRouter.js');

    await app.inject({
      method: 'POST',
      url: '/api/settings/maintenance/clear-usage',
    });

    invalidateTokenRouterCache();
    const router = new TokenRouter();

    // The observable consequence of keeping the cooldown: the channel is not handed back
    // out the moment an operator clears usage statistics.
    expect(await router.selectChannel('gpt-4o-mini')).toBeNull();

    const refreshed = await db.select().from(schema.routeChannels)
      .where(eq(schema.routeChannels.id, channel.id))
      .get();
    expect(refreshed?.cooldownUntil).toBe(COOLING_UNTIL);
  });
});
