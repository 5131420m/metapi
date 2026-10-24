/**
 * Candy-probe result store: the "verdict" side of the feature.
 *
 * Deliberately display-only. Nothing here feeds routing, health accounting or cooldowns —
 * P1 is about making a verdict visible, and an automatic exclusion policy is a later,
 * separately-gated slice. (The probe REQUEST does use the site API endpoint pool — see
 * candyProbeService — but that is the pool's own endpoint state, not channel routing.)
 *
 * Persistence follows the existing runtime-health precedent: one JSON blob in the
 * `settings` table behind a debounce, so a restart does not blank every badge and no
 * schema migration is involved.
 */

import { eq } from 'drizzle-orm';
import { db, schema } from '../../db/index.js';
import { upsertSetting } from '../../db/upsertSetting.js';
import { isCandyFingerprintId } from './fingerprints.js';
import type { CandyFingerprintId } from './fingerprints.js';
import type {
  CandyProbeConfigFingerprint,
  CandyProbeExpectation,
  CandyProbeQuestionInfo,
  CandyProbeSampleResult,
  CandyProbeTrigger,
  CandyProbeVerdict,
} from '../../../shared/candyProbe.js';

export type {
  CandyProbeConfigFingerprint,
  CandyProbeExpectation,
  CandyProbeQuestionInfo,
  CandyProbeSampleResult,
  CandyProbeTrigger,
  CandyProbeVerdict,
};

export type CandyProbeResult = {
  channelId: number;
  routeId: number | null;
  model: string;
  fingerprint: CandyFingerprintId;
  verdict: CandyProbeVerdict;
  /** 1 when the single answer was correct, else 0. */
  score: number;
  /** Always 1: one question, one answer. */
  total: number;
  endpoint: string | null;
  actualModel: string | null;
  latencyMs: number | null;
  /** ISO timestamp of the run. */
  checkedAt: string;
  reason: string | null;
  /** The question this verdict was measured on. */
  question: CandyProbeQuestionInfo;
  /** The single answer's read, for the detail panel. Always exactly one entry. */
  samples: CandyProbeSampleResult[];
  /** 1 when the answer was readable, 0 when it was not (kept for the web's types). */
  validSampleCount: number;
  /** What a wrong answer is allowed to mean for this model (see `modelExpectation.ts`). */
  expectation: CandyProbeExpectation;
  /** The channel inputs this verdict was measured against. */
  config: CandyProbeConfigFingerprint;
  /** What started the run; rows persisted before the field existed read back as `manual`. */
  trigger: CandyProbeTrigger;
  /**
   * Consecutive fail/inconclusive runs against the CURRENT config; 0 after a pass.
   * Scales the schedule's recheck backoff so a persistently bad channel cannot eat the
   * daily ceiling. Rows persisted before the field existed read back as 0.
   */
  failStreak: number;
};

export type CandyProbeSnapshot = Omit<CandyProbeResult, 'samples'> & {
  /** False once the verdict is older than the freshness TTL. */
  fresh: boolean;
  expiresAt: string;
};

/**
 * v2 = the single-shot shape (one answer, score 0/1, total 1).
 *
 * v1 blobs are multi-sample verdicts ("2/3") whose numbers no longer mean anything to the
 * UI, so v1 is never read back — it is only cleared. v1 rows lived at most 7 days anyway,
 * so dropping them costs nothing.
 */
export const CANDY_PROBE_SETTING_KEY = 'candy_probe_results_v2';
/** The pre-single-shot key, cleared on discard so no stale multi-sample blob survives. */
export const CANDY_PROBE_SETTING_KEY_V1 = 'candy_probe_results_v1';
export const CANDY_PROBE_FRESH_TTL_MS = 60 * 60 * 1000;
const CANDY_PROBE_PERSIST_DEBOUNCE_MS = 500;
const CANDY_PROBE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const CANDY_PROBE_MAX_ENTRIES = 500;

/**
 * Freshness TTL in force; overridable by the scheduler.
 *
 * The default is a flat 1h. When the schedule runs, the honest expiry is "the next
 * scheduled recheck, plus margin for tick cadence and one run's timeout" — a flat TTL
 * shorter than the recheck interval would blank badges between rounds (the octopus
 * lesson: a constant that only works when the interval happens to equal it).
 */
let freshTtlMs = CANDY_PROBE_FRESH_TTL_MS;

/** Set the freshness TTL (null restores the default 1h). */
export function setCandyProbeFreshTtlMs(ms: number | null): void {
  freshTtlMs = typeof ms === 'number' && Number.isFinite(ms) && ms > 0
    ? Math.trunc(ms)
    : CANDY_PROBE_FRESH_TTL_MS;
}

