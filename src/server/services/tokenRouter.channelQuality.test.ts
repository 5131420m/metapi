import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type DbModule = typeof import('../db/index.js');
type TokenRouterModule = typeof import('./tokenRouter.js');
type ConfigModule = typeof import('../config.js');

describe('TokenRouter channel quality telemetry', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let TokenRouter: TokenRouterModule['TokenRouter'];
  let resetSiteRuntimeHealthState: TokenRouterModule['resetSiteRuntimeHealthState'];
  let flushSiteRuntimeHealthPersistence: TokenRouterModule['flushSiteRuntimeHealthPersistence'];
  let config: ConfigModule['config'];
  let dataDir = '';
  let idSeed = 0;
  let originalTimeoutCountsAsChannelFailure: boolean;

  const nextId = () => {
    idSeed += 1;
    return idSeed;
  };

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-token-router-channel-quality-'));
    process.env.DATA_DIR = dataDir;

    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    const tokenRouterModule = await import('./tokenRouter.js');
    const configModule = await import('../config.js');
    db = dbModule.db;
    schema = dbModule.schema;
    TokenRouter = tokenRouterModule.TokenRouter;
    resetSiteRuntimeHealthState = tokenRouterModule.resetSiteRuntimeHealthState;
    flushSiteRuntimeHealthPersistence = tokenRouterModule.flushSiteRuntimeHealthPersistence;
    config = configModule.config;
    originalTimeoutCountsAsChannelFailure = config.timeoutCountsAsChannelFailure;
  });

  beforeEach(async () => {
    idSeed = 0;
    config.timeoutCountsAsChannelFailure = originalTimeoutCountsAsChannelFailure;
    await db.delete(schema.routeChannels).run();
    await db.delete(schema.tokenRoutes).run();
    await db.delete(schema.settings).run();
    await db.delete(schema.accountTokens).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
    resetSiteRuntimeHealthState();
  });

  afterAll(() => {
    config.timeoutCountsAsChannelFailure = originalTimeoutCountsAsChannelFailure;
    resetSiteRuntimeHealthState();
    delete process.env.DATA_DIR;
  });

  async function createChannelFixture(modelPattern: string, namePrefix: string) {
    const route = await db.insert(schema.tokenRoutes).values({
      modelPattern,
      enabled: true,
    }).returning().get();
    const site = await db.insert(schema.sites).values({
      name: `${namePrefix}-site-${nextId()}`,
      url: `https://${namePrefix}-${nextId()}.example.com`,
      platform: 'new-api',
      status: 'active',
    }).returning().get();
    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: `${namePrefix}-user-${nextId()}`,
      accessToken: `access-${nextId()}`,
      apiToken: `sk-${nextId()}`,
      status: 'active',
    }).returning().get();
    const token = await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: `${namePrefix}-token`,
      token: `token-${namePrefix}-${nextId()}`,
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

  it('accumulates per-channel first-byte and throughput EMAs from successful requests', async () => {
    const { channel } = await createChannelFixture('claude-5-quality', 'cq');
    const router = new TokenRouter();
    for (let index = 0; index < 5; index += 1) {
      await router.recordSuccess(channel.id, 5500, 0, 'claude-5-quality', undefined, {
        firstByteLatencyMs: 400,
        completionTokens: 150,
        isStream: true,
      });
    }

    const snapshots = await router.getChannelQualitySnapshots([channel.id]);
    const quality = snapshots[String(channel.id)];
    expect(quality).toBeTruthy();
    expect(quality.firstByteEmaMs).toBe(400);
    expect(quality.firstByteSampleCount).toBe(5);
    // 150 completion tokens over a (5500 - 400)ms generation window.
    expect(quality.tpsEma).toBeCloseTo((150 * 1000) / 5100, 3);
    expect(quality.tpsSampleCount).toBe(5);
    expect(quality.recentSampleCount).toBeCloseTo(5, 0);
    // Recent-window counts share the quality timescale, not the lifetime counters.
    expect(quality.recentSuccessCount).toBeCloseTo(5, 0);
    expect(quality.recentFailureCount).toBeCloseTo(0, 1);
    // Recent rate is prior-smoothed: (5 successes + 1 prior) / (5 samples + 2 priors).
    expect(quality.recentSuccessRate).toBeCloseTo(6 / 7, 3);
    expect(quality.lastUpdatedAtMs).not.toBeNull();
  });

  it('keeps channel quality independent between two channels of the same site', async () => {
    const first = await createChannelFixture('gpt-cq-split', 'cq-a');
    const second = await createChannelFixture('gpt-cq-split-b', 'cq-b');
    const router = new TokenRouter();
    await router.recordSuccess(first.channel.id, 4000, 0, 'gpt-cq-split', undefined, {
      firstByteLatencyMs: 900,
      isStream: false,
    });
    await router.recordSuccess(second.channel.id, 9000, 0, 'gpt-cq-split-b', undefined, {
      firstByteLatencyMs: 7000,
      isStream: false,
    });
    await router.recordFailure(second.channel.id, {
      status: 500,
      errorText: 'upstream exploded',
    });

    const snapshots = await router.getChannelQualitySnapshots([first.channel.id, second.channel.id]);
    const firstQuality = snapshots[String(first.channel.id)];
    const secondQuality = snapshots[String(second.channel.id)];
    expect(firstQuality.firstByteEmaMs).toBe(900);
    expect(firstQuality.recentSampleCount).toBeCloseTo(1, 0);
    expect(firstQuality.recentSuccessCount).toBeCloseTo(1, 0);
    expect(firstQuality.recentFailureCount).toBeCloseTo(0, 1);
    // (1 + 1 prior success) / (1 + 2 priors).
    expect(firstQuality.recentSuccessRate).toBeCloseTo(2 / 3, 3);
    expect(secondQuality.firstByteEmaMs).toBe(7000);
    expect(secondQuality.recentSampleCount).toBeCloseTo(2, 0);
    expect(secondQuality.recentSuccessCount).toBeCloseTo(1, 0);
    expect(secondQuality.recentFailureCount).toBeCloseTo(1, 0);
    // 1 success + 1 failure -> (1 + 1) / (2 + 2).
    expect(secondQuality.recentSuccessRate).toBeCloseTo(0.5, 3);
    expect(secondQuality.recentSuccessRate).toBeLessThan(firstQuality.recentSuccessRate!);
  });

  it('counts a per-minute usage-limit failure on the channel recent window', async () => {
    const { channel } = await createChannelFixture('gpt-cq-limit', 'cq-limit');
    const router = new TokenRouter();
    await router.recordSuccess(channel.id, 3000, 0, 'gpt-cq-limit', undefined, {
      firstByteLatencyMs: 300,
      isStream: false,
    });
    // 429 naming a per-minute window: the site health deliberately ignores it, but the
    // channel display panel must show it — being throttled is per-credential evidence.
    await router.recordFailure(channel.id, {
      status: 429,
      errorText: 'rate limit exceeded, per minute quota reached',
    });

    const snapshots = await router.getChannelQualitySnapshots([channel.id]);
    const quality = snapshots[String(channel.id)];
    expect(quality.recentSampleCount).toBeCloseTo(2, 0);
    expect(quality.recentSuccessRate).toBeLessThan(0.9);
    expect(quality.recentSuccessRate).toBeGreaterThanOrEqual(0.2);
  });

  it('skips exempt first-byte timeouts in the channel recent window', async () => {
    config.timeoutCountsAsChannelFailure = false;
    const { channel } = await createChannelFixture('gpt-cq-timeout', 'cq-timeout');
    const router = new TokenRouter();
    await router.recordSuccess(channel.id, 3000, 0, 'gpt-cq-timeout', undefined, {
      firstByteLatencyMs: 300,
      isStream: false,
    });
    await router.recordFailure(channel.id, {
      status: 504,
      errorText: 'first byte timeout',
      failureKind: 'first-byte-timeout',
    });

    const snapshots = await router.getChannelQualitySnapshots([channel.id]);
    const quality = snapshots[String(channel.id)];
    expect(quality.recentSampleCount).toBeCloseTo(1, 0);
    // Only the success counts: the exempt timeout is not channel evidence.
    expect(quality.recentSuccessRate).toBeCloseTo(2 / 3, 3);
  });

  it('restores channel quality after a persistence round-trip', async () => {
    const { channel } = await createChannelFixture('gpt-cq-persist', 'cq-persist');
    const router = new TokenRouter();
    for (let index = 0; index < 3; index += 1) {
      await router.recordSuccess(channel.id, 4800, 0, 'gpt-cq-persist', undefined, {
        firstByteLatencyMs: 600,
        completionTokens: 90,
        isStream: true,
      });
    }
    await flushSiteRuntimeHealthPersistence();
    resetSiteRuntimeHealthState();

    const snapshots = await router.getChannelQualitySnapshots([channel.id]);
    const quality = snapshots[String(channel.id)];
    expect(quality.firstByteEmaMs).toBe(600);
    expect(quality.firstByteSampleCount).toBe(3);
    expect(quality.tpsSampleCount).toBe(3);
    expect(quality.recentSampleCount).toBeCloseTo(3, 0);
  });

  it('reports null quality for a channel with no recorded traffic', async () => {
    const { channel } = await createChannelFixture('gpt-cq-empty', 'cq-empty');
    const router = new TokenRouter();
    const snapshots = await router.getChannelQualitySnapshots([channel.id]);
    const quality = snapshots[String(channel.id)];
    expect(quality.firstByteEmaMs).toBeNull();
    expect(quality.tpsEma).toBeNull();
    expect(quality.recentSuccessCount).toBeNull();
    expect(quality.recentFailureCount).toBeNull();
    expect(quality.recentSuccessRate).toBeNull();
    expect(quality.recentSampleCount).toBe(0);
    expect(quality.lastUpdatedAtMs).toBeNull();
  });
});
