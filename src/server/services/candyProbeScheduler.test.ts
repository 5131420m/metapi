import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const runChannelCandyProbeMock = vi.hoisted(() => vi.fn());
const isCandyProbeInFlightMock = vi.hoisted(() => vi.fn(() => false));

// The scheduler must reach the upstream ONLY through the probe service; mocking it keeps
// the sweep tests about the scheduling rules, not about HTTP. The real service has its own
// suite. Everything else (the result store, the config) stays real.
vi.mock('./candyProbeService.js', async () => {
  const actual = await vi.importActual<typeof import('./candyProbeService.js')>('./candyProbeService.js');
  return {
    ...actual,
    runChannelCandyProbe: (...args: unknown[]) => runChannelCandyProbeMock(...args),
    isCandyProbeInFlight: (...args: unknown[]) => isCandyProbeInFlightMock(...args),
  };
});

type DbModule = typeof import('../db/index.js');
type SchedulerModule = typeof import('./candyProbeScheduler.js');
type StoreModule = typeof import('./candyProbe/resultStore.js');
type ConfigModule = typeof import('../config.js');
type CandyProbeResult = import('./candyProbe/resultStore.js').CandyProbeResult;

const HOUR_MS = 60 * 60 * 1000;

describe('candyProbeScheduler', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let selectDueCandyTargets: SchedulerModule['selectDueCandyTargets'];
  let loadScheduleCandidateRows: SchedulerModule['loadScheduleCandidateRows'];
  let runCandyProbeSweep: SchedulerModule['runCandyProbeSweep'];
  let resetCandyProbeSchedulerForTests: SchedulerModule['resetCandyProbeSchedulerForTests'];
  let startCandyProbeScheduler: SchedulerModule['startCandyProbeScheduler'];
  let stopCandyProbeScheduler: SchedulerModule['stopCandyProbeScheduler'];
  let resolveCandyProbeScheduleValidityMs: SchedulerModule['resolveCandyProbeScheduleValidityMs'];
  let resolveCandyFailBackoffMs: SchedulerModule['resolveCandyFailBackoffMs'];
  let recordCandyProbeResult: StoreModule['recordCandyProbeResult'];
  let getCandyProbeResultForChannel: StoreModule['getCandyProbeResultForChannel'];
  let getCandyProbeSnapshots: StoreModule['getCandyProbeSnapshots'];
  let resetCandyProbeStoreForTests: StoreModule['resetCandyProbeStoreForTests'];
  let config: ConfigModule['config'];
  let dataDir = '';
  let originalDataDir: string | undefined;
  let originalScheduleConfig: {
    enabled: boolean;
    recheckHours: number;
    maxPerTick: number;
    dailyMaxRuns: number;
  };

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-candy-schedule-'));
    originalDataDir = process.env.DATA_DIR;
    process.env.DATA_DIR = dataDir;

    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    const schedulerModule = await import('./candyProbeScheduler.js');
    const storeModule = await import('./candyProbe/resultStore.js');
    const configModule = await import('../config.js');

    db = dbModule.db;
    schema = dbModule.schema;
    selectDueCandyTargets = schedulerModule.selectDueCandyTargets;
    loadScheduleCandidateRows = schedulerModule.loadScheduleCandidateRows;
    runCandyProbeSweep = schedulerModule.runCandyProbeSweep;
    resetCandyProbeSchedulerForTests = schedulerModule.resetCandyProbeSchedulerForTests;
    startCandyProbeScheduler = schedulerModule.startCandyProbeScheduler;
    stopCandyProbeScheduler = schedulerModule.stopCandyProbeScheduler;
    resolveCandyProbeScheduleValidityMs = schedulerModule.resolveCandyProbeScheduleValidityMs;
    resolveCandyFailBackoffMs = schedulerModule.resolveCandyFailBackoffMs;
    recordCandyProbeResult = storeModule.recordCandyProbeResult;
    getCandyProbeResultForChannel = storeModule.getCandyProbeResultForChannel;
    getCandyProbeSnapshots = storeModule.getCandyProbeSnapshots;
    resetCandyProbeStoreForTests = storeModule.resetCandyProbeStoreForTests;
    config = configModule.config;
    originalScheduleConfig = {
      enabled: config.candyProbeScheduleEnabled,
      recheckHours: config.candyProbeScheduleRecheckHours,
      maxPerTick: config.candyProbeScheduleMaxPerTick,
      dailyMaxRuns: config.candyProbeScheduleDailyMaxRuns,
    };
  });

  beforeEach(async () => {
    runChannelCandyProbeMock.mockReset();
    isCandyProbeInFlightMock.mockReset().mockReturnValue(false);
    resetCandyProbeSchedulerForTests();
    resetCandyProbeStoreForTests();
    config.candyProbeScheduleEnabled = false;
    config.candyProbeScheduleRecheckHours = 12;
    config.candyProbeScheduleMaxPerTick = 1;
    config.candyProbeScheduleDailyMaxRuns = 48;

    await db.delete(schema.routeChannels).run();
    await db.delete(schema.tokenRoutes).run();
    await db.delete(schema.settings).run();
    await db.delete(schema.accountTokens).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
  });

  afterAll(() => {
    config.candyProbeScheduleEnabled = originalScheduleConfig.enabled;
    config.candyProbeScheduleRecheckHours = originalScheduleConfig.recheckHours;
    config.candyProbeScheduleMaxPerTick = originalScheduleConfig.maxPerTick;
    config.candyProbeScheduleDailyMaxRuns = originalScheduleConfig.dailyMaxRuns;
    resetCandyProbeSchedulerForTests();
    // Best-effort: on Windows the SQLite handle is still open at teardown, so removing the
    // temp dir raises EPERM and would fail the whole suite over a scratch directory the
    // OS reclaims anyway.
    try {
      rmSync(dataDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
    if (originalDataDir === undefined) {
      delete process.env.DATA_DIR;
    } else {
      process.env.DATA_DIR = originalDataDir;
    }
  });

  /** Seed one probeable channel; returns the ids the assertions care about. */
  let seedCounter = 0;
  async function seedChannel(input: {
    sourceModel?: string;
    modelPattern?: string;
    channelEnabled?: boolean;
    routeEnabled?: boolean;
    accountStatus?: string;
    siteStatus?: string;
    cooldownUntil?: string | null;
    cooldownSource?: string | null;
    lastSelectedAt?: string | null;
    apiToken?: string;
    sharedAccount?: { siteId: number; accountId: number };
    siteMaxConcurrency?: number;
  } = {}) {
    seedCounter += 1;
    // (platform, url) is unique: every seed gets its own site.
    const seedUrl = `https://candy-schedule-${seedCounter}.example.com`;
    let siteId = input.sharedAccount?.siteId;
    let accountId = input.sharedAccount?.accountId;
    if (siteId === undefined || accountId === undefined) {
      // `max_concurrency` is NOT NULL with a default: only set it when the test asks,
      // or the insert would override the default with an explicit NULL.
      const siteValues: Record<string, unknown> = {
        name: `candy-schedule-site-${seedCounter}`,
        url: seedUrl,
        platform: 'new-api',
        status: input.siteStatus ?? 'active',
      };
      if (input.siteMaxConcurrency !== undefined) {
        siteValues.maxConcurrency = input.siteMaxConcurrency;
      }
      const site = await db.insert(schema.sites).values(siteValues).returning().get();
      const account = await db.insert(schema.accounts).values({
        siteId: site.id,
        username: 'schedule-user',
        accessToken: 'access-schedule',
        apiToken: input.apiToken ?? 'sk-schedule',
        status: input.accountStatus ?? 'active',
      }).returning().get();
      siteId = site.id;
      accountId = account.id;
    }
    const route = await db.insert(schema.tokenRoutes).values({
      modelPattern: input.modelPattern ?? 'gpt-5.4',
      enabled: input.routeEnabled ?? true,
    }).returning().get();
    const channel = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId,
      sourceModel: input.sourceModel ?? 'gpt-5.4',
      enabled: input.channelEnabled ?? true,
      cooldownUntil: input.cooldownUntil ?? null,
      cooldownSource: input.cooldownSource ?? null,
      lastSelectedAt: input.lastSelectedAt ?? null,
    }).returning().get();
    return { siteId: siteId!, accountId: accountId!, routeId: route.id, channelId: channel.id };
  }

  /**
   * A verdict shaped the way the probe records one, for store-driven window tests.
   *
   * `accountId` matters: the selector compares the stored config fingerprint against the
   * channel's current one, and a verdict recorded "against another account" is legitimately
   * treated as never-checked — the window tests would all pass for the wrong reason
   * without it.
   */
  function buildResult(
    channelId: number,
    accountId: number | null,
    overrides: Partial<CandyProbeResult> = {},
  ): CandyProbeResult {
    return {
      channelId,
      routeId: null,
      model: 'gpt-5.4',
      fingerprint: 'generic_openai',
      verdict: 'pass',
      score: 1,
      total: 1,
      endpoint: 'chat',
      actualModel: 'gpt-5.4',
      latencyMs: 100,
      checkedAt: new Date().toISOString(),
      reason: null,
      question: { id: 'candy-bag-reference', prompt: '…', expected: '21' },
      samples: [{ index: 1, answer: '21', correct: true, note: null }],
      validSampleCount: 1,
      expectation: 'expected',
      config: { model: 'gpt-5.4', accountId, tokenId: null },
      trigger: 'schedule',
      failStreak: 0,
      ...overrides,
    };
  }

  /** The lookup seam the pure selector takes: the real store, the mocked in-flight check. */
  const lookup = () => ({
    resultFor: getCandyProbeResultForChannel,
    inFlight: (channelId: number) => isCandyProbeInFlightMock(channelId),
  });

  const loadRows = () => loadScheduleCandidateRows();

  describe('selectDueCandyTargets', () => {
    it('treats a channel with no verdict as due', async () => {
      const { channelId } = await seedChannel();
      const selection = selectDueCandyTargets(await loadRows(), lookup(), Date.now(), { recheckMs: 12 * HOUR_MS, maxTargets: 4 });
      expect(selection.targets.map((target) => target.channelId)).toEqual([channelId]);
    });

    it('leaves small-concurrency sites to real traffic, but probes roomier ones', async () => {
      // A scheduled probe holds a site lease for the whole exchange; on a 1-2 slot site
      // that is half or all of the site's real capacity. The schedule skips those sites
      // entirely — a manual click still probes them.
      const { channelId: tiny } = await seedChannel({ siteMaxConcurrency: 1 });
      const { channelId: small } = await seedChannel({ siteMaxConcurrency: 2 });
      const { channelId: roomy } = await seedChannel({ siteMaxConcurrency: 3 });
      const { channelId: unbounded } = await seedChannel();

      const selection = selectDueCandyTargets(await loadRows(), lookup(), Date.now(), { recheckMs: 12 * HOUR_MS, maxTargets: 8 });
      expect(selection.targets.map((target) => target.channelId).sort((left, right) => left - right))
        .toEqual([roomy, unbounded].sort((left, right) => left - right));
      expect(selection.targets.map((target) => target.channelId)).not.toContain(tiny);
      expect(selection.targets.map((target) => target.channelId)).not.toContain(small);
    });

    it('keeps a fresh pass verdict off the list until the recheck window elapses', async () => {
      const { channelId, accountId } = await seedChannel();
      const now = Date.now();
      recordCandyProbeResult(buildResult(channelId, accountId, {
        verdict: 'pass',
        checkedAt: new Date(now - (12 * HOUR_MS - 10 * 60_000)).toISOString(),
      }));
      const fresh = selectDueCandyTargets(await loadRows(), lookup(), now, { recheckMs: 12 * HOUR_MS, maxTargets: 4 });
      expect(fresh.targets).toHaveLength(0);

      recordCandyProbeResult(buildResult(channelId, accountId, {
        checkedAt: new Date(now - 12 * HOUR_MS).toISOString(),
      }));
      const due = selectDueCandyTargets(await loadRows(), lookup(), now, { recheckMs: 12 * HOUR_MS, maxTargets: 4 });
      expect(due.targets.map((target) => target.channelId)).toEqual([channelId]);
    });

    it('rechecks a fail verdict sooner than a pass, but never below an hour', async () => {
      const { channelId, accountId } = await seedChannel();
      const now = Date.now();
      // 30 minutes old: below the one-hour floor, so not due yet even for a fail.
      recordCandyProbeResult(buildResult(channelId, accountId, {
        verdict: 'fail',
        failStreak: 1,
        checkedAt: new Date(now - 30 * 60_000).toISOString(),
      }));
      const tooSoon = selectDueCandyTargets(await loadRows(), lookup(), now, { recheckMs: 12 * HOUR_MS, maxTargets: 4 });
      expect(tooSoon.targets).toHaveLength(0);

      // 4 hours old: past the first-fail window (3h), so due.
      recordCandyProbeResult(buildResult(channelId, accountId, {
        verdict: 'fail',
        failStreak: 1,
        checkedAt: new Date(now - 4 * HOUR_MS).toISOString(),
      }));
      const due = selectDueCandyTargets(await loadRows(), lookup(), now, { recheckMs: 12 * HOUR_MS, maxTargets: 4 });
      expect(due.targets.map((target) => target.channelId)).toEqual([channelId]);
    });

    it('backs off exponentially while a channel keeps failing', async () => {
      const { channelId, accountId } = await seedChannel();
      const now = Date.now();
      // 4 hours old. First failure (streak 1): window 3h → due. Third failure (streak 3):
      // window 12h → not yet. A fixed 3h window would have retested it 8 times a day.
      recordCandyProbeResult(buildResult(channelId, accountId, {
        verdict: 'fail',
        failStreak: 3,
        checkedAt: new Date(now - 4 * HOUR_MS).toISOString(),
      }));
      const selection = selectDueCandyTargets(await loadRows(), lookup(), now, { recheckMs: 12 * HOUR_MS, maxTargets: 4 });
      expect(selection.targets).toHaveLength(0);
    });

    it('treats a verdict recorded against a different config as never checked', async () => {
      const { channelId, accountId } = await seedChannel();
      const now = Date.now();
      // Fresh verdict, but measured against a different model: the honest state for the
      // current channel is "unknown", not "checked a minute ago".
      recordCandyProbeResult(buildResult(channelId, accountId, {
        checkedAt: new Date(now - 60_000).toISOString(),
        config: { model: 'gpt-4.1', accountId, tokenId: null },
      }));
      const selection = selectDueCandyTargets(await loadRows(), lookup(), now, { recheckMs: 12 * HOUR_MS, maxTargets: 4 });
      expect(selection.targets.map((target) => target.channelId)).toEqual([channelId]);
      expect(selection.targets[0]?.checkedAtMs).toBeNull();
    });

    it('skips a channel in a provider-directed cooldown, but not one in our own backoff', async () => {
      const now = Date.now();
      await seedChannel({
        cooldownUntil: new Date(now + 30 * 60_000).toISOString(),
        cooldownSource: 'provider_quota',
      });
      const backoff = await seedChannel({
        cooldownUntil: new Date(now + 30 * 60_000).toISOString(),
        cooldownSource: 'metapi_backoff',
      });
      const selection = selectDueCandyTargets(await loadRows(), lookup(), now, { recheckMs: 12 * HOUR_MS, maxTargets: 4 });
      expect(selection.targets.map((target) => target.channelId)).toEqual([backoff.channelId]);
    });

    it('skips a channel whose probe is already in flight', async () => {
      const busy = await seedChannel();
      const idle = await seedChannel();
      isCandyProbeInFlightMock.mockImplementation((channelId: number) => channelId === busy.channelId);
      const selection = selectDueCandyTargets(await loadRows(), lookup(), Date.now(), { recheckMs: 12 * HOUR_MS, maxTargets: 4 });
      expect(selection.targets.map((target) => target.channelId)).toEqual([idle.channelId]);
    });

    it('skips non-conversation models, disabled rows and credential-less channels', async () => {
      const embedding = await seedChannel({ sourceModel: 'text-embedding-3-small' });
      const disabled = await seedChannel({ channelEnabled: false });
      const disabledRoute = await seedChannel({ routeEnabled: false });
      const disabledAccount = await seedChannel({ accountStatus: 'disabled' });
      const noCredential = await seedChannel({ apiToken: '' });
      const healthy = await seedChannel();
      const selection = selectDueCandyTargets(await loadRows(), lookup(), Date.now(), { recheckMs: 12 * HOUR_MS, maxTargets: 8 });
      const ids = selection.targets.map((target) => target.channelId);
      expect(ids).toEqual([healthy.channelId]);
      for (const skipped of [embedding, disabled, disabledRoute, disabledAccount, noCredential]) {
        expect(ids).not.toContain(skipped.channelId);
      }
    });

    it('runs the channel that carried traffic first, then the stalest', async () => {
      const now = Date.now();
      const hot = await seedChannel({ lastSelectedAt: new Date(now - HOUR_MS).toISOString() });
      const stale = await seedChannel({ lastSelectedAt: null });
      const fresh = await seedChannel({ lastSelectedAt: null });
      recordCandyProbeResult(buildResult(fresh.channelId, fresh.accountId, {
        // Past the 12h recheck window, so due — but "checked 13h ago" sorts after the
        // never-checked channels, which is the ordering this test pins.
        checkedAt: new Date(now - 13 * HOUR_MS).toISOString(),
      }));
      const selection = selectDueCandyTargets(await loadRows(), lookup(), now, { recheckMs: 12 * HOUR_MS, maxTargets: 3 });
      expect(selection.targets.map((target) => target.channelId))
        .toEqual([hot.channelId, stale.channelId, fresh.channelId]);
    });

    it('dedupes by upstream identity and reports the siblings for the fan-out', async () => {
      // Two channels over the same account token and model: one request upstream.
      const shared = await seedChannel();
      const sibling = await seedChannel({
        modelPattern: 'gpt-*',
        sharedAccount: { siteId: shared.siteId, accountId: shared.accountId },
      });
      const other = await seedChannel();
      const selection = selectDueCandyTargets(await loadRows(), lookup(), Date.now(), { recheckMs: 12 * HOUR_MS, maxTargets: 4 });
      expect(selection.targets).toHaveLength(2);
      const representative = selection.targets[0]!;
      expect(representative.channelId).toBe(shared.channelId);
      expect(selection.siblingsByChannelId.get(representative.channelId))
        .toEqual([{ channelId: sibling.channelId, routeId: sibling.routeId }]);
      expect(selection.siblingsByChannelId.get(other.channelId)).toEqual([]);
    });

    it('caps the targets per tick, but the fan-out still covers capped siblings', async () => {
      const shared = await seedChannel();
      const sibling = await seedChannel({
        modelPattern: 'gpt-*',
        sharedAccount: { siteId: shared.siteId, accountId: shared.accountId },
      });
      await seedChannel();
      const selection = selectDueCandyTargets(await loadRows(), lookup(), Date.now(), { recheckMs: 12 * HOUR_MS, maxTargets: 1 });
      expect(selection.targets).toHaveLength(1);
      expect(selection.targets[0]!.channelId).toBe(shared.channelId);
      expect(selection.siblingsByChannelId.get(shared.channelId))
        .toEqual([{ channelId: sibling.channelId, routeId: sibling.routeId }]);
    });
  });

  describe('fail backoff', () => {
    it('scales the recheck window exponentially with the consecutive-fail streak', () => {
      const twelveHours = 12 * HOUR_MS;
      // The reviewer's requested shape: 3h → 6h → 12h, capped at the regular window.
      expect(resolveCandyFailBackoffMs(twelveHours, 1)).toBe(3 * HOUR_MS);
      expect(resolveCandyFailBackoffMs(twelveHours, 2)).toBe(6 * HOUR_MS);
      expect(resolveCandyFailBackoffMs(twelveHours, 3)).toBe(12 * HOUR_MS);
      expect(resolveCandyFailBackoffMs(twelveHours, 50)).toBe(12 * HOUR_MS);
      // Rows persisted before the streak existed read back as 0: behave like a first fail.
      expect(resolveCandyFailBackoffMs(twelveHours, 0)).toBe(3 * HOUR_MS);
      // A one-hour cadence: the floor and the cap collapse onto the window itself.
      expect(resolveCandyFailBackoffMs(HOUR_MS, 9)).toBe(HOUR_MS);
    });
  });

  describe('runCandyProbeSweep', () => {
    it('probes the due channel and copies the verdict to its identity siblings', async () => {
      const shared = await seedChannel();
      const sibling = await seedChannel({
        modelPattern: 'gpt-*',
        sharedAccount: { siteId: shared.siteId, accountId: shared.accountId },
      });
      // The mocked run mirrors the real one: it records its own verdict and returns it.
      runChannelCandyProbeMock.mockImplementation(async (input: { channelId: number }) => {
        const result = buildResult(input.channelId, shared.accountId, { routeId: shared.routeId });
        recordCandyProbeResult(result);
        return result;
      });

      await runCandyProbeSweep();

      expect(runChannelCandyProbeMock).toHaveBeenCalledTimes(1);
      expect(runChannelCandyProbeMock).toHaveBeenCalledWith(expect.objectContaining({
        channelId: shared.channelId,
        trigger: 'schedule',
      }));
      const snapshots = getCandyProbeSnapshots([shared.channelId, sibling.channelId]);
      expect(snapshots[String(shared.channelId)]?.verdict).toBe('pass');
      // The sibling never ran; its verdict is the identity's, with its own ids.
      const copied = snapshots[String(sibling.channelId)];
      expect(copied?.verdict).toBe('pass');
      expect(copied?.trigger).toBe('schedule');
      expect(copied?.question.id).toBe('candy-bag-reference');
    });

    it('respects the rolling daily ceiling', async () => {
      await seedChannel();
      await seedChannel();
      config.candyProbeScheduleMaxPerTick = 4;
      config.candyProbeScheduleDailyMaxRuns = 1;
      runChannelCandyProbeMock.mockImplementation(async (input: { channelId: number }) => {
        recordCandyProbeResult(buildResult(input.channelId, null));
        return buildResult(input.channelId, null);
      });

      await runCandyProbeSweep();

      // Two identities were due and the tick allows four; the daily ceiling stops the second.
      expect(runChannelCandyProbeMock).toHaveBeenCalledTimes(1);
    });

    it('is single-flight: a second sweep while one runs does nothing', async () => {
      await seedChannel();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      runChannelCandyProbeMock.mockImplementation(async () => {
        await gate;
        return buildResult(0, null);
      });

      const first = runCandyProbeSweep();
      // The sweep reaches the probe only after its candidate load; wait until the gated
      // probe really is in flight before firing the second sweep at it.
      await vi.waitFor(() => {
        expect(runChannelCandyProbeMock).toHaveBeenCalledTimes(1);
      });
      const second = runCandyProbeSweep();
      await second;
      expect(runChannelCandyProbeMock).toHaveBeenCalledTimes(1);
      release();
      await first;
      expect(runChannelCandyProbeMock).toHaveBeenCalledTimes(1);
    });

    it('swallows a failing run and keeps the sweep alive', async () => {
      await seedChannel();
      runChannelCandyProbeMock.mockRejectedValue(new Error('upstream exploded'));
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

      await expect(runCandyProbeSweep()).resolves.toBeUndefined();

      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
    });
  });

  describe('scheduler lifecycle', () => {
    it('aligns the freshness TTL with the recheck cadence on start, and restores the default on stop', async () => {
      const { channelId } = await seedChannel();
      recordCandyProbeResult(buildResult(channelId, null, { checkedAt: new Date().toISOString() }));

      config.candyProbeScheduleRecheckHours = 12;
      startCandyProbeScheduler(60_000);
      const scheduled = getCandyProbeSnapshots([channelId])[String(channelId)]!;
      const scheduledTtl = Date.parse(scheduled.expiresAt) - Date.parse(scheduled.checkedAt);
      expect(scheduledTtl).toBe(resolveCandyProbeScheduleValidityMs(12 * HOUR_MS));
      expect(scheduledTtl).toBeGreaterThan(12 * HOUR_MS);

      stopCandyProbeScheduler();
      const manual = getCandyProbeSnapshots([channelId])[String(channelId)]!;
      expect(Date.parse(manual.expiresAt) - Date.parse(manual.checkedAt)).toBe(60 * 60 * 1000);
    });
  });
});