const resultsByChannelId = new Map<number, CandyProbeResult>();
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let persistInFlight: Promise<void> | null = null;
/** Set when a write arrives during a persist pass, so that pass runs again afterwards. */
let persistDirty = false;

/**
 * Bumped by every reset (factory reset / backup import).
 *
 * A reset replaces the whole database, so a probe that started before it describes channels
 * that no longer exist — and after a reset the autoincrement ids can restart from 1, so a
 * stale verdict can match a brand-new channel's config fingerprint exactly. Probes therefore
 * carry the generation they started in: a run that finishes after a reset is dropped instead
 * of being written onto the new database, and a queued persist pass does not write the
 * previous generation's results back into the fresh settings row.
 */
let storeGeneration = 0;

export function getCandyProbeStoreGeneration(): number {
  return storeGeneration;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asStringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizeVerdict(value: unknown): CandyProbeVerdict | null {
  return value === 'pass' || value === 'fail' || value === 'inconclusive' ? value : null;
}

function normalizeFingerprintId(value: unknown): CandyFingerprintId | null {
  // The registry owns which ids exist; restating them here would silently drop a newly added
  // fingerprint from every stored verdict (and the badge would read "unknown").
  return typeof value === 'string' && isCandyFingerprintId(value) ? value : null;
}

function normalizeQuestionInfo(value: unknown): CandyProbeQuestionInfo {
  if (!isRecord(value)) return { id: 'unknown', prompt: '', expected: '' };
  return {
    id: asStringOrNull(value.id) ?? 'unknown',
    prompt: typeof value.prompt === 'string' ? value.prompt : '',
    expected: typeof value.expected === 'string' ? value.expected : '',
  };
}

function normalizeSampleResult(value: unknown): CandyProbeSampleResult | null {
  if (!isRecord(value)) return null;
  const index = asFiniteNumber(value.index);
  if (index == null || index <= 0) return null;
  return {
    index: Math.trunc(index),
    answer: typeof value.answer === 'string' ? value.answer : '',
    correct: value.correct === true,
    note: asStringOrNull(value.note),
  };
}

function normalizeStoredResult(value: unknown): CandyProbeResult | null {
  if (!isRecord(value)) return null;
  const channelId = asFiniteNumber(value.channelId);
  const verdict = normalizeVerdict(value.verdict);
  const fingerprint = normalizeFingerprintId(value.fingerprint);
  const checkedAt = asStringOrNull(value.checkedAt);
  if (channelId == null || channelId <= 0 || !verdict || !fingerprint || !checkedAt) return null;
  const samples = Array.isArray(value.samples)
    ? value.samples.map(normalizeSampleResult).filter((item): item is CandyProbeSampleResult => item !== null)
    : [];
  return {
    channelId: Math.trunc(channelId),
    routeId: asFiniteNumber(value.routeId),
    model: typeof value.model === 'string' ? value.model : '',
    fingerprint,
    verdict,
    // Single-shot shape: clamp whatever a hand-edited row claims back to 0/1 and one entry.
    score: (asFiniteNumber(value.score) ?? 0) >= 1 ? 1 : 0,
    total: 1,
    endpoint: asStringOrNull(value.endpoint),
    actualModel: asStringOrNull(value.actualModel),
    latencyMs: asFiniteNumber(value.latencyMs),
    checkedAt,
    reason: asStringOrNull(value.reason),
    question: normalizeQuestionInfo(value.question),
    samples: samples.slice(0, 1),
    validSampleCount: (asFiniteNumber(value.validSampleCount) ?? 0) >= 1 ? 1 : 0,
    // A row written before the baseline existed is treated as `unknown`: it must not be shown
    // with a degradation claim that was never measured.
    expectation: value.expectation === 'expected' || value.expectation === 'reference-only'
      ? value.expectation
      : 'unknown',
    // Rows persisted before the fingerprint existed carry none: they are kept, but the
    // snapshot filter will not match them against a channel, so they simply do not show.
    config: normalizeStoredConfig(value.config, value.model),
    // Rows persisted before the trigger existed are manual runs by definition: the
    // schedule is newer than every stored verdict.
    trigger: value.trigger === 'schedule' ? 'schedule' : 'manual',
    // Rows persisted before the streak existed have none: their next bad run starts at 1.
    failStreak: typeof value.failStreak === 'number' && Number.isFinite(value.failStreak) && value.failStreak > 0
      ? Math.trunc(value.failStreak)
      : 0,
  };
}

function normalizeStoredConfig(
  raw: unknown,
  fallbackModel: unknown,
): CandyProbeConfigFingerprint {
  if (!isRecord(raw)) {
    return {
      model: typeof fallbackModel === 'string' ? fallbackModel : '',
      accountId: null,
      tokenId: null,
    };
  }
  return {
    model: typeof raw.model === 'string' ? raw.model : '',
    accountId: asFiniteNumber(raw.accountId),
    tokenId: asFiniteNumber(raw.tokenId),
  };
}

function isRetainable(result: CandyProbeResult, nowMs: number): boolean {
  const checkedAtMs = Date.parse(result.checkedAt);
  if (!Number.isFinite(checkedAtMs)) return false;
  return (nowMs - checkedAtMs) <= CANDY_PROBE_RETENTION_MS;
}

function pruneEntries(nowMs: number): void {
  for (const [channelId, result] of resultsByChannelId.entries()) {
    if (!isRetainable(result, nowMs)) resultsByChannelId.delete(channelId);
  }
  if (resultsByChannelId.size <= CANDY_PROBE_MAX_ENTRIES) return;
  const ordered = Array.from(resultsByChannelId.entries())
    .sort((left, right) => left[1].checkedAt.localeCompare(right[1].checkedAt));
  const excess = resultsByChannelId.size - CANDY_PROBE_MAX_ENTRIES;
  for (let index = 0; index < excess; index += 1) {
    const entry = ordered[index];
    if (entry) resultsByChannelId.delete(entry[0]);
  }
}

export function recordCandyProbeResult(result: CandyProbeResult): CandyProbeResult {
  resultsByChannelId.set(result.channelId, result);
  pruneEntries(Date.now());
  schedulePersistence();
  return result;
}

/**
 * Record a verdict unless the store was reset while the probe was running.
 *
 * Returns false when the result was discarded, so the caller can say so in the trace instead
 * of pretending the verdict was stored.
 */
export function recordCandyProbeResultIfCurrent(
  result: CandyProbeResult,
  generation: number,
): boolean {
  if (generation !== storeGeneration) return false;
  recordCandyProbeResult(result);
  return true;
}

/**
 * Copy one run's verdict onto the other due channels that share its upstream identity.
 *
 * Several route channels can point at the same account token and model (a wildcard route
 * beside an exact one); to the upstream they are ONE request, so one run answers for all
 * of them — and without this copy the siblings' badges would read "未测" until their own
 * turn came around. Each copy keeps its own channelId/routeId; everything a verdict
 * depends on (model, credential, fingerprint, question, samples) is the identity's, so
 * the snapshot filter matches each sibling as if it had been probed itself.
 *
 * Generation-guarded like the run's own write: a copy that lands after a factory reset /
 * backup import describes channels of a database that is gone.
 */
export function recordCandyProbeResultForChannels(
  result: CandyProbeResult,
  targets: Array<{ channelId: number; routeId: number }>,
  generation: number,
): number {
  if (generation !== storeGeneration) return 0;
  let written = 0;
  for (const target of targets) {
    const channelId = Math.trunc(target.channelId);
    if (!Number.isFinite(channelId) || channelId <= 0) continue;
    resultsByChannelId.set(channelId, { ...result, channelId, routeId: target.routeId });
    written += 1;
  }
  if (written > 0) {
    pruneEntries(Date.now());
    schedulePersistence();
  }
  return written;
}

/** Compare two config fingerprints the way the snapshot filter needs to. */
export function candyProbeConfigMatches(
  stored: CandyProbeConfigFingerprint | null | undefined,
  current: CandyProbeConfigFingerprint | null | undefined,
): boolean {
  if (!stored || !current) return false;
  return stored.model === current.model
    && (stored.accountId ?? null) === (current.accountId ?? null)
    && (stored.tokenId ?? null) === (current.tokenId ?? null);
}

export function getCandyProbeResultForChannel(channelId: number): CandyProbeResult | null {
  if (!Number.isFinite(channelId) || channelId <= 0) return null;
  return resultsByChannelId.get(Math.trunc(channelId)) ?? null;
}

/**
 * Snapshots for the channel list.
 *
 * `configByChannelId` is the channel's CURRENT configuration; a verdict whose stored
 * fingerprint no longer matches is dropped rather than shown, because the honest answer for
 * "is this channel degraded" after its model or credential changed is "unknown". Omitting
 * the argument skips the check (used by tests and by callers that only want the raw store).
 */
export function getCandyProbeSnapshots(
  channelIds: number[],
  configByChannelId?: Record<number, CandyProbeConfigFingerprint>,
  nowMs = Date.now(),
): Record<string, CandyProbeSnapshot> {
  const snapshots: Record<string, CandyProbeSnapshot> = {};
  for (const channelId of channelIds) {
    if (!Number.isFinite(channelId) || channelId <= 0) continue;
    const result = resultsByChannelId.get(Math.trunc(channelId));
    if (!result) continue;
    if (configByChannelId) {
      const current = configByChannelId[Math.trunc(channelId)];
      if (!candyProbeConfigMatches(result.config, current)) continue;
    }
    const checkedAtMs = Date.parse(result.checkedAt);
    const expiresAtMs = Number.isFinite(checkedAtMs) ? checkedAtMs + freshTtlMs : nowMs;
    const { samples: _samples, ...rest } = result;
    snapshots[String(result.channelId)] = {
      ...rest,
      fresh: Number.isFinite(checkedAtMs) && nowMs < expiresAtMs,
      expiresAt: new Date(expiresAtMs).toISOString(),
    };
  }
  return snapshots;
}

function schedulePersistence(): void {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    void flushCandyProbeResultsPersistence().catch(() => undefined);
  }, CANDY_PROBE_PERSIST_DEBOUNCE_MS);
  persistTimer.unref?.();
}

