/**
 * Candy-probe result store: the "verdict" side of the feature.
 *
 * Deliberately display-only. Nothing here feeds routing, health accounting or cooldowns —
 * P1 is about making a verdict visible, and an automatic exclusion policy is a later,
 * separately-gated slice.
 *
 * Persistence follows the existing runtime-health precedent: one JSON blob in the
 * `settings` table behind a debounce, so a restart does not blank every badge and no
 * schema migration is involved.
 */

import { eq } from 'drizzle-orm';
import { db, schema } from '../../db/index.js';
import { upsertSetting } from '../../db/upsertSetting.js';
import type { CandyAnswerParseMode } from './questionBank.js';
import type { CandyFingerprintId } from './fingerprints.js';

export type CandyProbeVerdict = 'pass' | 'fail' | 'inconclusive';

export type CandyProbeQuestionResult = {
  id: string;
  prompt: string;
  expected: string;
  answer: string;
  correct: boolean;
};

export type CandyProbeResult = {
  channelId: number;
  routeId: number | null;
  model: string;
  fingerprint: CandyFingerprintId;
  verdict: CandyProbeVerdict;
  score: number;
  total: number;
  endpoint: string | null;
  actualModel: string | null;
  latencyMs: number | null;
  /** ISO timestamp of the run. */
  checkedAt: string;
  reason: string | null;
  parseMode: CandyAnswerParseMode;
  questions: CandyProbeQuestionResult[];
};

export type CandyProbeSnapshot = Omit<CandyProbeResult, 'questions'> & {
  /** False once the verdict is older than the freshness TTL. */
  fresh: boolean;
  expiresAt: string;
};

export const CANDY_PROBE_SETTING_KEY = 'candy_probe_results_v1';
export const CANDY_PROBE_FRESH_TTL_MS = 60 * 60 * 1000;
const CANDY_PROBE_PERSIST_DEBOUNCE_MS = 500;
const CANDY_PROBE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const CANDY_PROBE_MAX_ENTRIES = 500;

const resultsByChannelId = new Map<number, CandyProbeResult>();
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let persistInFlight: Promise<void> | null = null;

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

function normalizeParseMode(value: unknown): CandyAnswerParseMode {
  return value === 'numbered' || value === 'lines' || value === 'none' ? value : 'none';
}

function normalizeFingerprintId(value: unknown): CandyFingerprintId | null {
  return value === 'claude_code' || value === 'codex' || value === 'generic_openai' ? value : null;
}

function normalizeQuestionResult(value: unknown): CandyProbeQuestionResult | null {
  if (!isRecord(value)) return null;
  const id = asStringOrNull(value.id);
  if (!id) return null;
  return {
    id,
    prompt: typeof value.prompt === 'string' ? value.prompt : '',
    expected: typeof value.expected === 'string' ? value.expected : '',
    answer: typeof value.answer === 'string' ? value.answer : '',
    correct: value.correct === true,
  };
}

function normalizeStoredResult(value: unknown): CandyProbeResult | null {
  if (!isRecord(value)) return null;
  const channelId = asFiniteNumber(value.channelId);
  const verdict = normalizeVerdict(value.verdict);
  const fingerprint = normalizeFingerprintId(value.fingerprint);
  const checkedAt = asStringOrNull(value.checkedAt);
  if (channelId == null || channelId <= 0 || !verdict || !fingerprint || !checkedAt) return null;
  const questions = Array.isArray(value.questions)
    ? value.questions.map(normalizeQuestionResult).filter((item): item is CandyProbeQuestionResult => item !== null)
    : [];
  return {
    channelId: Math.trunc(channelId),
    routeId: asFiniteNumber(value.routeId),
    model: typeof value.model === 'string' ? value.model : '',
    fingerprint,
    verdict,
    score: Math.max(0, Math.trunc(asFiniteNumber(value.score) ?? 0)),
    total: Math.max(0, Math.trunc(asFiniteNumber(value.total) ?? 0)),
    endpoint: asStringOrNull(value.endpoint),
    actualModel: asStringOrNull(value.actualModel),
    latencyMs: asFiniteNumber(value.latencyMs),
    checkedAt,
    reason: asStringOrNull(value.reason),
    parseMode: normalizeParseMode(value.parseMode),
    questions,
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

export function getCandyProbeResultForChannel(channelId: number): CandyProbeResult | null {
  if (!Number.isFinite(channelId) || channelId <= 0) return null;
  return resultsByChannelId.get(Math.trunc(channelId)) ?? null;
}

export function getCandyProbeSnapshots(
  channelIds: number[],
  nowMs = Date.now(),
): Record<string, CandyProbeSnapshot> {
  const snapshots: Record<string, CandyProbeSnapshot> = {};
  for (const channelId of channelIds) {
    if (!Number.isFinite(channelId) || channelId <= 0) continue;
    const result = resultsByChannelId.get(Math.trunc(channelId));
    if (!result) continue;
    const checkedAtMs = Date.parse(result.checkedAt);
    const expiresAtMs = Number.isFinite(checkedAtMs) ? checkedAtMs + CANDY_PROBE_FRESH_TTL_MS : nowMs;
    const { questions: _questions, ...rest } = result;
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
    await persistInFlight;
    return;
  }
  persistInFlight = (async () => {
    pruneEntries(Date.now());
    const payload: Record<string, CandyProbeResult> = {};
    for (const [channelId, result] of resultsByChannelId.entries()) {
      payload[String(channelId)] = result;
    }
    await upsertSetting(CANDY_PROBE_SETTING_KEY, payload);
  })().finally(() => {
    persistInFlight = null;
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

export function resetCandyProbeStoreForTests(): void {
  resultsByChannelId.clear();
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  persistInFlight = null;
}
