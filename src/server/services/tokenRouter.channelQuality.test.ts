import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';

type DbModule = typeof import('../db/index.js');
type TokenRouterModule = typeof import('./tokenRouter.js');
type ConfigModule = typeof import('../config.js');

describe('TokenRouter channel quality telemetry', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let TokenRouter: TokenRouterModule['TokenRouter'];
  let resetSiteRuntimeHealthState: TokenRouterModule['resetSiteRuntimeHealthState'];
  let flushSiteRuntimeHealthPersistence: TokenRouterModule['flushSiteRuntimeHealthPersistence'];
  let invalidateTokenRouterCache: TokenRouterModule['invalidateTokenRouterCache'];
  let config: ConfigModule['config'];
  let dataDir = '';
  let idSeed = 0;
  let originalTimeoutCountsAsChannelFailure: boolean;
  let originalRoutingWeights: typeof config.routingWeights;

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
    invalidateTokenRouterCache = tokenRouterModule.invalidateTokenRouterCache;
    config = configModule.config;
    originalTimeoutCountsAsChannelFailure = config.timeoutCountsAsChannelFailure;
    originalRoutingWeights = { ...config.routingWeights };
  });

  beforeEach(async () => {
    idSeed = 0;
    config.timeoutCountsAsChannelFailure = originalTimeoutCountsAsChannelFailure;
    config.routingWeights = { ...originalRoutingWeights };
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
    config.routingWeights = { ...originalRoutingWeights };
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

  async function createSharedSiteFixture(modelPattern: string, channelCount: number) {
    const route = await db.insert(schema.tokenRoutes).values({
      modelPattern,
      enabled: true,
    }).returning().get();
    const site = await db.insert(schema.sites).values({
      name: `score-site-${nextId()}`,
      url: `https://score-${nextId()}.example.com`,
      platform: 'new-api',
      status: 'active',
    }).returning().get();
    const channels = [];
    for (let index = 0; index < channelCount; index += 1) {
      const account = await db.insert(schema.accounts).values({
        siteId: site.id,
        username: `score-user-${nextId()}`,
        accessToken: `access-${nextId()}`,
        apiToken: `sk-${nextId()}`,
        status: 'active',
      }).returning().get();
      const token = await db.insert(schema.accountTokens).values({
        accountId: account.id,
        name: `score-token-${index}`,
        token: `token-score-${nextId()}`,
        enabled: true,
        isDefault: false,
      }).returning().get();
      channels.push(await db.insert(schema.routeChannels).values({
        routeId: route.id,
        accountId: account.id,
        tokenId: token.id,
        priority: 0,
        weight: 10,
        enabled: true,
      }).returning().get());
    }
    invalidateTokenRouterCache();
    return { route, site, channels };
  }

  it('scores the weighted first-byte component from the channel EMA with site fallback', async () => {
    const { channels } = await createSharedSiteFixture('gpt-cq-score', 3);
    const [slowChannel, fastChannel, quietChannel] = channels;
    const router = new TokenRouter();
    for (let index = 0; index < 12; index += 1) {
      await router.recordSuccess(slowChannel.id, 60000, 0, 'gpt-cq-score', undefined, {
        firstByteLatencyMs: 8000,
        isStream: false,
      });
    }
    for (let index = 0; index < 12; index += 1) {
      await router.recordSuccess(fastChannel.id, 60000, 0, 'gpt-cq-score', undefined, {
        firstByteLatencyMs: 200,
        isStream: false,
      });
    }

    config.routingWeights = {
      baseWeightFactor: 0.3,
      valueScoreFactor: 0.7,
      costWeight: 0,
      balanceWeight: 0,
      usageWeight: 0,
      firstByteWeight: 1,
      speedWeight: 0,
      successWeight: 0,
    };

    const decision = await router.explainSelection('gpt-cq-score');
    const byChannelId = new Map(decision.candidates.map((candidate) => [candidate.channelId, candidate]));
    const slow = byChannelId.get(slowChannel.id)!;
    const fast = byChannelId.get(fastChannel.id)!;
    const quiet = byChannelId.get(quietChannel.id)!;

    // The channel's own EMA drives the component: 8000ms → clamp(2500/8000) = 0.3125,
    // 200ms → saturated 1.0. Site-level scoring would hand both channels the same
    // blended site EMA (~308ms) and equal probabilities.
    expect(fast.probability).toBeGreaterThan(slow.probability);
    expect(slow.reason).toContain('首字=8000ms·通道');
    expect(fast.reason).toContain('首字=200ms·通道');
    // The quiet channel has no samples of its own → site fallback, annotated as such.
    expect(quiet.reason).toContain('首字=');
    expect(quiet.reason).toContain('·站点');
    expect(quiet.reason).not.toContain('·通道');
  });

  it('scores the weighted speed component from the channel tps EMA', async () => {
    const { channels } = await createSharedSiteFixture('gpt-cq-speed', 2);
    const [slowChannel, fastChannel] = channels;
    const router = new TokenRouter();
    for (let index = 0; index < 12; index += 1) {
      await router.recordSuccess(slowChannel.id, 5000, 0, 'gpt-cq-speed', undefined, {
        firstByteLatencyMs: 300,
        completionTokens: 10,
        isStream: true,
      });
    }
    for (let index = 0; index < 12; index += 1) {
      await router.recordSuccess(fastChannel.id, 5000, 0, 'gpt-cq-speed', undefined, {
        firstByteLatencyMs: 300,
        completionTokens: 900,
        isStream: true,
      });
    }

    config.routingWeights = {
      baseWeightFactor: 0.3,
      valueScoreFactor: 0.7,
      costWeight: 0,
      balanceWeight: 0,
      usageWeight: 0,
      firstByteWeight: 0,
      speedWeight: 1,
      successWeight: 0,
    };

    const decision = await router.explainSelection('gpt-cq-speed');
    const byChannelId = new Map(decision.candidates.map((candidate) => [candidate.channelId, candidate]));
    const slow = byChannelId.get(slowChannel.id)!;
    const fast = byChannelId.get(fastChannel.id)!;

    // 10 tokens over a (5000-300)ms window ≈ 2.1tps vs 900 tokens ≈ 191tps (saturated).
    expect(fast.probability).toBeGreaterThan(slow.probability);
    expect(slow.reason).toContain('速度=2.1tps·通道');
    expect(fast.reason).toContain('·通道');
  });

  it('uses the channel lifetime success rate as the weighted SR historical fallback', async () => {
    const { channels } = await createSharedSiteFixture('gpt-cq-sr', 2);
    const [mixedChannel, perfectChannel] = channels;
    await db.update(schema.routeChannels).set({ successCount: 1, failCount: 1 })
      .where(eq(schema.routeChannels.id, mixedChannel.id)).run();
    await db.update(schema.routeChannels).set({ successCount: 3, failCount: 0 })
      .where(eq(schema.routeChannels.id, perfectChannel.id)).run();
    invalidateTokenRouterCache();

    config.routingWeights = {
      baseWeightFactor: 0.3,
      valueScoreFactor: 0.7,
      costWeight: 0,
      balanceWeight: 0,
      usageWeight: 0,
      firstByteWeight: 0,
      speedWeight: 0,
      successWeight: 1,
    };

    const router = new TokenRouter();
    const decision = await router.explainSelection('gpt-cq-sr');
    const byChannelId = new Map(decision.candidates.map((candidate) => [candidate.channelId, candidate]));
    const mixed = byChannelId.get(mixedChannel.id)!;
    const perfect = byChannelId.get(perfectChannel.id)!;

    // Empty recent window → confidence 0 → the blend is pure historical. Channel
    // granularity: mixed shows its own 50%, perfect its own 100% — the site
    // aggregate (4/5 = 80%) would have made both candidates identical.
    expect(mixed.reason).toContain('成功率=50.0%');
    expect(perfect.reason).toContain('成功率=100.0%');
    expect(perfect.probability).toBeGreaterThan(mixed.probability);
  });
});
