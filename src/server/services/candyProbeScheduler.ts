/**
 * Candy-probe schedule: the "who gets refreshed while nobody is clicking" side.
 *
 * A manual probe answers "is this channel degraded RIGHT NOW, on demand". The schedule
 * answers the same question continuously, at a cost the operator chose: default OFF, at
 * most `candyProbeScheduleMaxPerTick` channels per tick, at most
 * `candyProbeScheduleDailyMaxRuns` runs per rolling 24h, and never a second run for one
 * upstream identity while a first would do.
 *
 * The octopus lessons this carries:
 *
 * - coverage must be amortized, not burst: one channel per tick, oldest-verdict-first, so
 *   a schedule cannot look like a bulk health check to a quota-limited upstream;
 * - a verdict's validity is tied to the recheck cadence, not to a flat constant (see
 *   `resolveCandyProbeScheduleValidityMs` + the store's freshness TTL);
 * - a fail/inconclusive verdict deserves a sooner recheck than a pass — but with backoff,
 *   or one bad channel would eat the whole daily ceiling.
 *
 * Boundaries: this module itself writes no routing state. It reads route-channel rows,
 * calls `runChannelCandyProbe` and writes verdict copies into the candy result store.
 * The probe REQUEST is a real request, though: it goes through the site API endpoint
 * pool, so it records endpoint success/failure in the pool's state and holds a site
 * concurrency lease for the exchange. The verdict still never feeds channel routing,
 * health or cooldowns — the architecture test in this directory keeps that executable.
 */

import { and, eq, isNull, or } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { config } from '../config.js';
import { CANDY_PROBE_MAX_TIMEOUT_MS } from '../../shared/candyProbe.js';
import { isCandyProbeInFlight, runChannelCandyProbe } from './candyProbeService.js';
import {
  candyProbeConfigMatches,
  getCandyProbeResultForChannel,
  getCandyProbeStoreGeneration,
  recordCandyProbeResultForChannels,
  setCandyProbeFreshTtlMs,
  type CandyProbeConfigFingerprint,
  type CandyProbeResult,
} from './candyProbe/resultStore.js';
import {
  isChannelProbeApplicable,
  resolveProbeModelName,
  resolveProbeTokenValue,
} from './channelProbeContext.js';
import { isProviderDirectedCooldown } from './tokenRouter.js';

/** A channel counts as "carrying traffic" for this long after its last selection. */
const CANDY_SCHEDULE_HOT_WINDOW_MS = 24 * 60 * 60 * 1000;
/**
 * Sites at or below this site concurrency limit are left alone by the SCHEDULE. A probe
 * holds a site lease for the whole exchange — a thinking model can take minutes — and on
 * a 1-2 slot site that is half or all of the site's real capacity. `0`/unset means the
 * site has no lease gate at all, so it is fine. Manual clicks are unaffected.
 */
const CANDY_SCHEDULE_MIN_SITE_CONCURRENCY = 3;
/**
 * Sooner recheck for a bad verdict — a degraded channel is worth confirming before the
 * next regular round — but never shorter than this, or one bad channel would burn the
 * daily ceiling on its own.
 */
const CANDY_SCHEDULE_FAIL_RECHECK_MS = 60 * 60 * 1000;
/** The daily ceiling counts runs started in this window. */
const CANDY_SCHEDULE_DAILY_WINDOW_MS = 24 * 60 * 60 * 1000;

/** The joined channel row the sweep reads; same shape the manual probe and the recovery probe join. */
export type CandyScheduleCandidateRow = {
  route_channels: typeof schema.routeChannels.$inferSelect;
  token_routes: typeof schema.tokenRoutes.$inferSelect;
  accounts: typeof schema.accounts.$inferSelect;
  sites: typeof schema.sites.$inferSelect;
  account_tokens: typeof schema.accountTokens.$inferSelect | null;
};

/** One channel chosen to run this tick. */
export type CandyScheduleTarget = {
  channelId: number;
  routeId: number;
  accountId: number;
  tokenId: number | null;
  model: string;
  siteName: string;
  /** When this identity's verdict was last checked; null when it never was (or no longer matches). */
  checkedAtMs: number | null;
  /** When the channel was last selected for real traffic; null when it never was. */
  lastSelectedAtMs: number | null;
};

/** What one run answers for: the inputs a candy verdict depends on, and nothing else. */
export type CandyScheduleIdentity = {
  accountId: number;
  tokenId: number | null;
  model: string;
};

