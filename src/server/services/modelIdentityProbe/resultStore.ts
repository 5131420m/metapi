/**
 * Model fingerprint (identity) probe result store.
 *
 * Same shape of persistence as the candy probe's store: an in-memory map, persisted as one
 * JSON blob in `settings` behind a debounce, no schema migration. Display-only — nothing here
 * feeds routing, health or cooldowns.
 *
 * Differences from the candy store, each deliberate:
 * - the config fingerprint includes the reference bank's `builtAt`: a verdict scored against
 *   an older bank is not comparable with today's ranking, so it stops being shown;
 * - freshness is 24h: identity changes far more slowly than a single answer does;
 * - only summaries are stored (no raw numbers), see `IdentityProbeResult`.
 */

import { eq } from 'drizzle-orm';
import { db, schema } from '../../db/index.js';
import { upsertSetting } from '../../db/upsertSetting.js';
import type {
  IdentityProbeCandidate,
  IdentityProbeConfigFingerprint,
  IdentityProbeDecision,
  IdentityProbeRequestFormat,
  IdentityProbeResult,
  IdentityProbeSampleSummary,
  IdentityProbeSnapshot,
  IdentityProbeVerdict,
} from '../../../shared/modelIdentityProbe.js';

export type {
  IdentityProbeConfigFingerprint,
  IdentityProbeResult,
  IdentityProbeSnapshot,
};

export const IDENTITY_PROBE_SETTING_KEY = 'model_identity_probe_results_v1';
export const IDENTITY_PROBE_FRESH_TTL_MS = 24 * 60 * 60 * 1000;
const IDENTITY_PROBE_PERSIST_DEBOUNCE_MS = 500;
const IDENTITY_PROBE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const IDENTITY_PROBE_MAX_ENTRIES = 500;
const MAX_CANDIDATES = 5;
const MAX_SAMPLES = 3;
const MAX_TEXT_CHARS = 300;

const resultsByChannelId = new Map<number, IdentityProbeResult>();
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let persistInFlight: Promise<void> | null = null;
let persistDirty = false;
/** Bumped by every reset; a run that started in an older generation is dropped. */
let storeGeneration = 0;

