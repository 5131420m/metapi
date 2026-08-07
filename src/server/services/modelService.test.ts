import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { and, eq } from 'drizzle-orm';
import { config } from '../config.js';

type DbModule = typeof import('../db/index.js');
type ModelServiceModule = typeof import('./modelService.js');

describe('rebuildTokenRoutesFromAvailability', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let rebuildTokenRoutesFromAvailability: ModelServiceModule['rebuildTokenRoutesFromAvailability'];
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-model-service-'));
    process.env.DATA_DIR = dataDir;

    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    const modelService = await import('./modelService.js');

    db = dbModule.db;
    schema = dbModule.schema;
    rebuildTokenRoutesFromAvailability = modelService.rebuildTokenRoutesFromAvailability;
  });

  beforeEach(async () => {
    await db.delete(schema.routeChannels).run();
    await db.delete(schema.tokenRoutes).run();
    await db.delete(schema.tokenModelAvailability).run();
    await db.delete(schema.modelAvailability).run();
    await db.delete(schema.accountTokens).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
  });

  afterAll(() => {
    delete process.env.DATA_DIR;
  });

  it('creates an exact route with an account-direct channel for apikey model availability', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'apikey-site',
      url: 'https://apikey-site.example.com',
      platform: 'new-api',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'apikey-user',
      accessToken: '',
      apiToken: 'sk-apikey-route',
      status: 'active',
      extraConfig: JSON.stringify({ credentialMode: 'apikey' }),
    }).returning().get();

    await db.insert(schema.modelAvailability).values({
      accountId: account.id,
      modelName: 'gpt-5.2-codex',
      available: true,
      latencyMs: 1200,
      checkedAt: '2026-03-08T08:00:00.000Z',
    }).run();

    const rebuild = await rebuildTokenRoutesFromAvailability();

    expect(rebuild.models).toBe(1);

    const route = await db.select().from(schema.tokenRoutes)
      .where(eq(schema.tokenRoutes.modelPattern, 'gpt-5.2-codex'))
      .get();
    expect(route).toBeDefined();

    const channels = await db.select().from(schema.routeChannels)
      .where(and(
        eq(schema.routeChannels.routeId, route!.id),
        eq(schema.routeChannels.accountId, account.id),
      ))
      .all();

    expect(channels).toHaveLength(1);
    expect(channels[0]?.tokenId ?? null).toBeNull();
    expect(channels[0]?.manualOverride).toBe(false);
  });

  it('ignores hidden account_tokens for direct apikey connections when rebuilding routes', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'apikey-legacy-site',
      url: 'https://apikey-legacy.example.com',
      platform: 'new-api',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'apikey-legacy-user',
      accessToken: '',
      apiToken: 'sk-direct-credential',
      status: 'active',
      extraConfig: JSON.stringify({ credentialMode: 'apikey' }),
    }).returning().get();

    const hiddenToken = await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: 'legacy-hidden',
      token: 'sk-hidden-legacy-token',
      source: 'legacy',
      enabled: true,
      isDefault: true,
    }).returning().get();

    await db.insert(schema.modelAvailability).values({
      accountId: account.id,
      modelName: 'gpt-4.1',
      available: true,
      latencyMs: 200,
      checkedAt: '2026-03-20T08:00:00.000Z',
    }).run();

    await db.insert(schema.tokenModelAvailability).values({
      tokenId: hiddenToken.id,
      modelName: 'gpt-4.1',
      available: true,
      latencyMs: 180,
      checkedAt: '2026-03-20T08:00:00.000Z',
    }).run();

    const rebuild = await rebuildTokenRoutesFromAvailability();

    expect(rebuild.models).toBe(1);

    const route = await db.select().from(schema.tokenRoutes)
      .where(eq(schema.tokenRoutes.modelPattern, 'gpt-4.1'))
      .get();
    expect(route).toBeDefined();

    const channels = await db.select().from(schema.routeChannels)
      .where(and(
        eq(schema.routeChannels.routeId, route!.id),
        eq(schema.routeChannels.accountId, account.id),
      ))
      .all();

    expect(channels).toHaveLength(1);
    expect(channels[0]?.tokenId ?? null).toBeNull();
  });

  it('creates an exact route with an account-direct channel for oauth model availability', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'codex-site',
      url: 'https://chatgpt.com/backend-api/codex',
      platform: 'codex',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'codex-user@example.com',
      accessToken: 'oauth-access-token',
      apiToken: null,
      status: 'active',
      extraConfig: JSON.stringify({
        credentialMode: 'session',
        oauth: {
          provider: 'codex',
          accountId: 'chatgpt-account-123',
          email: 'codex-user@example.com',
          planType: 'team',
        },
      }),
    }).returning().get();

    await db.insert(schema.modelAvailability).values({
      accountId: account.id,
      modelName: 'gpt-5.2-codex',
      available: true,
      latencyMs: 320,
      checkedAt: '2026-03-17T00:00:00.000Z',
    }).run();

    const rebuild = await rebuildTokenRoutesFromAvailability();

    expect(rebuild.models).toBe(1);

    const route = await db.select().from(schema.tokenRoutes)
      .where(eq(schema.tokenRoutes.modelPattern, 'gpt-5.2-codex'))
      .get();
    expect(route).toBeDefined();

    const channels = await db.select().from(schema.routeChannels)
      .where(and(
        eq(schema.routeChannels.routeId, route!.id),
        eq(schema.routeChannels.accountId, account.id),
      ))
      .all();

    expect(channels).toHaveLength(1);
    expect(channels[0]?.tokenId ?? null).toBeNull();
    expect(channels[0]?.manualOverride).toBe(false);
  });

  it('creates an exact route with an account-direct channel for oauth accounts stored via structured identity columns', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'codex-site-structured',
      url: 'https://chatgpt.com/backend-api/codex',
      platform: 'codex',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'codex-structured@example.com',
      accessToken: 'oauth-access-token',
      apiToken: null,
      status: 'active',
      oauthProvider: 'codex',
      oauthAccountKey: 'chatgpt-account-structured-123',
      extraConfig: JSON.stringify({
        credentialMode: 'session',
        oauth: {
          email: 'codex-structured@example.com',
          planType: 'team',
        },
      }),
    }).returning().get();

    await db.insert(schema.modelAvailability).values({
      accountId: account.id,
      modelName: 'gpt-5.2-codex',
      available: true,
      latencyMs: 320,
      checkedAt: '2026-04-01T00:00:00.000Z',
    }).run();

    const rebuild = await rebuildTokenRoutesFromAvailability();

    expect(rebuild.models).toBe(1);

    const route = await db.select().from(schema.tokenRoutes)
      .where(eq(schema.tokenRoutes.modelPattern, 'gpt-5.2-codex'))
      .get();
    expect(route).toBeDefined();

    const channels = await db.select().from(schema.routeChannels)
      .where(and(
        eq(schema.routeChannels.routeId, route!.id),
        eq(schema.routeChannels.accountId, account.id),
      ))
      .all();

    expect(channels).toHaveLength(1);
    expect(channels[0]?.tokenId ?? null).toBeNull();
    expect(channels[0]?.manualOverride).toBe(false);
  });

  it('merges namespaced aliases into one route while keeping every full upstream model as a channel', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'alias-site',
      url: 'https://alias-site.example.com',
      platform: 'new-api',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'alias-user',
      accessToken: '',
      apiToken: 'sk-alias',
      status: 'active',
      extraConfig: JSON.stringify({ credentialMode: 'apikey' }),
    }).returning().get();

    for (const modelName of ['AAA/BBB', 'CCC/BBB', 'BBB', 'bbb']) {
      await db.insert(schema.modelAvailability).values({
        accountId: account.id,
        modelName,
        available: true,
      }).run();
    }

    const rebuild = await rebuildTokenRoutesFromAvailability();

    expect(rebuild.models).toBe(1);
    const routes = await db.select().from(schema.tokenRoutes).all();
    expect(routes.map((route) => route.modelPattern)).toEqual(['bbb']);

    const channels = await db.select().from(schema.routeChannels)
      .where(eq(schema.routeChannels.routeId, routes[0]!.id))
      .all();
    expect(channels).toHaveLength(4);
    expect(channels.map((channel) => channel.sourceModel).sort()).toEqual([
      'AAA/BBB',
      'BBB',
      'CCC/BBB',
      'bbb',
    ]);
    expect(channels.every((channel) => channel.accountId === account.id)).toBe(true);
  });

  it('applies canonical whitelist, exact-or-family site disables, and full-name brand blocking', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'filter-site',
      url: 'https://filter.example.com',
      platform: 'new-api',
    }).returning().get();
    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'filter-user',
      accessToken: '',
      apiToken: 'sk-filter',
      status: 'active',
      extraConfig: JSON.stringify({ credentialMode: 'apikey' }),
    }).returning().get();
    for (const modelName of ['AAA/BBB', 'CCC/BBB', 'BBB', 'deepseek/BBB', 'DDD/EEE']) {
      await db.insert(schema.modelAvailability).values({ accountId: account.id, modelName, available: true }).run();
    }
    await db.insert(schema.siteDisabledModels).values({ siteId: site.id, modelName: 'AAA/BBB' }).run();

    const previousAllowed = [...config.globalAllowedModels];
    const previousBlocked = [...config.globalBlockedBrands];
    config.globalAllowedModels = ['BBB'];
    config.globalBlockedBrands = ['DeepSeek'];
    try {
      await rebuildTokenRoutesFromAvailability();
    } finally {
      config.globalAllowedModels = previousAllowed;
      config.globalBlockedBrands = previousBlocked;
    }

    const route = await db.select().from(schema.tokenRoutes).where(eq(schema.tokenRoutes.modelPattern, 'bbb')).get();
    expect(route).toBeDefined();
    const channels = await db.select().from(schema.routeChannels)
      .where(eq(schema.routeChannels.routeId, route!.id))
      .all();
    expect(channels.map((channel) => channel.sourceModel).sort()).toEqual(['BBB', 'CCC/BBB']);
  });

  it('converges existing automatic alias routes onto the plain canonical route without losing its configuration', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'convergence-site',
      url: 'https://convergence.example.com',
      platform: 'new-api',
    }).returning().get();
    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'convergence-user',
      accessToken: '',
      apiToken: 'sk-convergence',
      status: 'active',
      extraConfig: JSON.stringify({ credentialMode: 'apikey' }),
    }).returning().get();
    for (const modelName of ['AAA/BBB', 'CCC/BBB', 'BBB']) {
      await db.insert(schema.modelAvailability).values({ accountId: account.id, modelName, available: true }).run();
    }

    const aliasA = await db.insert(schema.tokenRoutes).values({ modelPattern: 'AAA/BBB', enabled: true }).returning().get();
    const aliasC = await db.insert(schema.tokenRoutes).values({ modelPattern: 'CCC/BBB', enabled: true }).returning().get();
    const canonical = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'BBB',
      displayName: 'Preferred BBB',
      routingStrategy: 'round_robin',
      modelMapping: JSON.stringify({ bbb: 'legacy-target' }),
      enabled: true,
    }).returning().get();
    for (const route of [aliasA, aliasC]) {
      await db.insert(schema.routeChannels).values({
        routeId: route.id,
        accountId: account.id,
        tokenId: null,
        sourceModel: route.modelPattern,
        enabled: true,
        manualOverride: false,
      }).run();
    }

    await rebuildTokenRoutesFromAvailability();

    const routes = await db.select().from(schema.tokenRoutes).all();
    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({
      id: canonical.id,
      modelPattern: 'bbb',
      displayName: 'Preferred BBB',
      routingStrategy: 'round_robin',
      modelMapping: JSON.stringify({ bbb: 'legacy-target' }),
    });
    const channels = await db.select().from(schema.routeChannels)
      .where(eq(schema.routeChannels.routeId, canonical.id))
      .all();
    expect(channels.map((channel) => channel.sourceModel).sort()).toEqual(['AAA/BBB', 'BBB', 'CCC/BBB']);
  });

  it('preserves an alias route when it owns a manual channel', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'manual-alias-site',
      url: 'https://manual-alias.example.com',
      platform: 'new-api',
    }).returning().get();
    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'manual-alias-user',
      accessToken: '',
      apiToken: 'sk-manual-alias',
      status: 'active',
      extraConfig: JSON.stringify({ credentialMode: 'apikey' }),
    }).returning().get();
    await db.insert(schema.modelAvailability).values({ accountId: account.id, modelName: 'BBB', available: true }).run();
    const alias = await db.insert(schema.tokenRoutes).values({ modelPattern: 'AAA/BBB', enabled: true }).returning().get();
    const manual = await db.insert(schema.routeChannels).values({
      routeId: alias.id,
      accountId: account.id,
      sourceModel: 'AAA/BBB',
      enabled: true,
      manualOverride: true,
    }).returning().get();

    await rebuildTokenRoutesFromAvailability();

    const canonical = await db.select().from(schema.tokenRoutes).where(eq(schema.tokenRoutes.modelPattern, 'bbb')).get();
    expect(canonical).toBeDefined();
    expect(canonical!.id).not.toBe(alias.id);
    expect(await db.select().from(schema.tokenRoutes).where(eq(schema.tokenRoutes.id, alias.id)).get()).toBeDefined();
    expect(await db.select().from(schema.routeChannels).where(eq(schema.routeChannels.id, manual.id)).get()).toBeDefined();
  });

  it('removes stale exact routes and keeps wildcard routes on rebuild', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'site-1',
      url: 'https://site-1.example.com',
      platform: 'new-api',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'user-1',
      accessToken: 'access-1',
      status: 'active',
    }).returning().get();

    const token = await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: 'default',
      token: 'sk-test',
      source: 'manual',
      enabled: true,
      isDefault: true,
    }).returning().get();

    await db.insert(schema.tokenModelAvailability).values({
      tokenId: token.id,
      modelName: 'latest-model',
      available: true,
    }).run();

    const staleRoute = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'old-model',
      enabled: true,
    }).returning().get();

    await db.insert(schema.routeChannels).values({
      routeId: staleRoute.id,
      accountId: account.id,
      tokenId: token.id,
      priority: 0,
      weight: 10,
      enabled: true,
      manualOverride: false,
    }).run();

    const wildcardRoute = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'gpt-*',
      enabled: true,
    }).returning().get();

    await db.insert(schema.routeChannels).values({
      routeId: wildcardRoute.id,
      accountId: account.id,
      tokenId: token.id,
      priority: 0,
      weight: 10,
      enabled: true,
      manualOverride: false,
    }).run();

    const rebuild = await rebuildTokenRoutesFromAvailability();

    expect(rebuild.models).toBe(1);
    expect(rebuild.removedRoutes).toBe(1);

    const oldRoute = await db.select().from(schema.tokenRoutes).where(eq(schema.tokenRoutes.id, staleRoute.id)).get();
    expect(oldRoute).toBeUndefined();

    const oldChannels = await db.select().from(schema.routeChannels).where(eq(schema.routeChannels.routeId, staleRoute.id)).all();
    expect(oldChannels).toHaveLength(0);

    const latestRoute = await db.select().from(schema.tokenRoutes).where(eq(schema.tokenRoutes.modelPattern, 'latest-model')).get();
    expect(latestRoute).toBeDefined();
    const latestChannels = await db.select().from(schema.routeChannels)
      .where(and(eq(schema.routeChannels.routeId, latestRoute!.id), eq(schema.routeChannels.tokenId, token.id)))
      .all();
    expect(latestChannels.length).toBeGreaterThan(0);

    const wildcardRouteAfter = await db.select().from(schema.tokenRoutes).where(eq(schema.tokenRoutes.id, wildcardRoute.id)).get();
    expect(wildcardRouteAfter).toBeDefined();
  });
});
