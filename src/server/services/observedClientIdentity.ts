/**
 * Observed client identity: what the real Claude Code / Codex traffic on THIS box looks like.
 *
 * Why this exists: relays route by client identity, so a probe (candy question, model
 * fingerprint) or a playground request only measures what real traffic meets if it wears
 * the identity real traffic wears. A hand-written template drifts: the box's traffic moved
 * from `claude-cli/2.1.63` to `2.1.151`, Codex from `0.101.0` to `0.114.0`, and the session
 * header from `Session_id` to `session-id`, while the templates stood still.
 *
 * So the proxy surfaces record a sanitized snapshot of every successful real CLI request,
 * and every synthetic request resolves its identity from that snapshot, falling back to the
 * built-in templates in `candyProbe/fingerprints.ts` only when nothing has been observed.
 *
 * What a snapshot holds, and what it deliberately does not:
 * - identity header VALUES from a fixed allowlist (user agent, `x-app`, `originator`,
 *   `x-stainless-*`, betas, versions). Never credentials, never hosts, never `x-metapi-*`.
 * - session header NAMES only (`session-id`, `x-claude-code-session-id`, …). The values are
 *   real users' session ids; a synthetic request derives its own from a seed instead, so it
 *   can never land on a real conversation's sticky channel or continuation.
 * - a few body traits (booleans / enums / short strings). Never message content, tools or
 *   system text.
 *
 * Writes come only from `proxy-core/surfaces/sharedSurface.ts`; the probes and the
 * playground only call `resolveClientIdentityProfile`. The architecture test pins both.
 *
 * Persistence follows the probe stores: one JSON blob in `settings`, debounced, hydrated on
 * startup, excluded from backups (it describes this box), cleared on factory reset.
 */

import { eq } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { upsertSetting } from '../db/upsertSetting.js';
import { uuidFromSeed } from '../proxy-core/providers/headerUtils.js';
import { isClaudeCodeUserAgent } from '../proxy-core/cliProfiles/claudeCodeProfile.js';
import { detectCodexOfficialClientApp } from '../shared/codexClientFamily.js';
import {
  getCandyFingerprint,
  type CandyFingerprintId,
} from './candyProbe/fingerprints.js';

export type ObservedClientKind = 'claude_code' | 'codex';
export type ObservedDownstreamFormat = 'claude' | 'responses' | 'openai';
export type ClientIdentitySource = 'observed' | 'builtin' | 'sdk';

export type ObservedBodyTraits = {
  hasTopLevelSystem?: boolean;
  hasMetadataUserId?: boolean;
  reasoningEffort?: string | null;
  include?: string[] | null;
  store?: boolean | null;
  hasMaxOutputTokens?: boolean;
  hasPromptCacheKey?: boolean;
  parallelToolCalls?: boolean | null;
  stream?: boolean | null;
};

export type ObservedClientIdentity = {
  key: string;
  clientKind: ObservedClientKind;
  downstreamFormat: ObservedDownstreamFormat;
  headers: Record<string, string>;
  sessionHeaderNames: string[];
  bodyTraits: ObservedBodyTraits;
  firstSeenAt: string;
  lastSeenAt: string;
  count: number;
};

export type ClientIdentityProfile = {
  source: ClientIdentitySource;
  clientKind: ObservedClientKind | 'generic';
  downstreamFormat: ObservedDownstreamFormat;
  /** Identity headers to send as DOWNSTREAM headers, through the real passthrough rules. */
  downstreamHeaders: Record<string, string>;
  /**
   * Headers injected past the passthrough filter. Only the `sdk` profile uses it: the
   * neutral SDK identity was never real traffic, so it has no passthrough path to mirror.
   */
  providerHeaders: Record<string, string>;
  /** Null for builtin/sdk: the body builders then keep their own template behavior. */
  bodyTraits: ObservedBodyTraits | null;
  /** The derived session id the headers carry (null when the client sends none). */
  sessionId: string | null;
  userAgent: string | null;
  observedAt: string | null;
};