export function getIdentityProbeStoreGeneration(): number {
  return storeGeneration;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asStringOrNull(value: unknown, max = MAX_TEXT_CHARS): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

const VERDICTS: readonly IdentityProbeVerdict[] = [
  'model_match',
  'version_mismatch',
  'family_match',
  'likely_match',
  'mismatch',
  'uncertain',
  'not_model',
  'inconclusive',
];

/**
 * Read a stored verdict. `match` predates the graded verdicts and only ever meant "the top
 * candidate is the claimed family", which is exactly `family_match` — the honest reading of
 * an old row, never the stronger `model_match`.
 */
function normalizeVerdict(value: unknown): IdentityProbeVerdict | null {
  if (value === 'match') return 'family_match';
  return VERDICTS.includes(value as IdentityProbeVerdict) ? value as IdentityProbeVerdict : null;
}
const DECISIONS: readonly IdentityProbeDecision[] = ['scored', 'partial', 'unscorable', 'not_model'];
const FORMATS: readonly IdentityProbeRequestFormat[] = ['openai', 'claude', 'responses'];

function normalizeCandidate(value: unknown): IdentityProbeCandidate | null {
  if (!isRecord(value)) return null;
  const model = asStringOrNull(value.model, 120);
  const family = asStringOrNull(value.family, 60);
  if (!model || !family) return null;
  return {
    model,
    displayName: asStringOrNull(value.displayName, 120) ?? model,
    family,
    familyName: asStringOrNull(value.familyName, 60) ?? family,
    probability: asFiniteNumber(value.probability),
  };
}

function normalizeSample(value: unknown): IdentityProbeSampleSummary | null {
  if (!isRecord(value)) return null;
  const index = asFiniteNumber(value.index);
  if (index == null || index <= 0) return null;
  const state = value.state === 'complete' || value.state === 'truncated' ? value.state : 'failed';
  return {
    index: Math.trunc(index),
    state,
    count: Math.max(0, Math.trunc(asFiniteNumber(value.count) ?? 0)),
    expectedCount: Math.max(0, Math.trunc(asFiniteNumber(value.expectedCount) ?? 0)),
    accepted: value.accepted === true,
    responseModel: asStringOrNull(value.responseModel, 120),
    latencyMs: asFiniteNumber(value.latencyMs),
    error: asStringOrNull(value.error),
  };
}

function normalizeConfig(value: unknown, fallbackModel: string): IdentityProbeConfigFingerprint {
  if (!isRecord(value)) return { model: fallbackModel, accountId: null, tokenId: null, bankBuiltAt: null };
  return {
    model: typeof value.model === 'string' ? value.model : fallbackModel,
    accountId: asFiniteNumber(value.accountId),
    tokenId: asFiniteNumber(value.tokenId),
    bankBuiltAt: asStringOrNull(value.bankBuiltAt, 80),
  };
}

/**
 * Normalize one result, both on write (caps text and list sizes) and on hydrate (rejects
 * anything a hand-edited row could smuggle in).
 */
export function normalizeIdentityProbeResult(value: unknown): IdentityProbeResult | null {
  if (!isRecord(value)) return null;
  const channelId = asFiniteNumber(value.channelId);
  const checkedAt = asStringOrNull(value.checkedAt, 64);
  const verdict = normalizeVerdict(value.verdict);
  if (channelId == null || channelId <= 0 || !checkedAt || !verdict) return null;
  const model = typeof value.model === 'string' ? value.model : '';
  const candidates = Array.isArray(value.candidates)
    ? value.candidates.map(normalizeCandidate).filter((item): item is IdentityProbeCandidate => item !== null)
    : [];
  const samples = Array.isArray(value.samples)
    ? value.samples.map(normalizeSample).filter((item): item is IdentityProbeSampleSummary => item !== null)
    : [];
  return {
    channelId: Math.trunc(channelId),
    routeId: asFiniteNumber(value.routeId),
    model,
    verdict,
    reason: asStringOrNull(value.reason),
    decision: DECISIONS.includes(value.decision as IdentityProbeDecision) ? value.decision as IdentityProbeDecision : null,
    prediction: normalizeCandidate(value.prediction),
    candidates: candidates.slice(0, MAX_CANDIDATES),
    probability: asFiniteNumber(value.probability),
    probabilityStatus: value.probabilityStatus === 'reference_calibrated' ? 'reference_calibrated' : 'unavailable',
    claimedModel: asStringOrNull(value.claimedModel, 120),
    claimedFamily: asStringOrNull(value.claimedFamily, 60),
    claimedFamilyName: asStringOrNull(value.claimedFamilyName, 60),
    claimedRank: asFiniteNumber(value.claimedRank),
    claimedProbability: asFiniteNumber(value.claimedProbability),
    modelLike: typeof value.modelLike === 'boolean' ? value.modelLike : null,
    usedOutputs: Math.max(0, Math.trunc(asFiniteNumber(value.usedOutputs) ?? 0)),
    samples: samples.slice(0, MAX_SAMPLES),
    requestFormat: FORMATS.includes(value.requestFormat as IdentityProbeRequestFormat)
      ? value.requestFormat as IdentityProbeRequestFormat
      : 'openai',
    endpoint: asStringOrNull(value.endpoint, 40),
    actualModel: asStringOrNull(value.actualModel, 120),
    latencyMs: asFiniteNumber(value.latencyMs),
    checkedAt,
    config: normalizeConfig(value.config, model),
    trigger: 'manual',
  };
}

function isRetainable(result: IdentityProbeResult, nowMs: number): boolean {
  const checkedAtMs = Date.parse(result.checkedAt);
  return Number.isFinite(checkedAtMs) && (nowMs - checkedAtMs) <= IDENTITY_PROBE_RETENTION_MS;
}

function pruneEntries(nowMs: number): void {
  for (const [channelId, result] of resultsByChannelId.entries()) {
    if (!isRetainable(result, nowMs)) resultsByChannelId.delete(channelId);
  }
  if (resultsByChannelId.size <= IDENTITY_PROBE_MAX_ENTRIES) return;
  const ordered = Array.from(resultsByChannelId.entries())
    .sort((left, right) => left[1].checkedAt.localeCompare(right[1].checkedAt));
  const excess = resultsByChannelId.size - IDENTITY_PROBE_MAX_ENTRIES;
  for (let index = 0; index < excess; index += 1) {
    const entry = ordered[index];
    if (entry) resultsByChannelId.delete(entry[0]);
  }
}

export function recordIdentityProbeResult(result: IdentityProbeResult): IdentityProbeResult {
  const normalized = normalizeIdentityProbeResult(result) ?? result;
  resultsByChannelId.set(normalized.channelId, normalized);
  pruneEntries(Date.now());
  schedulePersistence();
  return normalized;
}

/** Record unless the store was reset while the run was in flight. */
export function recordIdentityProbeResultIfCurrent(result: IdentityProbeResult, generation: number): boolean {
  if (generation !== storeGeneration) return false;
  recordIdentityProbeResult(result);
  return true;
}

/**
 * Compare the stored fingerprint with the channel's current one.
 *
 * `bankBuiltAt` is compared only when the CURRENT side knows it: the channel list passes
 * null until this process has loaded a bank, and must not hide every verdict until then.
 */
export function identityProbeConfigMatches(
  stored: IdentityProbeConfigFingerprint | null | undefined,
  current: IdentityProbeConfigFingerprint | null | undefined,
): boolean {
  if (!stored || !current) return false;
  if (stored.model !== current.model) return false;
  if ((stored.accountId ?? null) !== (current.accountId ?? null)) return false;
  if ((stored.tokenId ?? null) !== (current.tokenId ?? null)) return false;
  if (current.bankBuiltAt && stored.bankBuiltAt !== current.bankBuiltAt) return false;
  return true;
}

export function getIdentityProbeResultForChannel(channelId: number): IdentityProbeResult | null {
  if (!Number.isFinite(channelId) || channelId <= 0) return null;
  return resultsByChannelId.get(Math.trunc(channelId)) ?? null;
}

export function getIdentityProbeSnapshots(
  channelIds: number[],
  configByChannelId?: Record<number, IdentityProbeConfigFingerprint>,
  nowMs = Date.now(),
): Record<string, IdentityProbeSnapshot> {
  const snapshots: Record<string, IdentityProbeSnapshot> = {};
  for (const channelId of channelIds) {
    if (!Number.isFinite(channelId) || channelId <= 0) continue;
    const result = resultsByChannelId.get(Math.trunc(channelId));
    if (!result) continue;
    if (configByChannelId && !identityProbeConfigMatches(result.config, configByChannelId[Math.trunc(channelId)])) {
      continue;
    }
    const checkedAtMs = Date.parse(result.checkedAt);
    const expiresAtMs = Number.isFinite(checkedAtMs) ? checkedAtMs + IDENTITY_PROBE_FRESH_TTL_MS : nowMs;
    const { samples: _samples, candidates: _candidates, ...rest } = result;
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
    void flushIdentityProbeResultsPersistence().catch(() => undefined);
  }, IDENTITY_PROBE_PERSIST_DEBOUNCE_MS);
  persistTimer.unref?.();
}

