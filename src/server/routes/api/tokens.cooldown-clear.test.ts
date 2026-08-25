import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';

type DbModule = typeof import('../../db/index.js');

describe('POST /api/routes/:id/cooldown/clear', () => {
  let app: FastifyInstance;
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let dataDir = '';
  let seedId = 0;

  const nextId = () => {
    seedId += 1;
    return seedId;
  };

  const seedAccountWithToken = async () => {
    const id = nextId();
    const site = await db.insert(schema.sites).values({
      name: `cooldown-site-${id}`,
      url: `https://cooldown-site-${id}.example.com`,
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: `cooldown-user-${id}`,
      accessToken: `cooldown-access-token-${id}`,
      status: 'active',
    }).returning().get();

    const token = await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: `cooldown-token-${id}`,
      token: `sk-cooldown-token-${id}`,
      enabled: true,
      isDefault: true,
    }).returning().get();

    return { site, account, token };
  };

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-route-cooldown-clear-'));
    process.env.DATA_DIR = dataDir;

    await import('../../db/migrate.js');
    const dbModule = await import('../../db/index.js');
    const routesModule = await import('./tokens.js');

    db = dbModule.db;
    schema = dbModule.schema;

    app = Fastify();
    await app.register(routesModule.tokensRoutes);
  });

  beforeEach(async () => {
    await db.delete(schema.routeGroupSources).run();
    await db.delete(schema.routeChannels).run();
    await db.delete(schema.oauthRouteUnitMembers).run();
    await db.delete(schema.oauthRouteUnits).run();
    await db.delete(schema.tokenRoutes).run();
    await db.delete(schema.accountTokens).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
    seedId = 0;
  });

  afterAll(async () => {
    await app.close();
    delete process.env.DATA_DIR;
  });

  it('clears cooldown and failure counters for a direct route', async () => {
    const seeded = await seedAccountWithToken();
    const route = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'gpt-4o-mini',
      enabled: true,
    }).returning().get();

    const channel = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: seeded.account.id,
      tokenId: seeded.token.id,
      priority: 0,
      weight: 10,
      enabled: true,
      failCount: 8,
      lastFailAt: '2026-04-01T00:00:00.000Z',
      consecutiveFailCount: 2,
      cooldownLevel: 3,
      cooldownUntil: '2099-01-01T00:00:00.000Z',
    }).returning().get();

    const response = await app.inject({
      method: 'POST',
      url: `/api/routes/${route.id}/cooldown/clear`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      success: true,
      clearedChannels: 1,
    });

    const refreshed = await db.select().from(schema.routeChannels)
      .where(eq(schema.routeChannels.id, channel.id))
      .get();

    expect(refreshed).toMatchObject({
      failCount: 0,
      lastFailAt: null,
      consecutiveFailCount: 0,
      cooldownLevel: 0,
      cooldownUntil: null,
    });
  });

  it('clears cooldown for source-route channels exposed by explicit groups', async () => {
    const seeded = await seedAccountWithToken();
    const sourceRoute = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'claude-sonnet-4-5',
      enabled: true,
    }).returning().get();

    const groupRoute = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'claude-opus-4-6',
      displayName: 'claude-opus-4-6',
      routeMode: 'explicit_group',
      enabled: true,
    }).returning().get();

    await db.insert(schema.routeGroupSources).values({
      groupRouteId: groupRoute.id,
      sourceRouteId: sourceRoute.id,
    }).run();

    const channel = await db.insert(schema.routeChannels).values({
      routeId: sourceRoute.id,
      accountId: seeded.account.id,
      tokenId: seeded.token.id,
      sourceModel: 'claude-sonnet-4-5',
      priority: 0,
      weight: 10,
      enabled: true,
      failCount: 5,
      lastFailAt: '2026-04-01T00:00:00.000Z',
      consecutiveFailCount: 1,
      cooldownLevel: 2,
      cooldownUntil: '2099-01-01T00:00:00.000Z',
    }).returning().get();

    const response = await app.inject({
      method: 'POST',
      url: `/api/routes/${groupRoute.id}/cooldown/clear`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      success: true,
      clearedChannels: 1,
    });

    const refreshed = await db.select().from(schema.routeChannels)
      .where(eq(schema.routeChannels.id, channel.id))
      .get();

    expect(refreshed).toMatchObject({
      failCount: 0,
      lastFailAt: null,
      consecutiveFailCount: 0,
      cooldownLevel: 0,
      cooldownUntil: null,
    });
  });

  it('only clears cooldown for explicit-group source routes that are enabled exact routes', async () => {
    const seeded = await seedAccountWithToken();
    const visibleSourceRoute = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'gpt-5.4',
      enabled: true,
    }).returning().get();
    const disabledSourceRoute = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'gpt-4.1',
      enabled: false,
    }).returning().get();
    const wildcardSourceRoute = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'gpt-*',
      enabled: true,
    }).returning().get();

    const groupRoute = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'gpt-clear-group',
      displayName: 'gpt-clear-group',
      routeMode: 'explicit_group',
      enabled: true,
    }).returning().get();

    await db.insert(schema.routeGroupSources).values([
      { groupRouteId: groupRoute.id, sourceRouteId: visibleSourceRoute.id },
      { groupRouteId: groupRoute.id, sourceRouteId: disabledSourceRoute.id },
      { groupRouteId: groupRoute.id, sourceRouteId: wildcardSourceRoute.id },
    ]).run();

    const visibleChannel = await db.insert(schema.routeChannels).values({
      routeId: visibleSourceRoute.id,
      accountId: seeded.account.id,
      tokenId: seeded.token.id,
      priority: 0,
      weight: 10,
      enabled: true,
      failCount: 4,
      lastFailAt: '2026-04-01T00:00:00.000Z',
      consecutiveFailCount: 1,
      cooldownLevel: 2,
      cooldownUntil: '2099-01-01T00:00:00.000Z',
    }).returning().get();
    const disabledChannel = await db.insert(schema.routeChannels).values({
      routeId: disabledSourceRoute.id,
      accountId: seeded.account.id,
      tokenId: seeded.token.id,
      priority: 0,
      weight: 10,
      enabled: true,
      failCount: 6,
      lastFailAt: '2026-04-01T00:00:00.000Z',
      consecutiveFailCount: 2,
      cooldownLevel: 3,
      cooldownUntil: '2099-01-01T00:00:00.000Z',
    }).returning().get();
    const wildcardChannel = await db.insert(schema.routeChannels).values({
      routeId: wildcardSourceRoute.id,
      accountId: seeded.account.id,
      tokenId: seeded.token.id,
      priority: 0,
      weight: 10,
      enabled: true,
      failCount: 7,
      lastFailAt: '2026-04-01T00:00:00.000Z',
      consecutiveFailCount: 2,
      cooldownLevel: 3,
      cooldownUntil: '2099-01-01T00:00:00.000Z',
    }).returning().get();

    const response = await app.inject({
      method: 'POST',
      url: `/api/routes/${groupRoute.id}/cooldown/clear`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      success: true,
      clearedChannels: 1,
    });

    const refreshedVisible = await db.select().from(schema.routeChannels)
      .where(eq(schema.routeChannels.id, visibleChannel.id))
      .get();
    const refreshedDisabled = await db.select().from(schema.routeChannels)
      .where(eq(schema.routeChannels.id, disabledChannel.id))
      .get();
    const refreshedWildcard = await db.select().from(schema.routeChannels)
      .where(eq(schema.routeChannels.id, wildcardChannel.id))
      .get();

    expect(refreshedVisible).toMatchObject({
      failCount: 0,
      lastFailAt: null,
      consecutiveFailCount: 0,
      cooldownLevel: 0,
      cooldownUntil: null,
    });
    expect(refreshedDisabled?.cooldownUntil).toBe('2099-01-01T00:00:00.000Z');
    expect(refreshedWildcard?.cooldownUntil).toBe('2099-01-01T00:00:00.000Z');
  });
});