export const OBSERVED_CLIENT_IDENTITY_SETTING_KEY = 'observed_client_identity_v1';
const MAX_VARIANTS_PER_KEY = 5;
/** A new variant, changed headers or changed traits: write soon. */
const MATERIAL_PERSIST_DELAY_MS = 5_000;
/** Only counters / timestamps moved: busy traffic must not turn into a settings write per request. */
const ROUTINE_PERSIST_DELAY_MS = 5 * 60_000;
const MAX_HEADER_VALUE_LENGTH = 1_024;
const MAX_INCLUDE_ITEMS = 8;
const MAX_TRAIT_STRING_LENGTH = 64;

const IDENTITY_HEADER_NAMES = new Set([
  'user-agent',
  'x-app',
  'originator',
  'version',
  'anthropic-beta',
  'anthropic-version',
  'anthropic-dangerous-direct-browser-access',
  'openai-beta',
]);
const SESSION_HEADER_NAMES = [
  'x-claude-code-session-id',
  'session-id',
  'session_id',
  'conversation-id',
  'conversation_id',
  'x-codex-window-id',
] as const;
/** Belt and braces: never stored even if the allowlist above grows carelessly. */
const BLOCKED_HEADER_NAMES = new Set([
  'authorization',
  'x-api-key',
  'x-goog-api-key',
  'cookie',
  'host',
  'content-length',
]);

const variantsByKey = new Map<string, ObservedClientIdentity[]>();
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let persistTimerDueAtMs = 0;
let persistInFlight: Promise<void> | null = null;
let persistDirty = false;
let storeGeneration = 0;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function headerValue(value: unknown): string | null {
  const raw = typeof value === 'string'
    ? value
    : Array.isArray(value) && typeof value[0] === 'string'
      ? value[0]
      : null;
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, MAX_HEADER_VALUE_LENGTH);
}

function shortString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, MAX_TRAIT_STRING_LENGTH) : null;
}

export function buildObservedClientIdentityKey(
  clientKind: ObservedClientKind,
  downstreamFormat: ObservedDownstreamFormat,
): string {
  return `${clientKind}|${downstreamFormat}`;
}

export function isObservedClientKind(value: unknown): value is ObservedClientKind {
  return value === 'claude_code' || value === 'codex';
}

export function isObservedDownstreamFormat(value: unknown): value is ObservedDownstreamFormat {
  return value === 'claude' || value === 'responses' || value === 'openai';
}

/**
 * Whether the user agent is the official client's own.
 *
 * `clientKind` alone is not enough to learn from: the proxy's Codex detection is a routing
 * heuristic, and any request carrying an `x-stainless-*` or `openai-beta` header (every
 * OpenAI SDK) is classified as `codex`. Learning from those would dress every synthetic
 * request in a third-party app's identity and label it "observed real client". So only a
 * request whose user agent is the client's own is learned; `originator` alone is not trusted.
 */
export function isOfficialClientUserAgent(
  clientKind: ObservedClientKind,
  userAgent: string | null | undefined,
): boolean {
  const value = typeof userAgent === 'string' ? userAgent.trim() : '';
  if (!value) return false;
  if (clientKind === 'claude_code') return isClaudeCodeUserAgent(value);
  return detectCodexOfficialClientApp({ 'user-agent': value }) !== null;
}

/** The allowlisted identity headers of one request, lower-cased. */
export function extractIdentityHeaders(headers: Record<string, unknown> | undefined): {
  headers: Record<string, string>;
  sessionHeaderNames: string[];
} {
  const identity: Record<string, string> = {};
  const sessionNames = new Set<string>();
  for (const [rawKey, rawValue] of Object.entries(headers || {})) {
    const key = rawKey.trim().toLowerCase();
    if (!key || BLOCKED_HEADER_NAMES.has(key) || key.startsWith('x-metapi-')) continue;
    const value = headerValue(rawValue);
    if (!value) continue;
    if ((SESSION_HEADER_NAMES as readonly string[]).includes(key)) {
      sessionNames.add(key);
      continue;
    }
    if (key === 'x-stainless-retry-count') {
      // A retry count describes one request, not the client: always replay a first attempt.
      identity[key] = '0';
      continue;
    }
    if (IDENTITY_HEADER_NAMES.has(key) || key.startsWith('x-stainless-')) {
      identity[key] = value;
    }
  }
  return {
    headers: identity,
    sessionHeaderNames: SESSION_HEADER_NAMES.filter((name) => sessionNames.has(name)),
  };
}