export async function flushIdentityProbeResultsPersistence(): Promise<void> {
  if (persistInFlight) {
    persistDirty = true;
    await persistInFlight;
    return;
  }
  persistInFlight = (async () => {
    do {
      persistDirty = false;
      const generationAtPassStart = storeGeneration;
      pruneEntries(Date.now());
      const payload: Record<string, IdentityProbeResult> = {};
      for (const [channelId, result] of resultsByChannelId.entries()) payload[String(channelId)] = result;
      if (generationAtPassStart !== storeGeneration) break;
      await upsertSetting(IDENTITY_PROBE_SETTING_KEY, payload);
      if (generationAtPassStart !== storeGeneration) break;
    } while (persistDirty);
  })().finally(() => {
    persistInFlight = null;
    persistDirty = false;
  });
  await persistInFlight;
}

export async function hydrateIdentityProbeResultsFromSettings(): Promise<void> {
  const row = await db.select({ value: schema.settings.value })
    .from(schema.settings)
    .where(eq(schema.settings.key, IDENTITY_PROBE_SETTING_KEY))
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
    const result = normalizeIdentityProbeResult(entry);
    if (!result || !isRetainable(result, nowMs)) continue;
    resultsByChannelId.set(result.channelId, result);
  }
  pruneEntries(nowMs);
}

function resetIdentityProbeStore(): void {
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
 * Discard everything for a database that is being replaced (factory reset, backup import).
 * Same reasoning as `discardCandyProbeResults`: memory, in-flight runs AND the persisted row.
 */
export async function discardIdentityProbeResults(): Promise<void> {
  await flushIdentityProbeResultsPersistence().catch(() => undefined);
  resetIdentityProbeStore();
  await upsertSetting(IDENTITY_PROBE_SETTING_KEY, {}).catch(() => undefined);
}

export function resetIdentityProbeStoreForTests(): void {
  resetIdentityProbeStore();
}