export async function flushCandyProbeResultsPersistence(): Promise<void> {
  if (persistInFlight) {
    // A write landed while a round was running. Waiting for that round and returning would
    // drop the newer state until something happened to trigger another flush, so mark the
    // store dirty and let the round that is already in flight run once more.
    persistDirty = true;
    await persistInFlight;
    return;
  }

  persistInFlight = (async () => {
    // Loop rather than write once: each pass snapshots the CURRENT map, and a write that
    // arrives mid-pass sets `persistDirty` again.
    do {
      persistDirty = false;
      const generationAtPassStart = storeGeneration;
      pruneEntries(Date.now());
      const payload: Record<string, CandyProbeResult> = {};
      for (const [channelId, result] of resultsByChannelId.entries()) {
        payload[String(channelId)] = result;
      }
      // A reset during this pass means the payload describes a database that is gone: writing
      // it would restore the previous generation's verdicts into the fresh settings row.
      if (generationAtPassStart !== storeGeneration) break;
      await upsertSetting(CANDY_PROBE_SETTING_KEY, payload);
      if (generationAtPassStart !== storeGeneration) break;
    } while (persistDirty);
  })().finally(() => {
    persistInFlight = null;
    persistDirty = false;
  });
  await persistInFlight;
}

export async function hydrateCandyProbeResultsFromSettings(): Promise<void> {
  const row = await db.select({ value: schema.settings.value })
    .from(schema.settings)
    .where(eq(schema.settings.key, CANDY_PROBE_SETTING_KEY))
    .get();
  if (!row || typeof row.value !== 'string' || !row.value.trim()) return;

  let parsed: unknown;
  try {
    parsed = JSON.parse(row.value);
  } catch {
    return;
  }
  if (!isRecord(parsed)) return;

  const nowMs = Date.now();
  for (const entry of Object.values(parsed)) {
    const result = normalizeStoredResult(entry);
    if (!result) continue;
    if (!isRetainable(result, nowMs)) continue;
    resultsByChannelId.set(result.channelId, result);
  }
  pruneEntries(nowMs);
}