/** Shape-only facts about one request body; nothing a user wrote is kept. */
export function extractBodyTraits(
  downstreamFormat: ObservedDownstreamFormat,
  body: unknown,
): ObservedBodyTraits {
  if (!isRecord(body)) return {};
  const traits: ObservedBodyTraits = {
    stream: typeof body.stream === 'boolean' ? body.stream : null,
  };
  if (downstreamFormat === 'claude') {
    const system = body.system;
    traits.hasTopLevelSystem = (typeof system === 'string' && system.trim().length > 0)
      || (Array.isArray(system) && system.length > 0);
    traits.hasMetadataUserId = isRecord(body.metadata)
      && typeof body.metadata.user_id === 'string'
      && body.metadata.user_id.trim().length > 0;
    return traits;
  }
  if (downstreamFormat === 'responses') {
    traits.reasoningEffort = isRecord(body.reasoning) ? shortString(body.reasoning.effort) : null;
    traits.include = Array.isArray(body.include)
      ? body.include
        .map(shortString)
        .filter((item): item is string => item !== null)
        .slice(0, MAX_INCLUDE_ITEMS)
      : null;
    traits.store = typeof body.store === 'boolean' ? body.store : null;
    traits.hasMaxOutputTokens = body.max_output_tokens !== undefined;
    traits.hasPromptCacheKey = typeof body.prompt_cache_key === 'string' && body.prompt_cache_key.trim().length > 0;
    traits.parallelToolCalls = typeof body.parallel_tool_calls === 'boolean' ? body.parallel_tool_calls : null;
    return traits;
  }
  traits.hasMaxOutputTokens = body.max_tokens !== undefined || body.max_completion_tokens !== undefined;
  return traits;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

function schedulePersistence(delayMs: number): void {
  const dueAtMs = Date.now() + delayMs;
  if (persistTimer && persistTimerDueAtMs <= dueAtMs) return;
  if (persistTimer) clearTimeout(persistTimer);
  persistTimerDueAtMs = dueAtMs;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    persistTimerDueAtMs = 0;
    void flushObservedClientIdentityPersistence().catch(() => undefined);
  }, delayMs);
  persistTimer.unref?.();
}

/**
 * Record one successful real request. Call ONLY from the proxy surfaces' shared success
 * bookkeeping (`sharedSurface.ts`), which also filters out playground and probe requests.
 */
export function recordObservedClientIdentity(input: {
  clientKind: ObservedClientKind;
  downstreamFormat: ObservedDownstreamFormat;
  headers?: Record<string, unknown>;
  body?: unknown;
  nowMs?: number;
}): ObservedClientIdentity | null {
  const { headers, sessionHeaderNames } = extractIdentityHeaders(input.headers);
  const userAgent = headers['user-agent'];
  // Without the client's own user agent there is nothing to replay that would identify it.
  if (!isOfficialClientUserAgent(input.clientKind, userAgent)) return null;
  const nowIso = new Date(input.nowMs ?? Date.now()).toISOString();
  const key = buildObservedClientIdentityKey(input.clientKind, input.downstreamFormat);
  const bodyTraits = extractBodyTraits(input.downstreamFormat, input.body);
  const variants = variantsByKey.get(key) ?? [];
  const index = variants.findIndex((variant) => variant.headers['user-agent'] === userAgent);
  let entry: ObservedClientIdentity;
  let material = false;
  if (index >= 0) {
    const previous = variants[index]!;
    material = stableJson(previous.headers) !== stableJson(headers)
      || stableJson(previous.sessionHeaderNames) !== stableJson(sessionHeaderNames)
      || stableJson(previous.bodyTraits) !== stableJson(bodyTraits)
      || index !== 0;
    entry = {
      ...previous,
      headers,
      sessionHeaderNames,
      bodyTraits,
      lastSeenAt: nowIso,
      count: previous.count + 1,
    };
    variants.splice(index, 1);
  } else {
    material = true;
    entry = {
      key,
      clientKind: input.clientKind,
      downstreamFormat: input.downstreamFormat,
      headers,
      sessionHeaderNames,
      bodyTraits,
      firstSeenAt: nowIso,
      lastSeenAt: nowIso,
      count: 1,
    };
  }
  variants.unshift(entry);
  variantsByKey.set(key, variants.slice(0, MAX_VARIANTS_PER_KEY));
  schedulePersistence(material ? MATERIAL_PERSIST_DELAY_MS : ROUTINE_PERSIST_DELAY_MS);
  return entry;
}

