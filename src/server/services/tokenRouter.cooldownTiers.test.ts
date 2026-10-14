import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';

type DbModule = typeof import('../db/index.js');
type TokenRouterModule = typeof import('./tokenRouter.js');
type ConfigModule = typeof import('../config.js');

/**
 * Two related cooldown-duration contracts:
 *
 *  - a 429 the upstream scoped to a per-minute window gets a ~30s cooldown, not the
 *    5-minute plan-quota fallback;
 *  - the Fibonacci backoff escalates on the CONSECUTIVE failure streak, so a long-serving
 *    channel is not punished for history it has already recovered from.
 */
describe('cooldown duration tiers', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let TokenRouter: TokenRouterModule['TokenRouter'];
  let tokenRouterTestUtils: TokenRouterModule['__tokenRouterTestUtils'];
  let isChannelRecentlyFailed: TokenRouterModule['isChannelRecentlyFailed'];
  let invalidateTokenRouterCache: TokenRouterModule['invalidateTokenRouterCache'];
  let resetSiteRuntimeHealthState: TokenRouterModule['resetSiteRuntimeHealthState'];
  let config: ConfigModule['config'];
  let dataDir = '';
  let originalFailureCooldownMaxSec = 0;
  let idSeed = 0;

  const nextLabel = (prefix: string) => {
    idSeed += 1;
    return `${prefix}-${idSeed}`;
  };

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-token-router-cooldown-tiers-'));
    process.env.DATA_DIR = dataDir;

    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    const tokenRouterModule = await import('./tokenRouter.js');
    const configModule = await import('../config.js');
    db = dbModule.db;
    schema = dbModule.schema;
    TokenRouter = tokenRouterModule.TokenRouter;
    tokenRouterTestUtils = tokenRouterModule.__tokenRouterTestUtils;
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
    // Pin the jitter to its floor so these assertions are about the TIER, not the spread.
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

  const seedChannel = async (options: {
    platform?: string;
    oauthProvider?: string | null;
    extraConfig?: string | null;
    routingStrategy?: string;
    failCount?: number;
    consecutiveFailCount?: number;
  } = {}) => {
    const label = nextLabel('tier');
    const site = await db.insert(schema.sites).values({
      name: `${label}-site`,
      url: `https://${label}.example.com`,
      platform: options.platform ?? 'new-api',
      status: 'active',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: `${label}-user`,
      accessToken: `${label}-access-token`,
      apiToken: options.oauthProvider ? null : `${label}-api-token`,
      status: 'active',
      ...(options.oauthProvider ? { oauthProvider: options.oauthProvider } : {}),
      ...(options.extraConfig ? { extraConfig: options.extraConfig } : {}),
    }).returning().get();

    const route = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'gpt-4o-mini',
      routingStrategy: options.routingStrategy ?? 'weighted',
      enabled: true,
    }).returning().get();

    const channel = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: account.id,
      priority: 0,
      weight: 10,
      enabled: true,
      ...(options.failCount == null ? {} : { failCount: options.failCount }),
      ...(options.consecutiveFailCount == null ? {} : { consecutiveFailCount: options.consecutiveFailCount }),
    }).returning().get();

    return { site, account, route, channel };
  };

  const recordAndMeasureCooldown = async (
    router: InstanceType<TokenRouterModule['TokenRouter']>,
    channelId: number,
    context?: Parameters<InstanceType<TokenRouterModule['TokenRouter']>['recordFailure']>[1],
  ) => {
    const startedAt = Date.now();
    await router.recordFailure(channelId, context);
    const row = await db.select().from(schema.routeChannels)
      .where(eq(schema.routeChannels.id, channelId))
      .get();
    return {
      row,
      cooldownMs: Date.parse(String(row?.cooldownUntil || '')) - startedAt,
    };
  };

  describe('per-minute rate limits', () => {
    const PER_MINUTE_MS = 30 * 1000;
    const TOLERANCE_MS = 3_000;

    it.each([
      ['requests per minute phrasing', 'Rate limit reached: 20 requests per minute'],
      ['RPM shorthand', 'rate limit exceeded (RPM)'],
      ['TPM shorthand', 'limit reached: TPM quota for this key'],
      ['slash notation', 'rate limit: 60/min exceeded'],
      ['chinese phrasing', '请求过于频繁，已超过每分钟限额'],
    ])('uses the short per-minute tier for %s', async (_label, errorText) => {
      const { channel } = await seedChannel();
      const router = new TokenRouter();

      const { cooldownMs } = await recordAndMeasureCooldown(router, channel.id, {
        status: 429,
        errorText: JSON.stringify({ error: { message: errorText } }),
        modelName: 'gpt-4o-mini',
      });

      expect(cooldownMs).toBeGreaterThan(0);
      expect(cooldownMs).toBeLessThanOrEqual(PER_MINUTE_MS + TOLERANCE_MS);
    });

    it('keeps the 5-minute tier for a limit with no stated window', async () => {
      const { channel } = await seedChannel();
      const router = new TokenRouter();

      const { cooldownMs } = await recordAndMeasureCooldown(router, channel.id, {
        status: 429,
        errorText: JSON.stringify({ error: { message: 'rate limit exceeded' } }),
        modelName: 'gpt-4o-mini',
      });

      // A plan-shaped limit has no minute boundary to wait out, so it keeps the long tier.
      expect(cooldownMs).toBeGreaterThanOrEqual(5 * 60 * 1000);
      expect(cooldownMs).toBeLessThanOrEqual((5 * 60 * 1000) + TOLERANCE_MS);
    });

    it('still prefers an upstream reset hint over the per-minute tier', async () => {
      const { channel } = await seedChannel({
        platform: 'codex',
        oauthProvider: 'codex',
        extraConfig: JSON.stringify({
          credentialMode: 'session',
          oauth: { provider: 'codex' },
        }),
      });
      const router = new TokenRouter();

      // The hint describes THIS failure, so it outranks the per-minute heuristic even when
      // the message also mentions a minute.
      const { cooldownMs } = await recordAndMeasureCooldown(router, channel.id, {
        status: 429,
        errorText: JSON.stringify({
          error: {
            type: 'usage_limit_reached',
            resets_in_seconds: 600,
            message: 'rate limit: 60 requests per minute',
          },
        }),
        modelName: 'gpt-4o-mini',
      });

      expect(cooldownMs).toBeGreaterThanOrEqual(9 * 60 * 1000);
      expect(cooldownMs).toBeLessThanOrEqual(11 * 60 * 1000);
    });

    it('does not park a per-minute throttle on a stale plan-window reset', async () => {
      const staleResetAt = new Date(Date.now() + 5 * 60 * 60 * 1000).toISOString();
      const { channel } = await seedChannel({
        platform: 'codex',
        oauthProvider: 'codex',
        extraConfig: JSON.stringify({
          credentialMode: 'session',
          oauth: {
            provider: 'codex',
            quota: {
              status: 'supported',
              source: 'reverse_engineered',
              lastLimitResetAt: staleResetAt,
              windows: {},
            },
          },
        }),
      });
      const router = new TokenRouter();

      const { cooldownMs } = await recordAndMeasureCooldown(router, channel.id, {
        status: 429,
        errorText: JSON.stringify({ error: { message: 'rate limit exceeded: 60 per minute' } }),
        modelName: 'gpt-4o-mini',
      });

      // The stored reset is a 5h plan window observed earlier; honouring it here would
      // idle the channel for hours over a throttle that clears within the minute.
      expect(cooldownMs).toBeLessThanOrEqual(PER_MINUTE_MS + TOLERANCE_MS);
    });

    it('ignores the per-minute wording on a non-limit failure', async () => {
      const { channel } = await seedChannel();
      const router = new TokenRouter();

      const { row, cooldownMs } = await recordAndMeasureCooldown(router, channel.id, {
        status: 500,
        errorText: 'upstream crashed while enforcing 60 per minute budget',
        modelName: 'gpt-4o-mini',
      });

      // Not a 429, so it takes the ordinary backoff path and counts as a real failure.
      expect(row?.failCount).toBe(1);
      expect(cooldownMs).toBeGreaterThanOrEqual(15_000);
    });
  });

  describe('backoff base', () => {
    it('escalates on the consecutive streak across repeated failures', async () => {
      const { channel } = await seedChannel();
      const router = new TokenRouter();

      // Fibonacci steps off a 15s base: 15, 15, 30, 45 ...
      const first = await recordAndMeasureCooldown(router, channel.id);
      expect(first.row?.consecutiveFailCount).toBe(1);
      expect(first.cooldownMs).toBeGreaterThanOrEqual(15_000);
      expect(first.cooldownMs).toBeLessThan(25_000);

      const second = await recordAndMeasureCooldown(router, channel.id);
      expect(second.row?.consecutiveFailCount).toBe(2);
      expect(second.cooldownMs).toBeGreaterThanOrEqual(15_000);
      expect(second.cooldownMs).toBeLessThan(25_000);

      const third = await recordAndMeasureCooldown(router, channel.id);
      expect(third.row?.consecutiveFailCount).toBe(3);
      expect(third.cooldownMs).toBeGreaterThanOrEqual(30_000);
      expect(third.cooldownMs).toBeLessThan(40_000);

      const fourth = await recordAndMeasureCooldown(router, channel.id);
      expect(fourth.row?.consecutiveFailCount).toBe(4);
      expect(fourth.cooldownMs).toBeGreaterThanOrEqual(45_000);
      expect(fourth.cooldownMs).toBeLessThan(55_000);
    });

    it('does not punish a long-serving channel for history it recovered from', async () => {
      // 57 lifetime failures but no current streak: the old failCount-indexed backoff drew
      // the 30-day ceiling here, taking a healthy workhorse out of rotation for a month.
      const { channel } = await seedChannel({ failCount: 57, consecutiveFailCount: 0 });
      const router = new TokenRouter();

      const { row, cooldownMs } = await recordAndMeasureCooldown(router, channel.id);

      expect(row?.failCount).toBe(58);
      expect(row?.consecutiveFailCount).toBe(1);
      expect(cooldownMs).toBeGreaterThanOrEqual(15_000);
      expect(cooldownMs).toBeLessThan(25_000);
    });

    it('restarts the backoff after a success clears the streak', async () => {
      const { channel } = await seedChannel();
      const router = new TokenRouter();

      await recordAndMeasureCooldown(router, channel.id);
      await recordAndMeasureCooldown(router, channel.id);
      const escalated = await recordAndMeasureCooldown(router, channel.id);
      expect(escalated.cooldownMs).toBeGreaterThanOrEqual(30_000);

      await router.recordSuccess(channel.id, 180, 0.01);
      const afterSuccess = await db.select().from(schema.routeChannels)
        .where(eq(schema.routeChannels.id, channel.id))
        .get();
      expect(afterSuccess?.consecutiveFailCount).toBe(0);

      const restarted = await recordAndMeasureCooldown(router, channel.id);
      expect(restarted.row?.consecutiveFailCount).toBe(1);
      expect(restarted.cooldownMs).toBeGreaterThanOrEqual(15_000);
      expect(restarted.cooldownMs).toBeLessThan(25_000);
    });

    it('sizes the soft-avoidance window from the streak, not the lifetime count', () => {
      const nowMs = Date.now();

      // Streak 4 => a 45s window, so a 40s-old failure is still avoided.
      expect(isChannelRecentlyFailed({
        failCount: 4,
        consecutiveFailCount: 4,
        lastFailAt: new Date(nowMs - 40 * 1000).toISOString(),
      }, nowMs)).toBe(true);

      // Same lifetime count, no active streak => the shortest window, so it is not avoided.
      expect(isChannelRecentlyFailed({
        failCount: 4,
        consecutiveFailCount: 0,
        lastFailAt: new Date(nowMs - 40 * 1000).toISOString(),
      }, nowMs)).toBe(false);
    });

    it('falls back to failCount for a legacy row without a streak column', () => {
      const nowMs = Date.now();

      // A row written before consecutive_fail_count existed keeps the old behaviour
      // instead of silently losing its avoidance window.
      expect(isChannelRecentlyFailed({
        failCount: 4,
        lastFailAt: new Date(nowMs - 40 * 1000).toISOString(),
      }, nowMs)).toBe(true);
    });
  });
});
