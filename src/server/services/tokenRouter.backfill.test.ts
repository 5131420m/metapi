import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';

type DbModule = typeof import('../db/index.js');
type TokenRouterModule = typeof import('./tokenRouter.js');
type LocalTimeModule = typeof import('./localTimeService.js');

describe('TokenRouter runtime-health backfill from proxy logs', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let TokenRouter: TokenRouterModule['TokenRouter'];
  let resetSiteRuntimeHealthState: TokenRouterModule['resetSiteRuntimeHealthState'];
  let flushSiteRuntimeHealthPersistence: TokenRouterModule['flushSiteRuntimeHealthPersistence'];
  let backfillRuntimeHealthFromProxyLogs: TokenRouterModule['backfillRuntimeHealthFromProxyLogs'];
  let formatUtcSqlDateTime: LocalTimeModule['formatUtcSqlDateTime'];
  let dataDir = '';
  let idSeed = 0;

  const nextId = () => {
    idSeed += 1;
    return idSeed;
  };

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-token-router-backfill-'));
    process.env.DATA_DIR = dataDir;

    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    const tokenRouterModule = await import('./tokenRouter.js');
    const localTimeModule = await import('./localTimeService.js');
    db = dbModule.db;
    schema = dbModule.schema;
    TokenRouter = tokenRouterModule.TokenRouter;
    resetSiteRuntimeHealthState = tokenRouterModule.resetSiteRuntimeHealthState;
    flushSiteRuntimeHealthPersistence = tokenRouterModule.flushSiteRuntimeHealthPersistence;
    backfillRuntimeHealthFromProxyLogs = tokenRouterModule.backfillRuntimeHealthFromProxyLogs;
    formatUtcSqlDateTime = localTimeModule.formatUtcSqlDateTime;
  });

  beforeEach(async () => {
    idSeed = 0;
    await db.delete(schema.proxyLogs).run();
    await db.delete(schema.routeChannels).run();
    await db.delete(schema.tokenRoutes).run();
    await db.delete(schema.settings).run();
    await db.delete(schema.accountTokens).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
    resetSiteRuntimeHealthState();
  });

  afterAll(() => {
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

  function insertSuccessLog(input: {
    channelId: number;
    siteId: number;
    accountId: number;
    routeId: number;
    model: string;
    createdAtMs: number;
    latencyMs: number;
    firstByteLatencyMs: number | null;
    completionTokens: number | null;
    isStream: boolean;
  }) {
    // proxy_logs has no site column — the site is derived from the serving account.
    void input.siteId;
    return db.insert(schema.proxyLogs).values({
      routeId: input.routeId,
      channelId: input.channelId,
      accountId: input.accountId,
      siteId: input.siteId,
      modelRequested: input.model,
      modelActual: input.model,
      status: 'success',
      httpStatus: 200,
      latencyMs: input.latencyMs,
      promptTokens: 100,
      completionTokens: input.completionTokens,
      totalTokens: input.completionTokens == null ? null : 100 + input.completionTokens,
      estimatedCost: 0,
      errorMessage: '[usage:upstream]',
      retryCount: 0,
      createdAt: formatUtcSqlDateTime(new Date(input.createdAtMs)),
      isStream: input.isStream,
      firstByteLatencyMs: input.firstByteLatencyMs,
    }).run();
  }

  async function readPersistedPayload() {
    const row = await db.select().from(schema.settings).get();
    expect(row).toBeTruthy();
    return JSON.parse(row!.value as string) as {
      savedAtMs: number;
      globalBySiteId: Record<string, unknown>;
      modelBySiteId: Record<string, Record<string, unknown>>;
      channelById: Record<string, { firstByteEmaMs: number; firstByteSampleCount: number; tpsEma: number | null; tpsSampleCount: number }>;
    };
  }

  it('seeds channel, site and site-model state from recent success logs through the real state math', async () => {
    const { route, site, account, channel } = await createChannelFixture('gpt-bf-seed', 'bf-s');
    const nowMs = Date.now();
    // Two streamed successes, 3h and 2h ago. Both pass all three tps gates.
    await insertSuccessLog({
      channelId: channel.id, siteId: site.id, accountId: account.id, routeId: route.id,
      model: 'gpt-bf-seed', createdAtMs: nowMs - 3 * 3600_000,
      latencyMs: 10_000, firstByteLatencyMs: 1_000, completionTokens: 500, isStream: true,
    });
    await insertSuccessLog({
      channelId: channel.id, siteId: site.id, accountId: account.id, routeId: route.id,
      model: 'gpt-bf-seed', createdAtMs: nowMs - 2 * 3600_000,
      latencyMs: 8_000, firstByteLatencyMs: 2_000, completionTokens: 300, isStream: true,
    });

    const result = await backfillRuntimeHealthFromProxyLogs(nowMs);
    expect(result.skipped).toBe(false);
    expect(result.scannedRows).toBe(2);
    expect(result.seededChannels).toBe(1);
    expect(result.seededSiteModels).toBe(1);

    const router = new TokenRouter();
    const snapshots = await router.getChannelQualitySnapshots([channel.id]);
    const quality = snapshots[String(channel.id)];
    // FB EMA through the real α=0.3 math: 1000 then 1000×0.7 + 2000×0.3.
    expect(quality.firstByteEmaMs).toBe(1300);
    expect(quality.firstByteSampleCount).toBe(2);
    // tps: 500 tokens / 9s then blended with 300 / 6s.
    expect(quality.tpsEma).toBeCloseTo((500 / 9) * 0.7 + (300 / 6) * 0.3, 3);
    expect(quality.tpsSampleCount).toBe(2);
    // Window: one success 3h ago (6 half-lives) + one 2h ago (4 half-lives).
    expect(quality.recentSampleCount).toBeCloseTo(0.5 ** 6 + 0.5 ** 4, 2);

    await flushSiteRuntimeHealthPersistence();
    const payload = await readPersistedPayload();
    expect(payload.channelById[String(channel.id)]).toMatchObject({ firstByteEmaMs: 1300 });
    // Site-global and site×model states were seeded alongside.
    expect(payload.globalBySiteId[String(site.id)]).toBeTruthy();
    expect(Object.keys(payload.modelBySiteId[String(site.id)] ?? {})).toContain('gpt-bf-seed');
  });

  it('seeds nothing when the blob already covers every entity with fresher live state', async () => {
    const { route, site, account, channel } = await createChannelFixture('gpt-bf-fresh', 'bf-f');
    const nowMs = Date.now();
    await insertSuccessLog({
      channelId: channel.id, siteId: site.id, accountId: account.id, routeId: route.id,
      model: 'gpt-bf-fresh', createdAtMs: nowMs - 3600_000,
      latencyMs: 5_000, firstByteLatencyMs: 800, completionTokens: 200, isStream: true,
    });
    // Live traffic AFTER the log row: the blob is fresher than the logs for this
    // channel AND its site/model states — the fill-gaps guard must leave all of it alone.
    const router = new TokenRouter();
    await router.recordSuccess(channel.id, 4_000, 0, 'gpt-bf-fresh', undefined, {
      firstByteLatencyMs: 500,
      isStream: true,
      completionTokens: 400,
    });
    await flushSiteRuntimeHealthPersistence();

    const result = await backfillRuntimeHealthFromProxyLogs(nowMs);
    // The scan ran (logs exist in the window) but found no gaps to fill.
    expect(result.skipped).toBe(false);
    expect(result.scannedRows).toBe(1);
    expect(result.seededChannels).toBe(0);
    expect(result.seededSiteModels).toBe(0);
    // The live-recorded state (higher fidelity) is untouched: one live sample only.
    const snapshots = await router.getChannelQualitySnapshots([channel.id]);
    expect(snapshots[String(channel.id)].firstByteSampleCount).toBe(1);
    expect(snapshots[String(channel.id)].firstByteEmaMs).toBe(500);
  });

  it('fills only the gaps: blob-covered channels keep their live state, uncovered channels get seeded', async () => {
    const covered = await createChannelFixture('gpt-bf-covered', 'bf-c');
    const uncovered = await createChannelFixture('gpt-bf-uncovered', 'bf-u');
    const nowMs = Date.now();
    // Covered channel: live-recorded state (also covers its site and model states).
    const router = new TokenRouter();
    await router.recordSuccess(covered.channel.id, 4_000, 0, 'gpt-bf-covered', undefined, {
      firstByteLatencyMs: 700,
      isStream: true,
      completionTokens: 100,
    });
    await flushSiteRuntimeHealthPersistence();

    // Both channels have log rows; only the uncovered one lacks state.
    for (const [fixture, model] of [[covered, 'gpt-bf-covered'], [uncovered, 'gpt-bf-uncovered']] as const) {
      await insertSuccessLog({
        channelId: fixture.channel.id, siteId: fixture.site.id, accountId: fixture.account.id,
        routeId: fixture.route.id, model, createdAtMs: nowMs - 2 * 3600_000,
        latencyMs: 6_000, firstByteLatencyMs: 900, completionTokens: 240, isStream: true,
      });
    }

    const result = await backfillRuntimeHealthFromProxyLogs(nowMs);
    expect(result.skipped).toBe(false);
    expect(result.seededChannels).toBe(1);

    const snapshots = await router.getChannelQualitySnapshots([covered.channel.id, uncovered.channel.id]);
    // Covered: the live sample survived (1), not inflated by any log replay.
    expect(snapshots[String(covered.channel.id)].firstByteSampleCount).toBe(1);
    expect(snapshots[String(covered.channel.id)].firstByteEmaMs).toBe(700);
    // Uncovered: seeded from its log row.
    expect(snapshots[String(uncovered.channel.id)].firstByteEmaMs).toBe(900);
    expect(snapshots[String(uncovered.channel.id)].firstByteSampleCount).toBe(1);
  });

  it('applies the throughput gates to replayed rows exactly like the live path', async () => {
    const { route, site, account, channel } = await createChannelFixture('gpt-bf-gates', 'bf-g');
    const nowMs = Date.now();
    // One trusted tps row (window 9s) and one pseudo-stream row (window 50ms).
    await insertSuccessLog({
      channelId: channel.id, siteId: site.id, accountId: account.id, routeId: route.id,
      model: 'gpt-bf-gates', createdAtMs: nowMs - 3 * 3600_000,
      latencyMs: 10_000, firstByteLatencyMs: 1_000, completionTokens: 450, isStream: true,
    });
    await insertSuccessLog({
      channelId: channel.id, siteId: site.id, accountId: account.id, routeId: route.id,
      model: 'gpt-bf-gates', createdAtMs: nowMs - 2 * 3600_000,
      latencyMs: 9_050, firstByteLatencyMs: 9_000, completionTokens: 120, isStream: true,
    });

    const result = await backfillRuntimeHealthFromProxyLogs(nowMs);
    expect(result.seededChannels).toBe(1);

    const router = new TokenRouter();
    const snapshots = await router.getChannelQualitySnapshots([channel.id]);
    const quality = snapshots[String(channel.id)];
    // Both rows contribute first-byte evidence…
    expect(quality.firstByteSampleCount).toBe(2);
    // …but only the row with a real generation window contributes throughput.
    expect(quality.tpsSampleCount).toBe(1);
    expect(quality.tpsEma).toBeCloseTo((450 * 1000) / 9_000, 3);
  });

  it('does not resurrect state for channels that no longer exist', async () => {
    const { route, site, account } = await createChannelFixture('gpt-bf-dead', 'bf-d');
    const nowMs = Date.now();
    await insertSuccessLog({
      channelId: 987_654, siteId: site.id, accountId: account.id, routeId: route.id,
      model: 'gpt-bf-dead', createdAtMs: nowMs - 3600_000,
      latencyMs: 5_000, firstByteLatencyMs: 900, completionTokens: 200, isStream: true,
    });

    const result = await backfillRuntimeHealthFromProxyLogs(nowMs);
    expect(result.skipped).toBe(false);
    expect(result.seededChannels).toBe(0);
  });
});
