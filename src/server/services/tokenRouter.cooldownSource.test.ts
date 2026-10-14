import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';

type DbModule = typeof import('../db/index.js');
type TokenRouterModule = typeof import('./tokenRouter.js');
type ConfigModule = typeof import('../config.js');

/**
 * A cooling channel records WHY it is cooling, instead of leaving consumers to infer it
 * from the shape of its failure counters.
 */
describe('cooldown source', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let TokenRouter: TokenRouterModule['TokenRouter'];
  let tokenRouterTestUtils: TokenRouterModule['__tokenRouterTestUtils'];
  let isProviderDirectedCooldown: TokenRouterModule['isProviderDirectedCooldown'];
  let isChannelRecentlyFailed: TokenRouterModule['isChannelRecentlyFailed'];
  let invalidateTokenRouterCache: TokenRouterModule['invalidateTokenRouterCache'];
  let resetSiteRuntimeHealthState: TokenRouterModule['resetSiteRuntimeHealthState'];
  let config: ConfigModule['config'];
  let dataDir = '';
  let originalFailureCooldownMaxSec = 0;
  let idSeed = 0;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-token-router-cooldown-source-'));
    process.env.DATA_DIR = dataDir;

    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    const tokenRouterModule = await import('./tokenRouter.js');
    const configModule = await import('../config.js');
    db = dbModule.db;
    schema = dbModule.schema;
    TokenRouter = tokenRouterModule.TokenRouter;
    tokenRouterTestUtils = tokenRouterModule.__tokenRouterTestUtils;
    isProviderDirectedCooldown = tokenRouterModule.isProviderDirectedCooldown;
    isChannelRecentlyFailed = tokenRouterModule.isChannelRecentlyFailed;
    invalidateTokenRouterCache = tokenRouterModule.invalidateTokenRouterCache;
    resetSiteRuntimeHealthState = tokenRouterModule.resetSiteRuntimeHealthState;
    config = configModule.config;
    originalFailureCooldownMaxSec = config.tokenRouterFailureCooldownMaxSec;
  });

  beforeEach(async () => {
    await db.delete(schema.routeChannels).run();
    await db.delete(schema.tokenRoutes).run();
    await db.delete(schema.settings).run();
    await db.delete(schema.accountTokens).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
    config.tokenRouterFailureCooldownMaxSec = originalFailureCooldownMaxSec;
    invalidateTokenRouterCache();
    resetSiteRuntimeHealthState();
    tokenRouterTestUtils.setFailureCooldownJitterSource(() => 0);
  });

  afterEach(() => {
    tokenRouterTestUtils.setFailureCooldownJitterSource(null);
  });

  afterAll(() => {
    config.tokenRouterFailureCooldownMaxSec = originalFailureCooldownMaxSec;
    tokenRouterTestUtils.setFailureCooldownJitterSource(null);
    invalidateTokenRouterCache();
    resetSiteRuntimeHealthState();
    delete process.env.DATA_DIR;
  });

  const seedChannel = async (options: { routingStrategy?: string; failCount?: number } = {}) => {
    idSeed += 1;
    const label = `source-${idSeed}`;
    const site = await db.insert(schema.sites).values({
      name: `${label}-site`,
      url: `https://${label}.example.com`,
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: `${label}-user`,
      accessToken: `${label}-access-token`,
      apiToken: `${label}-api-token`,
      status: 'active',
    }).returning().get();

    const token = await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: `${label}-token`,
      token: `sk-${label}-token`,
      enabled: true,
      isDefault: true,
    }).returning().get();

    const route = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'gpt-4o-mini',
      routingStrategy: options.routingStrategy ?? 'weighted',
      enabled: true,
    }).returning().get();

    const channel = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: account.id,
      tokenId: token.id,
      priority: 0,
      weight: 10,
      enabled: true,
      ...(options.failCount == null ? {} : { failCount: options.failCount }),
    }).returning().get();

    return { site, account, token, route, channel };
  };

  const readChannel = async (channelId: number) => db.select().from(schema.routeChannels)
    .where(eq(schema.routeChannels.id, channelId))
    .get();

  it('records a rate limit as provider-directed', async () => {
    const { channel } = await seedChannel();
    const router = new TokenRouter();

    await router.recordFailure(channel.id, {
      status: 429,
      errorText: JSON.stringify({ error: { message: 'rate limit exceeded' } }),
      modelName: 'gpt-4o-mini',
    });

    const row = await readChannel(channel.id);
    expect(row?.cooldownSource).toBe('provider_quota');
    expect(isProviderDirectedCooldown(row!)).toBe(true);
  });

  it('records an ordinary failure as our own backoff', async () => {
    const { channel } = await seedChannel();
    const router = new TokenRouter();

    await router.recordFailure(channel.id, {
      status: 500,
      errorText: 'upstream exploded',
      modelName: 'gpt-4o-mini',
    });

    const row = await readChannel(channel.id);
    expect(row?.cooldownSource).toBe('metapi_backoff');
    expect(isProviderDirectedCooldown(row!)).toBe(false);
  });

  it('keeps the lifetime failure count when a rate limit cools the channel', async () => {
    const { channel } = await seedChannel({ failCount: 6 });
    const router = new TokenRouter();

    await router.recordFailure(channel.id, {
      status: 429,
      errorText: JSON.stringify({ error: { message: 'rate limit exceeded' } }),
      modelName: 'gpt-4o-mini',
    });

    const row = await readChannel(channel.id);
    // The old implementation reset failCount to 0 here purely to mark the cooldown as
    // provider-directed, erasing the channel's entire failure history as a side effect.
    expect(row?.failCount).toBe(7);
    expect(row?.cooldownSource).toBe('provider_quota');
  });

  it('does not soft-avoid a channel whose only cooldown came from the provider', async () => {
    const { channel } = await seedChannel({ failCount: 6 });
    const router = new TokenRouter();

    await router.recordFailure(channel.id, {
      status: 429,
      errorText: JSON.stringify({ error: { message: 'rate limit exceeded' } }),
      modelName: 'gpt-4o-mini',
    });

    const row = await readChannel(channel.id);
    // A rate limit zeroes the streak, so preserving failCount must not resurrect the old
    // behaviour where the lifetime count drove the soft-avoidance window.
    expect(row?.consecutiveFailCount).toBe(0);
    expect(isChannelRecentlyFailed(row!)).toBe(false);
  });

  it('records a round-robin tier cooldown as our own backoff', async () => {
    const { channel } = await seedChannel({ routingStrategy: 'round_robin' });
    const router = new TokenRouter();

    await router.recordFailure(channel.id);
    const afterFirst = await readChannel(channel.id);
    // Below the threshold there is no cooldown yet, so there is no source to state.
    expect(afterFirst?.cooldownUntil).toBeNull();
    expect(afterFirst?.cooldownSource).toBeNull();

    await router.recordFailure(channel.id);
    await router.recordFailure(channel.id);

    const afterThird = await readChannel(channel.id);
    expect(afterThird?.cooldownUntil).toBeTruthy();
    expect(afterThird?.cooldownSource).toBe('metapi_backoff');
    expect(isProviderDirectedCooldown(afterThird!)).toBe(false);
  });

  it('clears the source when a success releases the channel', async () => {
    const { channel } = await seedChannel();
    const router = new TokenRouter();

    await router.recordFailure(channel.id, {
      status: 429,
      errorText: JSON.stringify({ error: { message: 'rate limit exceeded' } }),
      modelName: 'gpt-4o-mini',
    });
    expect((await readChannel(channel.id))?.cooldownSource).toBe('provider_quota');

    await router.recordSuccess(channel.id, 120, 0.01);

    const row = await readChannel(channel.id);
    // A stale source on a non-cooling channel would misclassify its next cooldown.
    expect(row?.cooldownUntil).toBeNull();
    expect(row?.cooldownSource).toBeNull();
    expect(isProviderDirectedCooldown(row!)).toBe(false);
  });

  it('clears the source when an operator clears the cooldown', async () => {
    const { channel } = await seedChannel();
    const router = new TokenRouter();

    await router.recordFailure(channel.id, {
      status: 429,
      errorText: JSON.stringify({ error: { message: 'rate limit exceeded' } }),
      modelName: 'gpt-4o-mini',
    });

    await router.clearChannelFailureState([channel.id]);

    const row = await readChannel(channel.id);
    expect(row?.cooldownUntil).toBeNull();
    expect(row?.cooldownSource).toBeNull();
  });

  it('clears the source when a recovery probe succeeds', async () => {
    const { channel } = await seedChannel();
    const router = new TokenRouter();

    await router.recordFailure(channel.id, {
      status: 500,
      errorText: 'upstream exploded',
      modelName: 'gpt-4o-mini',
    });
    expect((await readChannel(channel.id))?.cooldownSource).toBe('metapi_backoff');

    await router.recordProbeSuccess(channel.id, 95, 'gpt-4o-mini');

    const row = await readChannel(channel.id);
    expect(row?.cooldownUntil).toBeNull();
    expect(row?.cooldownSource).toBeNull();
  });

  describe('isProviderDirectedCooldown', () => {
    it('is false for a channel that is not cooling at all', () => {
      expect(isProviderDirectedCooldown({ cooldownUntil: null })).toBe(false);
      expect(isProviderDirectedCooldown({
        cooldownUntil: null,
        cooldownSource: 'provider_quota',
      })).toBe(false);
    });

    it('trusts the stated source over the counter shape', () => {
      // Counters that look like our own backoff, but the row says otherwise.
      expect(isProviderDirectedCooldown({
        cooldownUntil: '2099-01-01T00:00:00.000Z',
        cooldownSource: 'provider_quota',
        failCount: 9,
        consecutiveFailCount: 4,
        cooldownLevel: 2,
      })).toBe(true);

      // Counters that look provider-directed, but the row says it is our backoff.
      expect(isProviderDirectedCooldown({
        cooldownUntil: '2099-01-01T00:00:00.000Z',
        cooldownSource: 'metapi_backoff',
        failCount: 0,
        consecutiveFailCount: 0,
        cooldownLevel: 0,
      })).toBe(false);
    });

    it('falls back to the legacy counter signal for a row with no source', () => {
      // Rows written before cooldown_source existed must keep their old classification,
      // so an upgrade does not start probing provider-quota channels.
      expect(isProviderDirectedCooldown({
        cooldownUntil: '2099-01-01T00:00:00.000Z',
        failCount: 0,
        consecutiveFailCount: 0,
        cooldownLevel: 0,
      })).toBe(true);

      expect(isProviderDirectedCooldown({
        cooldownUntil: '2099-01-01T00:00:00.000Z',
        failCount: 2,
        consecutiveFailCount: 0,
        cooldownLevel: 0,
      })).toBe(false);
    });

    it('ignores an unrecognized source instead of guessing', () => {
      expect(isProviderDirectedCooldown({
        cooldownUntil: '2099-01-01T00:00:00.000Z',
        cooldownSource: 'something-new',
        failCount: 0,
        consecutiveFailCount: 0,
        cooldownLevel: 0,
      })).toBe(false);
    });
  });
});