export type CandyScheduleSelection = {
  /** Representatives chosen to run this tick, in run order. */
  targets: CandyScheduleTarget[];
  /**
   * For each representative channelId, the OTHER due channels that share its upstream
   * identity. One run answers for all of them; the sweep copies the verdict over rather
   * than paying for the same upstream request twice.
   */
  siblingsByChannelId: Map<number, Array<{ channelId: number; routeId: number }>>;
};

/** Seams so the pure selector can be tested without a database or the service module. */
export type CandyScheduleLookup = {
  resultFor: (channelId: number) => CandyProbeResult | null;
  inFlight: (channelId: number) => boolean;
};

function buildIdentityKey(identity: CandyScheduleIdentity): string {
  return `${identity.accountId}|${identity.tokenId ?? ''}|${identity.model}`;
}

function parseIsoOrNull(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

/** The recheck cadence from the settings-visible hours knob. */
export function resolveCandyProbeRecheckMs(): number {
  return Math.max(1, Math.trunc(config.candyProbeScheduleRecheckHours)) * 60 * 60 * 1000;
}

/**
 * How long a verdict stays fresh once the schedule runs.
 *
 * `recheck + recheck/4 + one run's ceiling`: the whole recheck window, plus a quarter for
 * tick cadence, plus the time one run may legally take. A flat 1h TTL beside a 12h recheck
 * would blank badges for most of the interval — the octopus lesson was exactly that a
 * freshness constant only works while the interval happens to equal it.
 */
export function resolveCandyProbeScheduleValidityMs(recheckMs: number): number {
  const safeRecheckMs = Math.max(1, Math.trunc(recheckMs));
  return safeRecheckMs + Math.trunc(safeRecheckMs / 4) + CANDY_PROBE_MAX_TIMEOUT_MS;
}

/**
 * Recheck backoff for a bad verdict, exponential in the consecutive-fail streak.
 *
 * With the default 12h cadence: 3h → 6h → 12h, capped at the regular window. A fixed 3h
 * meant a few permanently broken channels retested 8 times a day each — enough to eat the
 * whole daily ceiling and starve every other channel of coverage.
 */
export function resolveCandyFailBackoffMs(recheckMs: number, failStreak: number): number {
  const safeRecheckMs = Math.max(1, Math.trunc(recheckMs));
  const base = Math.max(CANDY_SCHEDULE_FAIL_RECHECK_MS, Math.trunc(safeRecheckMs / 4));
  const streak = Number.isFinite(failStreak) && failStreak >= 1 ? Math.trunc(failStreak) : 1;
  return Math.min(safeRecheckMs, base * 2 ** Math.min(streak - 1, 10));
}

/**
 * Which channels a tick should run, in order — the whole scheduling decision in one pure
 * function, so every rule below has a test rather than a hope.
 */
export function selectDueCandyTargets(
  rows: CandyScheduleCandidateRow[],
  lookup: CandyScheduleLookup,
  nowMs: number,
  options: { recheckMs: number; maxTargets: number },
): CandyScheduleSelection {
  const due: CandyScheduleTarget[] = [];
  for (const row of rows) {
    if (row.route_channels.enabled !== true) continue;
    if (row.token_routes.enabled !== true) continue;
    if ((row.accounts.status || 'active') !== 'active') continue;
    if ((row.sites.status || 'active') !== 'active') continue;

    // Small-concurrency sites have no room for background work: the probe would hold one
    // of the site's 1-2 slots for a whole exchange, making real requests queue behind an
    // unattended sweep. Manual clicks still probe them; the schedule just leaves them be.
    const siteMaxConcurrency = Number(row.sites.maxConcurrency ?? 0);
    if (siteMaxConcurrency > 0 && siteMaxConcurrency < CANDY_SCHEDULE_MIN_SITE_CONCURRENCY) continue;

    const channelId = row.route_channels.id;
    if (!Number.isFinite(channelId) || channelId <= 0) continue;

    const model = resolveProbeModelName(row);
    if (!model) continue;
    if (!isChannelProbeApplicable({
      sourceModel: row.route_channels.sourceModel,
      modelPattern: row.token_routes.modelPattern,
    })) continue;
    if (!resolveProbeTokenValue(row)) continue;

    // A provider-directed cooldown is the upstream's own window (a 429 with a reset hint).
    // Probing before it expires cannot succeed and reads as abuse — the same rule the
    // recovery probe applies when it decides what to leave alone.
    if (isProviderDirectedCooldown(row.route_channels)) continue;

    // A manual click (or the previous tick's run) still in flight: the single-flight map
    // would only collapse identical parameters, so skip here and cover every shape.
    if (lookup.inFlight(channelId)) continue;

    const currentConfig: CandyProbeConfigFingerprint = {
      model,
      accountId: row.accounts.id ?? null,
      tokenId: row.route_channels.tokenId ?? null,
    };
    const stored = lookup.resultFor(channelId);
    let checkedAtMs: number | null = null;
    if (stored && candyProbeConfigMatches(stored.config, currentConfig)) {
      // A verdict recorded against a different model or credential is not this channel's
      // verdict: the honest state is "never checked", not "checked N hours ago".
      checkedAtMs = parseIsoOrNull(stored.checkedAt);
      if (checkedAtMs !== null) {
        // A bad verdict deserves a sooner recheck than a pass — with EXPONENTIAL backoff
        // in the consecutive-fail streak, so a permanently broken channel still gets
        // checked without eating the daily ceiling 8 times a day.
        const windowMs = stored.verdict === 'pass'
          ? Math.max(1, Math.trunc(options.recheckMs))
          : resolveCandyFailBackoffMs(options.recheckMs, stored.failStreak ?? 1);
        if (nowMs - checkedAtMs < windowMs) continue;
      }
    }

    due.push({
      channelId,
      routeId: row.route_channels.routeId,
      accountId: row.accounts.id ?? -1,
      tokenId: row.route_channels.tokenId ?? null,
      model,
      siteName: String(row.sites.name ?? ''),
      checkedAtMs,
      lastSelectedAtMs: parseIsoOrNull(row.route_channels.lastSelectedAt),
    });
  }

  // Channels that carried real traffic get their verdicts refreshed first — those are the
  // badges a user is actually reading. Within each group the stalest (or never-checked)
  // come first, so coverage rotates fairly instead of always re-testing the same head.
  due.sort((left, right) => {
    const leftHot = left.lastSelectedAtMs !== null && nowMs - left.lastSelectedAtMs <= CANDY_SCHEDULE_HOT_WINDOW_MS;
    const rightHot = right.lastSelectedAtMs !== null && nowMs - right.lastSelectedAtMs <= CANDY_SCHEDULE_HOT_WINDOW_MS;
    if (leftHot !== rightHot) return leftHot ? -1 : 1;
    const leftChecked = left.checkedAtMs ?? 0;
    const rightChecked = right.checkedAtMs ?? 0;
    if (leftChecked !== rightChecked) return leftChecked - rightChecked;
    return left.channelId - right.channelId;
  });

  // One run per upstream identity: a wildcard route and an exact route over the same
  // account token and model are one request to the upstream, and the verdict for one is
  // the verdict for both.
  const seenIdentities = new Set<string>();
  const targets: CandyScheduleTarget[] = [];
  const siblingsByChannelId = new Map<number, Array<{ channelId: number; routeId: number }>>();
  const identityMembers = new Map<string, CandyScheduleTarget[]>();
  for (const target of due) {
    const identityKey = buildIdentityKey(target);
    const members = identityMembers.get(identityKey) ?? [];
    members.push(target);
    identityMembers.set(identityKey, members);
    if (seenIdentities.has(identityKey)) continue;
    seenIdentities.add(identityKey);
    if (targets.length < Math.max(1, Math.trunc(options.maxTargets))) {
      targets.push(target);
      siblingsByChannelId.set(target.channelId, []);
    }
  }
  // The fan-out list per representative: the identity's other due channels (they may sit
  // beyond the tick cap — copying a verdict costs nothing, running it twice does).
  for (const target of targets) {
    const members = identityMembers.get(buildIdentityKey(target)) ?? [];
    siblingsByChannelId.set(
      target.channelId,
      members
        .filter((member) => member.channelId !== target.channelId)
        .map((member) => ({ channelId: member.channelId, routeId: member.routeId })),
    );
  }
  return { targets, siblingsByChannelId };
}

/**
 * The sweep's candidate query — exported because it is also the honest way for tests to
 * feed the pure selector: hand-built rows would drift from the real join the moment a
 * filter here changes.
 */
export async function loadScheduleCandidateRows(): Promise<CandyScheduleCandidateRow[]> {
  return await db.select()
    .from(schema.routeChannels)
    .innerJoin(schema.accounts, eq(schema.routeChannels.accountId, schema.accounts.id))
    .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
    .innerJoin(schema.tokenRoutes, eq(schema.routeChannels.routeId, schema.tokenRoutes.id))
    .leftJoin(schema.accountTokens, eq(schema.routeChannels.tokenId, schema.accountTokens.id))
    .where(and(
      eq(schema.routeChannels.enabled, true),
      eq(schema.tokenRoutes.enabled, true),
      // NULL status reads as active, same as the selector: legacy rows must not vanish here.
      or(isNull(schema.accounts.status), eq(schema.accounts.status, 'active')),
      or(isNull(schema.sites.status), eq(schema.sites.status, 'active')),
    ))
    .all();
}

let schedulerTimer: ReturnType<typeof setInterval> | null = null;
let sweepInFlight: Promise<void> | null = null;
/** Start timestamps (ms) of scheduled runs inside the daily window; the ceiling is a cost guard. */
const recentRunStarts: number[] = [];

function shouldUnrefTimer(timer: ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>): void {
  if (typeof (timer as { unref?: () => void }).unref === 'function') {
    (timer as { unref: () => void }).unref();
  }
}

function pruneRecentRunStarts(nowMs: number): void {
  while (recentRunStarts.length > 0 && nowMs - (recentRunStarts[0] ?? 0) > CANDY_SCHEDULE_DAILY_WINDOW_MS) {
    recentRunStarts.shift();
  }
}

/**
 * One sweep: pick the due channels, run at most `maxPerTick` of them serially, copy each
 * verdict to its identity siblings. Everything that can go wrong here is logged and
 * swallowed — a failed sweep must never take the process or the tick loop down.
 */
export async function runCandyProbeSweep(nowMs = Date.now()): Promise<void> {
  if (sweepInFlight) return;
  sweepInFlight = (async () => {
    try {
      pruneRecentRunStarts(nowMs);
      if (recentRunStarts.length >= config.candyProbeScheduleDailyMaxRuns) return;

      // Taken BEFORE the candidate load awaits: a factory reset / backup import during the
      // load would otherwise hand the fan-out a sibling list from the old database, and the
      // copies would land on whatever now carries those channel ids.
      const storeGeneration = getCandyProbeStoreGeneration();
      const rows = await loadScheduleCandidateRows();
      const selection = selectDueCandyTargets(
        rows,
        { resultFor: getCandyProbeResultForChannel, inFlight: isCandyProbeInFlight },
        nowMs,
        {
          recheckMs: resolveCandyProbeRecheckMs(),
          maxTargets: config.candyProbeScheduleMaxPerTick,
        },
      );
      if (selection.targets.length <= 0) return;
      for (const target of selection.targets) {
        pruneRecentRunStarts(Date.now());
        if (recentRunStarts.length >= config.candyProbeScheduleDailyMaxRuns) {
          console.info('[candy-schedule] 已达每日巡检上限，剩余通道顺延到下个窗口');
          break;
        }
        recentRunStarts.push(Date.now());
        try {
          const result = await runChannelCandyProbe({
            channelId: target.channelId,
            trigger: 'schedule',
          });
          const siblings = selection.siblingsByChannelId.get(target.channelId) ?? [];
          const copied = recordCandyProbeResultForChannels(result, siblings, storeGeneration);
          console.info(
            `[candy-schedule] 通道 ${target.channelId}（${target.model} @ ${target.siteName}）`
            + `${result.verdict}`
            + `${copied > 0 ? `，同步 ${copied} 条同身份通道` : ''}`,
          );
        } catch (error) {
          console.warn(`[candy-schedule] 通道 ${target.channelId} 巡检失败：${(error as Error)?.message || 'unknown'}`);
        }
      }
    } catch (error) {
      console.warn('[candy-schedule] sweep failed', error);
    } finally {
      sweepInFlight = null;
    }
  })();
  await sweepInFlight;
}

export function startCandyProbeScheduler(tickMs = config.candyProbeScheduleTickMs): void {
  stopCandyProbeScheduler();
  const safeTickMs = Math.max(60_000, Math.trunc(tickMs));
  schedulerTimer = setInterval(() => {
    void runCandyProbeSweep().catch(() => undefined);
  }, safeTickMs);
  shouldUnrefTimer(schedulerTimer);
  // Badges must stay fresh across the whole recheck interval, not just the default hour.
  setCandyProbeFreshTtlMs(resolveCandyProbeScheduleValidityMs(resolveCandyProbeRecheckMs()));
}

export function stopCandyProbeScheduler(): void {
  if (schedulerTimer) {
    clearInterval(schedulerTimer);
    schedulerTimer = null;
  }
  // Back to the manual-mode TTL: without a schedule nobody refreshes a verdict, so an hour
  // is the honest horizon again.
  setCandyProbeFreshTtlMs(null);
}

export function resetCandyProbeSchedulerForTests(): void {
  stopCandyProbeScheduler();
  sweepInFlight = null;
  recentRunStarts.length = 0;
}