/** Every stored variant, most recent first within each key. */
export function listObservedClientIdentities(): ObservedClientIdentity[] {
  return Array.from(variantsByKey.values())
    .flat()
    .map((entry) => structuredClone(entry));
}

export function getObservedClientIdentity(
  clientKind: ObservedClientKind,
  downstreamFormat: ObservedDownstreamFormat,
  variantUserAgent?: string | null,
): ObservedClientIdentity | null {
  const variants = variantsByKey.get(buildObservedClientIdentityKey(clientKind, downstreamFormat));
  if (!variants || variants.length === 0) return null;
  const wanted = typeof variantUserAgent === 'string' ? variantUserAgent.trim() : '';
  if (wanted) {
    return variants.find((variant) => variant.headers['user-agent'] === wanted) ?? null;
  }
  return variants[0] ?? null;
}

/** The client a request of this format is assumed to come from, absent a preference. */
export function resolveDefaultClientKind(downstreamFormat: ObservedDownstreamFormat): ObservedClientKind {
  return downstreamFormat === 'claude' ? 'claude_code' : 'codex';
}

/** The built-in template family for a format: the same mapping the candy probe uses. */
export function resolveBuiltinFingerprintId(downstreamFormat: ObservedDownstreamFormat): CandyFingerprintId {
  if (downstreamFormat === 'claude') return 'claude_code';
  if (downstreamFormat === 'responses') return 'codex';
  return 'codex_chat';
}

function deriveSessionId(sessionSeed: string): string {
  return uuidFromSeed(`metapi:identity:${sessionSeed}`);
}

function lowerCaseKeys(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
}

function findSessionId(headers: Record<string, string>): string | null {
  for (const name of SESSION_HEADER_NAMES) {
    if (name === 'x-codex-window-id') continue;
    if (headers[name]) return headers[name]!;
  }
  return null;
}

/**
 * The built-in template identity of one fingerprint family.
 *
 * `generic_openai` is the neutral SDK identity: it was never real traffic, so it rides
 * `providerHeaders` exactly as before (its Stainless markers have no passthrough path on the
 * chat surface). Every other family rides `downstreamHeaders` like an observed identity.
 */
export function buildBuiltinClientIdentityProfile(
  fingerprintId: CandyFingerprintId,
  sessionSeed: string,
  modelName = '',
): ClientIdentityProfile {
  const fingerprint = getCandyFingerprint(fingerprintId);
  const headers = lowerCaseKeys(fingerprint.buildProviderHeaders({
    model: modelName,
    prompt: '',
    scopeKey: sessionSeed,
  }));
  const isSdk = fingerprintId === 'generic_openai';
  return {
    source: isSdk ? 'sdk' : 'builtin',
    clientKind: isSdk ? 'generic' : fingerprintId === 'claude_code' ? 'claude_code' : 'codex',
    downstreamFormat: fingerprint.downstreamFormat,
    downstreamHeaders: isSdk ? {} : headers,
    providerHeaders: isSdk ? headers : {},
    bodyTraits: null,
    sessionId: findSessionId(headers),
    userAgent: headers['user-agent'] ?? null,
    observedAt: null,
  };
}

