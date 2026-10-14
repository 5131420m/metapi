import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';

type DbModule = typeof import('../db/index.js');
type TokenRouterModule = typeof import('./tokenRouter.js');
type ConfigModule = typeof import('../config.js');

/**
 * Cooldowns Metapi computes itself carry positive jitter so sibling channels of one
 * upstream group stop thawing in the same millisecond. These tests pin the random draw,
 * so they assert the actual contract (bounds, monotonicity, which cooldowns are exempt)
 * instead of sampling a range and hoping.
 */
describe('failure cooldown jitter', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let TokenRouter: TokenRouterModule['TokenRouter'];
  let tokenRouterTestUtils: TokenRouterModule['__tokenRouterTestUtils'];
  let invalidateTokenRouterCache: TokenRouterModule['invalidateTokenRouterCache'];
  let resetSiteRuntimeHealthState: TokenRouterModule['resetSiteRuntimeHealthState'];
  let config: ConfigModule['config'];
  let dataDir = '';
  let originalFailureCooldownMaxSec = 0;

  const JITTER_RATIO = 0.15;
  const JITTER_MAX_MS = 30_000;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-token-router-cooldown-jitter-'));
    process.env.DATA_DIR = dataDir;

    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    const tokenRouterModule = await import('./tokenRouter.js');
    const configModule = await import('../config.js');
    db = dbModule.db;
    schema = dbModule.schema;
    TokenRouter = tokenRouterModule.TokenRouter;
    tokenRouterTestUtils = tokenRouterModule.__tokenRouterTestUtils;
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

  const seedWeightedChannel = async (label: string, overrides: {
    routingStrategy?: string;
    failCount?: number;
  } = {}) => {
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
      routingStrategy: overrides.routingStrategy ?? 'weighted',
      enabled: true,
    }).returning().get();

    const channel = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: account.id,
      tokenId: token.id,
      priority: 0,
      weight: 10,
      enabled: true,
      ...(overrides.failCount == null ? {} : { failCount: overrides.failCount }),
    }).returning().get();

    return { site, account, token, route, channel };
  };

  it('never shortens a cooldown and spreads at most the ratio of a short duration', () => {
    const { applyFailureCooldownJitter, setFailureCooldownJitterSource } = tokenRouterTestUtils;
    const baseMs = 15_000;

    setFailureCooldownJitterSource(() => 0);
    // A zero draw is the floor: the earned protection window is never cut short.
    expect(applyFailureCooldownJitter(baseMs)).toBe(baseMs);

    setFailureCooldownJitterSource(() => 1);
    expect(applyFailureCooldownJitter(baseMs)).toBe(baseMs + (baseMs * JITTER_RATIO));

    setFailureCooldownJitterSource(() => 0.5);
    expect(applyFailureCooldownJitter(baseMs)).toBe(baseMs + (baseMs * JITTER_RATIO * 0.5));
  });

  it('caps the spread absolutely so a long cooldown stays a named tier', () => {
    const { applyFailureCooldownJitter, setFailureCooldownJitterSource } = tokenRouterTestUtils;
    setFailureCooldownJitterSource(() => 1);

    // The 24h round-robin tier: a pure ratio would stretch it to 27.6h and dissolve the
    // boundary between "one day" and the tier below it.
    const oneDayMs = 24 * 60 * 60 * 1000;
    expect(applyFailureCooldownJitter(oneDayMs)).toBe(oneDayMs + JITTER_MAX_MS);

    const oneHourMs = 60 * 60 * 1000;
    expect(applyFailureCooldownJitter(oneHourMs)).toBe(oneHourMs + JITTER_MAX_MS);
  });

  it('treats a zero or negative duration as no cooldown at all', () => {
    const { applyFailureCooldownJitter, setFailureCooldownJitterSource } = tokenRouterTestUtils;
    setFailureCooldownJitterSource(() => 1);

    expect(applyFailureCooldownJitter(0)).toBe(0);
    expect(applyFailureCooldownJitter(-5_000)).toBe(0);
  });

  it('de-correlates two channels that fail in the same instant', async () => {
    const first = await seedWeightedChannel('jitter-sibling-a');
    const second = await db.insert(schema.routeChannels).values({
      routeId: first.route.id,
      accountId: first.account.id,
      tokenId: first.token.id,
      priority: 0,
      weight: 10,
      enabled: true,
    }).returning().get();

    const router = new TokenRouter();
    const draws = [0.2, 0.9];
    let drawIndex = 0;
    tokenRouterTestUtils.setFailureCooldownJitterSource(() => draws[drawIndex++] ?? 0);

    await router.recordFailure(first.channel.id);
    await router.recordFailure(second.id);

    const [firstRow, secondRow] = await Promise.all([
      db.select().from(schema.routeChannels).where(eq(schema.routeChannels.id, first.channel.id)).get(),
      db.select().from(schema.routeChannels).where(eq(schema.routeChannels.id, second.id)).get(),
    ]);

    // Same base backoff, different draws: the two thaw instants must not coincide.
    expect(firstRow?.cooldownUntil).toBeTruthy();
    expect(secondRow?.cooldownUntil).toBeTruthy();
    expect(firstRow?.cooldownUntil).not.toBe(secondRow?.cooldownUntil);
  });

  it('keeps jitter under the operator-configured cooldown ceiling', async () => {
    config.tokenRouterFailureCooldownMaxSec = 20;
    const { channel } = await seedWeightedChannel('jitter-capped');

    const router = new TokenRouter();
    // The maximum draw must still not breach the hard ceiling the operator set.
    tokenRouterTestUtils.setFailureCooldownJitterSource(() => 1);

    const startedAt = Date.now();
    await router.recordFailure(channel.id);
    const row = await db.select().from(schema.routeChannels)
      .where(eq(schema.routeChannels.id, channel.id))
      .get();
    const cooldownMs = Date.parse(String(row?.cooldownUntil || '')) - startedAt;

    expect(cooldownMs).toBeLessThanOrEqual(20_000);
    expect(cooldownMs).toBeGreaterThan(0);
  });

  it('stores an upstream-dictated reset instant verbatim, without jitter', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'jitter-exempt-site',
      url: 'https://jitter-exempt.example.com',
      platform: 'codex',
      status: 'active',
    }).returning().get();

    const resetAt = new Date(Date.now() + 9 * 60 * 1000).toISOString();
    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'jitter-exempt-user',
      accessToken: 'jitter-exempt-access-token',
      status: 'active',
      oauthProvider: 'codex',
      extraConfig: JSON.stringify({
        credentialMode: 'session',
        oauth: {
          provider: 'codex',
          quota: {
            status: 'supported',
            source: 'reverse_engineered',
            lastLimitResetAt: resetAt,
            windows: {},
          },
        },
      }),
    }).returning().get();

    const route = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'gpt-5.4',
      routingStrategy: 'weighted',
      enabled: true,
    }).returning().get();

    const channel = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: account.id,
      priority: 0,
      weight: 10,
      enabled: true,
    }).returning().get();

    const router = new TokenRouter();
    tokenRouterTestUtils.setFailureCooldownJitterSource(() => 1);

    await router.recordFailure(channel.id, {
      status: 429,
      errorText: JSON.stringify({
        error: {
          type: 'usage_limit_reached',
          message: 'The usage limit has been reached',
        },
      }),
      modelName: 'gpt-5.4',
    });

    const row = await db.select().from(schema.routeChannels)
      .where(eq(schema.routeChannels.id, channel.id))
      .get();

    // The provider said when the channel may come back; jitter must not move that instant.
    expect(row?.cooldownUntil).toBe(resetAt);
  });

  it('jitters the short-window fallback when upstream gives no reset timing', async () => {
    const { channel } = await seedWeightedChannel('jitter-short-window');

    const router = new TokenRouter();
    tokenRouterTestUtils.setFailureCooldownJitterSource(() => 1);

    const startedAt = Date.now();
    await router.recordFailure(channel.id, {
      status: 429,
      errorText: JSON.stringify({ error: { message: 'rate limit exceeded' } }),
      modelName: 'gpt-4o-mini',
    });

    const row = await db.select().from(schema.routeChannels)
      .where(eq(schema.routeChannels.id, channel.id))
      .get();
    const cooldownMs = Date.parse(String(row?.cooldownUntil || '')) - startedAt;

    // 5 minute fallback plus the capped spread, not the uncapped 15% of five minutes.
    expect(cooldownMs).toBeGreaterThanOrEqual(5 * 60 * 1000);
    expect(cooldownMs).toBeLessThanOrEqual((5 * 60 * 1000) + JITTER_MAX_MS + 2_000);
  });
});
