import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';

type DbModule = typeof import('../db/index.js');
type TokenRouterModule = typeof import('./tokenRouter.js');
type ConfigModule = typeof import('../config.js');

/**
 * An observed timeout must rotate without being charged to the channel. These tests pin
 * the boundary from both sides: the default exemption AND the strict opt-in, because an
 * exemption that cannot be switched back on is indistinguishable from a dropped feature.
 */
describe('tokenRouter timeout failure accounting', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let TokenRouter: TokenRouterModule['TokenRouter'];
  let invalidateTokenRouterCache: TokenRouterModule['invalidateTokenRouterCache'];
  let resetSiteRuntimeHealthState: TokenRouterModule['resetSiteRuntimeHealthState'];
  let config: ConfigModule['config'];
  let dataDir = '';
  let idSeed = 0;
  let originalTimeoutCountsAsChannelFailure = false;
  let originalRoutingWeights: typeof config.routingWeights;

  const nextId = () => {
    idSeed += 1;
    return idSeed;
  };

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-token-router-timeout-'));
    process.env.DATA_DIR = dataDir;

    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    const tokenRouterModule = await import('./tokenRouter.js');
    const configModule = await import('../config.js');
    db = dbModule.db;
    schema = dbModule.schema;
    TokenRouter = tokenRouterModule.TokenRouter;
    invalidateTokenRouterCache = tokenRouterModule.invalidateTokenRouterCache;
    resetSiteRuntimeHealthState = tokenRouterModule.resetSiteRuntimeHealthState;
    config = configModule.config;
    originalTimeoutCountsAsChannelFailure = config.timeoutCountsAsChannelFailure;
    originalRoutingWeights = { ...config.routingWeights };
  });

  beforeEach(async () => {
    idSeed = 0;
    config.timeoutCountsAsChannelFailure = false;
    config.routingWeights = { ...originalRoutingWeights };
    await db.delete(schema.routeChannels).run();
    await db.delete(schema.tokenRoutes).run();
    await db.delete(schema.settings).run();
    await db.delete(schema.accountTokens).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
    invalidateTokenRouterCache();
    resetSiteRuntimeHealthState();
  });

  afterAll(() => {
    config.timeoutCountsAsChannelFailure = originalTimeoutCountsAsChannelFailure;
    config.routingWeights = { ...originalRoutingWeights };
    invalidateTokenRouterCache();
    resetSiteRuntimeHealthState();
    delete process.env.DATA_DIR;
  });

  async function seedChannel(modelPattern: string) {
    const id = nextId();
    const route = await db.insert(schema.tokenRoutes).values({
      modelPattern,
      enabled: true,
    }).returning().get();
    const site = await db.insert(schema.sites).values({
      name: `timeout-site-${id}`,
      url: `https://timeout-site-${id}.example.com`,
      platform: 'new-api',
      status: 'active',
    }).returning().get();
    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: `timeout-user-${id}`,
      accessToken: `access-${id}`,
      apiToken: `sk-${id}`,
      status: 'active',
    }).returning().get();
    const token = await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: `timeout-token-${id}`,
      token: `token-${id}`,
      enabled: true,
      isDefault: true,
    }).returning().get();
    const channel = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: account.id,
      tokenId: token.id,
      sourceModel: modelPattern,
      priority: 0,
      weight: 10,
      enabled: true,
    }).returning().get();

    return { route, site, account, token, channel };
  }

  const readChannel = async (channelId: number) => await db.select().from(schema.routeChannels)
    .where(eq(schema.routeChannels.id, channelId))
    .get();

  const timeoutContext = (modelName: string) => ({
    status: 408,
    errorText: 'first byte timeout (45s)',
    modelName,
    failureKind: 'first-byte-timeout' as const,
  });

  it('does not grow failCount or write cooldown for a timeout (default)', async () => {
    const seeded = await seedChannel('gpt-timeout-default');
    const router = new TokenRouter();

    for (let index = 0; index < 4; index += 1) {
      await router.recordFailure(seeded.channel.id, timeoutContext('gpt-timeout-default'));
    }

    const refreshed = await readChannel(seeded.channel.id);
    expect(refreshed).toMatchObject({
      failCount: 0,
      consecutiveFailCount: 0,
      cooldownLevel: 0,
      cooldownUntil: null,
    });
    // lastFailAt is still recorded: the timeout must remain visible for diagnosis.
    expect(refreshed?.lastFailAt).toBeTruthy();
  });

  it('keeps the channel selectable after repeated timeouts', async () => {
    const seeded = await seedChannel('gpt-timeout-selectable');
    const router = new TokenRouter();

    for (let index = 0; index < 4; index += 1) {
      await router.recordFailure(seeded.channel.id, timeoutContext('gpt-timeout-selectable'));
    }
    invalidateTokenRouterCache();

    const decision = await router.explainSelection('gpt-timeout-selectable');
    const candidate = decision.candidates.find((item) => item.channelId === seeded.channel.id);
    expect(candidate?.eligible).toBe(true);
    expect(candidate?.reason || '').not.toContain('冷却中');
    expect(candidate?.probability || 0).toBeGreaterThan(0);
  });

  it('still cools the channel for an ordinary upstream failure', async () => {
    // Counterfactual: proves the exemption is keyed on failureKind, not on being lenient
    // about every 5xx-ish failure.
    const seeded = await seedChannel('gpt-timeout-contrast');
    const router = new TokenRouter();

    await router.recordFailure(seeded.channel.id, {
      status: 502,
      errorText: 'Bad gateway',
      modelName: 'gpt-timeout-contrast',
    });

    const refreshed = await readChannel(seeded.channel.id);
    expect(refreshed?.failCount).toBe(1);
    expect(refreshed?.cooldownUntil).toBeTruthy();
  });

  it('charges the timeout to the channel when the strict toggle is on', async () => {
    const seeded = await seedChannel('gpt-timeout-strict');
    const router = new TokenRouter();
    config.timeoutCountsAsChannelFailure = true;

    await router.recordFailure(seeded.channel.id, timeoutContext('gpt-timeout-strict'));

    const refreshed = await readChannel(seeded.channel.id);
    expect(refreshed?.failCount).toBe(1);
    expect(refreshed?.cooldownUntil).toBeTruthy();
  });

  it('does not open the model-level breaker after a timeout streak', async () => {
    // The site-level exemption already existed; the model-level state used to take the
    // maximum transient penalty for the same abort, which contradicted it.
    const seeded = await seedChannel('gpt-timeout-breaker');
    const router = new TokenRouter();

    for (let index = 0; index < 5; index += 1) {
      await router.recordFailure(seeded.channel.id, timeoutContext('gpt-timeout-breaker'));
    }
    invalidateTokenRouterCache();

    const decision = await router.explainSelection('gpt-timeout-breaker');
    const candidate = decision.candidates.find((item) => item.channelId === seeded.channel.id);
    expect(candidate?.reason || '').not.toContain('熔断');
    expect(candidate?.eligible).toBe(true);
  });

  it('does not shrink the timed-out channel weight against a healthy sibling', async () => {
    // The model-level penalty is invisible through cooldown/breaker assertions: it only
    // scales the WEIGHT. Two equal-weight channels on separate sites make it observable —
    // an unexempted penalty (2.5 -> factor 1/3.5) drops the timed-out channel's share far
    // below the 50/50 split, without ever making it ineligible.
    config.routingWeights = {
      baseWeightFactor: 1,
      valueScoreFactor: 0,
      costWeight: 0,
      balanceWeight: 0,
      usageWeight: 0,
    };

    const modelPattern = 'gpt-timeout-weight';
    const route = await db.insert(schema.tokenRoutes).values({
      modelPattern,
      enabled: true,
    }).returning().get();

    const makeChannel = async (label: string) => {
      const id = nextId();
      const site = await db.insert(schema.sites).values({
        name: `weight-site-${label}-${id}`,
        url: `https://weight-site-${label}-${id}.example.com`,
        platform: 'new-api',
        status: 'active',
      }).returning().get();
      const account = await db.insert(schema.accounts).values({
        siteId: site.id,
        username: `weight-user-${label}-${id}`,
        accessToken: `access-${label}-${id}`,
        apiToken: `sk-${label}-${id}`,
        status: 'active',
      }).returning().get();
      const token = await db.insert(schema.accountTokens).values({
        accountId: account.id,
        name: `weight-token-${label}-${id}`,
        token: `token-${label}-${id}`,
        enabled: true,
        isDefault: true,
      }).returning().get();
      return await db.insert(schema.routeChannels).values({
        routeId: route.id,
        accountId: account.id,
        tokenId: token.id,
        sourceModel: modelPattern,
        priority: 0,
        weight: 10,
        enabled: true,
      }).returning().get();
    };

    const timedOut = await makeChannel('timeout');
    const healthy = await makeChannel('healthy');

    const router = new TokenRouter();
    for (let index = 0; index < 5; index += 1) {
      await router.recordFailure(timedOut.id, timeoutContext(modelPattern));
    }
    invalidateTokenRouterCache();

    const decision = await router.explainSelection(modelPattern);
    const timedOutCandidate = decision.candidates.find((item) => item.channelId === timedOut.id);
    const healthyCandidate = decision.candidates.find((item) => item.channelId === healthy.id);

    expect(timedOutCandidate?.eligible).toBe(true);
    expect(healthyCandidate?.eligible).toBe(true);
    // Equal weights, no penalty charged: the split stays even.
    expect(timedOutCandidate?.probability || 0).toBeGreaterThan(40);
    expect(healthyCandidate?.probability || 0).toBeGreaterThan(40);
  });
});