/**
 * Drop everything, including anything a persisted blob would restore.
 *
 * Called on factory reset and on a backup import: the verdicts describe channels of the
 * database that is being replaced, so keeping them in memory would let the next write
 * resurrect them into the new settings row. Bumping the generation additionally invalidates
 * probes that are still running (they finish against the OLD database, where a channel id can
 * even be reused after the replacement).
 *
 * Callers must await `flushCandyProbeResultsPersistence()` BEFORE this: a pass that is already
 * in flight holds a payload of the old verdicts, and clearing the timer does not stop it.
 */
export function resetCandyProbeStore(): void {
  resultsByChannelId.clear();
  storeGeneration += 1;
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  persistInFlight = null;
  persistDirty = false;
}

/**
 * Discard the probe results for a database that is being replaced.
 *
 * One call for the whole operation, because doing it in pieces was wrong: flushing and
 * clearing memory left the persisted row in place, and a factory reset is the ONLY thing that
 * wipes `settings`. After a backup import the old row therefore survived, the next restart's
 * `hydrateCandyProbeResultsFromSettings()` read it back, and the imported data commonly reuses
 * channel ids — so the previous database's verdicts reappeared as the new database's own,
 * with config fingerprints that still matched.
 *
 * Writing an empty object (rather than deleting the row) keeps the single write path the
 * debounced flush already uses, and `hydrate` treats it as "no verdicts".
 */
export async function discardCandyProbeResults(): Promise<void> {
  // An in-flight pass carries the pre-replacement payload and would land after the reset.
  await flushCandyProbeResultsPersistence().catch(() => undefined);
  resetCandyProbeStore();
  await upsertSetting(CANDY_PROBE_SETTING_KEY, {}).catch(() => undefined);
  // v1 blobs are multi-sample verdicts this build can no longer interpret; leaving them
  // would only resurrect them on the next restart of an older build.
  await upsertSetting(CANDY_PROBE_SETTING_KEY_V1, {}).catch(() => undefined);
}

export function resetCandyProbeStoreForTests(): void {
  resetCandyProbeStore();
}