/** The neutral SDK identity (the model fingerprint probe's comparison mode). */
export function resolveSdkClientIdentityProfile(sessionSeed: string, modelName = ''): ClientIdentityProfile {
  return buildBuiltinClientIdentityProfile('generic_openai', sessionSeed, modelName);
}

/**
 * The identity a synthetic request should wear: the most recent observed variant for this
 * client and format, else the built-in template.
 */
export function resolveClientIdentityProfile(input: {
  downstreamFormat: ObservedDownstreamFormat;
  clientKind?: ObservedClientKind;
  variantUserAgent?: string | null;
  sessionSeed: string;
  modelName?: string;
}): ClientIdentityProfile {
  const clientKind = input.clientKind ?? resolveDefaultClientKind(input.downstreamFormat);
  const observed = getObservedClientIdentity(clientKind, input.downstreamFormat, input.variantUserAgent);
  if (!observed) {
    return buildBuiltinClientIdentityProfile(
      resolveBuiltinFingerprintId(input.downstreamFormat),
      input.sessionSeed,
      input.modelName,
    );
  }
  const downstreamHeaders: Record<string, string> = { ...observed.headers };
  const sessionId = observed.sessionHeaderNames.some((name) => name !== 'x-codex-window-id')
    ? deriveSessionId(input.sessionSeed)
    : null;
  for (const name of observed.sessionHeaderNames) {
    if (name === 'x-codex-window-id') {
      downstreamHeaders[name] = `${sessionId ?? deriveSessionId(input.sessionSeed)}:0`;
    } else if (sessionId) {
      downstreamHeaders[name] = sessionId;
    }
  }
  return {
    source: 'observed',
    clientKind,
    downstreamFormat: input.downstreamFormat,
    downstreamHeaders,
    providerHeaders: {},
    bodyTraits: structuredClone(observed.bodyTraits),
    sessionId,
    userAgent: observed.headers['user-agent'] ?? null,
    observedAt: observed.lastSeenAt,
  };
}

function normalizeStoredIdentity(value: unknown): ObservedClientIdentity | null {
  if (!isRecord(value)) return null;
  if (!isObservedClientKind(value.clientKind) || !isObservedDownstreamFormat(value.downstreamFormat)) return null;
  const { headers, sessionHeaderNames } = extractIdentityHeaders({
    ...(isRecord(value.headers) ? value.headers : {}),
    // Re-derive session names through the same allowlist, so a hand-edited row cannot
    // smuggle arbitrary header names in.
    ...Object.fromEntries(
      (Array.isArray(value.sessionHeaderNames) ? value.sessionHeaderNames : [])
        .filter((name): name is string => typeof name === 'string')
        .map((name) => [name, 'x']),
    ),
  });
  // The recording rule again: a row an earlier build learned from a third-party SDK is
  // dropped on hydrate instead of being replayed.
  if (!isOfficialClientUserAgent(value.clientKind, headers['user-agent'])) return null;
  const firstSeenAt = typeof value.firstSeenAt === 'string' ? value.firstSeenAt : null;
  const lastSeenAt = typeof value.lastSeenAt === 'string' ? value.lastSeenAt : null;
  if (!firstSeenAt || !lastSeenAt || !Number.isFinite(Date.parse(lastSeenAt))) return null;
  const rawTraits = isRecord(value.bodyTraits) ? value.bodyTraits : {};
  const bodyTraits: ObservedBodyTraits = {};
  for (const flag of ['hasTopLevelSystem', 'hasMetadataUserId', 'hasMaxOutputTokens', 'hasPromptCacheKey'] as const) {
    if (typeof rawTraits[flag] === 'boolean') bodyTraits[flag] = rawTraits[flag] as boolean;
  }
  for (const flag of ['store', 'parallelToolCalls', 'stream'] as const) {
    if (typeof rawTraits[flag] === 'boolean' || rawTraits[flag] === null) bodyTraits[flag] = rawTraits[flag] as boolean | null;
  }
  if (rawTraits.reasoningEffort === null || typeof rawTraits.reasoningEffort === 'string') {
    bodyTraits.reasoningEffort = shortString(rawTraits.reasoningEffort);
  }
  if (rawTraits.include === null) bodyTraits.include = null;
  else if (Array.isArray(rawTraits.include)) {
    bodyTraits.include = rawTraits.include
      .map(shortString)
      .filter((item): item is string => item !== null)
      .slice(0, MAX_INCLUDE_ITEMS);
  }
  const count = typeof value.count === 'number' && Number.isFinite(value.count) && value.count > 0
    ? Math.trunc(value.count)
    : 1;
  return {
    key: buildObservedClientIdentityKey(value.clientKind, value.downstreamFormat),
    clientKind: value.clientKind,
    downstreamFormat: value.downstreamFormat,
    headers,
    sessionHeaderNames,
    bodyTraits,
    firstSeenAt,
    lastSeenAt,
    count,
  };
}