describe('POST /api/channels/:channelId/cooldown/clear', () => {
  let app: FastifyInstance;
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let dataDir = '';
  let seedId = 0;

  const nextId = () => {
    seedId += 1;
    return seedId;
  };

  const COOLING = {
    failCount: 6,
    lastFailAt: '2026-04-01T00:00:00.000Z',
    consecutiveFailCount: 3,
    cooldownLevel: 2,
    cooldownUntil: '2099-01-01T00:00:00.000Z',
  };

  const CLEARED = {
    failCount: 0,
    lastFailAt: null,
    consecutiveFailCount: 0,
    cooldownLevel: 0,
    cooldownUntil: null,
  };

  const seedRouteWithChannels = async (channelCount: number) => {
    const id = nextId();
    const site = await db.insert(schema.sites).values({
      name: `chan-cooldown-site-${id}`,
      url: `https://chan-cooldown-site-${id}.example.com`,
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: `chan-cooldown-user-${id}`,
      accessToken: `chan-cooldown-access-${id}`,
      status: 'active',
    }).returning().get();

    const token = await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: `chan-cooldown-token-${id}`,
      token: `chan-token-${id}`,
      enabled: true,
      isDefault: true,
    }).returning().get();

    const route = await db.insert(schema.tokenRoutes).values({
      modelPattern: `chan-model-${id}`,
      enabled: true,
    }).returning().get();

    const channels = [];
    for (let index = 0; index < channelCount; index += 1) {
      channels.push(await db.insert(schema.routeChannels).values({
        routeId: route.id,
        accountId: account.id,
        tokenId: token.id,
        sourceModel: `chan-model-${id}`,
        priority: index,
        weight: 10,
        enabled: true,
        ...COOLING,
      }).returning().get());
    }

    return { site, account, token, route, channels };
  };

  const readChannel = async (channelId: number) => await db.select().from(schema.routeChannels)
    .where(eq(schema.routeChannels.id, channelId))
    .get();

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-channel-cooldown-clear-'));
    process.env.DATA_DIR = dataDir;

    await import('../../db/migrate.js');
    const dbModule = await import('../../db/index.js');
    const routesModule = await import('./tokens.js');

    db = dbModule.db;
    schema = dbModule.schema;

    app = Fastify();
    await app.register(routesModule.tokensRoutes);
  });

  beforeEach(async () => {
    await db.delete(schema.routeGroupSources).run();
    await db.delete(schema.routeChannels).run();
    await db.delete(schema.oauthRouteUnitMembers).run();
    await db.delete(schema.oauthRouteUnits).run();
    await db.delete(schema.tokenRoutes).run();
    await db.delete(schema.accountTokens).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
    seedId = 0;
  });

  afterAll(async () => {
    await app.close();
    delete process.env.DATA_DIR;
  });

  it('clears cooldown for the targeted channel only', async () => {
    const seeded = await seedRouteWithChannels(2);
    const [target, sibling] = seeded.channels;

    const response = await app.inject({
      method: 'POST',
      url: `/api/channels/${target.id}/cooldown/clear`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      success: true,
      clearedChannels: 1,
      routeId: seeded.route.id,
    });

    expect(await readChannel(target.id)).toMatchObject(CLEARED);
    // The sibling is the whole point of a per-channel button: it must stay cooling.
    expect(await readChannel(sibling.id)).toMatchObject(COOLING);
  });

  it('returns 404 for an unknown channel and touches nothing', async () => {
    const seeded = await seedRouteWithChannels(1);
    const [existing] = seeded.channels;

    const response = await app.inject({
      method: 'POST',
      url: `/api/channels/${existing.id + 9999}/cooldown/clear`,
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ success: false });
    expect(await readChannel(existing.id)).toMatchObject(COOLING);
  });

  it('rejects a non-numeric channel id without clearing anything', async () => {
    const seeded = await seedRouteWithChannels(1);
    const [existing] = seeded.channels;

    const response = await app.inject({
      method: 'POST',
      url: '/api/channels/not-a-number/cooldown/clear',
    });

    expect(response.statusCode).toBe(404);
    expect(await readChannel(existing.id)).toMatchObject(COOLING);
  });

  it('also releases the route-unit member row backing the channel', async () => {
    // Route-unit channels carry cooldown on the MEMBER row; clearing only the channel row
    // left them cooling with no way to release them from the UI.
    const seeded = await seedRouteWithChannels(1);
    const [channel] = seeded.channels;

    const unit = await db.insert(schema.oauthRouteUnits).values({
      siteId: seeded.site.id,
      provider: 'codex',
      name: 'chan-cooldown-unit',
      strategy: 'round_robin',
    }).returning().get();

    const member = await db.insert(schema.oauthRouteUnitMembers).values({
      unitId: unit.id,
      accountId: seeded.account.id,
      sortOrder: 0,
      failCount: 4,
      lastFailAt: '2026-04-01T00:00:00.000Z',
      consecutiveFailCount: 2,
      cooldownLevel: 1,
      cooldownUntil: '2099-01-01T00:00:00.000Z',
    }).returning().get();

    await db.update(schema.routeChannels)
      .set({ oauthRouteUnitId: unit.id })
      .where(eq(schema.routeChannels.id, channel.id))
      .run();

    const response = await app.inject({
      method: 'POST',
      url: `/api/channels/${channel.id}/cooldown/clear`,
    });

    expect(response.statusCode).toBe(200);
    expect(await readChannel(channel.id)).toMatchObject(CLEARED);

    const refreshedMember = await db.select().from(schema.oauthRouteUnitMembers)
      .where(eq(schema.oauthRouteUnitMembers.id, member.id))
      .get();
    expect(refreshedMember).toMatchObject({
      failCount: 0,
      lastFailAt: null,
      consecutiveFailCount: 0,
      cooldownLevel: 0,
      cooldownUntil: null,
    });
  });
});