export async function flushObservedClientIdentityPersistence(): Promise<void> {
  if (persistInFlight) {
    persistDirty = true;
    await persistInFlight;
    return;
  }
  persistInFlight = (async () => {
    do {
      persistDirty = false;
      const generationAtPassStart = storeGeneration;
      const payload: Record<string, ObservedClientIdentity[]> = {};
      for (const [key, variants] of variantsByKey.entries()) payload[key] = variants;
      if (generationAtPassStart !== storeGeneration) break;
      await upsertSetting(OBSERVED_CLIENT_IDENTITY_SETTING_KEY, payload);
      if (generationAtPassStart !== storeGeneration) break;
    } while (persistDirty);
  })().finally(() => {
    persistInFlight = null;
    persistDirty = false;
  });
  await persistInFlight;
}

export async function hydrateObservedClientIdentitiesFromSettings(): Promise<void> {
  const row = await db.select({ value: schema.settings.value })
    .from(schema.settings)
    .where(eq(schema.settings.key, OBSERVED_CLIENT_IDENTITY_SETTING_KEY))
    .get();
  if (!row || typeof row.value !== 'string' || !row.value.trim()) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.value);
  } catch {
    return;
  }
  if (!isRecord(parsed)) return;
  for (const rawVariants of Object.values(parsed)) {
    if (!Array.isArray(rawVariants)) continue;
    const variants = rawVariants
      .map(normalizeStoredIdentity)
      .filter((entry): entry is ObservedClientIdentity => entry !== null);
    if (variants.length === 0) continue;
    const key = variants[0]!.key;
    const sameKey = variants
      .filter((entry) => entry.key === key)
      .sort((left, right) => right.lastSeenAt.localeCompare(left.lastSeenAt));
    const unique: ObservedClientIdentity[] = [];
    for (const entry of sameKey) {
      if (unique.some((existing) => existing.headers['user-agent'] === entry.headers['user-agent'])) continue;
      unique.push(entry);
    }
    // A live record that raced the hydrate wins over the persisted copy.
    if (!variantsByKey.has(key)) variantsByKey.set(key, unique.slice(0, MAX_VARIANTS_PER_KEY));
  }
}

function resetObservedClientIdentityStore(): void {
  variantsByKey.clear();
  storeGeneration += 1;
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
    persistTimerDueAtMs = 0;
  }
  persistInFlight = null;
  persistDirty = false;
}

/** Factory reset: drop the snapshots in memory and in `settings`. */
export async function discardObservedClientIdentities(): Promise<void> {
  await flushObservedClientIdentityPersistence().catch(() => undefined);
  resetObservedClientIdentityStore();
  await upsertSetting(OBSERVED_CLIENT_IDENTITY_SETTING_KEY, {}).catch(() => undefined);
}

export function resetObservedClientIdentityStoreForTests(): void {
  resetObservedClientIdentityStore();
}
