import { and, eq, inArray, isNull } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { upsertSetting } from '../db/upsertSetting.js';
import { resetAccountAuthFailureStreak } from './accountAuthFailureStreak.js';
import {
  config,
  normalizeTokenRouterFailureCooldownMaxSec,
  TOKEN_ROUTER_FAILURE_COOLDOWN_MAX_SEC_CEILING,
} from '../config.js';
import { getCachedModelRoutingReferenceCost, refreshModelPricingCatalog } from './modelPricingService.js';
import { proxyChannelCoordinator, type ProxyChannelLoadSnapshot } from './proxyChannelCoordinator.js';
import { RETRYABLE_TIMEOUT_PATTERNS } from './proxyRetryPolicy.js';
import {
  normalizeRouteRoutingStrategy,
  type RouteRoutingStrategy,
} from './routeRoutingStrategy.js';
import { type DownstreamRoutingPolicy, EMPTY_DOWNSTREAM_ROUTING_POLICY } from './downstreamPolicyTypes.js';
import { isUsableAccountToken } from './accountTokenService.js';
import { getOauthInfoFromAccount } from './oauth/oauthAccount.js';
import { parseCodexQuotaResetHint } from './oauth/quota.js';
import {
  getOauthRouteUnitStrategyLabel,
  listOauthRouteUnitMembersByUnitIds,
  loadOauthRouteUnitSummariesByIds,
  type OAuthRouteUnitSummary,
} from './oauth/routeUnitService.js';
import {
  isExactTokenRouteModelPattern,
  isTokenRouteRegexPattern,
  matchesTokenRouteModelPattern,
  parseTokenRouteRegexPattern,
} from '../../shared/tokenRoutePatterns.js';
import {
  normalizeTokenRouteMode,
  type RouteDecision,
  type RouteDecisionCandidate,
  type RouteMode,
} from '../../shared/tokenRouteContract.js';
import { ROUTING_SPEED_TARGET_TPS } from '../../shared/routingQualityContract.js';

interface RouteMatch {
  route: RouteRow;
  channels: Array<{
    channel: typeof schema.routeChannels.$inferSelect;
    account: typeof schema.accounts.$inferSelect;
    site: typeof schema.sites.$inferSelect;
    token: typeof schema.accountTokens.$inferSelect | null;
    routeUnit: OAuthRouteUnitSummary | null;
    routeUnitMembers: Array<{
      member: typeof schema.oauthRouteUnitMembers.$inferSelect;
      account: typeof schema.accounts.$inferSelect;
      site: typeof schema.sites.$inferSelect;
      token: null;
    }>;
  }>;
}

type RouteChannelCandidate = RouteMatch['channels'][number];

interface SelectedChannel {
  channel: typeof schema.routeChannels.$inferSelect;
  account: typeof schema.accounts.$inferSelect;
  site: typeof schema.sites.$inferSelect;
  token: typeof schema.accountTokens.$inferSelect | null;
  tokenValue: string;
  tokenName: string;
  actualModel: string;
}

type FailureAwareChannel = {
  failCount?: number | null;
  consecutiveFailCount?: number | null;
  lastFailAt?: string | null;
};

export type SiteRuntimeFailureContext = {
  status?: number | null;
  errorText?: string | null;
  modelName?: string | null;
  /**
   * What kind of failure this was, when the caller knows more than status and text say.
   *
   * `first-byte-timeout` is an observed timeout budget being spent, not channel damage, so it
   * is exempt from the failure bookkeeping entirely (see `isExemptTimeoutFailure`).
   *
   * `stream-interrupted` is its opposite. The channel accepted the request, produced output,
   * and then broke the stream AFTER the response was already committed downstream — a failure
   * the proxy cannot recover from, because the bytes are on the wire. That is confirmed
   * channel damage rather than one unlucky request, so it escalates a cooldown immediately
   * instead of waiting for the ordinary failure streak (see `isStreamInterruptedFailure`).
   *
   * `stream-idle-timeout` is the mid-stream half of the first-byte budget: the upstream went
   * quiet for longer than the shared wait limit (`resolveStreamIdleTimeoutMs`). It is our own
   * budget expiring, not proof the link broke — a reasoning model can legitimately pause — so
   * it follows the same timeout policy as `first-byte-timeout` (exempt unless the operator
   * opted into `timeoutCountsAsChannelFailure`, and then an ordinary failure), and never the
   * immediate stream-break escalation.
   */
  failureKind?: 'first-byte-timeout' | 'stream-idle-timeout' | 'stream-interrupted' | null;
};

type SiteRuntimeHealthState = {
  penaltyScore: number;
  latencyEmaMs: number | null;
  transientFailureStreak: number;
  lastTransientFailureAtMs: number | null;
  recentSuccessCount: number;
  recentFailureCount: number;
  recentWindowUpdatedAtMs: number;
  breakerLevel: number;
  breakerUntilMs: number | null;
  lastUpdatedAtMs: number;
  lastFailureAtMs: number | null;
  lastSuccessAtMs: number | null;
  /** EMA of observed time-to-first-byte, feeding the weighted value score. */
  firstByteEmaMs: number | null;
  /** Samples behind `firstByteEmaMs`; drives the neutral-fallback confidence. */
  firstByteSampleCount: number;
  /** EMA of observed stream generation throughput (tokens/sec). */
  tpsEma: number | null;
  /** Samples behind `tpsEma`; drives the neutral-fallback confidence. */
  tpsSampleCount: number;
};

/**
 * Structural host of the quality EMAs. Both the site runtime health state and the
 * channel quality state carry these fields, so EMA updates and hydration share one
 * implementation.
 */
type QualityEmaHost = {
  firstByteEmaMs: number | null;
  firstByteSampleCount: number;
  tpsEma: number | null;
  tpsSampleCount: number;
};

/**
 * Structural host of the decaying recent outcome window. Shared by site and channel
 * quality states so the snapshot math (priors, half-life, confidence) cannot drift
 * between the two granularities.
 */
type RecentOutcomeWindowHost = {
  recentSuccessCount: number;
  recentFailureCount: number;
  recentWindowUpdatedAtMs: number;
  lastUpdatedAtMs: number | null;
};

/**
 * Per-channel quality telemetry for DISPLAY ONLY (step one of the channel-granularity
 * rollout): first-byte / throughput EMAs and a decaying recent success window, keyed by
 * the channel the request actually ran on. Scoring keeps consuming the site-level
 * signals until the divergence between channels of one site has actually been observed.
 */
type ChannelQualityState = QualityEmaHost & RecentOutcomeWindowHost & {
  lastUpdatedAtMs: number;
};

const FAILURE_BACKOFF_BASE_SEC = 15;
const SHORT_WINDOW_LIMIT_COOLDOWN_MS = 5 * 60 * 1000;
/**
 * Fallback cooldown for a 429 the upstream scoped to a per-minute window (RPM/TPM).
 *
 * Half the window: long enough that a fixed per-minute bucket has probably rolled over
 * and a sliding one has drained most of the way, short enough that the channel does not
 * sit out the ~10 further windows the 5-minute plan-quota fallback would cost it. A
 * channel that is still throttled when it comes back simply earns another cooldown, and
 * the jitter keeps siblings from retrying in lockstep.
 */
const PER_MINUTE_LIMIT_COOLDOWN_MS = 30 * 1000;
// Keep weighted-route backoff within the JavaScript Date range when fail counts grow large.
const MAX_FAILURE_BACKOFF_SEC = 30 * 24 * 60 * 60;
/**
 * De-correlating jitter added to every cooldown Metapi computes itself (Fibonacci backoff,
 * round-robin tiers, the short-window limit fallback).
 *
 * Without it, N channels sharing one upstream group are rate-limited by the same traffic
 * burst, get the same `now + duration`, and therefore thaw in the same millisecond — the
 * retry wave then re-trips the same limit, which is a textbook thundering herd. The jitter
 * is positive-only: shortening a cooldown would weaken the protection window the failure
 * just earned.
 *
 * The spread is `ratio` of the duration but never more than `MAX_MS`, because the two
 * numbers answer different questions. The ratio keeps the jitter meaningful for a short
 * backoff (a 15s cooldown gets ~2s), while the absolute cap keeps a long cooldown a
 * *named tier*: a pure ratio would stretch the 24h round-robin tier to as much as 27.6h,
 * so "level 3 means one day" would stop being true and the tier boundaries would blur
 * into each other. De-correlation only needs the thaw instants to stop coinciding, and
 * tens of seconds of spread does that at any tier length.
 *
 * A cooldown dictated by the upstream itself (a codex `resets_at` / `resets_in_seconds`
 * hint, or a stored quota reset) is NOT jittered — that timestamp is authoritative and is
 * stored verbatim.
 */
const FAILURE_COOLDOWN_JITTER_RATIO = 0.15;
const FAILURE_COOLDOWN_JITTER_MAX_MS = 30_000;
/**
 * Upper bound of the soft-avoidance preference window (see `isChannelRecentlyFailed`).
 *
 * Ten minutes is a routing-decision timescale: long enough to steer traffic away from a
 * channel that is visibly struggling, short enough that the hint cannot outlive its own
 * relevance. Exclusion past this point is the hard cooldown's job, not a preference's.
 */
const SOFT_AVOIDANCE_MAX_MS = 10 * 60 * 1000;

/**
 * Why a channel is cooling, recorded on the row instead of being inferred from the shape
 * of its counters.
 *
 * `PROVIDER_QUOTA` means the upstream dictated the window (a 429 usage/rate limit, or an
 * explicit reset hint). Such a cooldown must be waited out: probing it early achieves
 * nothing and looks like abuse to the provider. `METAPI_BACKOFF` is our own failure
 * escalation, which a successful recovery probe is allowed to cut short.
 *
 * `STREAM_INTERRUPTED` is our own escalation too, but states a stronger reason: the channel
 * had already started answering and then dropped the stream. It is kept distinct from
 * `METAPI_BACKOFF` because the two answer different operator questions — "this channel is
 * failing" versus "this channel breaks mid-answer" — and because a stream break escalates on
 * its own scale rather than through the consecutive-failure streak.
 */
export const COOLDOWN_SOURCE_PROVIDER_QUOTA = 'provider_quota';
export const COOLDOWN_SOURCE_METAPI_BACKOFF = 'metapi_backoff';
export const COOLDOWN_SOURCE_STREAM_INTERRUPTED = 'stream_interrupted';

export type CooldownSource =
  | typeof COOLDOWN_SOURCE_PROVIDER_QUOTA
  | typeof COOLDOWN_SOURCE_METAPI_BACKOFF
  | typeof COOLDOWN_SOURCE_STREAM_INTERRUPTED;

type CooldownSourceAwareChannel = {
  cooldownUntil?: string | null;
  cooldownSource?: string | null;
  failCount?: number | null;
  consecutiveFailCount?: number | null;
  cooldownLevel?: number | null;
};

/**
 * Whether a cooling channel was put there by the upstream rather than by our own backoff.
 *
 * Reads the stated `cooldownSource`. A row that predates that column (or arrives from a
 * partial restore) carries null, and only then does this fall back to the old implicit
 * signal — "cooling with all failure counters at zero" — so an upgrade does not suddenly
 * start probing provider-quota channels. New writes always state the source, so the
 * fallback is a compatibility shim, not the contract.
 */
export function isProviderDirectedCooldown(channel: CooldownSourceAwareChannel): boolean {
  if (!channel.cooldownUntil) return false;

  const source = (channel.cooldownSource || '').trim();
  if (source) return source === COOLDOWN_SOURCE_PROVIDER_QUOTA;

  return (channel.failCount ?? 0) <= 0
    && (channel.consecutiveFailCount ?? 0) <= 0
    && (channel.cooldownLevel ?? 0) <= 0;
}

const MIN_EFFECTIVE_UNIT_COST = 1e-6;
const ROUND_ROBIN_FAILURE_THRESHOLD = 3;
const ROUND_ROBIN_COOLDOWN_LEVELS_SEC = [0, 10 * 60, 60 * 60, 24 * 60 * 60] as const;
const STABLE_FIRST_SITE_SCORE_RATIO = 0.92;
const SITE_RUNTIME_HEALTH_DECAY_HALF_LIFE_MS = 10 * 60 * 1000;
const SITE_RUNTIME_MIN_MULTIPLIER = 0.08;
const SITE_RUNTIME_LATENCY_BASELINE_MS = 2_500;
const SITE_RUNTIME_LATENCY_EMA_ALPHA = 0.3;
const SITE_RUNTIME_TPS_EMA_ALPHA = 0.3;
/**
 * Throughput a site must sustain (tokens/sec) to score a full 1.0 on the weighted
 * speed component. Sites faster than this saturate: beyond the target, extra speed
 * stops buying probability, mirroring the stable-first tolerance philosophy. Shared with
 * the routes-page speed badge so the two cannot disagree about "full speed".
 */
const SITE_RUNTIME_SPEED_TARGET_TPS = ROUTING_SPEED_TARGET_TPS;
/** Upper bound for a single observed tokens/sec sample, so one bogus usage payload cannot poison the EMA. */
const SITE_RUNTIME_SPEED_MAX_TPS = 500;
/** Minimum stream generation window (latency minus first byte) before a tokens/sec sample is trusted. */
const SITE_RUNTIME_TPS_MIN_GENERATION_MS = 500;
/** Samples of a quality EMA (first-byte / tps) needed for full confidence; below it the score blends toward neutral. */
const SITE_RUNTIME_SIGNAL_CONFIDENCE_SAMPLES = 10;
/** Neutral value-score component used when a quality signal has no samples yet (cold start). */
const NEUTRAL_VALUE_COMPONENT_SCORE = 0.5;
const SITE_RUNTIME_BREAKER_STREAK_THRESHOLD = 3;
const SITE_RUNTIME_BREAKER_LEVELS_MS = [0, 60_000, 5 * 60_000, 30 * 60 * 1000] as const;
const SITE_TRANSIENT_STREAK_WINDOW_MS = 5 * 60 * 1000;
const SITE_RECENT_OUTCOME_HALF_LIFE_MS = 30 * 60 * 1000;
const SITE_RECENT_SUCCESS_CONFIDENCE_SAMPLES = 12;
const SITE_RECENT_SUCCESS_PRIOR_SUCCESSES = 1;
const SITE_RECENT_SUCCESS_PRIOR_FAILURES = 1;
const SITE_RECENT_SUCCESS_FALLBACK_RATE = 0.5;
const SITE_RECENT_MODEL_WEIGHT = 0.65;
const SITE_HISTORICAL_HEALTH_MIN_MULTIPLIER = 0.45;
const SITE_HISTORICAL_HEALTH_MAX_SAMPLE = 24;
const SITE_HISTORICAL_LATENCY_BASELINE_MS = 2_000;
const SITE_HISTORICAL_LATENCY_WINDOW_MS = 20_000;
const SITE_HISTORICAL_MAX_LATENCY_PENALTY = 0.18;
const SITE_RUNTIME_HEALTH_SETTING_KEY = 'token_router_site_runtime_health_v1';
const SITE_RUNTIME_HEALTH_PERSIST_DEBOUNCE_MS = 500;
const SITE_RUNTIME_HEALTH_PERSIST_STALE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SITE_RUNTIME_HEALTH_PERSIST_IDLE_TTL_MS = 12 * 60 * 60 * 1000;
const SITE_RUNTIME_HEALTH_PERSIST_MIN_PENALTY = 0.02;

const SITE_PROTOCOL_FAILURE_PATTERNS: RegExp[] = [
  /unsupported\s+legacy\s+protocol/i,
  /please\s+use\s+\/v1\/responses/i,
  /please\s+use\s+\/v1\/messages/i,
  /please\s+use\s+\/v1\/chat\/completions/i,
  /does\s+not\s+allow\s+\/v1\/[a-z0-9/_:-]+\s+dispatch/i,
  /unsupported\s+endpoint/i,
  /unsupported\s+path/i,
  /unknown\s+endpoint/i,
  /unrecognized\s+request\s+url/i,
  /no\s+route\s+matched/i,
];

const SITE_MODEL_FAILURE_PATTERNS: RegExp[] = [
  /unsupported\s+model/i,
  /model\s+not\s+supported/i,
  /does\s+not\s+support(?:\s+the)?\s+model/i,
  /no\s+such\s+model/i,
  /unknown\s+model/i,
  /unknown\s+provider\s+for\s+model/i,
  /invalid\s+model/i,
  /model.*does\s+not\s+exist/i,
  /当前\s*api\s*不支持所选模型/i,
  /不支持所选模型/i,
];

const SITE_VALIDATION_FAILURE_PATTERNS: RegExp[] = [
  /invalid\s+request\s+body/i,
  /validation/i,
  /missing\s+required/i,
  /required\s+parameter/i,
  /unknown\s+parameter/i,
  /unrecognized\s+(field|key|parameter)/i,
  /malformed/i,
  /invalid\s+json/i,
  /cannot\s+parse/i,
  /unsupported\s+media\s+type/i,
];

const SITE_TRANSIENT_FAILURE_PATTERNS: RegExp[] = [
  /bad\s+gateway/i,
  /gateway\s+time-?out/i,
  ...RETRYABLE_TIMEOUT_PATTERNS,
  /service\s+unavailable/i,
  /temporar(?:y|ily)\s+unavailable/i,
  /cpu\s+overloaded/i,
  /overloaded/i,
  /connection\s+reset/i,
  /connection\s+refused/i,
  /econnreset/i,
  /econnrefused/i,
];

const USAGE_LIMIT_RATE_LIMIT_PATTERNS: RegExp[] = [
  /usage_limit_reached/i,
  /usage\s+limit\s+has\s+been\s+reached/i,
  /quota\s+exceeded/i,
  /rate\s+limit/i,
  /\blimit\b/i,
];

/**
 * A 429 whose limit is scoped to a MINUTE (an RPM/TPM throttle) is a different animal
 * from a plan quota: the window it belongs to drains on its own within sixty seconds.
 *
 * Both arrive as "429 + something limit-shaped", so without this distinction they share
 * one 5-minute fallback and a channel throttled for one second of burst traffic sits out
 * roughly ten windows it could already have served. These patterns recognise the upstream
 * saying "per minute" so the cooldown can match the window the provider actually used.
 */
const PER_MINUTE_RATE_LIMIT_PATTERNS: RegExp[] = [
  /per[-\s]?min(?:ute)?\b/i,
  /\b(?:rpm|tpm)\b/i,
  /\d+\s*\/\s*min(?:ute)?\b/i,
  /minute\s+limit/i,
  /每分钟/,
];

type SiteRuntimeHealthPersistencePayload = {
  version: 1;
  savedAtMs: number;
  globalBySiteId: Record<string, SiteRuntimeHealthState>;
  modelBySiteId: Record<string, Record<string, SiteRuntimeHealthState>>;
  /** Display-only per-channel quality EMAs; absent in payloads written before it existed. */
  channelById?: Record<string, ChannelQualityState>;
};

type SiteRuntimeHealthDetails = {
  globalMultiplier: number;
  modelMultiplier: number;
  combinedMultiplier: number;
  globalBreakerOpen: boolean;
  modelBreakerOpen: boolean;
  modelKey: string;
  recentSuccessRate: number;
  recentSampleCount: number;
  recentConfidence: number;
  /** Resolved first-byte EMA (model-level preferred, site-global fallback); null when never observed. */
  firstByteEmaMs: number | null;
  /** Confidence [0,1] behind `firstByteEmaMs`, from its sample count. */
  firstByteConfidence: number;
  /** Resolved stream throughput EMA (tokens/sec); null when never observed. */
  tpsEma: number | null;
  /** Confidence [0,1] behind `tpsEma`, from its sample count. */
  tpsConfidence: number;
};

type WeightedSelectionMode = 'weighted' | 'stable_first';
type WeightedSelectionResult = {
  selected: RouteChannelCandidate | null;
  details: Array<{ candidate: RouteChannelCandidate; probability: number; reason: string }>;
  stableSiteCount: number;
};

type RecentOutcomeSnapshot = {
  successCount: number;
  failureCount: number;
  sampleCount: number;
  successRate: number;
  confidence: number;
};

type StableFirstSitePoolState = {
  siteId: number;
  leader: RouteChannelCandidate;
  effectiveSuccessRate: number;
  trusted: boolean;
  observationReason: string | null;
};

type StableFirstPoolPlan = {
  primaryCandidates: RouteChannelCandidate[];
  observationCandidates: RouteChannelCandidate[];
  primarySiteIds: Set<number>;
  observationSiteIds: Set<number>;
  siteStateById: Map<number, StableFirstSitePoolState>;
};

type StableFirstObservationProgressState = {
  requestCount: number;
  lastObservationAtMs: number | null;
};

const siteRuntimeHealthStates = new Map<number, SiteRuntimeHealthState>();
const siteModelRuntimeHealthStates = new Map<number, Map<string, SiteRuntimeHealthState>>();
const channelQualityByChannelId = new Map<number, ChannelQualityState>();
const stableFirstLastSelectedSiteByKey = new Map<string, number>();
const MAX_STABLE_FIRST_ROTATION_KEYS = 1024;
const stableFirstObservationProgressByKey = new Map<string, StableFirstObservationProgressState>();
const stableFirstObservationSiteCooldownByKey = new Map<string, number>();
const MAX_STABLE_FIRST_OBSERVATION_PROGRESS_KEYS = 1024;
const MAX_STABLE_FIRST_OBSERVATION_SITE_COOLDOWN_KEYS = 4096;
let siteRuntimeHealthLoaded = false;
let siteRuntimeHealthLoadPromise: Promise<void> | null = null;
let siteRuntimeHealthSaveTimer: ReturnType<typeof setTimeout> | null = null;
let siteRuntimeHealthPersistInFlight: Promise<void> | null = null;

const STABLE_FIRST_PRIMARY_SUCCESS_RATE_RATIO = 0.92;
const STABLE_FIRST_TRUSTED_RECENT_CONFIDENCE = 0.5;
const STABLE_FIRST_TRUSTED_HISTORICAL_CALLS = 8;
const STABLE_FIRST_OBSERVATION_REQUEST_INTERVAL = 24;
const STABLE_FIRST_OBSERVATION_SITE_COOLDOWN_MS = 30 * 60 * 1000;

function rememberStableFirstSiteSelectionForKey(rotationKey: string, siteId: number): void {
  if (!rotationKey || !Number.isFinite(siteId) || siteId <= 0) return;
  if (stableFirstLastSelectedSiteByKey.has(rotationKey)) {
    stableFirstLastSelectedSiteByKey.delete(rotationKey);
  }
  stableFirstLastSelectedSiteByKey.set(rotationKey, siteId);
  while (stableFirstLastSelectedSiteByKey.size > MAX_STABLE_FIRST_ROTATION_KEYS) {
    const oldestKey = stableFirstLastSelectedSiteByKey.keys().next().value;
    if (!oldestKey) break;
    stableFirstLastSelectedSiteByKey.delete(oldestKey);
  }
}

function rememberStableFirstObservationProgressForKey(
  rotationKey: string,
  state: StableFirstObservationProgressState,
): void {
  if (!rotationKey) return;
  if (stableFirstObservationProgressByKey.has(rotationKey)) {
    stableFirstObservationProgressByKey.delete(rotationKey);
  }
  stableFirstObservationProgressByKey.set(rotationKey, state);
  while (stableFirstObservationProgressByKey.size > MAX_STABLE_FIRST_OBSERVATION_PROGRESS_KEYS) {
    const oldestKey = stableFirstObservationProgressByKey.keys().next().value;
    if (!oldestKey) break;
    stableFirstObservationProgressByKey.delete(oldestKey);
  }
}

function rememberStableFirstObservationSiteCooldown(
  rotationKey: string,
  siteId: number,
  observedAtMs: number,
): void {
  if (!rotationKey || !Number.isFinite(siteId) || siteId <= 0) return;
  const scopedKey = `${rotationKey}:${siteId}`;
  if (stableFirstObservationSiteCooldownByKey.has(scopedKey)) {
    stableFirstObservationSiteCooldownByKey.delete(scopedKey);
  }
  stableFirstObservationSiteCooldownByKey.set(scopedKey, observedAtMs);
  while (stableFirstObservationSiteCooldownByKey.size > MAX_STABLE_FIRST_OBSERVATION_SITE_COOLDOWN_KEYS) {
    const oldestKey = stableFirstObservationSiteCooldownByKey.keys().next().value;
    if (!oldestKey) break;
    stableFirstObservationSiteCooldownByKey.delete(oldestKey);
  }
}

function fibonacciNumber(index: number): number {
  if (index <= 2) return 1;
  let prev = 1;
  let current = 1;
  for (let i = 3; i <= index; i += 1) {
    const next = prev + current;
    prev = current;
    current = next;
  }
  return current;
}

/**
 * Weighted-route failures use a Fibonacci backoff, but the resulting cooldown must stay
 * representable as a JavaScript Date for downstream `toISOString()` calls.
 *
 * The exponent is the CONSECUTIVE failure streak, not the lifetime `failCount`.
 * `failCount` is a cumulative statistic that only ever grows (a success does not decrement
 * it), so using it as the Fibonacci index made the backoff a function of how long a
 * channel had been in service rather than how unhealthy it is now: a workhorse with 57
 * historical failures and a 100% recent success rate drew the 30-day ceiling on its next
 * single hiccup. The streak resets to 0 on success, so the backoff grows while a channel
 * is genuinely failing and starts over once it proves itself.
 */
function resolveFailureBackoffSec(consecutiveFailCount?: number | null): number {
  const normalizedStreak = Math.max(1, Math.trunc(consecutiveFailCount ?? 0));
  return Math.min(FAILURE_BACKOFF_BASE_SEC * fibonacciNumber(normalizedStreak), MAX_FAILURE_BACKOFF_SEC);
}

/**
 * The failure streak a channel's backoff and soft-avoidance window are computed from.
 *
 * Falls back to `failCount` only when the streak column is absent (a legacy row written
 * before `consecutive_fail_count` existed, or a partial restore), so such a row degrades
 * to the old behaviour instead of silently losing its backoff entirely.
 */
function resolveChannelFailureStreak(channel: FailureAwareChannel): number {
  const streak = Math.trunc(channel.consecutiveFailCount ?? 0);
  if (streak > 0) return streak;
  if (channel.consecutiveFailCount == null) {
    return Math.max(0, Math.trunc(channel.failCount ?? 0));
  }
  return 0;
}

function resolveConfiguredFailureCooldownMaxMs(): number {
  const normalized = normalizeTokenRouterFailureCooldownMaxSec(config.tokenRouterFailureCooldownMaxSec)
    ?? TOKEN_ROUTER_FAILURE_COOLDOWN_MAX_SEC_CEILING;
  return Math.max(1_000, normalized * 1000);
}

function clampFailureCooldownMs(cooldownMs: number): number {
  const normalized = Math.max(0, Math.trunc(cooldownMs));
  return Math.min(normalized, resolveConfiguredFailureCooldownMaxMs());
}

/**
 * Ceiling for the soft-avoidance window (see `isChannelRecentlyFailed`).
 *
 * Deliberately NOT the configured hard-cooldown cap: a preference hint that outlives the
 * routing decisions it informs is just a stale ranking. It also never exceeds the hard
 * cap, because preferring against a channel for longer than it could be cooled would
 * invert the two mechanisms' severity.
 */
function clampSoftAvoidanceMs(avoidMs: number): number {
  const normalized = Math.max(0, Math.trunc(avoidMs));
  return Math.min(normalized, SOFT_AVOIDANCE_MAX_MS, resolveConfiguredFailureCooldownMaxMs());
}

/**
 * Source of the jitter fraction, injectable so tests can pin the random draw instead of
 * asserting on a range and hoping. Production always reads `Math.random`.
 */
let failureCooldownJitterSource: () => number = Math.random;

/**
 * Spreads same-instant cooldowns apart so sibling channels do not thaw together.
 *
 * Applied BEFORE `clampFailureCooldownMs` on purpose: the configured cap is a hard
 * ceiling the operator set, so jitter must never push a cooldown past it.
 */
function applyFailureCooldownJitter(cooldownMs: number): number {
  const normalized = Math.max(0, Math.trunc(cooldownMs));
  if (normalized <= 0) return 0;
  const spreadMs = Math.min(normalized * FAILURE_COOLDOWN_JITTER_RATIO, FAILURE_COOLDOWN_JITTER_MAX_MS);
  const fraction = clampNumber(failureCooldownJitterSource(), 0, 1);
  return normalized + Math.trunc(spreadMs * fraction);
}

function resolveJitteredFailureCooldownMs(cooldownMs: number): number {
  return clampFailureCooldownMs(applyFailureCooldownJitter(cooldownMs));
}

function resolveEffectiveFailureCooldownMs(consecutiveFailCount?: number | null): number {
  return resolveJitteredFailureCooldownMs(resolveFailureBackoffSec(consecutiveFailCount) * 1000);
}

function resolveRoundRobinCooldownSec(level: number): number {
  const normalizedLevel = Math.max(0, Math.min(ROUND_ROBIN_COOLDOWN_LEVELS_SEC.length - 1, Math.trunc(level)));
  return ROUND_ROBIN_COOLDOWN_LEVELS_SEC[normalizedLevel] ?? 0;
}

function resolveSiteRuntimeBreakerMs(level: number): number {
  const normalizedLevel = Math.max(0, Math.min(SITE_RUNTIME_BREAKER_LEVELS_MS.length - 1, Math.trunc(level)));
  return SITE_RUNTIME_BREAKER_LEVELS_MS[normalizedLevel] ?? 0;
}

function matchesAnyPattern(patterns: RegExp[], input?: string | null): boolean {
  const text = (input || '').trim();
  if (!text) return false;
  return patterns.some((pattern) => pattern.test(text));
}

function isUsageLimitRateLimitFailure(context: SiteRuntimeFailureContext = {}): boolean {
  const status = typeof context.status === 'number' ? context.status : 0;
  if (status !== 429) return false;
  return matchesAnyPattern(USAGE_LIMIT_RATE_LIMIT_PATTERNS, context.errorText);
}

/**
 * True when the upstream named a per-minute window for the limit it just enforced.
 *
 * Only consulted for a failure already classified as a usage/rate limit, so this answers
 * "which window?" and never "is this a limit?".
 */
function isPerMinuteRateLimitFailure(context: SiteRuntimeFailureContext = {}): boolean {
  return matchesAnyPattern(PER_MINUTE_RATE_LIMIT_PATTERNS, context.errorText);
}

function isModelScopedRuntimeFailure(context: SiteRuntimeFailureContext = {}): boolean {
  return matchesAnyPattern(SITE_MODEL_FAILURE_PATTERNS, context.errorText);
}

function isProtocolRuntimeFailure(context: SiteRuntimeFailureContext = {}): boolean {
  return matchesAnyPattern(SITE_PROTOCOL_FAILURE_PATTERNS, context.errorText);
}

function isValidationRuntimeFailure(context: SiteRuntimeFailureContext = {}): boolean {
  return matchesAnyPattern(SITE_VALIDATION_FAILURE_PATTERNS, context.errorText);
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function isContributionCloseToBest(value: number, bestValue: number, ratio = STABLE_FIRST_SITE_SCORE_RATIO): boolean {
  if (bestValue <= 0) return true;
  return value >= (bestValue * ratio);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function readFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readFiniteInteger(value: unknown): number | null {
  const normalized = readFiniteNumber(value);
  return normalized == null ? null : Math.trunc(normalized);
}

function readNullableTimestamp(value: unknown): number | null {
  const normalized = readFiniteInteger(value);
  if (normalized == null || normalized <= 0) return null;
  return normalized;
}

function decayRecentOutcomeCount(value: number, elapsedMs: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  if (elapsedMs <= 0) return value;
  const decayFactor = Math.pow(0.5, elapsedMs / SITE_RECENT_OUTCOME_HALF_LIFE_MS);
  return value * decayFactor;
}

/**
 * A decayed sample count below this is not evidence — it is float residue left by the
 * half-life math (`39 × 0.5^k` reaches exact 0 only at subnormal underflow, ~22 days idle).
 * Every consumer gates on `sampleCount > 0`, so an un-snapped residue would leak the prior
 * 0.5 through the channel success-rate badge as a red 50% on an idle channel instead of the
 * honest "no samples" null.
 */
const RECENT_OUTCOME_SAMPLE_EPSILON = 1e-9;

function normalizeRecentOutcomeCount(value: number): number {
  const normalized = Math.max(0, value);
  return normalized < RECENT_OUTCOME_SAMPLE_EPSILON ? 0 : normalized;
}

function buildRecentOutcomeSnapshot(
  successCount: number,
  failureCount: number,
): RecentOutcomeSnapshot {
  const normalizedSuccessCount = normalizeRecentOutcomeCount(successCount);
  const normalizedFailureCount = normalizeRecentOutcomeCount(failureCount);
  const sampleCount = normalizedSuccessCount + normalizedFailureCount;
  const successRate = (
    normalizedSuccessCount + SITE_RECENT_SUCCESS_PRIOR_SUCCESSES
  ) / (
    sampleCount + SITE_RECENT_SUCCESS_PRIOR_SUCCESSES + SITE_RECENT_SUCCESS_PRIOR_FAILURES
  );
  return {
    successCount: normalizedSuccessCount,
    failureCount: normalizedFailureCount,
    sampleCount,
    successRate,
    confidence: clampNumber(sampleCount / SITE_RECENT_SUCCESS_CONFIDENCE_SAMPLES, 0, 1),
  };
}

function getRecentOutcomeSnapshot(state: RecentOutcomeWindowHost | null | undefined, nowMs = Date.now()): RecentOutcomeSnapshot {
  if (!state) {
    return buildRecentOutcomeSnapshot(0, 0);
  }
  const updatedAtMs = Math.max(0, readFiniteInteger(state.recentWindowUpdatedAtMs) ?? state.lastUpdatedAtMs ?? nowMs);
  const elapsedMs = Math.max(0, nowMs - updatedAtMs);
  return buildRecentOutcomeSnapshot(
    decayRecentOutcomeCount(state.recentSuccessCount, elapsedMs),
    decayRecentOutcomeCount(state.recentFailureCount, elapsedMs),
  );
}

function refreshRecentOutcomeWindow(state: RecentOutcomeWindowHost, nowMs = Date.now()): void {
  const snapshot = getRecentOutcomeSnapshot(state, nowMs);
  state.recentSuccessCount = snapshot.successCount;
  state.recentFailureCount = snapshot.failureCount;
  state.recentWindowUpdatedAtMs = nowMs;
}

function blendRecentOutcomeSnapshots(
  globalSnapshot: RecentOutcomeSnapshot,
  modelSnapshot: RecentOutcomeSnapshot | null,
): RecentOutcomeSnapshot {
  if (!modelSnapshot || modelSnapshot.sampleCount <= 0) {
    return globalSnapshot;
  }
  const modelWeight = SITE_RECENT_MODEL_WEIGHT;
  const globalWeight = 1 - modelWeight;
  return buildRecentOutcomeSnapshot(
    (globalSnapshot.successCount * globalWeight) + (modelSnapshot.successCount * modelWeight),
    (globalSnapshot.failureCount * globalWeight) + (modelSnapshot.failureCount * modelWeight),
  );
}

function resolveStableFirstSuccessRate(
  details: SiteRuntimeHealthDetails,
  historicalSuccessRate: number | null | undefined,
): number {
  const fallbackRate = historicalSuccessRate ?? SITE_RECENT_SUCCESS_FALLBACK_RATE;
  return (
    (details.recentSuccessRate * details.recentConfidence)
    + (fallbackRate * (1 - details.recentConfidence))
  );
}

/**
 * Shrink an observed quality score toward the neutral component score while the
 * sample behind it is scarce. A site with one lucky observation must not outrank
 * one with a hundred boring ones, and a brand-new site must not be buried at zero
 * before it ever had a chance to be measured.
 */
function blendQualityComponentScore(score: number, confidence: number): number {
  return clampNumber(
    (score * confidence) + (NEUTRAL_VALUE_COMPONENT_SCORE * (1 - confidence)),
    0,
    1,
  );
}

/**
 * Derive the quality metrics a successful request can contribute from its stream
 * timing. First-byte latency is always usable when observed; tokens/sec is only
 * trusted for stream responses with a real generation window (total latency minus
 * first byte), so non-stream replies — where the first byte IS the whole body —
 * cannot fabricate a throughput sample.
 */
function resolveStreamTimingQualityMetrics(
  latencyMs: number,
  streamTiming?: {
    firstByteLatencyMs?: number | null;
    completionTokens?: number | null;
    isStream?: boolean | null;
  },
): RuntimeSuccessQualityMetrics {
  const firstByteLatencyMs = readFiniteNumber(streamTiming?.firstByteLatencyMs);
  if (firstByteLatencyMs == null || firstByteLatencyMs < 0) return {};
  const metrics: RuntimeSuccessQualityMetrics = { firstByteLatencyMs };
  const completionTokens = readFiniteNumber(streamTiming?.completionTokens);
  const streamEligible = streamTiming?.isStream == null || streamTiming.isStream === true;
  if (streamEligible && completionTokens != null && completionTokens > 0) {
    const generationMs = latencyMs - firstByteLatencyMs;
    if (generationMs >= SITE_RUNTIME_TPS_MIN_GENERATION_MS) {
      metrics.tokensPerSecond = Math.min(
        SITE_RUNTIME_SPEED_MAX_TPS,
        (completionTokens * 1000) / generationMs,
      );
    }
  }
  return metrics;
}

/**
 * An observed timeout says "this attempt waited longer than its budget", not "this
 * credential is broken". The budget itself is a per-response-shape policy decision
 * (see `proxy-core/responseTimeoutPolicy.ts`), so a media generation that legitimately
 * runs long must not be recorded as channel damage: otherwise every channel the request
 * touched lands in Fibonacci backoff and the NEXT request has nothing left to select.
 *
 * With the toggle off (default) the abort may still rotate address/protocol/channel for
 * the current request — only the bookkeeping is suppressed. `lastFailAt` is still written
 * so the timeout stays visible for diagnosis. Turning the toggle on restores the old
 * behaviour of treating a timeout as an ordinary upstream failure everywhere.
 */
function isExemptTimeoutFailure(context: SiteRuntimeFailureContext = {}): boolean {
  if (config.timeoutCountsAsChannelFailure) return false;
  return context.failureKind === 'first-byte-timeout'
    || context.failureKind === 'stream-idle-timeout';
}

/**
 * A stream that broke after the response was already committed downstream.
 *
 * Escalation is immediate rather than streak-based, and the reason is the failure itself
 * rather than the request: the channel accepted the request, answered, and then dropped the
 * connection. Two things follow.
 *
 *  - The downstream request is already damaged and cannot be recovered by this proxy, so the
 *    only thing that can prevent a repeat is keeping the channel out of selection. Waiting
 *    for three consecutive failures (the round-robin threshold) means the next two requests
 *    are allowed to hit the same channel and break the same way.
 *  - The evidence is stronger than a failed attempt: an HTTP 5xx can come from the request,
 *    while a mid-stream break after a successful start is the channel's own link failing.
 *
 * The streak is deliberately NOT consulted for the level, and is reset after escalating: this
 * branch counts stream breaks on its own scale, so mixing an ordinary failure streak into it
 * would escalate twice for one underlying fault.
 */
function isStreamInterruptedFailure(context: SiteRuntimeFailureContext = {}): boolean {
  return context.failureKind === 'stream-interrupted';
}

/**
 * One step up the shared cooldown ladder for a channel we have just caught breaking a stream.
 *
 * Reuses `ROUND_ROBIN_COOLDOWN_LEVELS_SEC` on purpose: one ladder for "how long do we keep a
 * damaged channel out", so the two mechanisms cannot drift into disagreeing about severity.
 * Level `0` is a zero-second entry, so the first stream break lands on the next rung (10
 * minutes) rather than on no cooldown at all.
 */
function resolveStreamInterruptedCooldown(level: number, nowMs: number): {
  cooldownLevel: number;
  cooldownUntil: string | null;
} {
  const escalatedLevel = Math.min(
    Math.max(0, Math.trunc(level)) + 1,
    ROUND_ROBIN_COOLDOWN_LEVELS_SEC.length - 1,
  );
  const cooldownSec = resolveRoundRobinCooldownSec(escalatedLevel);
  return {
    cooldownLevel: escalatedLevel,
    cooldownUntil: cooldownSec > 0
      ? new Date(nowMs + resolveJitteredFailureCooldownMs(cooldownSec * 1000)).toISOString()
      : null,
  };
}

// NOTE: deliberately has NO timeout exemption of its own. Its only caller chain is
// `recordSiteRuntimeFailure` -> `applyRuntimeHealthFailure` -> here, and that entry point
// already skips both the global and the model-level state for an exempt timeout. A second
// check here would be unreachable by construction (an added one survived mutation testing,
// which is what exposed it as dead defense).
function resolveSiteRuntimeFailurePenalty(context: SiteRuntimeFailureContext = {}): number {
  const status = typeof context.status === 'number' ? context.status : 0;
  const errorText = (context.errorText || '').trim();

  if (isUsageLimitRateLimitFailure({ status, errorText })) {
    return 0.4;
  }

  if (isModelScopedRuntimeFailure({ status, errorText })) {
    return 0.9;
  }

  if (isProtocolRuntimeFailure({ status, errorText })) {
    return 0.6;
  }

  if (isValidationRuntimeFailure({ status, errorText })) {
    return 0.25;
  }

  if (status >= 500 || matchesAnyPattern(SITE_TRANSIENT_FAILURE_PATTERNS, errorText)) {
    return 2.5;
  }

  if (status === 429) {
    return 2.2;
  }

  if (status === 401 || status === 403) {
    return 1.8;
  }

  if (status >= 400 && status < 500) {
    return 0.9;
  }

  return 1.2;
}

function isTransientSiteRuntimeFailure(context: SiteRuntimeFailureContext = {}): boolean {
  if (isExemptTimeoutFailure(context)) {
    return false;
  }
  const status = typeof context.status === 'number' ? context.status : 0;
  const errorText = (context.errorText || '').trim();
  if (isUsageLimitRateLimitFailure({ status, errorText })) {
    return false;
  }
  if (isModelScopedRuntimeFailure({ status, errorText })) {
    return false;
  }
  if (isProtocolRuntimeFailure({ status, errorText })) {
    return false;
  }
  if (isValidationRuntimeFailure({ status, errorText })) {
    return false;
  }
  return status >= 500 || status === 429 || matchesAnyPattern(SITE_TRANSIENT_FAILURE_PATTERNS, errorText);
}

function resolveShortWindowLimitCooldown(
  account: typeof schema.accounts.$inferSelect,
  context: SiteRuntimeFailureContext = {},
  nowMs = Date.now(),
): string | null {
  const status = typeof context.status === 'number' ? context.status : 0;
  const errorText = (context.errorText || '').trim();
  if (!isUsageLimitRateLimitFailure({ status, errorText })) return null;

  // Upstream-dictated reset instants are authoritative: keep them verbatim rather than
  // jittering them, so the channel comes back exactly when the provider says it may.
  // This hint describes THIS failure, so it outranks the per-minute heuristic below.
  const resetHint = parseCodexQuotaResetHint(status, errorText, nowMs);
  if (resetHint) {
    const hintMs = Date.parse(resetHint.resetAt);
    if (Number.isFinite(hintMs) && hintMs > nowMs) {
      return new Date(hintMs).toISOString();
    }
  }

  // Checked BEFORE the stored quota reset: that stored instant is a previously observed
  // 5h/7d plan-window reset, so honouring it for a failure the upstream just scoped to a
  // minute would park the channel for hours over a throttle that clears in seconds.
  if (isPerMinuteRateLimitFailure({ status, errorText })) {
    return new Date(nowMs + applyFailureCooldownJitter(PER_MINUTE_LIMIT_COOLDOWN_MS)).toISOString();
  }

  const oauth = getOauthInfoFromAccount(account);
  const storedResetAt = oauth?.quota?.lastLimitResetAt;
  if (oauth?.provider === 'codex' && storedResetAt) {
    const storedMs = Date.parse(storedResetAt);
    if (Number.isFinite(storedMs) && storedMs > nowMs) {
      return new Date(storedMs).toISOString();
    }
  }

  // No reset information from upstream: this duration is Metapi's own guess, so it carries
  // jitter to keep sibling channels of the same upstream group from thawing in lockstep.
  return new Date(nowMs + applyFailureCooldownJitter(SHORT_WINDOW_LIMIT_COOLDOWN_MS)).toISOString();
}

function getDecayedSiteRuntimePenalty(state: SiteRuntimeHealthState, nowMs: number): number {
  if (!Number.isFinite(state.penaltyScore) || state.penaltyScore <= 0) return 0;
  const elapsedMs = Math.max(0, nowMs - state.lastUpdatedAtMs);
  if (elapsedMs <= 0) return state.penaltyScore;
  const decayFactor = Math.pow(0.5, elapsedMs / SITE_RUNTIME_HEALTH_DECAY_HALF_LIFE_MS);
  return state.penaltyScore * decayFactor;
}

function hydrateSiteRuntimeHealthState(raw: unknown): SiteRuntimeHealthState | null {
  if (!isRecord(raw)) return null;

  const lastUpdatedAtMs = readFiniteInteger(raw.lastUpdatedAtMs) ?? Date.now();
  const recentWindowUpdatedAtMs = readFiniteInteger(raw.recentWindowUpdatedAtMs) ?? lastUpdatedAtMs;
  const firstByteEmaMs = readFiniteNumber(raw.firstByteEmaMs);
  const tpsEma = readFiniteNumber(raw.tpsEma);
  return {
    penaltyScore: Math.max(0, readFiniteNumber(raw.penaltyScore) ?? 0),
    latencyEmaMs: readFiniteNumber(raw.latencyEmaMs),
    transientFailureStreak: Math.max(0, readFiniteInteger(raw.transientFailureStreak) ?? 0),
    lastTransientFailureAtMs: readNullableTimestamp(raw.lastTransientFailureAtMs),
    recentSuccessCount: Math.max(0, readFiniteNumber(raw.recentSuccessCount) ?? 0),
    recentFailureCount: Math.max(0, readFiniteNumber(raw.recentFailureCount) ?? 0),
    recentWindowUpdatedAtMs: Math.max(0, recentWindowUpdatedAtMs),
    breakerLevel: Math.max(0, readFiniteInteger(raw.breakerLevel) ?? 0),
    breakerUntilMs: readNullableTimestamp(raw.breakerUntilMs),
    lastUpdatedAtMs: Math.max(0, lastUpdatedAtMs),
    lastFailureAtMs: readNullableTimestamp(raw.lastFailureAtMs),
    lastSuccessAtMs: readNullableTimestamp(raw.lastSuccessAtMs),
    firstByteEmaMs: firstByteEmaMs != null && firstByteEmaMs >= 0 ? firstByteEmaMs : null,
    firstByteSampleCount: Math.max(0, readFiniteNumber(raw.firstByteSampleCount) ?? 0),
    tpsEma: tpsEma != null && tpsEma > 0 ? tpsEma : null,
    tpsSampleCount: Math.max(0, readFiniteNumber(raw.tpsSampleCount) ?? 0),
  };
}

function cloneSiteRuntimeHealthState(state: SiteRuntimeHealthState): SiteRuntimeHealthState {
  return {
    penaltyScore: state.penaltyScore,
    latencyEmaMs: state.latencyEmaMs,
    transientFailureStreak: state.transientFailureStreak,
    lastTransientFailureAtMs: state.lastTransientFailureAtMs,
    recentSuccessCount: state.recentSuccessCount,
    recentFailureCount: state.recentFailureCount,
    recentWindowUpdatedAtMs: state.recentWindowUpdatedAtMs,
    breakerLevel: state.breakerLevel,
    breakerUntilMs: state.breakerUntilMs,
    lastUpdatedAtMs: state.lastUpdatedAtMs,
    lastFailureAtMs: state.lastFailureAtMs,
    lastSuccessAtMs: state.lastSuccessAtMs,
    firstByteEmaMs: state.firstByteEmaMs,
    firstByteSampleCount: state.firstByteSampleCount,
    tpsEma: state.tpsEma,
    tpsSampleCount: state.tpsSampleCount,
  };
}

function hydrateChannelQualityState(raw: unknown): ChannelQualityState | null {
  if (!isRecord(raw)) return null;

  const lastUpdatedAtMs = readFiniteInteger(raw.lastUpdatedAtMs) ?? Date.now();
  const recentWindowUpdatedAtMs = readFiniteInteger(raw.recentWindowUpdatedAtMs) ?? lastUpdatedAtMs;
  const firstByteEmaMs = readFiniteNumber(raw.firstByteEmaMs);
  const tpsEma = readFiniteNumber(raw.tpsEma);
  return {
    firstByteEmaMs: firstByteEmaMs != null && firstByteEmaMs >= 0 ? firstByteEmaMs : null,
    firstByteSampleCount: Math.max(0, readFiniteNumber(raw.firstByteSampleCount) ?? 0),
    tpsEma: tpsEma != null && tpsEma > 0 ? tpsEma : null,
    tpsSampleCount: Math.max(0, readFiniteNumber(raw.tpsSampleCount) ?? 0),
    recentSuccessCount: Math.max(0, readFiniteNumber(raw.recentSuccessCount) ?? 0),
    recentFailureCount: Math.max(0, readFiniteNumber(raw.recentFailureCount) ?? 0),
    recentWindowUpdatedAtMs: Math.max(0, recentWindowUpdatedAtMs),
    lastUpdatedAtMs: Math.max(0, lastUpdatedAtMs),
  };
}

function getOrCreateRuntimeHealthState<K>(states: Map<K, SiteRuntimeHealthState>, key: K, nowMs = Date.now()): SiteRuntimeHealthState {
  const existing = states.get(key);
  if (!existing) {
    const initial: SiteRuntimeHealthState = {
      penaltyScore: 0,
      latencyEmaMs: null,
      transientFailureStreak: 0,
      lastTransientFailureAtMs: null,
      recentSuccessCount: 0,
      recentFailureCount: 0,
      recentWindowUpdatedAtMs: nowMs,
      breakerLevel: 0,
      breakerUntilMs: null,
      lastUpdatedAtMs: nowMs,
      lastFailureAtMs: null,
      lastSuccessAtMs: null,
      firstByteEmaMs: null,
      firstByteSampleCount: 0,
      tpsEma: null,
      tpsSampleCount: 0,
    };
    states.set(key, initial);
    return initial;
  }

  const nextPenalty = getDecayedSiteRuntimePenalty(existing, nowMs);
  if (nextPenalty !== existing.penaltyScore || existing.lastUpdatedAtMs !== nowMs) {
    existing.penaltyScore = nextPenalty;
    existing.lastUpdatedAtMs = nowMs;
  }
  return existing;
}

function getOrCreateSiteRuntimeHealthState(siteId: number, nowMs = Date.now()): SiteRuntimeHealthState {
  return getOrCreateRuntimeHealthState(siteRuntimeHealthStates, siteId, nowMs);
}

function getSiteModelRuntimeHealthState(siteId: number, modelName?: string | null): SiteRuntimeHealthState | null {
  const modelKey = normalizeModelAlias(modelName || '');
  if (!modelKey) return null;
  return siteModelRuntimeHealthStates.get(siteId)?.get(modelKey) ?? null;
}

function getOrCreateSiteModelRuntimeHealthState(
  siteId: number,
  modelName?: string | null,
  nowMs = Date.now(),
): SiteRuntimeHealthState | null {
  const modelKey = normalizeModelAlias(modelName || '');
  if (!modelKey) return null;
  let modelStates = siteModelRuntimeHealthStates.get(siteId);
  if (!modelStates) {
    modelStates = new Map<string, SiteRuntimeHealthState>();
    siteModelRuntimeHealthStates.set(siteId, modelStates);
  }
  return getOrCreateRuntimeHealthState(modelStates, modelKey, nowMs);
}

function isRuntimeHealthBreakerOpen(state: SiteRuntimeHealthState | null | undefined, nowMs = Date.now()): boolean {
  if (!state) return false;
  return typeof state.breakerUntilMs === 'number' && state.breakerUntilMs > nowMs;
}

function getRuntimeHealthMultiplier(state: SiteRuntimeHealthState | null | undefined, nowMs = Date.now()): number {
  if (!state) return 1;
  if (isRuntimeHealthBreakerOpen(state, nowMs)) {
    return SITE_RUNTIME_MIN_MULTIPLIER;
  }
  // Pure safety floor: failure penalty + breaker. Responsiveness used to be damped
  // here through the total-latency EMA, but that punished channels serving long
  // outputs and double-counted the quality signals that now live in the weighted
  // value score (first-byte / speed components). Ranking slow-but-healthy channels
  // is the weights' job; this multiplier only reacts to failures.
  const penaltyScore = getDecayedSiteRuntimePenalty(state, nowMs);
  return clampNumber(1 / (1 + penaltyScore), SITE_RUNTIME_MIN_MULTIPLIER, 1);
}

function getSiteRuntimeHealthDetails(siteId: number, modelName?: string | null, nowMs = Date.now()): SiteRuntimeHealthDetails {
  const modelKey = normalizeModelAlias(modelName || '');
  const globalState = siteRuntimeHealthStates.get(siteId);
  const modelState = modelKey ? getSiteModelRuntimeHealthState(siteId, modelKey) : null;
  const globalMultiplier = getRuntimeHealthMultiplier(globalState, nowMs);
  const modelMultiplier = modelState ? getRuntimeHealthMultiplier(modelState, nowMs) : 1;
  const globalRecentSnapshot = getRecentOutcomeSnapshot(globalState, nowMs);
  const modelRecentSnapshot = modelState ? getRecentOutcomeSnapshot(modelState, nowMs) : null;
  const recentSnapshot = blendRecentOutcomeSnapshots(globalRecentSnapshot, modelRecentSnapshot);
  // Quality EMAs prefer the model-scoped observation and fall back to the site-global
  // one; confidence follows whichever state actually supplied the value.
  const firstByteSource = modelState?.firstByteEmaMs != null ? modelState : globalState;
  const tpsSource = modelState?.tpsEma != null ? modelState : globalState;
  return {
    globalMultiplier,
    modelMultiplier,
    combinedMultiplier: clampNumber(
      globalMultiplier * modelMultiplier,
      SITE_RUNTIME_MIN_MULTIPLIER * SITE_RUNTIME_MIN_MULTIPLIER,
      1,
    ),
    globalBreakerOpen: isRuntimeHealthBreakerOpen(globalState, nowMs),
    modelBreakerOpen: isRuntimeHealthBreakerOpen(modelState, nowMs),
    modelKey,
    recentSuccessRate: recentSnapshot.successRate,
    recentSampleCount: recentSnapshot.sampleCount,
    recentConfidence: recentSnapshot.confidence,
    firstByteEmaMs: firstByteSource?.firstByteEmaMs ?? null,
    firstByteConfidence: firstByteSource
      ? clampNumber(firstByteSource.firstByteSampleCount / SITE_RUNTIME_SIGNAL_CONFIDENCE_SAMPLES, 0, 1)
      : 0,
    tpsEma: tpsSource?.tpsEma ?? null,
    tpsConfidence: tpsSource
      ? clampNumber(tpsSource.tpsSampleCount / SITE_RUNTIME_SIGNAL_CONFIDENCE_SAMPLES, 0, 1)
      : 0,
  };
}

/**
 * Evidence chain for the weighted first-byte / speed components (step two of the
 * channel-granularity rollout): the channel's own EMA when it has one, else the
 * site-level detail above (model-scoped first, site-global second).
 *
 * Channel-first means a credential with its own measurement is no longer smeared by
 * its siblings' traffic, while a fresh channel inherits the site's evidence instead
 * of starting blind. Confidence follows whichever state actually supplied the value.
 */
type ChannelQualityEmaEvidence = {
  firstByteEmaMs: number | null;
  firstByteConfidence: number;
  tpsEma: number | null;
  tpsConfidence: number;
  /** Where each value came from — the reason string annotates it (·通道 / ·站点). */
  firstByteFromChannel: boolean;
  tpsFromChannel: boolean;
};

function resolveChannelQualityEmaEvidence(
  channelId: number | null | undefined,
  siteDetail: SiteRuntimeHealthDetails,
): ChannelQualityEmaEvidence {
  const channelState = Number.isFinite(channelId ?? NaN)
    ? channelQualityByChannelId.get(Math.trunc(channelId!))
    : undefined;
  const firstByteFromChannel = channelState?.firstByteEmaMs != null;
  const tpsFromChannel = channelState?.tpsEma != null;
  return {
    firstByteEmaMs: firstByteFromChannel ? channelState!.firstByteEmaMs : siteDetail.firstByteEmaMs,
    firstByteConfidence: firstByteFromChannel
      ? clampNumber((channelState?.firstByteSampleCount ?? 0) / SITE_RUNTIME_SIGNAL_CONFIDENCE_SAMPLES, 0, 1)
      : siteDetail.firstByteConfidence,
    tpsEma: tpsFromChannel ? channelState!.tpsEma : siteDetail.tpsEma,
    tpsConfidence: tpsFromChannel
      ? clampNumber((channelState?.tpsSampleCount ?? 0) / SITE_RUNTIME_SIGNAL_CONFIDENCE_SAMPLES, 0, 1)
      : siteDetail.tpsConfidence,
    firstByteFromChannel,
    tpsFromChannel,
  };
}

function applyRuntimeHealthFailure(state: SiteRuntimeHealthState, context: SiteRuntimeFailureContext = {}, nowMs = Date.now()): void {
  refreshRecentOutcomeWindow(state, nowMs);
  state.recentFailureCount += 1;
  state.penaltyScore += resolveSiteRuntimeFailurePenalty(context);
  if (isTransientSiteRuntimeFailure(context)) {
    const lastTransientFailureAtMs = state.lastTransientFailureAtMs;
    const shouldContinueStreak = (
      typeof lastTransientFailureAtMs === 'number'
      && (nowMs - lastTransientFailureAtMs) <= SITE_TRANSIENT_STREAK_WINDOW_MS
    );
    state.transientFailureStreak = shouldContinueStreak
      ? state.transientFailureStreak + 1
      : 1;
    state.lastTransientFailureAtMs = nowMs;
    if (state.transientFailureStreak >= SITE_RUNTIME_BREAKER_STREAK_THRESHOLD) {
      state.breakerLevel = Math.min(state.breakerLevel + 1, SITE_RUNTIME_BREAKER_LEVELS_MS.length - 1);
      const breakerMs = resolveSiteRuntimeBreakerMs(state.breakerLevel);
      state.breakerUntilMs = breakerMs > 0 ? nowMs + breakerMs : null;
      state.transientFailureStreak = 0;
    }
  } else {
    state.transientFailureStreak = 0;
    state.lastTransientFailureAtMs = null;
  }
  state.lastFailureAtMs = nowMs;
}

/**
 * Quality observations carried by a successful proxy request. `firstByteLatencyMs`
 * feeds the responsiveness EMA; `tokensPerSecond` (stream generation throughput)
 * feeds the speed EMA. Both are optional because non-chat surfaces and probes
 * may only observe latency.
 */
export type RuntimeSuccessQualityMetrics = {
  firstByteLatencyMs?: number | null;
  tokensPerSecond?: number | null;
};

/**
 * Read-only, display-facing quality snapshot for one channel. Null fields mean
 * "no sample yet" — the UI renders them as an em dash, never as zero.
 */
export type ChannelQualitySnapshot = {
  firstByteEmaMs: number | null;
  firstByteSampleCount: number;
  tpsEma: number | null;
  tpsSampleCount: number;
  /** Decayed-window success count (30-min half-life); null when the channel has no state. */
  recentSuccessCount: number | null;
  /** Decayed-window failure count (30-min half-life); null when the channel has no state. */
  recentFailureCount: number | null;
  /** Decaying-window success rate with priors; null when the window has no samples. */
  recentSuccessRate: number | null;
  recentSampleCount: number;
  lastUpdatedAtMs: number | null;
};

/**
 * Feed first-byte / throughput observations into a quality EMA host. One implementation
 * for both granularities (site and channel) so their smoothing behaviour cannot drift.
 */
function applyQualityEmaUpdates(state: QualityEmaHost, quality: RuntimeSuccessQualityMetrics): void {
  const firstByteLatencyMs = readFiniteNumber(quality.firstByteLatencyMs);
  if (firstByteLatencyMs != null && firstByteLatencyMs >= 0) {
    const normalizedFirstByteMs = Math.trunc(firstByteLatencyMs);
    state.firstByteEmaMs = state.firstByteEmaMs == null
      ? normalizedFirstByteMs
      : (state.firstByteEmaMs * (1 - SITE_RUNTIME_LATENCY_EMA_ALPHA))
        + (normalizedFirstByteMs * SITE_RUNTIME_LATENCY_EMA_ALPHA);
    state.firstByteSampleCount += 1;
  }
  const tokensPerSecond = readFiniteNumber(quality.tokensPerSecond);
  if (tokensPerSecond != null && tokensPerSecond > 0) {
    state.tpsEma = state.tpsEma == null
      ? tokensPerSecond
      : (state.tpsEma * (1 - SITE_RUNTIME_TPS_EMA_ALPHA))
        + (tokensPerSecond * SITE_RUNTIME_TPS_EMA_ALPHA);
    state.tpsSampleCount += 1;
  }
}

function applyRuntimeHealthSuccess(
  state: SiteRuntimeHealthState,
  latencyMs: number,
  nowMs = Date.now(),
  quality: RuntimeSuccessQualityMetrics = {},
): void {
  refreshRecentOutcomeWindow(state, nowMs);
  state.recentSuccessCount += 1;
  state.penaltyScore = Math.max(0, state.penaltyScore * 0.2 - 0.3);
  state.transientFailureStreak = 0;
  state.lastTransientFailureAtMs = null;
  state.breakerLevel = 0;
  state.breakerUntilMs = null;
  state.lastSuccessAtMs = nowMs;
  const normalizedLatencyMs = Math.max(0, Math.trunc(latencyMs));
  state.latencyEmaMs = state.latencyEmaMs == null
    ? normalizedLatencyMs
    : (state.latencyEmaMs * (1 - SITE_RUNTIME_LATENCY_EMA_ALPHA))
      + (normalizedLatencyMs * SITE_RUNTIME_LATENCY_EMA_ALPHA);
  applyQualityEmaUpdates(state, quality);
}

function shouldPersistSiteRuntimeHealthState(state: SiteRuntimeHealthState, nowMs = Date.now()): boolean {
  const lastTouchedAtMs = Math.max(
    state.lastUpdatedAtMs,
    state.lastFailureAtMs ?? 0,
    state.lastSuccessAtMs ?? 0,
    state.lastTransientFailureAtMs ?? 0,
  );
  if ((nowMs - lastTouchedAtMs) > SITE_RUNTIME_HEALTH_PERSIST_STALE_TTL_MS) {
    return false;
  }

  if (isRuntimeHealthBreakerOpen(state, nowMs)) return true;
  if (getDecayedSiteRuntimePenalty(state, nowMs) >= SITE_RUNTIME_HEALTH_PERSIST_MIN_PENALTY) return true;
  if (getRecentOutcomeSnapshot(state, nowMs).sampleCount > 0.01) return true;
  if ((state.latencyEmaMs ?? 0) > 0) return true;
  return (nowMs - lastTouchedAtMs) <= SITE_RUNTIME_HEALTH_PERSIST_IDLE_TTL_MS;
}

function buildSiteRuntimeHealthPersistencePayload(nowMs = Date.now()): SiteRuntimeHealthPersistencePayload {
  const globalBySiteId: Record<string, SiteRuntimeHealthState> = {};
  const modelBySiteId: Record<string, Record<string, SiteRuntimeHealthState>> = {};
  const channelById: Record<string, ChannelQualityState> = {};

  for (const [siteId, state] of siteRuntimeHealthStates.entries()) {
    if (!shouldPersistSiteRuntimeHealthState(state, nowMs)) continue;
    globalBySiteId[String(siteId)] = cloneSiteRuntimeHealthState(state);
  }

  for (const [siteId, modelStates] of siteModelRuntimeHealthStates.entries()) {
    const persistedModels: Record<string, SiteRuntimeHealthState> = {};
    for (const [modelKey, state] of modelStates.entries()) {
      if (!shouldPersistSiteRuntimeHealthState(state, nowMs)) continue;
      persistedModels[modelKey] = cloneSiteRuntimeHealthState(state);
    }
    if (Object.keys(persistedModels).length > 0) {
      modelBySiteId[String(siteId)] = persistedModels;
    }
  }

  // Channel quality is display-only, so a state untouched for the stale TTL (deleted
  // channels, retired experiments) simply ages out instead of growing the blob.
  for (const [channelId, state] of channelQualityByChannelId.entries()) {
    if ((nowMs - state.lastUpdatedAtMs) > SITE_RUNTIME_HEALTH_PERSIST_STALE_TTL_MS) continue;
    channelById[String(channelId)] = { ...state };
  }

  return {
    version: 1,
    savedAtMs: nowMs,
    globalBySiteId,
    modelBySiteId,
    channelById,
  };
}

async function persistSiteRuntimeHealthState(): Promise<void> {
  if (siteRuntimeHealthPersistInFlight) {
    await siteRuntimeHealthPersistInFlight;
    return;
  }
  const persistTask = (async () => {
    const payload = buildSiteRuntimeHealthPersistencePayload();
    await upsertSetting(SITE_RUNTIME_HEALTH_SETTING_KEY, payload);
  })();
  siteRuntimeHealthPersistInFlight = persistTask.finally(() => {
    if (siteRuntimeHealthPersistInFlight === persistTask) {
      siteRuntimeHealthPersistInFlight = null;
    }
  });
  await siteRuntimeHealthPersistInFlight;
}

function scheduleSiteRuntimeHealthPersistence(): void {
  if (siteRuntimeHealthSaveTimer) return;
  siteRuntimeHealthSaveTimer = setTimeout(() => {
    siteRuntimeHealthSaveTimer = null;
    void persistSiteRuntimeHealthState().catch((error) => {
      console.error('Failed to persist site runtime health state', error);
    });
  }, SITE_RUNTIME_HEALTH_PERSIST_DEBOUNCE_MS);
}

async function loadSiteRuntimeHealthStateFromSettings(): Promise<void> {
  siteRuntimeHealthStates.clear();
  siteModelRuntimeHealthStates.clear();
  channelQualityByChannelId.clear();

  const row = await db.select({ value: schema.settings.value })
    .from(schema.settings)
    .where(eq(schema.settings.key, SITE_RUNTIME_HEALTH_SETTING_KEY))
    .get();
  if (!row?.value) return;

  let parsed: unknown;
  try {
    parsed = JSON.parse(row.value);
  } catch {
    return;
  }
  if (!isRecord(parsed)) return;

  const globalBySiteId = isRecord(parsed.globalBySiteId) ? parsed.globalBySiteId : {};
  for (const [siteIdKey, stateRaw] of Object.entries(globalBySiteId)) {
    const siteId = Number(siteIdKey);
    if (!Number.isFinite(siteId) || siteId <= 0) continue;
    const state = hydrateSiteRuntimeHealthState(stateRaw);
    if (!state) continue;
    siteRuntimeHealthStates.set(siteId, state);
  }

  const modelBySiteId = isRecord(parsed.modelBySiteId) ? parsed.modelBySiteId : {};
  for (const [siteIdKey, modelStatesRaw] of Object.entries(modelBySiteId)) {
    const siteId = Number(siteIdKey);
    if (!Number.isFinite(siteId) || siteId <= 0 || !isRecord(modelStatesRaw)) continue;
    const hydratedModelStates = new Map<string, SiteRuntimeHealthState>();
    for (const [rawModelKey, stateRaw] of Object.entries(modelStatesRaw)) {
      const modelKey = normalizeModelAlias(rawModelKey);
      if (!modelKey) continue;
      const state = hydrateSiteRuntimeHealthState(stateRaw);
      if (!state) continue;
      hydratedModelStates.set(modelKey, state);
    }
    if (hydratedModelStates.size > 0) {
      siteModelRuntimeHealthStates.set(siteId, hydratedModelStates);
    }
  }

  const channelById = isRecord(parsed.channelById) ? parsed.channelById : {};
  for (const [channelIdKey, stateRaw] of Object.entries(channelById)) {
    const channelId = Number(channelIdKey);
    if (!Number.isFinite(channelId) || channelId <= 0) continue;
    const state = hydrateChannelQualityState(stateRaw);
    if (!state) continue;
    channelQualityByChannelId.set(channelId, state);
  }
}

async function ensureSiteRuntimeHealthStateLoaded(): Promise<void> {
  if (siteRuntimeHealthLoaded) return;
  if (!siteRuntimeHealthLoadPromise) {
    siteRuntimeHealthLoadPromise = (async () => {
      try {
        await loadSiteRuntimeHealthStateFromSettings();
        siteRuntimeHealthLoaded = true;
      } catch (error) {
        console.warn('Failed to restore site runtime health state from settings', error);
        siteRuntimeHealthLoadPromise = null;
        siteRuntimeHealthLoaded = false;
      }
    })();
  }
  await siteRuntimeHealthLoadPromise;
}

function recordSiteRuntimeFailure(siteId: number, context: SiteRuntimeFailureContext = {}, nowMs = Date.now()): void {
  if (!isExemptTimeoutFailure(context)) {
    applyRuntimeHealthFailure(getOrCreateSiteRuntimeHealthState(siteId, nowMs), context, nowMs);
    const modelState = getOrCreateSiteModelRuntimeHealthState(siteId, context.modelName, nowMs);
    if (modelState) {
      applyRuntimeHealthFailure(modelState, context, nowMs);
    }
  }
  scheduleSiteRuntimeHealthPersistence();
}

function recordSiteRuntimeSuccess(
  siteId: number,
  latencyMs: number,
  modelName?: string | null,
  quality: RuntimeSuccessQualityMetrics = {},
  nowMs = Date.now(),
): void {
  applyRuntimeHealthSuccess(getOrCreateSiteRuntimeHealthState(siteId, nowMs), latencyMs, nowMs, quality);
  const modelState = getOrCreateSiteModelRuntimeHealthState(siteId, modelName, nowMs);
  if (modelState) {
    applyRuntimeHealthSuccess(modelState, latencyMs, nowMs, quality);
  }
  scheduleSiteRuntimeHealthPersistence();
}

function getOrCreateChannelQualityState(channelId: number, nowMs = Date.now()): ChannelQualityState {
  const existing = channelQualityByChannelId.get(channelId);
  if (existing) return existing;
  const initial: ChannelQualityState = {
    firstByteEmaMs: null,
    firstByteSampleCount: 0,
    tpsEma: null,
    tpsSampleCount: 0,
    recentSuccessCount: 0,
    recentFailureCount: 0,
    recentWindowUpdatedAtMs: nowMs,
    lastUpdatedAtMs: nowMs,
  };
  channelQualityByChannelId.set(channelId, initial);
  return initial;
}

/**
 * Display-only success bookkeeping for the channel the request actually ran on. A
 * usage/rate-limit failure COUNTS here even though the site-level health deliberately
 * ignores it (line-level comment at the call sites): being throttled is exactly the
 * kind of per-credential divergence this panel exists to surface.
 */
function recordChannelQualitySuccess(
  channelId: number,
  quality: RuntimeSuccessQualityMetrics = {},
  nowMs = Date.now(),
): void {
  const state = getOrCreateChannelQualityState(channelId, nowMs);
  refreshRecentOutcomeWindow(state, nowMs);
  state.recentSuccessCount += 1;
  state.lastUpdatedAtMs = nowMs;
  applyQualityEmaUpdates(state, quality);
  scheduleSiteRuntimeHealthPersistence();
}

/**
 * Display-only failure bookkeeping. Exempt first-byte timeouts are skipped, mirroring
 * the site-level rule: a timeout within budget policy is not evidence about health.
 */
function recordChannelQualityFailure(channelId: number, context: SiteRuntimeFailureContext, nowMs = Date.now()): void {
  if (isExemptTimeoutFailure(context)) return;
  const state = getOrCreateChannelQualityState(channelId, nowMs);
  refreshRecentOutcomeWindow(state, nowMs);
  state.recentFailureCount += 1;
  state.lastUpdatedAtMs = nowMs;
  scheduleSiteRuntimeHealthPersistence();
}

export function resetSiteRuntimeHealthState(): void {
  siteRuntimeHealthStates.clear();
  siteModelRuntimeHealthStates.clear();
  channelQualityByChannelId.clear();
  stableFirstObservationProgressByKey.clear();
  stableFirstObservationSiteCooldownByKey.clear();
  siteRuntimeHealthLoaded = false;
  siteRuntimeHealthLoadPromise = null;
  if (siteRuntimeHealthSaveTimer) {
    clearTimeout(siteRuntimeHealthSaveTimer);
    siteRuntimeHealthSaveTimer = null;
  }
  siteRuntimeHealthPersistInFlight = null;
}

export async function flushSiteRuntimeHealthPersistence(): Promise<void> {
  if (siteRuntimeHealthSaveTimer) {
    clearTimeout(siteRuntimeHealthSaveTimer);
    siteRuntimeHealthSaveTimer = null;
    await persistSiteRuntimeHealthState();
    return;
  }
  if (siteRuntimeHealthPersistInFlight) {
    await siteRuntimeHealthPersistInFlight;
  }
}

/**
 * `scope: 'site'` drops the whole site's runtime health as well as the per-model entries —
 * correct for a route-wide clear, where the intent is "forget everything about this route".
 * `scope: 'model'` keeps the site-level penalty/breaker intact and only forgets the models
 * the given channels serve, so releasing ONE channel cannot silently reset a site-wide
 * breaker that other routes are still relying on.
 */
function clearRuntimeHealthStatesForChannels(rows: Array<{
  siteId: number;
  sourceModel: string | null;
  routeModelPattern: string;
}>, scope: 'site' | 'model' = 'site'): boolean {
  let changed = false;
  const modelKeysBySiteId = new Map<number, Set<string>>();

  for (const row of rows) {
    if (scope === 'site' && siteRuntimeHealthStates.delete(row.siteId)) {
      changed = true;
    }

    const resolvedModelName = normalizeChannelSourceModel(row.sourceModel)
      || (isExactRouteModelPattern(row.routeModelPattern) ? row.routeModelPattern.trim() : '');
    const modelKey = normalizeModelAlias(resolvedModelName);
    if (!modelKey) continue;
    if (!modelKeysBySiteId.has(row.siteId)) {
      modelKeysBySiteId.set(row.siteId, new Set());
    }
    modelKeysBySiteId.get(row.siteId)!.add(modelKey);
  }

  for (const [siteId, modelKeys] of modelKeysBySiteId.entries()) {
    const modelStates = siteModelRuntimeHealthStates.get(siteId);
    if (!modelStates) continue;
    for (const modelKey of modelKeys) {
      if (modelStates.delete(modelKey)) {
        changed = true;
      }
    }
    if (modelStates.size === 0) {
      siteModelRuntimeHealthStates.delete(siteId);
    }
  }

  return changed;
}

export function getSiteRuntimeHealthMultiplier(siteId: number, nowMs = Date.now()): number {
  const state = siteRuntimeHealthStates.get(siteId);
  return getRuntimeHealthMultiplier(state, nowMs);
}

export function isSiteRuntimeBreakerOpen(siteId: number, nowMs = Date.now()): boolean {
  const state = siteRuntimeHealthStates.get(siteId);
  return isRuntimeHealthBreakerOpen(state, nowMs);
}

export function filterSiteRuntimeBrokenCandidates<T extends { site: { id: number } }>(
  candidates: T[],
  nowMs = Date.now(),
): T[] {
  if (candidates.length <= 1) return candidates;
  const healthy = candidates.filter((candidate) => !isSiteRuntimeBreakerOpen(candidate.site.id, nowMs));
  return healthy.length > 0 ? healthy : candidates;
}

function buildRuntimeBreakerReason(details: SiteRuntimeHealthDetails): string {
  if (details.globalBreakerOpen && details.modelBreakerOpen) {
    return '站点熔断中，模型熔断中，优先避让';
  }
  if (details.globalBreakerOpen) {
    return '站点熔断中，优先避让';
  }
  if (details.modelBreakerOpen) {
    return '模型熔断中，优先避让';
  }
  return '运行时熔断中，优先避让';
}

function filterSiteRuntimeBrokenCandidatesByModel(
  candidates: RouteChannelCandidate[],
  modelName: string | ((candidate: RouteChannelCandidate) => string),
  nowMs = Date.now(),
): {
  candidates: RouteChannelCandidate[];
  avoided: Array<{ candidate: RouteChannelCandidate; reason: string }>;
} {
  if (candidates.length <= 1) {
    return {
      candidates,
      avoided: [],
    };
  }

  const resolveModelName = typeof modelName === 'function'
    ? modelName
    : (() => modelName);
  const avoided: Array<{ candidate: RouteChannelCandidate; reason: string }> = [];
  const healthy = candidates.filter((candidate) => {
    const details = getSiteRuntimeHealthDetails(candidate.site.id, resolveModelName(candidate), nowMs);
    const blocked = details.globalBreakerOpen || details.modelBreakerOpen;
    if (blocked) {
      avoided.push({
        candidate,
        reason: buildRuntimeBreakerReason(details),
      });
    }
    return !blocked;
  });

  return healthy.length > 0
    ? {
      candidates: healthy,
      avoided,
    }
    : {
      candidates,
      avoided: [],
    };
}

type RouteRow = typeof schema.tokenRoutes.$inferSelect & {
  routeMode: RouteMode;
  sourceRouteIds: number[];
};
type ChannelRow = typeof schema.routeChannels.$inferSelect;

type RouteCacheSnapshot = {
  loadedAt: number;
  routes: RouteRow[];
};

type RouteMatchCacheSnapshot = {
  loadedAt: number;
  match: RouteMatch;
};

let routeCacheSnapshot: RouteCacheSnapshot = {
  loadedAt: 0,
  routes: [],
};

const routeMatchCache = new Map<number, RouteMatchCacheSnapshot>();

function resolveTokenRouterCacheTtlMs(): number {
  const raw = Math.trunc(config.tokenRouterCacheTtlMs || 0);
  return Math.max(100, raw);
}

function isCacheFresh(loadedAt: number, nowMs: number): boolean {
  return nowMs - loadedAt < resolveTokenRouterCacheTtlMs();
}

async function loadEnabledRoutes(nowMs = Date.now()): Promise<RouteRow[]> {
  if (isCacheFresh(routeCacheSnapshot.loadedAt, nowMs)) {
    return routeCacheSnapshot.routes;
  }

  const rawRoutes = await db.select().from(schema.tokenRoutes)
    .where(eq(schema.tokenRoutes.enabled, true))
    .all();
  const explicitGroupRouteIds = rawRoutes
    .filter((route) => normalizeRouteMode(route.routeMode) === 'explicit_group')
    .map((route) => route.id);
  const sourceRows = explicitGroupRouteIds.length > 0
    ? await db.select().from(schema.routeGroupSources)
      .where(inArray(schema.routeGroupSources.groupRouteId, explicitGroupRouteIds))
      .all()
    : [];
  const sourceIdsByRouteId = new Map<number, number[]>();
  for (const row of sourceRows) {
    if (!sourceIdsByRouteId.has(row.groupRouteId)) {
      sourceIdsByRouteId.set(row.groupRouteId, []);
    }
    sourceIdsByRouteId.get(row.groupRouteId)!.push(row.sourceRouteId);
  }
  const routes = rawRoutes.map((route) => ({
    ...route,
    routeMode: normalizeRouteMode(route.routeMode),
    sourceRouteIds: Array.from(new Set(sourceIdsByRouteId.get(route.id) ?? [])),
  }));
  routeCacheSnapshot = {
    loadedAt: nowMs,
    routes,
  };
  return routes;
}

async function loadRouteMatch(route: RouteRow, nowMs = Date.now()): Promise<RouteMatch> {
  const cached = routeMatchCache.get(route.id);
  if (cached && isCacheFresh(cached.loadedAt, nowMs)) {
    return cached.match;
  }

  const enabledRoutes = await loadEnabledRoutes(nowMs);
  const routeIds = (() => {
    if (!isExplicitGroupRoute(route)) {
      return [route.id];
    }
    return Array.from(new Set(route.sourceRouteIds.filter((routeId) => Number.isFinite(routeId) && routeId > 0)));
  })();
  const enabledSourceRoutes = isExplicitGroupRoute(route)
    ? enabledRoutes.filter((item) => (
      routeIds.includes(item.id)
      && !isExplicitGroupRoute(item)
      && isExactRouteModelPattern(item.modelPattern)
    ))
    : enabledRoutes.filter((item) => routeIds.includes(item.id));
  const enabledSourceRouteIds = enabledSourceRoutes.map((item) => item.id);
  const fallbackSourceModelByRouteId = new Map<number, string>(
    enabledSourceRoutes
      .filter((item) => isExactRouteModelPattern(item.modelPattern))
      .map((item) => [item.id, (item.modelPattern || '').trim()]),
  );
  const channels = enabledSourceRouteIds.length > 0
    ? await db
      .select()
      .from(schema.routeChannels)
      .innerJoin(schema.accounts, eq(schema.routeChannels.accountId, schema.accounts.id))
      .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
      .leftJoin(schema.accountTokens, eq(schema.routeChannels.tokenId, schema.accountTokens.id))
      .where(inArray(schema.routeChannels.routeId, enabledSourceRouteIds))
      .all()
    : [];

  const oauthRouteUnitIds: number[] = Array.from(new Set<number>(
    channels
      .map((row) => Number(row.route_channels.oauthRouteUnitId))
      .filter((id): id is number => Number.isFinite(id) && id > 0),
  ));
  const [routeUnitSummaries, routeUnitMembersByUnitId] = await Promise.all([
    loadOauthRouteUnitSummariesByIds(oauthRouteUnitIds),
    listOauthRouteUnitMembersByUnitIds(oauthRouteUnitIds),
  ]);

  const mapped = channels.map((row) => ({
    channel: {
      ...row.route_channels,
      sourceModel: normalizeChannelSourceModel(row.route_channels.sourceModel)
        || fallbackSourceModelByRouteId.get(row.route_channels.routeId)
        || null,
    },
    account: row.accounts,
    site: row.sites,
    token: row.account_tokens,
    routeUnit: row.route_channels.oauthRouteUnitId
      ? (routeUnitSummaries.get(row.route_channels.oauthRouteUnitId) || null)
      : null,
    routeUnitMembers: row.route_channels.oauthRouteUnitId
      ? (routeUnitMembersByUnitId.get(row.route_channels.oauthRouteUnitId) || []).map((member) => ({
        member: member.member,
        account: member.account,
        site: member.site,
        token: null,
      }))
      : [],
  }));

  const match = { route, channels: mapped };
  routeMatchCache.set(route.id, {
    loadedAt: nowMs,
    match,
  });
  return match;
}

function patchCachedChannel(channelId: number, apply: (channel: ChannelRow) => void): void {
  for (const entry of routeMatchCache.values()) {
    const target = entry.match.channels.find((item) => item.channel.id === channelId);
    if (!target) continue;
    apply(target.channel);
    break;
  }
}

function clearStableFirstCachesForRoute(routeId: number): void {
  const routePrefix = `${routeId}:`;
  for (const key of stableFirstLastSelectedSiteByKey.keys()) {
    if (key.startsWith(routePrefix)) {
      stableFirstLastSelectedSiteByKey.delete(key);
    }
  }
  for (const key of stableFirstObservationProgressByKey.keys()) {
    if (key.startsWith(routePrefix)) {
      stableFirstObservationProgressByKey.delete(key);
    }
  }
  for (const key of stableFirstObservationSiteCooldownByKey.keys()) {
    if (key.startsWith(routePrefix)) {
      stableFirstObservationSiteCooldownByKey.delete(key);
    }
  }
}

function invalidateRouteScopedCache(routeId: number): void {
  if (!Number.isFinite(routeId) || routeId <= 0) return;
  routeMatchCache.delete(routeId);
  clearStableFirstCachesForRoute(routeId);
}

export function invalidateTokenRouterCache(): void {
  routeCacheSnapshot = {
    loadedAt: 0,
    routes: [],
  };
  routeMatchCache.clear();
  stableFirstLastSelectedSiteByKey.clear();
  stableFirstObservationProgressByKey.clear();
  stableFirstObservationSiteCooldownByKey.clear();
}

function isSiteDisabled(status?: string | null): boolean {
  return (status || 'active') === 'disabled';
}

/**
 * Soft avoidance: a channel that failed this recently is deprioritised while a healthy
 * sibling exists, but it is NOT excluded — `filterRecentlyFailedCandidates` hands the
 * whole pool back when every candidate is in this state.
 *
 * This window is clamped by its own ceiling rather than the hard-cooldown ceiling, which
 * is the operator's answer to a different question. `tokenRouterFailureCooldownMaxSec`
 * bounds how long a channel may be taken OUT of rotation; raising it to tolerate long
 * provider quota windows used to also stretch this preference window to the same length,
 * so a single failure could make a channel the last resort for days even though it was
 * never actually cooling. Keeping the two apart lets a long hard cap coexist with a
 * preference hint that expires on a routing-decision timescale.
 */
export function isChannelRecentlyFailed(
  channel: FailureAwareChannel,
  nowMs = Date.now(),
  avoidSec = resolveFailureBackoffSec(resolveChannelFailureStreak(channel)),
): boolean {
  const avoidMs = clampSoftAvoidanceMs(avoidSec * 1000);
  if (avoidMs <= 0) return false;
  if (resolveChannelFailureStreak(channel) <= 0) return false;
  if (!channel.lastFailAt) return false;

  const failTs = Date.parse(channel.lastFailAt);
  if (Number.isNaN(failTs)) return false;

  return nowMs - failTs < avoidMs;
}

export function filterRecentlyFailedCandidates<T extends { channel: FailureAwareChannel }>(
  candidates: T[],
  nowMs = Date.now(),
  avoidSec?: number,
): T[] {
  if (candidates.length <= 1) return candidates;
  if (avoidSec != null && avoidSec <= 0) return candidates;

  const healthy = candidates.filter((candidate) => !isChannelRecentlyFailed(candidate.channel, nowMs, avoidSec));
  // If all channels failed recently, keep them all and let weight/random decide.
  return healthy.length > 0 ? healthy : candidates;
}

export type RouteDecisionExplanation = RouteDecision & {
  routeId?: number;
  modelPattern?: string;
  selectedAccountId?: number;
};

const DEFAULT_DOWNSTREAM_POLICY: DownstreamRoutingPolicy = EMPTY_DOWNSTREAM_ROUTING_POLICY;

type ExplainSelectionOptions = {
  excludeChannelIds?: number[];
  bypassSourceModelCheck?: boolean;
  useChannelSourceModelForCost?: boolean;
  downstreamPolicy?: DownstreamRoutingPolicy;
};

type PricingReferenceRefreshOptions = {
  useChannelSourceModelForCost?: boolean;
  downstreamPolicy?: DownstreamRoutingPolicy;
  refreshedKeys?: Set<string>;
};

type CandidateEligibilityOptions = {
  requestedModel: string;
  bypassSourceModelCheck?: boolean;
  excludeChannelIds?: number[];
  nowIso?: string;
  downstreamPolicy?: DownstreamRoutingPolicy;
};

type CostSignal = {
  unitCost: number;
  source: 'observed' | 'configured' | 'catalog' | 'fallback';
};

export function isRegexModelPattern(pattern: string): boolean {
  return isTokenRouteRegexPattern(pattern);
}

export function parseRegexModelPattern(pattern: string): { test(value: string): boolean } | null {
  return parseTokenRouteRegexPattern(pattern).regex;
}

export function matchesModelPattern(model: string, pattern: string): boolean {
  // Exact match: case-insensitive so that e.g. "Deepseek-V4-pro" matches route "deepseek-v4-pro".
  if (model.toLowerCase() === pattern.toLowerCase()) return true;
  return matchesTokenRouteModelPattern(model, pattern);
}

function isExactRouteModelPattern(pattern: string): boolean {
  return isExactTokenRouteModelPattern(pattern);
}

function normalizeRouteMode(routeMode: string | null | undefined): RouteMode {
  return normalizeTokenRouteMode(routeMode);
}

function isExplicitGroupRoute(route: Pick<RouteRow, 'routeMode'> | Pick<typeof schema.tokenRoutes.$inferSelect, 'routeMode'>): boolean {
  return normalizeRouteMode(route.routeMode) === 'explicit_group';
}

function normalizeRouteDisplayName(displayName: string | null | undefined): string {
  return (displayName || '').trim();
}

function isRouteDisplayNameMatch(model: string, displayName: string | null | undefined): boolean {
  const alias = normalizeRouteDisplayName(displayName);
  return !!alias && alias === model;
}

function matchesRouteRequestModel(model: string, route: RouteRow): boolean {
  if (isExplicitGroupRoute(route)) {
    return isRouteDisplayNameMatch(model, route.displayName);
  }
  return matchesModelPattern(model, route.modelPattern) || isRouteDisplayNameMatch(model, route.displayName);
}

function getExposedModelNameForRoute(route: RouteRow): string {
  return normalizeRouteDisplayName(route.displayName) || route.modelPattern;
}

function hasCustomDisplayName(route: Pick<RouteRow, 'modelPattern' | 'displayName'>): boolean {
  const displayName = normalizeRouteDisplayName(route.displayName);
  const modelPattern = (route.modelPattern || '').trim();
  return !!displayName && displayName !== modelPattern;
}

function buildVisibleEnabledRoutes(routes: RouteRow[]): RouteRow[] {
  const exactModelNames = new Set(
    routes
      .filter((route) => (
        !isExplicitGroupRoute(route)
        && isExactRouteModelPattern(route.modelPattern)
        && !!normalizeRouteDisplayName(route.displayName)
      ))
      .map((route) => (route.modelPattern || '').trim().toLowerCase())
      .filter(Boolean),
  );
  const coveringGroups = routes.filter((route) => (
    route.enabled
    && (
      (isExplicitGroupRoute(route) && normalizeRouteDisplayName(route.displayName).length > 0 && route.sourceRouteIds.length > 0)
      || (!isExplicitGroupRoute(route) && !isExactRouteModelPattern(route.modelPattern) && hasCustomDisplayName(route))
    )
  ));

  if (coveringGroups.length === 0) return routes;

  return routes.filter((route) => {
    if (isExplicitGroupRoute(route)) {
      return normalizeRouteDisplayName(route.displayName).length > 0;
    }
    if (!isExactRouteModelPattern(route.modelPattern)) return true;
    if (hasCustomDisplayName(route)) return true;

    const exactModel = (route.modelPattern || '').trim();
    if (!exactModel) return true;

    return !coveringGroups.some((groupRoute) => {
      if (groupRoute.id === route.id) return false;
      const groupDisplayName = normalizeRouteDisplayName(groupRoute.displayName);
      if (
        !groupDisplayName
        || exactModelNames.has(groupDisplayName.toLowerCase())
        // A pattern alias that is identical to an unnamed exact route cannot
        // replace that route in dispatch: findRoute() gives exact matches
        // precedence. Keep the exact route visible so the UI reflects this.
        || (
          !isExplicitGroupRoute(groupRoute)
          && groupDisplayName.toLowerCase() === exactModel.toLowerCase()
        )
      ) return false;
      if (isExplicitGroupRoute(groupRoute)) {
        return groupRoute.sourceRouteIds.includes(route.id);
      }
      return matchesModelPattern(exactModel, groupRoute.modelPattern);
    });
  });
}

export function normalizeModelAlias(modelName: string): string {
  const normalized = (modelName || '').trim().toLowerCase();
  if (!normalized) return '';
  const slashIndex = normalized.lastIndexOf('/');
  if (slashIndex >= 0 && slashIndex < normalized.length - 1) {
    return normalized.slice(slashIndex + 1);
  }
  return normalized;
}

function isModelAliasEquivalent(left: string, right: string): boolean {
  const a = normalizeModelAlias(left);
  const b = normalizeModelAlias(right);
  return !!a && !!b && a === b;
}

function channelSupportsRequestedModel(channelSourceModel: string | null | undefined, requestedModel: string): boolean {
  const source = (channelSourceModel || '').trim();
  if (!source) return true;
  if (source === requestedModel) return true;
  if (isModelAliasEquivalent(source, requestedModel)) return true;
  if (matchesModelPattern(requestedModel, source)) return true;
  return false;
}

function isModelAllowedByDownstreamPolicy(requestedModel: string, policy: DownstreamRoutingPolicy): boolean {
  const supportedPatterns = Array.isArray(policy.supportedModels)
    ? policy.supportedModels
    : [];
  const hasSupportedPatterns = supportedPatterns.length > 0;
  const hasAllowedRoutes = policy.allowedRouteIds.length > 0;
  if (!hasSupportedPatterns && !hasAllowedRoutes) return policy.denyAllWhenEmpty === true ? false : true;
  const matchedSupportedPattern = supportedPatterns.some((pattern) => matchesModelPattern(requestedModel, pattern));
  if (matchedSupportedPattern) return true;
  if (hasAllowedRoutes) return true;
  return false;
}

function parseModelMappingRecord(modelMapping?: string | Record<string, unknown> | null): Record<string, unknown> | null {
  if (!modelMapping) return null;
  if (typeof modelMapping === 'object' && !Array.isArray(modelMapping)) {
    return modelMapping as Record<string, unknown>;
  }
  if (typeof modelMapping !== 'string') return null;
  try {
    const parsed = JSON.parse(modelMapping);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function resolveMappedModel(requestedModel: string, modelMapping?: string | Record<string, unknown> | null): string {
  const parsed = parseModelMappingRecord(modelMapping);
  if (!parsed) return requestedModel;

  const entries = Object.entries(parsed)
    .filter(([, value]) => typeof value === 'string' && value.trim().length > 0) as Array<[string, string]>;

  const exact = entries.find(([pattern]) => pattern === requestedModel);
  if (exact) return exact[1].trim();

  for (const [pattern, target] of entries) {
    if (matchesModelPattern(requestedModel, pattern)) {
      return target.trim();
    }
  }

  return requestedModel;
}

function normalizeChannelSourceModel(channelSourceModel: string | null | undefined): string {
  return (channelSourceModel || '').trim();
}

function resolveActualModelForSelectedChannel(
  requestedModel: string,
  route: RouteRow,
  mappedModel: string,
  channelSourceModel: string | null | undefined,
): string {
  const sourceModel = normalizeChannelSourceModel(channelSourceModel);
  // Prefer the channel's own source model (original case from the upstream) so that
  // e.g. client-visible "deepseek-v4-pro" maps back to "DeepSeek-V4-pro" on upstream A
  // and "deepseek-v4-pro" on upstream B.
  if (sourceModel) {
    return sourceModel;
  }
  if (isRouteDisplayNameMatch(requestedModel, route.displayName) && sourceModel) {
    return sourceModel;
  }
  return mappedModel;
}

function resolveRouteStrategy(route: RouteRow): RouteRoutingStrategy {
  return normalizeRouteRoutingStrategy(route.routingStrategy);
}

function parseIsoTimeMs(value?: string | null): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function compareNullableTimeAsc(left?: string | null, right?: string | null): number {
  const leftMs = parseIsoTimeMs(left);
  const rightMs = parseIsoTimeMs(right);
  if (leftMs == null && rightMs == null) return 0;
  if (leftMs == null) return -1;
  if (rightMs == null) return 1;
  return leftMs - rightMs;
}

function compareNullableTimeDesc(left?: string | null, right?: string | null): number {
  return compareNullableTimeAsc(right, left);
}

function isOauthRouteUnitCandidate(candidate: RouteChannelCandidate): boolean {
  return !!candidate.routeUnit || !!candidate.channel.oauthRouteUnitId;
}

function isOauthRouteUnitMemberCoolingDown(
  member: typeof schema.oauthRouteUnitMembers.$inferSelect,
  nowIso: string,
): boolean {
  return !!member.cooldownUntil && member.cooldownUntil > nowIso;
}

function compareStableFirstCandidateOrder(left: RouteChannelCandidate, right: RouteChannelCandidate): number {
  const selectionOrder = compareNullableTimeAsc(
    left.channel.lastSelectedAt || left.channel.lastUsedAt,
    right.channel.lastSelectedAt || right.channel.lastUsedAt,
  );
  if (selectionOrder !== 0) return selectionOrder;

  const usedOrder = compareNullableTimeAsc(left.channel.lastUsedAt, right.channel.lastUsedAt);
  if (usedOrder !== 0) return usedOrder;

  return (left.channel.id ?? 0) - (right.channel.id ?? 0);
}

function resolveChannelRuntimeLoadMultiplier(snapshot: ProxyChannelLoadSnapshot): number {
  if (!snapshot.sessionScoped || snapshot.concurrencyLimit <= 0) return 1;

  const activeRatio = clampNumber(snapshot.activeLeaseCount / Math.max(1, snapshot.concurrencyLimit), 0, 1.5);
  const waitingRatio = clampNumber(snapshot.waitingCount / Math.max(1, snapshot.concurrencyLimit), 0, 3);
  const activePenalty = activeRatio * 0.28;
  const waitingPenalty = waitingRatio * 0.32;
  const saturationPenalty = snapshot.saturated ? 0.12 : 0;
  return clampNumber(1 - activePenalty - waitingPenalty - saturationPenalty, 0.18, 1);
}

function formatChannelRuntimeLoad(snapshot: ProxyChannelLoadSnapshot): string {
  if (!snapshot.sessionScoped || snapshot.concurrencyLimit <= 0) {
    return '未限流';
  }
  const multiplier = resolveChannelRuntimeLoadMultiplier(snapshot);
  return `${multiplier.toFixed(2)}（活跃=${snapshot.activeLeaseCount}/${snapshot.concurrencyLimit}，等待=${snapshot.waitingCount}）`;
}

function resolveEffectiveUnitCost(candidate: RouteChannelCandidate, modelName: string): CostSignal {
  const successCount = Math.max(0, candidate.channel.successCount ?? 0);
  const totalCost = Math.max(0, candidate.channel.totalCost ?? 0);
  const configured = candidate.account.unitCost ?? null;

  if (successCount > 0 && totalCost > 0) {
    return {
      unitCost: Math.max(totalCost / successCount, MIN_EFFECTIVE_UNIT_COST),
      source: 'observed',
    };
  }

  if (typeof configured === 'number' && Number.isFinite(configured) && configured > 0) {
    return {
      unitCost: Math.max(configured, MIN_EFFECTIVE_UNIT_COST),
      source: 'configured',
    };
  }

  const catalogCost = getCachedModelRoutingReferenceCost({
    siteId: candidate.site.id,
    accountId: candidate.account.id,
    modelName,
  });
  if (typeof catalogCost === 'number' && Number.isFinite(catalogCost) && catalogCost > 0) {
    return {
      unitCost: Math.max(catalogCost, MIN_EFFECTIVE_UNIT_COST),
      source: 'catalog',
    };
  }

  return {
    unitCost: Math.max(config.routingFallbackUnitCost || 1, MIN_EFFECTIVE_UNIT_COST),
    source: 'fallback',
  };
}

type SiteHistoricalHealthMetrics = {
  multiplier: number;
  totalCalls: number;
  successRate: number | null;
  avgLatencyMs: number | null;
};

function buildSiteHistoricalHealthMetrics(candidates: RouteChannelCandidate[]): Map<number, SiteHistoricalHealthMetrics> {
  const totals = new Map<number, {
    totalCalls: number;
    successCount: number;
    failCount: number;
    totalLatencyMs: number;
    latencySamples: number;
  }>();

  for (const candidate of candidates) {
    const siteId = candidate.site.id;
    if (!totals.has(siteId)) {
      totals.set(siteId, {
        totalCalls: 0,
        successCount: 0,
        failCount: 0,
        totalLatencyMs: 0,
        latencySamples: 0,
      });
    }
    const target = totals.get(siteId)!;
    const successCount = Math.max(0, candidate.channel.successCount ?? 0);
    const failCount = Math.max(0, candidate.channel.failCount ?? 0);
    target.successCount += successCount;
    target.failCount += failCount;
    target.totalCalls += successCount + failCount;
    if (successCount > 0) {
      target.totalLatencyMs += Math.max(0, candidate.channel.totalLatencyMs ?? 0);
      target.latencySamples += successCount;
    }
  }

  const metrics = new Map<number, SiteHistoricalHealthMetrics>();
  for (const [siteId, total] of totals.entries()) {
    if (total.totalCalls <= 0) {
      metrics.set(siteId, {
        multiplier: 1,
        totalCalls: 0,
        successRate: null,
        avgLatencyMs: null,
      });
      continue;
    }

    const sampleFactor = clampNumber(total.totalCalls / SITE_HISTORICAL_HEALTH_MAX_SAMPLE, 0, 1);
    const successRate = total.successCount / total.totalCalls;
    const successPenaltyFactor = 1 - ((1 - successRate) * 0.55 * sampleFactor);
    const avgLatencyMs = total.latencySamples > 0
      ? Math.round(total.totalLatencyMs / total.latencySamples)
      : null;
    const latencyPenaltyRatio = avgLatencyMs == null
      ? 0
      : clampNumber(
        (avgLatencyMs - SITE_HISTORICAL_LATENCY_BASELINE_MS) / SITE_HISTORICAL_LATENCY_WINDOW_MS,
        0,
        1,
      ) * sampleFactor;
    const latencyFactor = 1 - (latencyPenaltyRatio * SITE_HISTORICAL_MAX_LATENCY_PENALTY);
    metrics.set(siteId, {
      multiplier: clampNumber(
        successPenaltyFactor * latencyFactor,
        SITE_HISTORICAL_HEALTH_MIN_MULTIPLIER,
        1,
      ),
      totalCalls: total.totalCalls,
      successRate,
      avgLatencyMs,
    });
  }

  return metrics;
}

function buildStableFirstPoolPlan(
  candidates: RouteChannelCandidate[],
  modelName: string | ((candidate: RouteChannelCandidate) => string),
  nowMs = Date.now(),
): StableFirstPoolPlan {
  if (candidates.length <= 0) {
    return {
      primaryCandidates: [],
      observationCandidates: [],
      primarySiteIds: new Set<number>(),
      observationSiteIds: new Set<number>(),
      siteStateById: new Map<number, StableFirstSitePoolState>(),
    };
  }

  const resolveModelName = typeof modelName === 'function'
    ? modelName
    : (() => modelName);
  const historicalBySiteId = buildSiteHistoricalHealthMetrics(candidates);
  const leaderBySiteId = new Map<number, RouteChannelCandidate>();
  const siteStateById = new Map<number, StableFirstSitePoolState>();

  for (const candidate of candidates) {
    const siteId = candidate.site.id;
    const currentLeader = leaderBySiteId.get(siteId);
    if (!currentLeader || compareStableFirstCandidateOrder(candidate, currentLeader) < 0) {
      leaderBySiteId.set(siteId, candidate);
    }
  }

  for (const [siteId, leader] of leaderBySiteId.entries()) {
    const healthDetails = getSiteRuntimeHealthDetails(siteId, resolveModelName(leader), nowMs);
    const historical = historicalBySiteId.get(siteId);
    const historicalTotalCalls = historical?.totalCalls ?? 0;
    const effectiveSuccessRate = resolveStableFirstSuccessRate(healthDetails, historical?.successRate);
    const trusted = (
      healthDetails.recentConfidence >= STABLE_FIRST_TRUSTED_RECENT_CONFIDENCE
      || historicalTotalCalls >= STABLE_FIRST_TRUSTED_HISTORICAL_CALLS
    );
    siteStateById.set(siteId, {
      siteId,
      leader,
      effectiveSuccessRate,
      trusted,
      observationReason: null,
    });
  }

  const allSiteStates = Array.from(siteStateById.values()).sort((left, right) => {
    const rateDiff = right.effectiveSuccessRate - left.effectiveSuccessRate;
    if (Math.abs(rateDiff) > 1e-9) return rateDiff > 0 ? 1 : -1;
    return compareStableFirstCandidateOrder(left.leader, right.leader);
  });
  const trustedSiteStates = allSiteStates.filter((state) => state.trusted);
  const leaderPool = trustedSiteStates.length > 0 ? trustedSiteStates : allSiteStates;

  const primarySiteIds = new Set<number>();
  const observationSiteIds = new Set<number>();
  const bestRate = leaderPool[0]?.effectiveSuccessRate ?? 0;
  const thresholdRate = bestRate > 0
    ? (bestRate * STABLE_FIRST_PRIMARY_SUCCESS_RATE_RATIO)
    : 0;

  for (const state of allSiteStates) {
    const inPrimary = leaderPool.length === 0
      ? true
      : (
        leaderPool.some((leaderState) => leaderState.siteId === state.siteId)
        && state.effectiveSuccessRate >= thresholdRate
      );
    if (inPrimary) {
      primarySiteIds.add(state.siteId);
      continue;
    }
    observationSiteIds.add(state.siteId);
    state.observationReason = state.trusted
      ? '观察池：近期成功率暂时落后，仅灰度真实流量会命中'
      : '观察池：近期样本不足，仅灰度真实流量会命中';
  }

  if (primarySiteIds.size <= 0 && allSiteStates.length > 0) {
    primarySiteIds.add(allSiteStates[0].siteId);
    observationSiteIds.delete(allSiteStates[0].siteId);
  }

  return {
    primaryCandidates: candidates.filter((candidate) => primarySiteIds.has(candidate.site.id)),
    observationCandidates: candidates.filter((candidate) => observationSiteIds.has(candidate.site.id)),
    primarySiteIds,
    observationSiteIds,
    siteStateById,
  };
}

function shouldUseStableFirstObservationCandidate(
  rotationKey: string,
  observationCandidates: RouteChannelCandidate[],
  nowMs = Date.now(),
): boolean {
  if (!rotationKey || observationCandidates.length <= 0) return false;
  const state = stableFirstObservationProgressByKey.get(rotationKey) ?? {
    requestCount: 0,
    lastObservationAtMs: null,
  };
  if ((state.requestCount + 1) < STABLE_FIRST_OBSERVATION_REQUEST_INTERVAL) {
    return false;
  }
  return observationCandidates.some((candidate) => {
    const observedAtMs = stableFirstObservationSiteCooldownByKey.get(`${rotationKey}:${candidate.site.id}`) ?? null;
    return observedAtMs == null || (nowMs - observedAtMs) >= STABLE_FIRST_OBSERVATION_SITE_COOLDOWN_MS;
  });
}

function updateStableFirstObservationProgress(
  rotationKey: string,
  input: {
    usedObservation: boolean;
    selectedSiteId?: number | null;
    nowMs?: number;
  },
): void {
  if (!rotationKey) return;
  const nowMs = input.nowMs ?? Date.now();
  const previous = stableFirstObservationProgressByKey.get(rotationKey) ?? {
    requestCount: 0,
    lastObservationAtMs: null,
  };
  if (input.usedObservation) {
    rememberStableFirstObservationProgressForKey(rotationKey, {
      requestCount: 0,
      lastObservationAtMs: nowMs,
    });
    if (typeof input.selectedSiteId === 'number' && input.selectedSiteId > 0) {
      rememberStableFirstObservationSiteCooldown(rotationKey, input.selectedSiteId, nowMs);
    }
    return;
  }
  rememberStableFirstObservationProgressForKey(rotationKey, {
    requestCount: Math.max(0, previous.requestCount) + 1,
    lastObservationAtMs: previous.lastObservationAtMs,
  });
}

function isExplicitTokenChannel(candidate: RouteChannelCandidate): boolean {
  return typeof candidate.channel.tokenId === 'number' && candidate.channel.tokenId > 0;
}

export class TokenRouter {
  /**
   * Find matching route and select a channel for the given model.
   * Returns null if no route/channel available.
   */
  async selectChannel(requestedModel: string, downstreamPolicy: DownstreamRoutingPolicy = DEFAULT_DOWNSTREAM_POLICY): Promise<SelectedChannel | null> {
    if (!isModelAllowedByDownstreamPolicy(requestedModel, downstreamPolicy)) return null;
    await ensureSiteRuntimeHealthStateLoaded();

    const match = await this.findRoute(requestedModel, downstreamPolicy);
    if (!match) return null;
    return await this.selectFromMatch(match, requestedModel, downstreamPolicy);
  }

  async previewSelectedChannel(
    requestedModel: string,
    downstreamPolicy: DownstreamRoutingPolicy = DEFAULT_DOWNSTREAM_POLICY,
  ): Promise<SelectedChannel | null> {
    if (!isModelAllowedByDownstreamPolicy(requestedModel, downstreamPolicy)) return null;
    await ensureSiteRuntimeHealthStateLoaded();

    const match = await this.findRoute(requestedModel, downstreamPolicy);
    if (!match) return null;
    return await this.selectFromMatch(match, requestedModel, downstreamPolicy, [], false);
  }

  /**
   * Select next channel for failover (exclude already-tried channels).
   */
  async selectNextChannel(
    requestedModel: string,
    excludeChannelIds: number[],
    downstreamPolicy: DownstreamRoutingPolicy = DEFAULT_DOWNSTREAM_POLICY,
  ): Promise<SelectedChannel | null> {
    if (!isModelAllowedByDownstreamPolicy(requestedModel, downstreamPolicy)) return null;
    await ensureSiteRuntimeHealthStateLoaded();

    const match = await this.findRoute(requestedModel, downstreamPolicy);
    if (!match) return null;
    return await this.selectFromMatch(match, requestedModel, downstreamPolicy, excludeChannelIds);
  }

  async selectPreferredChannel(
    requestedModel: string,
    preferredChannelId: number,
    downstreamPolicy: DownstreamRoutingPolicy = DEFAULT_DOWNSTREAM_POLICY,
    excludeChannelIds: number[] = [],
  ): Promise<SelectedChannel | null> {
    if (!isModelAllowedByDownstreamPolicy(requestedModel, downstreamPolicy)) return null;
    const normalizedPreferredChannelId = Math.trunc(preferredChannelId || 0);
    if (normalizedPreferredChannelId <= 0) return null;
    await ensureSiteRuntimeHealthStateLoaded();

    const match = await this.findRoute(requestedModel, downstreamPolicy);
    if (!match) return null;
    return await this.selectPreferredFromMatch(
      match,
      requestedModel,
      normalizedPreferredChannelId,
      downstreamPolicy,
      excludeChannelIds,
    );
  }

  async explainSelection(
    requestedModel: string,
    excludeChannelIds: number[] = [],
    downstreamPolicy: DownstreamRoutingPolicy = DEFAULT_DOWNSTREAM_POLICY,
  ): Promise<RouteDecisionExplanation> {
    await ensureSiteRuntimeHealthStateLoaded();
    const match = await this.findRoute(requestedModel, downstreamPolicy);
    return this.explainSelectionFromMatch(match, requestedModel, { excludeChannelIds, downstreamPolicy });
  }

  async explainSelectionForRoute(
    routeId: number,
    requestedModel: string,
    excludeChannelIds: number[] = [],
    downstreamPolicy: DownstreamRoutingPolicy = DEFAULT_DOWNSTREAM_POLICY,
  ): Promise<RouteDecisionExplanation> {
    await ensureSiteRuntimeHealthStateLoaded();
    const match = await this.findRouteById(routeId, downstreamPolicy);
    return this.explainSelectionFromMatch(match, requestedModel, { excludeChannelIds, downstreamPolicy });
  }

  async explainSelectionRouteWide(routeId: number, downstreamPolicy: DownstreamRoutingPolicy = DEFAULT_DOWNSTREAM_POLICY): Promise<RouteDecisionExplanation> {
    await ensureSiteRuntimeHealthStateLoaded();
    const match = await this.findRouteById(routeId, downstreamPolicy);
    const fallbackRequestedModel = match?.route.modelPattern || `route:${routeId}`;
    return this.explainSelectionFromMatch(match, fallbackRequestedModel, {
      bypassSourceModelCheck: true,
      useChannelSourceModelForCost: true,
      downstreamPolicy,
    });
  }

  async refreshPricingReferenceCosts(
    requestedModel: string,
    options: PricingReferenceRefreshOptions = {},
  ): Promise<void> {
    const downstreamPolicy = options.downstreamPolicy ?? DEFAULT_DOWNSTREAM_POLICY;
    const match = await this.findRoute(requestedModel, downstreamPolicy);
    await this.refreshPricingReferenceCostsForMatch(match, requestedModel, options);
  }

  async refreshPricingReferenceCostsForRoute(
    routeId: number,
    requestedModel: string,
    options: PricingReferenceRefreshOptions = {},
  ): Promise<void> {
    const downstreamPolicy = options.downstreamPolicy ?? DEFAULT_DOWNSTREAM_POLICY;
    const match = await this.findRouteById(routeId, downstreamPolicy);
    await this.refreshPricingReferenceCostsForMatch(match, requestedModel, options);
  }

  async refreshRouteWidePricingReferenceCosts(
    routeId: number,
    options: Omit<PricingReferenceRefreshOptions, 'useChannelSourceModelForCost'> = {},
  ): Promise<void> {
    const downstreamPolicy = options.downstreamPolicy ?? DEFAULT_DOWNSTREAM_POLICY;
    const match = await this.findRouteById(routeId, downstreamPolicy);
    const requestedModel = match?.route.modelPattern || `route:${routeId}`;
    await this.refreshPricingReferenceCostsForMatch(match, requestedModel, {
      ...options,
      useChannelSourceModelForCost: true,
    });
  }

  private explainSelectionFromMatch(
    match: RouteMatch | null,
    requestedModel: string,
    options: ExplainSelectionOptions = {},
  ): RouteDecisionExplanation {
    const excludeChannelIds = options.excludeChannelIds ?? [];
    const downstreamPolicy = options.downstreamPolicy ?? DEFAULT_DOWNSTREAM_POLICY;

    if (!match) {
      return {
        requestedModel,
        actualModel: requestedModel,
        matched: false,
        summary: ['未匹配到启用的路由'],
        candidates: [],
      };
    }

    const requestedByDisplayName = isRouteDisplayNameMatch(requestedModel, match.route.displayName);
    const bypassSourceModelCheck = (options.bypassSourceModelCheck ?? false) || requestedByDisplayName;
    const useChannelSourceModelForCost = (options.useChannelSourceModelForCost ?? false) || requestedByDisplayName;
    const mappedModel = resolveMappedModel(requestedModel, match.route.modelMapping);
    const routeStrategy = resolveRouteStrategy(match.route);
    const runtimeModelResolver = requestedByDisplayName
      ? ((candidate: RouteChannelCandidate) => normalizeChannelSourceModel(candidate.channel.sourceModel) || mappedModel)
      : mappedModel;

    const nowIso = new Date().toISOString();
    const nowMs = Date.now();
    const summary: string[] = [
      `命中路由：${match.route.modelPattern}`,
      routeStrategy === 'round_robin'
        ? '路由策略：轮询'
        : (routeStrategy === 'stable_first' ? '路由策略：稳定优先' : '路由策略：按权重随机'),
    ];
    if (requestedByDisplayName) {
      summary.push(`按显示名命中：${normalizeRouteDisplayName(match.route.displayName)}`);
      summary.push('显示名仅用于聚合展示，实际转发模型按选中通道来源模型决定');
    }
    const available: RouteChannelCandidate[] = [];
    const candidates: RouteDecisionCandidate[] = [];
    const candidateMap = new Map<number, RouteDecisionCandidate>();

    for (const row of match.channels) {
      const reasonParts = this.getCandidateEligibilityReasons(row, {
        requestedModel,
        bypassSourceModelCheck,
        excludeChannelIds,
        nowIso,
        downstreamPolicy,
      });

      const recentlyFailed = routeStrategy !== 'round_robin'
        ? isChannelRecentlyFailed(row.channel, nowMs)
        : false;
      const eligible = reasonParts.length === 0;
      const candidate: RouteDecisionCandidate = {
        channelId: row.channel.id,
        accountId: row.account.id,
        username: row.account.username || `account-${row.account.id}`,
        siteName: row.site.name || 'unknown',
        tokenName: row.token?.name || 'default',
        sourceModel: resolveActualModelForSelectedChannel(
          requestedModel,
          match.route,
          mappedModel,
          row.channel.sourceModel,
        ),
        priority: row.channel.priority ?? 0,
        weight: row.channel.weight ?? 10,
        eligible,
        recentlyFailed,
        avoidedByRecentFailure: false,
        probability: 0,
        reason: eligible ? '可用' : reasonParts.join('、'),
      };
      candidates.push(candidate);
      candidateMap.set(candidate.channelId, candidate);

      if (eligible) {
        available.push(row);
      }
    }

    if (available.length === 0) {
      summary.push('没有可用通道（全部被禁用、站点不可用、冷却或令牌不可用）');
      return {
        requestedModel,
        actualModel: mappedModel,
        matched: true,
        routeId: match.route.id,
        modelPattern: match.route.modelPattern,
        summary,
        candidates,
      };
    }

    if (routeStrategy === 'round_robin') {
      const rawOrdered = this.getRoundRobinCandidates(available);
      const breakerFiltered = filterSiteRuntimeBrokenCandidatesByModel(rawOrdered, runtimeModelResolver, nowMs);
      if (breakerFiltered.avoided.length > 0) {
        for (const item of breakerFiltered.avoided) {
          const target = candidateMap.get(item.candidate.channel.id);
          if (!target) continue;
          target.reason = item.reason;
        }
        const breakerSummaryLabel = breakerFiltered.avoided.some((item) => item.reason.includes('模型熔断'))
          ? '运行时熔断避让'
          : '站点熔断避让';
        summary.push(`${breakerSummaryLabel} ${breakerFiltered.avoided.length}`);
      }
      const ordered = breakerFiltered.candidates;
      let selected: RouteChannelCandidate | null = null;

      for (let index = 0; index < ordered.length; index += 1) {
        const target = candidateMap.get(ordered[index].channel.id);
        if (!target || !target.eligible) continue;
        target.probability = index === 0 ? 100 : 0;
        target.reason = index === 0
          ? `轮询命中（全局第 1 / ${ordered.length} 位，忽略优先级）`
          : `轮询排队中（全局第 ${index + 1} / ${ordered.length} 位，忽略优先级）`;
        if (index === 0) {
          selected = ordered[index];
        }
      }

      if (!selected) {
        summary.push('本次未选出通道');
        return {
          requestedModel,
          actualModel: mappedModel,
          matched: true,
          routeId: match.route.id,
          modelPattern: match.route.modelPattern,
          summary,
          candidates,
        };
      }

      const selectedChannel = candidateMap.get(selected.channel.id);
      const selectedLabel = selectedChannel
        ? `${selectedChannel.username} @ ${selectedChannel.siteName} / ${selectedChannel.tokenName}`
        : `channel-${selected.channel.id}`;
      const actualModel = resolveActualModelForSelectedChannel(
        requestedModel,
        match.route,
        mappedModel,
        selected.channel.sourceModel,
      );
      summary.push(`全局轮询：可用 ${ordered.length}，忽略优先级`);
      summary.push(`最终选择：${selectedLabel}`);
      if (actualModel !== mappedModel) {
        summary.push(`实际转发模型：${actualModel}`);
      }

      return {
        requestedModel,
        actualModel,
        matched: true,
        routeId: match.route.id,
        modelPattern: match.route.modelPattern,
        selectedChannelId: selected.channel.id,
        selectedAccountId: selected.account.id,
        selectedLabel,
        summary,
        candidates,
      };
    }

    if (routeStrategy === 'stable_first') {
      const breakerFiltered = filterSiteRuntimeBrokenCandidatesByModel(available, runtimeModelResolver, nowMs);
      if (breakerFiltered.avoided.length > 0) {
        for (const item of breakerFiltered.avoided) {
          const target = candidateMap.get(item.candidate.channel.id);
          if (!target) continue;
          target.reason = item.reason;
        }
      }

      const filteredCandidates = filterRecentlyFailedCandidates(breakerFiltered.candidates, nowMs);
      const avoided = breakerFiltered.candidates.filter((row) => !filteredCandidates.some((item) => item.channel.id === row.channel.id));
      if (avoided.length > 0) {
        for (const row of avoided) {
          const target = candidateMap.get(row.channel.id);
          if (!target) continue;
          target.avoidedByRecentFailure = true;
          target.reason = `最近失败，优先避让（${resolveFailureBackoffSec(resolveChannelFailureStreak(row.channel))} 秒窗口）`;
        }
      }

      const rotationKey = this.buildStableFirstRotationKey(match.route.id, requestedModel);
      const poolPlan = buildStableFirstPoolPlan(
        filteredCandidates,
        useChannelSourceModelForCost ? runtimeModelResolver : mappedModel,
        nowMs,
      );
      const observationDueNow = poolPlan.observationCandidates.length > 0
        && shouldUseStableFirstObservationCandidate(rotationKey, poolPlan.observationCandidates, nowMs);
      const useObservationNow = poolPlan.observationCandidates.length > 0
        && (poolPlan.primaryCandidates.length <= 0 || observationDueNow);
      const observationProgressState = stableFirstObservationProgressByKey.get(rotationKey) ?? {
        requestCount: 0,
        lastObservationAtMs: null,
      };
      const remainingPrimaryRequestsBeforeObservation = poolPlan.primaryCandidates.length > 0
        ? Math.max(0, STABLE_FIRST_OBSERVATION_REQUEST_INTERVAL - (observationProgressState.requestCount + 1))
        : 0;
      const observationBlockedByCooldown = poolPlan.primaryCandidates.length > 0
        && poolPlan.observationCandidates.length > 0
        && remainingPrimaryRequestsBeforeObservation === 0
        && !observationDueNow;
      const primaryWeighted = this.calculateWeightedSelection(
        poolPlan.primaryCandidates,
        useChannelSourceModelForCost ? runtimeModelResolver : mappedModel,
        downstreamPolicy,
        nowMs,
        'stable_first',
        rotationKey,
      );
      const observationWeighted = poolPlan.observationCandidates.length > 0
        ? this.calculateWeightedSelection(
          poolPlan.observationCandidates,
          useChannelSourceModelForCost ? runtimeModelResolver : mappedModel,
          downstreamPolicy,
          nowMs,
          'stable_first',
          `${rotationKey}:observe`,
        )
        : {
          selected: null,
          details: [],
          stableSiteCount: 0,
        };

      for (const detail of primaryWeighted.details) {
        const target = candidateMap.get(detail.candidate.channel.id);
        if (!target) continue;
        target.probability = Number((detail.probability * (useObservationNow ? 0 : 100)).toFixed(2));
        if (target.eligible && !target.avoidedByRecentFailure) {
          target.reason = useObservationNow
            ? `主池：本次让位给观察池灰度请求；${detail.reason}`
            : `主池：${detail.reason}`;
        }
      }
      for (const detail of observationWeighted.details) {
        const target = candidateMap.get(detail.candidate.channel.id);
        if (!target) continue;
        target.probability = Number((detail.probability * (useObservationNow ? 100 : 0)).toFixed(2));
        if (target.eligible && !target.avoidedByRecentFailure) {
          const siteState = poolPlan.siteStateById.get(detail.candidate.site.id);
          const observationWindowPrefix = useObservationNow
            ? (poolPlan.primaryCandidates.length > 0
              ? '本次命中灰度真实请求'
              : '当前主池为空，改由观察池承接')
            : (observationBlockedByCooldown
              ? '当前已到灰度窗口，但观察站点仍在冷却'
              : `当前还需 ${remainingPrimaryRequestsBeforeObservation} 次主池请求`);
          target.reason = poolPlan.observationSiteIds.has(detail.candidate.site.id)
            ? `${siteState?.observationReason || '观察池'}；${observationWindowPrefix}；${detail.reason}`
            : `观察池：${observationWindowPrefix}；${detail.reason}`;
        }
      }

      const weighted = useObservationNow
        ? observationWeighted
        : (primaryWeighted.selected ? primaryWeighted : observationWeighted);
      if (!weighted.selected) {
        summary.push('本次未选出通道');
        return {
          requestedModel,
          actualModel: mappedModel,
          matched: true,
          routeId: match.route.id,
          modelPattern: match.route.modelPattern,
          summary,
          candidates,
        };
      }

      const summaryParts = [`稳定优先：可用 ${available.length}`];
      if (poolPlan.primarySiteIds.size > 0) {
        summaryParts.push(`主池站点 ${poolPlan.primarySiteIds.size}`);
      }
      if (poolPlan.observationSiteIds.size > 0) {
        summaryParts.push(`观察池站点 ${poolPlan.observationSiteIds.size}`);
      }
      summaryParts.push('按近期成功率分层后按配置顺序轮询站点');
      if (poolPlan.observationSiteIds.size > 0) {
        if (useObservationNow) {
          summaryParts.push('本次命中观察池灰度流量');
        } else if (observationBlockedByCooldown) {
          summaryParts.push('观察池已到灰度窗口，但候选站点仍在观察冷却');
        } else if (poolPlan.primaryCandidates.length <= 0) {
          summaryParts.push('当前主池为空，由观察池承接流量');
        } else {
          summaryParts.push(`观察池仅消耗少量真实请求灰度流量（当前还需 ${remainingPrimaryRequestsBeforeObservation} 次主池请求）`);
        }
      }
      if (breakerFiltered.avoided.length > 0) {
        const breakerSummaryLabel = breakerFiltered.avoided.some((item) => item.reason.includes('模型熔断'))
          ? '运行时熔断避让'
          : '站点熔断避让';
        summaryParts.push(`${breakerSummaryLabel} ${breakerFiltered.avoided.length}`);
      }
      if (avoided.length > 0) {
        summaryParts.push(`最近失败避让 ${avoided.length}`);
      }
      summary.push(summaryParts.join('，'));

      const selectedChannel = candidateMap.get(weighted.selected.channel.id);
      const selectedLabel = selectedChannel
        ? `${selectedChannel.username} @ ${selectedChannel.siteName} / ${selectedChannel.tokenName}`
        : `channel-${weighted.selected.channel.id}`;
      const actualModel = resolveActualModelForSelectedChannel(
        requestedModel,
        match.route,
        mappedModel,
        weighted.selected.channel.sourceModel,
      );
      summary.push(`最终选择：${selectedLabel}（P${weighted.selected.channel.priority ?? 0}）`);
      if (actualModel !== mappedModel) {
        summary.push(`实际转发模型：${actualModel}`);
      }

      return {
        requestedModel,
        actualModel,
        matched: true,
        routeId: match.route.id,
        modelPattern: match.route.modelPattern,
        selectedChannelId: weighted.selected.channel.id,
        selectedAccountId: weighted.selected.account.id,
        selectedLabel,
        summary,
        candidates,
      };
    }

    const availableByPriority = new Map<number, RouteChannelCandidate[]>();
    for (const row of available) {
      const priority = row.channel.priority ?? 0;
      if (!availableByPriority.has(priority)) availableByPriority.set(priority, []);
      availableByPriority.get(priority)!.push(row);
    }

    const sortedPriorities = Array.from(availableByPriority.keys()).sort((a, b) => a - b);
    let selected: RouteChannelCandidate | null = null;
    let selectedPriority = 0;

    for (const priority of sortedPriorities) {
      const rawLayer = availableByPriority.get(priority) ?? [];
      if (rawLayer.length === 0) continue;

      const breakerFiltered = filterSiteRuntimeBrokenCandidatesByModel(rawLayer, runtimeModelResolver, nowMs);
      if (breakerFiltered.avoided.length > 0) {
        for (const item of breakerFiltered.avoided) {
          const target = candidateMap.get(item.candidate.channel.id);
          if (!target) continue;
          target.reason = item.reason;
        }
      }

      const filteredLayer = filterRecentlyFailedCandidates(breakerFiltered.candidates, nowMs);
      const avoided = breakerFiltered.candidates.filter((row) => !filteredLayer.some((item) => item.channel.id === row.channel.id));
      if (avoided.length > 0) {
        for (const row of avoided) {
          const target = candidateMap.get(row.channel.id);
          if (!target) continue;
          target.avoidedByRecentFailure = true;
          target.reason = `最近失败，优先避让（${resolveFailureBackoffSec(resolveChannelFailureStreak(row.channel))} 秒窗口）`;
        }
      }

      const weighted = this.calculateWeightedSelection(
        filteredLayer,
        useChannelSourceModelForCost ? runtimeModelResolver : mappedModel,
        downstreamPolicy,
        nowMs,
        'weighted',
      );
      for (const detail of weighted.details) {
        const target = candidateMap.get(detail.candidate.channel.id);
        if (!target) continue;
        target.probability = Number((detail.probability * 100).toFixed(2));
        if (target.eligible && !target.avoidedByRecentFailure) {
          target.reason = detail.reason;
        }
      }

      if (!weighted.selected) continue;
      selected = weighted.selected;
      selectedPriority = priority;
      const layerSummaryParts = [`优先级 P${priority}：可用 ${rawLayer.length}`];
      if (breakerFiltered.avoided.length > 0) {
        const breakerSummaryLabel = breakerFiltered.avoided.some((item) => item.reason.includes('模型熔断'))
          ? '运行时熔断避让'
          : '站点熔断避让';
        layerSummaryParts.push(`${breakerSummaryLabel} ${breakerFiltered.avoided.length}`);
      }
      if (avoided.length > 0) {
        layerSummaryParts.push(`最近失败避让 ${avoided.length}`);
      }
      summary.push(layerSummaryParts.join('，'));
      break;
    }

    if (!selected) {
      summary.push('本次未选出通道');
      return {
        requestedModel,
        actualModel: mappedModel,
        matched: true,
        routeId: match.route.id,
        modelPattern: match.route.modelPattern,
        summary,
        candidates,
      };
    }

    const selectedChannel = candidateMap.get(selected.channel.id);
    const selectedLabel = selectedChannel
      ? `${selectedChannel.username} @ ${selectedChannel.siteName} / ${selectedChannel.tokenName}`
      : `channel-${selected.channel.id}`;
    const actualModel = resolveActualModelForSelectedChannel(
      requestedModel,
      match.route,
      mappedModel,
      selected.channel.sourceModel,
    );
    summary.push(`最终选择：${selectedLabel}（P${selectedPriority}）`);
    if (actualModel !== mappedModel) {
      summary.push(`实际转发模型：${actualModel}`);
    }

    return {
      requestedModel,
      actualModel,
      matched: true,
      routeId: match.route.id,
      modelPattern: match.route.modelPattern,
      selectedChannelId: selected.channel.id,
      selectedAccountId: selected.account.id,
      selectedLabel,
      summary,
      candidates,
    };
  }

  private async refreshPricingReferenceCostsForMatch(
    match: RouteMatch | null,
    requestedModel: string,
    options: PricingReferenceRefreshOptions = {},
  ): Promise<void> {
    if (!match) return;

    const requestedByDisplayName = isRouteDisplayNameMatch(requestedModel, match.route.displayName);
    const useChannelSourceModelForCost = (options.useChannelSourceModelForCost ?? false) || requestedByDisplayName;
    const mappedModel = resolveMappedModel(requestedModel, match.route.modelMapping);
    const refreshedKeys = options.refreshedKeys ?? new Set<string>();

    await Promise.allSettled(match.channels.map(async (candidate) => {
      const refreshKey = `${candidate.site.id}:${candidate.account.id}`;
      if (refreshedKeys.has(refreshKey)) return;
      refreshedKeys.add(refreshKey);

      const modelName = useChannelSourceModelForCost
        ? (normalizeChannelSourceModel(candidate.channel.sourceModel) || mappedModel)
        : mappedModel;
      if (!modelName) return;

      await refreshModelPricingCatalog({
        site: {
          id: candidate.site.id,
          url: candidate.site.url,
          platform: candidate.site.platform,
          apiKey: candidate.site.apiKey,
        },
        account: {
          id: candidate.account.id,
          accessToken: candidate.account.accessToken,
          apiToken: candidate.account.apiToken,
        },
        modelName,
      });
    }));
  }

  /**
   * Record success for a channel.
   */
  async recordSuccess(
    channelId: number,
    latencyMs: number,
    cost: number,
    modelName?: string | null,
    actualAccountId?: number,
    streamTiming?: {
      firstByteLatencyMs?: number | null;
      completionTokens?: number | null;
      isStream?: boolean | null;
    },
  ) {
    await ensureSiteRuntimeHealthStateLoaded();
    const quality = resolveStreamTimingQualityMetrics(latencyMs, streamTiming);
    const row = await db.select()
      .from(schema.routeChannels)
      .innerJoin(schema.accounts, eq(schema.routeChannels.accountId, schema.accounts.id))
      .where(eq(schema.routeChannels.id, channelId))
      .get();
    if (!row) return;
    recordChannelQualitySuccess(channelId, quality);
    const ch = row.route_channels;
    const account = row.accounts;
    // A success between two auth failures proves the credential still works, so the 401s
    // are not consecutive — clear the expiry-confirmation streak of the account that ACTUALLY
    // served. For an OAuth route unit that is a member account, not the channel's anchor
    // `accountId`; the failure side (reportTokenExpired) is keyed on the dispatched member,
    // so resetting the anchor here would never clear the streak that is counting.
    const servingAccountId = Number.isFinite(actualAccountId) && (actualAccountId ?? 0) > 0
      ? Math.trunc(actualAccountId!)
      : account.id;
    resetAccountAuthFailureStreak(servingAccountId);
    const nowIso = new Date().toISOString();
    const nextSuccessCount = (ch.successCount ?? 0) + 1;
    const nextTotalLatencyMs = (ch.totalLatencyMs ?? 0) + latencyMs;
    const nextTotalCost = (ch.totalCost ?? 0) + cost;
    if (typeof ch.oauthRouteUnitId === 'number' && ch.oauthRouteUnitId > 0) {
      const targetAccountId = Number.isFinite(actualAccountId) && (actualAccountId ?? 0) > 0
        ? Math.trunc(actualAccountId!)
        : account.id;
      const memberRow = await db.select({
        member: schema.oauthRouteUnitMembers,
        account: schema.accounts,
      }).from(schema.oauthRouteUnitMembers)
        .innerJoin(schema.accounts, eq(schema.oauthRouteUnitMembers.accountId, schema.accounts.id))
        .where(and(
          eq(schema.oauthRouteUnitMembers.unitId, ch.oauthRouteUnitId),
          eq(schema.oauthRouteUnitMembers.accountId, targetAccountId),
        ))
        .get();

      if (memberRow) {
        const memberSuccessCount = (memberRow.member.successCount ?? 0) + 1;
        const memberTotalLatencyMs = (memberRow.member.totalLatencyMs ?? 0) + latencyMs;
        const memberTotalCost = (memberRow.member.totalCost ?? 0) + cost;
        await db.update(schema.oauthRouteUnitMembers).set({
          successCount: memberSuccessCount,
          totalLatencyMs: memberTotalLatencyMs,
          totalCost: memberTotalCost,
          lastUsedAt: nowIso,
          cooldownUntil: null,
          cooldownSource: null,
          lastFailAt: null,
          consecutiveFailCount: 0,
          cooldownLevel: 0,
          updatedAt: nowIso,
        }).where(eq(schema.oauthRouteUnitMembers.id, memberRow.member.id)).run();
        recordSiteRuntimeSuccess(memberRow.account.siteId, latencyMs, modelName, quality);
      } else {
        recordSiteRuntimeSuccess(account.siteId, latencyMs, modelName, quality);
      }
      invalidateRouteScopedCache(ch.routeId);
    } else {
      recordSiteRuntimeSuccess(account.siteId, latencyMs, modelName, quality);
    }

    await db.update(schema.routeChannels).set({
      successCount: nextSuccessCount,
      totalLatencyMs: nextTotalLatencyMs,
      totalCost: nextTotalCost,
      lastUsedAt: nowIso,
      cooldownUntil: null,
      cooldownSource: null,
      lastFailAt: null,
      consecutiveFailCount: 0,
      cooldownLevel: 0,
    }).where(eq(schema.routeChannels.id, channelId)).run();

    patchCachedChannel(channelId, (channel) => {
      channel.successCount = nextSuccessCount;
      channel.totalLatencyMs = nextTotalLatencyMs;
      channel.totalCost = nextTotalCost;
      channel.lastUsedAt = nowIso;
      channel.cooldownUntil = null;
      channel.cooldownSource = null;
      channel.lastFailAt = null;
      channel.consecutiveFailCount = 0;
      channel.cooldownLevel = 0;
    });
  }

  async recordProbeSuccess(
    channelId: number,
    latencyMs: number,
    modelName?: string | null,
    actualAccountId?: number,
  ) {
    await ensureSiteRuntimeHealthStateLoaded();
    const row = await db.select()
      .from(schema.routeChannels)
      .innerJoin(schema.accounts, eq(schema.routeChannels.accountId, schema.accounts.id))
      .where(eq(schema.routeChannels.id, channelId))
      .get();
    if (!row) return;

    const ch = row.route_channels;
    const account = row.accounts;
    if (typeof ch.oauthRouteUnitId === 'number' && ch.oauthRouteUnitId > 0) {
      const targetAccountId = Number.isFinite(actualAccountId) && (actualAccountId ?? 0) > 0
        ? Math.trunc(actualAccountId!)
        : account.id;
      const nowIso = new Date().toISOString();
      const memberRow = await db.select({
        member: schema.oauthRouteUnitMembers,
        account: schema.accounts,
      }).from(schema.oauthRouteUnitMembers)
        .innerJoin(schema.accounts, eq(schema.oauthRouteUnitMembers.accountId, schema.accounts.id))
        .where(and(
          eq(schema.oauthRouteUnitMembers.unitId, ch.oauthRouteUnitId),
          eq(schema.oauthRouteUnitMembers.accountId, targetAccountId),
        ))
        .get();

      if (memberRow) {
        await db.update(schema.oauthRouteUnitMembers).set({
          cooldownUntil: null,
          cooldownSource: null,
          lastFailAt: null,
          consecutiveFailCount: 0,
          cooldownLevel: 0,
          updatedAt: nowIso,
        }).where(eq(schema.oauthRouteUnitMembers.id, memberRow.member.id)).run();
        recordSiteRuntimeSuccess(memberRow.account.siteId, latencyMs, modelName);
      } else {
        recordSiteRuntimeSuccess(account.siteId, latencyMs, modelName);
      }

      await db.update(schema.routeChannels).set({
        cooldownUntil: null,
        cooldownSource: null,
        lastFailAt: null,
        consecutiveFailCount: 0,
        cooldownLevel: 0,
      }).where(eq(schema.routeChannels.id, channelId)).run();
      patchCachedChannel(channelId, (channel) => {
        channel.cooldownUntil = null;
        channel.cooldownSource = null;
        channel.lastFailAt = null;
        channel.consecutiveFailCount = 0;
        channel.cooldownLevel = 0;
      });
      invalidateRouteScopedCache(ch.routeId);
      return;
    }

    // 与上游一致：成功恢复只清除当前通道的失败/冷却状态，不扩散到同凭据的兄弟通道。
    const needsChannelReset = !!ch.cooldownUntil
      || !!ch.cooldownSource
      || !!ch.lastFailAt
      || (ch.consecutiveFailCount ?? 0) > 0
      || (ch.cooldownLevel ?? 0) > 0;

    if (needsChannelReset) {
      await db.update(schema.routeChannels).set({
        cooldownUntil: null,
        cooldownSource: null,
        lastFailAt: null,
        consecutiveFailCount: 0,
        cooldownLevel: 0,
      }).where(eq(schema.routeChannels.id, channelId)).run();
      patchCachedChannel(channelId, (channel) => {
        channel.cooldownUntil = null;
        channel.cooldownSource = null;
        channel.lastFailAt = null;
        channel.consecutiveFailCount = 0;
        channel.cooldownLevel = 0;
      });
    }

    recordSiteRuntimeSuccess(account.siteId, latencyMs, modelName);
  }

  /**
   * Clear persisted failure and cooldown state for the given channels.
   */
  async clearChannelFailureState(
    channelIds: number[],
    options: { runtimeHealthScope?: 'site' | 'model' } = {},
  ): Promise<number> {
    const normalizedChannelIds = Array.from(new Set(
      channelIds
        .filter((channelId): channelId is number => Number.isFinite(channelId) && channelId > 0)
        .map((channelId) => Math.trunc(channelId)),
    ));
    if (normalizedChannelIds.length === 0) return 0;

    await ensureSiteRuntimeHealthStateLoaded();
    const channelRows = await db.select({
      siteId: schema.accounts.siteId,
      sourceModel: schema.routeChannels.sourceModel,
      routeModelPattern: schema.tokenRoutes.modelPattern,
      oauthRouteUnitId: schema.routeChannels.oauthRouteUnitId,
    }).from(schema.routeChannels)
      .innerJoin(schema.accounts, eq(schema.routeChannels.accountId, schema.accounts.id))
      .innerJoin(schema.tokenRoutes, eq(schema.routeChannels.routeId, schema.tokenRoutes.id))
      .where(inArray(schema.routeChannels.id, normalizedChannelIds))
      .all();

    const result = await db.update(schema.routeChannels).set({
      failCount: 0,
      lastFailAt: null,
      consecutiveFailCount: 0,
      cooldownLevel: 0,
      cooldownUntil: null,
      cooldownSource: null,
    }).where(inArray(schema.routeChannels.id, normalizedChannelIds)).run();

    // A route-unit channel keeps its cooldown on the member rows, so clearing only the
    // channel row left those channels cooling with nothing in the UI able to release them.
    const routeUnitIds: number[] = Array.from(new Set<number>(
      channelRows
        .map((row) => Number(row.oauthRouteUnitId))
        .filter((unitId): unitId is number => Number.isFinite(unitId) && unitId > 0),
    ));
    if (routeUnitIds.length > 0) {
      await db.update(schema.oauthRouteUnitMembers).set({
        failCount: 0,
        lastFailAt: null,
        consecutiveFailCount: 0,
        cooldownLevel: 0,
        cooldownUntil: null,
        cooldownSource: null,
        updatedAt: new Date().toISOString(),
      }).where(inArray(schema.oauthRouteUnitMembers.unitId, routeUnitIds)).run();
    }

    if (clearRuntimeHealthStatesForChannels(channelRows, options.runtimeHealthScope ?? 'site')) {
      await persistSiteRuntimeHealthState();
    }

    invalidateTokenRouterCache();
    return Number(result?.changes || normalizedChannelIds.length);
  }

  /**
   * Record failure and set cooldown.
   */
  async recordFailure(
    channelId: number,
    context: SiteRuntimeFailureContext | string | null = {},
    actualAccountId?: number,
  ) {
    await ensureSiteRuntimeHealthStateLoaded();
    const row = await db.select()
      .from(schema.routeChannels)
      .innerJoin(schema.accounts, eq(schema.routeChannels.accountId, schema.accounts.id))
      .innerJoin(schema.tokenRoutes, eq(schema.routeChannels.routeId, schema.tokenRoutes.id))
      .where(eq(schema.routeChannels.id, channelId))
      .get();
    if (!row) return;

    const ch = row.route_channels;
    const account = row.accounts;
    const route = row.token_routes;
    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const normalizedContext: SiteRuntimeFailureContext = typeof context === 'string'
      ? { modelName: context }
      : (context ?? {});
    if (typeof ch.oauthRouteUnitId === 'number' && ch.oauthRouteUnitId > 0) {
      const targetAccountId = Number.isFinite(actualAccountId) && (actualAccountId ?? 0) > 0
        ? Math.trunc(actualAccountId!)
        : account.id;
      const memberRow = await db.select({
        member: schema.oauthRouteUnitMembers,
        account: schema.accounts,
        unit: schema.oauthRouteUnits,
      }).from(schema.oauthRouteUnitMembers)
        .innerJoin(schema.accounts, eq(schema.oauthRouteUnitMembers.accountId, schema.accounts.id))
        .innerJoin(schema.oauthRouteUnits, eq(schema.oauthRouteUnitMembers.unitId, schema.oauthRouteUnits.id))
        .where(and(
          eq(schema.oauthRouteUnitMembers.unitId, ch.oauthRouteUnitId),
          eq(schema.oauthRouteUnitMembers.accountId, targetAccountId),
        ))
        .get();
      if (memberRow) {
        // Route-unit channels carry their cooldown on the MEMBER row, not the channel row,
        // so the exemption has to be repeated here or a timeout would still cool the member.
        if (isExemptTimeoutFailure(normalizedContext)) {
          await db.update(schema.oauthRouteUnitMembers).set({
            lastFailAt: nowIso,
            updatedAt: nowIso,
          }).where(eq(schema.oauthRouteUnitMembers.id, memberRow.member.id)).run();
          recordSiteRuntimeFailure(memberRow.account.siteId, normalizedContext, nowMs);
          invalidateRouteScopedCache(route.id);
          return;
        }

        const shortWindowLimitCooldownUntil = resolveShortWindowLimitCooldown(memberRow.account, normalizedContext, nowMs);
        // A rate limit is still a failure that happened, so the lifetime statistic counts
        // it. It used to be reset to 0 purely to signal "provider-directed cooldown" to the
        // recovery sweep, which erased the member's entire failure history as a side
        // effect; `cooldownSource` now carries that signal explicitly.
        const failCount = (memberRow.member.failCount ?? 0) + 1;
        const routeUnitStrategy = memberRow.unit.strategy === 'stick_until_unavailable'
          ? 'stick_until_unavailable'
          : 'round_robin';
        let cooldownUntil: string | null = null;
        let cooldownSource: CooldownSource | null = null;
        let consecutiveFailCount = Math.max(0, memberRow.member.consecutiveFailCount ?? 0) + 1;
        let cooldownLevel = Math.max(0, memberRow.member.cooldownLevel ?? 0);

        if (shortWindowLimitCooldownUntil) {
          cooldownUntil = shortWindowLimitCooldownUntil;
          cooldownSource = COOLDOWN_SOURCE_PROVIDER_QUOTA;
          consecutiveFailCount = 0;
          cooldownLevel = 0;
        } else if (isStreamInterruptedFailure(normalizedContext)) {
          // Confirmed damage outranks the configured strategy: a member that breaks streams
          // mid-answer is cooled on its own scale even under stick_until_unavailable, which
          // by design never cools on ordinary failures.
          const escalated = resolveStreamInterruptedCooldown(cooldownLevel, nowMs);
          cooldownLevel = escalated.cooldownLevel;
          cooldownUntil = escalated.cooldownUntil;
          cooldownSource = cooldownUntil ? COOLDOWN_SOURCE_STREAM_INTERRUPTED : null;
          consecutiveFailCount = 0;
        } else if (routeUnitStrategy === 'round_robin') {
          if (consecutiveFailCount >= ROUND_ROBIN_FAILURE_THRESHOLD) {
            cooldownLevel = Math.min(cooldownLevel + 1, ROUND_ROBIN_COOLDOWN_LEVELS_SEC.length - 1);
            const cooldownSec = resolveRoundRobinCooldownSec(cooldownLevel);
            cooldownUntil = cooldownSec > 0
              ? new Date(nowMs + resolveJitteredFailureCooldownMs(cooldownSec * 1000)).toISOString()
              : null;
            cooldownSource = cooldownUntil ? COOLDOWN_SOURCE_METAPI_BACKOFF : null;
            consecutiveFailCount = 0;
          }
        } else {
          // Same contract as the channel path: the streak drives the backoff, so keep it.
          cooldownUntil = new Date(nowMs + resolveEffectiveFailureCooldownMs(consecutiveFailCount)).toISOString();
          cooldownSource = COOLDOWN_SOURCE_METAPI_BACKOFF;
          cooldownLevel = 0;
        }

        await db.update(schema.oauthRouteUnitMembers).set({
          failCount,
          lastFailAt: nowIso,
          consecutiveFailCount,
          cooldownLevel,
          cooldownUntil,
          cooldownSource,
          updatedAt: nowIso,
        }).where(eq(schema.oauthRouteUnitMembers.id, memberRow.member.id)).run();
        // Channel-level display quality counts every real failure, including the
        // usage limits the site health below deliberately ignores: a throttled
        // credential is exactly the per-channel divergence the panel exists to show.
        recordChannelQualityFailure(channelId, normalizedContext, nowMs);
        // 用量限流属于凭据/渠道级状态，不把单个成员的冷却扩散到整个站点。
        if (!shortWindowLimitCooldownUntil) {
          recordSiteRuntimeFailure(memberRow.account.siteId, normalizedContext, nowMs);
        }
        invalidateRouteScopedCache(route.id);
        return;
      }
    }

    const exemptTimeout = isExemptTimeoutFailure(normalizedContext);
    if (exemptTimeout) {
      // Observability only: record that the attempt timed out without growing failCount,
      // consecutiveFailCount or cooldown, so the channel stays selectable for the retry
      // this very request is about to make.
      await db.update(schema.routeChannels).set({
        lastFailAt: nowIso,
      }).where(eq(schema.routeChannels.id, channelId)).run();
      patchCachedChannel(channelId, (channel) => {
        channel.lastFailAt = nowIso;
      });
      recordSiteRuntimeFailure(account.siteId, normalizedContext, nowMs);
      return;
    }

    const shortWindowLimitCooldownUntil = resolveShortWindowLimitCooldown(account, normalizedContext, nowMs);
    // Counts the failure that actually occurred. The old `? 0 :` reset existed only to
    // encode "this cooldown came from the provider" in the counters, and cost the channel
    // its lifetime failure statistic every time it hit a rate limit.
    const failCount = (ch.failCount ?? 0) + 1;
    const routeStrategy = resolveRouteStrategy(route);
    // 与上游一致：每次失败只更新实际发起请求的通道，限流状态不扩散到同凭据的其他通道。
    const affectedChannelIds = [channelId];
    let cooldownUntil: string | null = null;
    let cooldownSource: CooldownSource | null = null;
    let consecutiveFailCount = Math.max(0, ch.consecutiveFailCount ?? 0) + 1;
    let cooldownLevel = Math.max(0, ch.cooldownLevel ?? 0);

    if (shortWindowLimitCooldownUntil) {
      cooldownUntil = shortWindowLimitCooldownUntil;
      cooldownSource = COOLDOWN_SOURCE_PROVIDER_QUOTA;
      consecutiveFailCount = 0;
      cooldownLevel = 0;
    } else if (isStreamInterruptedFailure(normalizedContext)) {
      // Deliberately before the strategy split, so the escalation does not depend on the
      // route being round-robin: the round-robin threshold exists to keep one unlucky
      // request from cooling a channel, and a mid-stream break after a successful start is
      // not that — it is the channel's own link failing.
      const escalated = resolveStreamInterruptedCooldown(cooldownLevel, nowMs);
      cooldownLevel = escalated.cooldownLevel;
      cooldownUntil = escalated.cooldownUntil;
      cooldownSource = cooldownUntil ? COOLDOWN_SOURCE_STREAM_INTERRUPTED : null;
      consecutiveFailCount = 0;
    } else if (routeStrategy === 'round_robin') {
      if (consecutiveFailCount >= ROUND_ROBIN_FAILURE_THRESHOLD) {
        cooldownLevel = Math.min(cooldownLevel + 1, ROUND_ROBIN_COOLDOWN_LEVELS_SEC.length - 1);
        const cooldownSec = resolveRoundRobinCooldownSec(cooldownLevel);
        cooldownUntil = cooldownSec > 0
          ? new Date(nowMs + resolveJitteredFailureCooldownMs(cooldownSec * 1000)).toISOString()
          : null;
        cooldownSource = cooldownUntil ? COOLDOWN_SOURCE_METAPI_BACKOFF : null;
        consecutiveFailCount = 0;
      }
    } else {
      // The streak is what the backoff escalates on, so it must survive this failure.
      // Zeroing it here (as the weighted path used to) pinned every cooldown at the first
      // Fibonacci step while the lifetime failCount silently drove escalation instead.
      cooldownUntil = new Date(nowMs + resolveEffectiveFailureCooldownMs(consecutiveFailCount)).toISOString();
      cooldownSource = COOLDOWN_SOURCE_METAPI_BACKOFF;
      cooldownLevel = 0;
    }

    await db.update(schema.routeChannels).set({
      failCount,
      lastFailAt: nowIso,
      consecutiveFailCount,
      cooldownLevel,
      cooldownUntil,
      cooldownSource,
    }).where(inArray(schema.routeChannels.id, affectedChannelIds)).run();

    for (const affectedChannelId of affectedChannelIds) {
      patchCachedChannel(affectedChannelId, (channel) => {
        channel.failCount = failCount;
        channel.lastFailAt = nowIso;
        channel.cooldownUntil = cooldownUntil;
        channel.cooldownSource = cooldownSource;
        channel.consecutiveFailCount = consecutiveFailCount;
        channel.cooldownLevel = cooldownLevel;
      });
    }

    // Channel-level display quality counts usage limits too (the site health below
    // skips them): being throttled is per-credential evidence the panel should show.
    recordChannelQualityFailure(channelId, normalizedContext, nowMs);

    // 用量限流属于凭据/渠道级状态，不把单次限流扩散成站点级健康惩罚。
    if (!shortWindowLimitCooldownUntil) {
      recordSiteRuntimeFailure(account.siteId, normalizedContext, nowMs);
    }
  }

  /**
   * Per-channel quality snapshot for display payloads, keyed by channel id as string
   * for direct JSON serialization. Awaits the persisted state first so a request right
   * after boot still sees the last known quality. Since step two of the
   * channel-granularity rollout the same underlying states also feed the weighted
   * first-byte / speed components; this getter itself remains read-only display API.
   */
  async getChannelQualitySnapshots(channelIds: Array<number>): Promise<Record<string, ChannelQualitySnapshot>> {
    await ensureSiteRuntimeHealthStateLoaded();
    const nowMs = Date.now();
    const snapshots: Record<string, ChannelQualitySnapshot> = {};
    for (const channelId of channelIds) {
      if (!Number.isFinite(channelId)) continue;
      const state = channelQualityByChannelId.get(channelId);
      if (!state) {
        snapshots[String(channelId)] = {
          firstByteEmaMs: null,
          firstByteSampleCount: 0,
          tpsEma: null,
          tpsSampleCount: 0,
          recentSuccessCount: null,
          recentFailureCount: null,
          recentSuccessRate: null,
          recentSampleCount: 0,
          lastUpdatedAtMs: null,
        };
        continue;
      }
      const recent = getRecentOutcomeSnapshot(state, nowMs);
      snapshots[String(channelId)] = {
        firstByteEmaMs: state.firstByteEmaMs,
        firstByteSampleCount: state.firstByteSampleCount,
        tpsEma: state.tpsEma,
        tpsSampleCount: state.tpsSampleCount,
        recentSuccessCount: recent.successCount,
        recentFailureCount: recent.failureCount,
        recentSuccessRate: recent.sampleCount > 0 ? recent.successRate : null,
        recentSampleCount: recent.sampleCount,
        lastUpdatedAtMs: state.lastUpdatedAtMs,
      };
    }
    return snapshots;
  }

  /**
   * Get all available models (aggregated from all routes).
   */
  async getAvailableModels(): Promise<string[]> {
    const routes = await loadEnabledRoutes();
    const exposed = buildVisibleEnabledRoutes(routes)
      .map((route) => getExposedModelNameForRoute(route).trim())
      .filter((name) => name.length > 0);
    return Array.from(new Set(exposed));
  }

  // --- Private methods ---

  private async selectFromMatch(
    match: RouteMatch,
    requestedModel: string,
    downstreamPolicy: DownstreamRoutingPolicy,
    excludeChannelIds: number[] = [],
    recordSelection = true,
  ): Promise<SelectedChannel | null> {
    const mappedModel = resolveMappedModel(requestedModel, match.route.modelMapping);
    const requestedByDisplayName = isRouteDisplayNameMatch(requestedModel, match.route.displayName);
    const bypassSourceModelCheck = requestedByDisplayName;
    const routeStrategy = resolveRouteStrategy(match.route);
    const runtimeModelResolver = requestedByDisplayName
      ? ((candidate: RouteChannelCandidate) => normalizeChannelSourceModel(candidate.channel.sourceModel) || mappedModel)
      : mappedModel;

    const nowIso = new Date().toISOString();
    const nowMs = Date.now();
    const available = match.channels.filter((candidate) => (
      this.getCandidateEligibilityReasons(candidate, {
        requestedModel,
        bypassSourceModelCheck,
        excludeChannelIds,
        nowIso,
        downstreamPolicy,
      }).length === 0
    ));

    if (available.length === 0) return null;

    if (routeStrategy === 'round_robin') {
      const breakerFiltered = filterSiteRuntimeBrokenCandidatesByModel(available, runtimeModelResolver, nowMs);
      const selected = this.selectRoundRobinCandidate(breakerFiltered.candidates);
      if (!selected) return null;
      return await this.finalizeSelectedCandidateForDispatch(
        selected,
        match,
        requestedModel,
        mappedModel,
        downstreamPolicy,
        recordSelection,
        nowIso,
        nowMs,
        undefined,
        undefined,
        false,
        excludeChannelIds,
      );
    }

    if (routeStrategy === 'stable_first') {
      const breakerFiltered = filterSiteRuntimeBrokenCandidatesByModel(available, runtimeModelResolver, nowMs);
      const candidates = filterRecentlyFailedCandidates(breakerFiltered.candidates, nowMs);
      const rotationKey = this.buildStableFirstRotationKey(match.route.id, requestedModel);
      const poolPlan = buildStableFirstPoolPlan(
        candidates,
        requestedByDisplayName ? runtimeModelResolver : mappedModel,
        nowMs,
      );
      const shouldUseObservation = (
        poolPlan.observationCandidates.length > 0
        && (
          poolPlan.primaryCandidates.length <= 0
          || (
            recordSelection
            && shouldUseStableFirstObservationCandidate(rotationKey, poolPlan.observationCandidates, nowMs)
          )
        )
      );
      const selectionPool = shouldUseObservation
        ? poolPlan.observationCandidates
        : (poolPlan.primaryCandidates.length > 0 ? poolPlan.primaryCandidates : poolPlan.observationCandidates);
      const selected = this.stableFirstSelect(
        selectionPool,
        requestedByDisplayName ? runtimeModelResolver : mappedModel,
        downstreamPolicy,
        nowMs,
        shouldUseObservation ? `${rotationKey}:observe` : rotationKey,
      );
      if (!selected) return null;
      return await this.finalizeSelectedCandidateForDispatch(
        selected,
        match,
        requestedModel,
        mappedModel,
        downstreamPolicy,
        recordSelection,
        nowIso,
        nowMs,
        rotationKey,
        `${rotationKey}:observe`,
        shouldUseObservation,
        excludeChannelIds,
      );
    }

    const layers = new Map<number, typeof available>();
    for (const candidate of available) {
      const priority = candidate.channel.priority ?? 0;
      if (!layers.has(priority)) layers.set(priority, []);
      layers.get(priority)!.push(candidate);
    }

    const sortedPriorities = Array.from(layers.keys()).sort((a, b) => a - b);
    for (const priority of sortedPriorities) {
      const rawLayer = layers.get(priority) ?? [];
      const breakerFiltered = filterSiteRuntimeBrokenCandidatesByModel(rawLayer, runtimeModelResolver, nowMs);
      const candidates = filterRecentlyFailedCandidates(breakerFiltered.candidates, nowMs);
      const selected = this.weightedRandomSelect(
        candidates,
        requestedByDisplayName ? runtimeModelResolver : mappedModel,
        downstreamPolicy,
        nowMs,
      );
      if (!selected) continue;
      const resolved = await this.finalizeSelectedCandidateForDispatch(
        selected,
        match,
        requestedModel,
        mappedModel,
        downstreamPolicy,
        recordSelection,
        nowIso,
        nowMs,
        undefined,
        undefined,
        false,
        excludeChannelIds,
      );
      if (resolved) return resolved;
    }

    return null;
  }

  private async selectPreferredFromMatch(
    match: RouteMatch,
    requestedModel: string,
    preferredChannelId: number,
    downstreamPolicy: DownstreamRoutingPolicy,
    excludeChannelIds: number[] = [],
    recordSelection = true,
  ): Promise<SelectedChannel | null> {
    const mappedModel = resolveMappedModel(requestedModel, match.route.modelMapping);
    const requestedByDisplayName = isRouteDisplayNameMatch(requestedModel, match.route.displayName);
    const bypassSourceModelCheck = requestedByDisplayName;
    const routeStrategy = resolveRouteStrategy(match.route);
    const runtimeModelResolver = requestedByDisplayName
      ? ((candidate: RouteChannelCandidate) => normalizeChannelSourceModel(candidate.channel.sourceModel) || mappedModel)
      : mappedModel;

    const nowIso = new Date().toISOString();
    const nowMs = Date.now();
    const available = match.channels.filter((candidate) => (
      this.getCandidateEligibilityReasons(candidate, {
        requestedModel,
        bypassSourceModelCheck,
        excludeChannelIds,
        nowIso,
        downstreamPolicy,
      }).length === 0
    ));

    const preferred = available.find((candidate) => candidate.channel.id === preferredChannelId);
    if (!preferred) return null;

    const breakerFiltered = filterSiteRuntimeBrokenCandidatesByModel([preferred], runtimeModelResolver, nowMs);
    if (breakerFiltered.candidates.length <= 0) return null;

    const selected = breakerFiltered.candidates.find((candidate) => candidate.channel.id === preferredChannelId);
    if (!selected) return null;
    if (!isOauthRouteUnitCandidate(selected) && routeStrategy !== 'round_robin' && isChannelRecentlyFailed(selected.channel, nowMs)) {
      return null;
    }
    return await this.finalizeSelectedCandidateForDispatch(
      selected,
      match,
      requestedModel,
      mappedModel,
      downstreamPolicy,
      recordSelection && (routeStrategy === 'round_robin' || routeStrategy === 'stable_first'),
      nowIso,
      nowMs,
      routeStrategy === 'stable_first' ? this.buildStableFirstRotationKey(match.route.id, requestedModel) : undefined,
      routeStrategy === 'stable_first' ? `${this.buildStableFirstRotationKey(match.route.id, requestedModel)}:observe` : undefined,
      false,
      excludeChannelIds,
    );
  }

  private async findRoute(model: string, downstreamPolicy: DownstreamRoutingPolicy): Promise<RouteMatch | null> {
    let routes = await loadEnabledRoutes();

    const supportedPatterns = Array.isArray(downstreamPolicy.supportedModels)
      ? downstreamPolicy.supportedModels
      : [];
    const matchedSupportedPattern = supportedPatterns.some((pattern) => matchesModelPattern(model, pattern));

    if (downstreamPolicy.allowedRouteIds.length > 0 && !matchedSupportedPattern) {
      const allowSet = new Set(downstreamPolicy.allowedRouteIds);
      routes = routes.filter((route) => allowSet.has(route.id));
    }

    const matchedRoute = routes.find((route) => isExplicitGroupRoute(route) && isRouteDisplayNameMatch(model, route.displayName))
      || routes.find((route) => (
        !isExplicitGroupRoute(route)
        && isExactRouteModelPattern(route.modelPattern)
        && (route.modelPattern || '').trim() === model
      ))
      || routes.find((route) => !isExplicitGroupRoute(route) && isRouteDisplayNameMatch(model, route.displayName))
      || routes.find((route) => !isExplicitGroupRoute(route) && matchesModelPattern(model, route.modelPattern));

    if (!matchedRoute) return null;

    return await this.loadRouteMatch(matchedRoute);
  }

  private async findRouteById(routeId: number, downstreamPolicy: DownstreamRoutingPolicy): Promise<RouteMatch | null> {
    if (downstreamPolicy.allowedRouteIds.length > 0 && !downstreamPolicy.allowedRouteIds.includes(routeId)) {
      return null;
    }

    const route = (await loadEnabledRoutes()).find((item) => item.id === routeId);
    if (!route) return null;

    return await this.loadRouteMatch(route);
  }

  private async loadRouteMatch(route: RouteRow): Promise<RouteMatch> {
    return await loadRouteMatch(route);
  }

  private resolveRouteUnitMemberTokenValue(candidate: {
    account: typeof schema.accounts.$inferSelect;
  }): string | null {
    const oauthAccessToken = candidate.account.accessToken?.trim();
    if (oauthAccessToken) return oauthAccessToken;
    const apiToken = candidate.account.apiToken?.trim();
    return apiToken || null;
  }

  private buildRouteUnitMemberDispatchCandidate(
    outerCandidate: RouteChannelCandidate,
    memberCandidate: RouteChannelCandidate['routeUnitMembers'][number],
  ): RouteChannelCandidate {
    return {
      ...outerCandidate,
      account: memberCandidate.account,
      site: memberCandidate.site,
      token: null,
    };
  }

  private getRouteUnitMemberEligibilityReasons(
    outerCandidate: RouteChannelCandidate,
    memberCandidate: RouteChannelCandidate['routeUnitMembers'][number],
    options: CandidateEligibilityOptions,
  ): string[] {
    const reasonParts: string[] = [];
    const bypassSourceModelCheck = options.bypassSourceModelCheck ?? false;
    const nowIso = options.nowIso ?? new Date().toISOString();

    if (!bypassSourceModelCheck && !channelSupportsRequestedModel(outerCandidate.channel.sourceModel, options.requestedModel)) {
      reasonParts.push(`来源模型不匹配=${outerCandidate.channel.sourceModel || ''}`);
    }

    if (!outerCandidate.channel.enabled) reasonParts.push('通道禁用');

    if (memberCandidate.account.status !== 'active') {
      reasonParts.push(`账号状态=${memberCandidate.account.status}`);
    }

    if (isSiteDisabled(memberCandidate.site.status)) {
      reasonParts.push(`站点状态=${memberCandidate.site.status || 'disabled'}`);
    }

    const downstreamExclusionReason = this.resolveDownstreamExclusionReason(
      this.buildRouteUnitMemberDispatchCandidate(outerCandidate, memberCandidate),
      options.downstreamPolicy,
    );
    if (downstreamExclusionReason) {
      reasonParts.push(downstreamExclusionReason);
    }

    const tokenValue = this.resolveRouteUnitMemberTokenValue(memberCandidate);
    if (!tokenValue) reasonParts.push('令牌不可用');

    if (isOauthRouteUnitMemberCoolingDown(memberCandidate.member, nowIso)) {
      reasonParts.push('冷却中');
    }

    return reasonParts;
  }

  private getEligibleRouteUnitMembers(
    candidate: RouteChannelCandidate,
    options: CandidateEligibilityOptions,
  ): RouteChannelCandidate['routeUnitMembers'] {
    if (!isOauthRouteUnitCandidate(candidate)) return [];
    return candidate.routeUnitMembers.filter((memberCandidate) => (
      this.getRouteUnitMemberEligibilityReasons(candidate, memberCandidate, options).length === 0
    ));
  }

  private getRoundRobinRouteUnitMembers(
    members: RouteChannelCandidate['routeUnitMembers'],
  ): RouteChannelCandidate['routeUnitMembers'] {
    return [...members].sort((left, right) => {
      const selectionOrder = compareNullableTimeAsc(
        left.member.lastSelectedAt || left.member.lastUsedAt,
        right.member.lastSelectedAt || right.member.lastUsedAt,
      );
      if (selectionOrder !== 0) return selectionOrder;

      const usedOrder = compareNullableTimeAsc(left.member.lastUsedAt, right.member.lastUsedAt);
      if (usedOrder !== 0) return usedOrder;

      const sortOrder = (left.member.sortOrder ?? 0) - (right.member.sortOrder ?? 0);
      if (sortOrder !== 0) return sortOrder;

      return left.account.id - right.account.id;
    });
  }

  private getStickyPreferredRouteUnitMember(
    members: RouteChannelCandidate['routeUnitMembers'],
  ): RouteChannelCandidate['routeUnitMembers'][number] | null {
    return [...members].sort((left, right) => {
      const selectionOrder = compareNullableTimeDesc(
        left.member.lastSelectedAt || left.member.lastUsedAt,
        right.member.lastSelectedAt || right.member.lastUsedAt,
      );
      if (selectionOrder !== 0) return selectionOrder;

      const sortOrder = (left.member.sortOrder ?? 0) - (right.member.sortOrder ?? 0);
      if (sortOrder !== 0) return sortOrder;

      return left.account.id - right.account.id;
    })[0] ?? null;
  }

  private selectRouteUnitMember(
    candidate: RouteChannelCandidate,
    requestedModel: string,
    downstreamPolicy: DownstreamRoutingPolicy,
    nowIso: string,
    nowMs: number,
    excludeChannelIds: number[] = [],
  ): RouteChannelCandidate['routeUnitMembers'][number] | null {
    if (!isOauthRouteUnitCandidate(candidate)) return null;
    const eligibleMembers = this.getEligibleRouteUnitMembers(candidate, {
      requestedModel,
      bypassSourceModelCheck: true,
      excludeChannelIds: [],
      nowIso,
      downstreamPolicy,
    });
    if (eligibleMembers.length === 0) return null;

    const isRouteUnitFailover = excludeChannelIds.includes(candidate.channel.id);
    const healthyMembers = isRouteUnitFailover
      ? eligibleMembers.filter((memberCandidate) => !isChannelRecentlyFailed(memberCandidate.member, nowMs))
      : filterRecentlyFailedCandidates(
        eligibleMembers.map((memberCandidate) => ({
          memberCandidate,
          channel: memberCandidate.member,
        })),
        nowMs,
      ).map((item) => item.memberCandidate);
    const candidateMembers = healthyMembers.length > 0
      ? healthyMembers
      : (isRouteUnitFailover ? [] : eligibleMembers);
    if (candidate.routeUnit?.strategy === 'stick_until_unavailable') {
      const sticky = this.getStickyPreferredRouteUnitMember(candidateMembers);
      if (sticky) return sticky;
      return this.getRoundRobinRouteUnitMembers(candidateMembers)[0] ?? null;
    }

    return this.getRoundRobinRouteUnitMembers(candidateMembers)[0] ?? null;
  }

  private async recordRouteUnitMemberSelection(
    routeUnitId: number,
    accountId: number,
  ): Promise<void> {
    const nowIso = new Date().toISOString();
    await db.update(schema.oauthRouteUnitMembers).set({
      lastSelectedAt: nowIso,
      updatedAt: nowIso,
    }).where(and(
      eq(schema.oauthRouteUnitMembers.unitId, routeUnitId),
      eq(schema.oauthRouteUnitMembers.accountId, accountId),
    )).run();
    const routeRows = await db.select({
      routeId: schema.routeChannels.routeId,
    }).from(schema.routeChannels)
      .where(eq(schema.routeChannels.oauthRouteUnitId, routeUnitId))
      .all();
    const routeIds: number[] = Array.from(new Set<number>(
      routeRows
        .map((row) => Number(row.routeId))
        .filter((routeId): routeId is number => Number.isFinite(routeId) && routeId > 0),
    ));
    for (const routeId of routeIds) {
      invalidateRouteScopedCache(routeId);
    }
  }

  private resolveChannelTokenValue(candidate: {
    channel: typeof schema.routeChannels.$inferSelect;
    account: typeof schema.accounts.$inferSelect;
    site?: typeof schema.sites.$inferSelect | null;
    token: typeof schema.accountTokens.$inferSelect | null;
  }): string | null {
    if (candidate.channel.tokenId) {
      if (!candidate.token) return null;
      if (!isUsableAccountToken(candidate.token)) return null;
      const token = candidate.token.token?.trim();
      return token ? token : null;
    }

    if (getOauthInfoFromAccount(candidate.account)) {
      const accessToken = candidate.account.accessToken?.trim();
      if (accessToken) return accessToken;
      return null;
    }

    const fallback = candidate.account.apiToken?.trim();
    if (fallback) return fallback;

    return null;
  }

  private resolveDownstreamExclusionReason(
    candidate: RouteChannelCandidate,
    downstreamPolicy?: DownstreamRoutingPolicy,
  ): string | null {
    if (!downstreamPolicy) return null;

    const excludedSiteIds = Array.isArray(downstreamPolicy.excludedSiteIds)
      ? downstreamPolicy.excludedSiteIds
      : [];
    if (excludedSiteIds.includes(candidate.site.id)) {
      return '站点已被下游密钥排除';
    }

    const excludedCredentialRefs = Array.isArray(downstreamPolicy.excludedCredentialRefs)
      ? downstreamPolicy.excludedCredentialRefs
      : [];
    if (excludedCredentialRefs.length <= 0) {
      return null;
    }

    for (const ref of excludedCredentialRefs) {
      if (ref.kind === 'account_token') {
        if (
          candidate.channel.tokenId === ref.tokenId
          && candidate.token?.id === ref.tokenId
          && candidate.account.id === ref.accountId
          && candidate.site.id === ref.siteId
        ) {
          return 'API Key/令牌已被下游密钥排除';
        }
        continue;
      }

      if (
        candidate.channel.tokenId == null
        && candidate.account.id === ref.accountId
        && candidate.site.id === ref.siteId
      ) {
        const resolvedTokenValue = this.resolveChannelTokenValue(candidate);
        const accountApiToken = candidate.account.apiToken?.trim() || '';
        if (resolvedTokenValue && accountApiToken && resolvedTokenValue === accountApiToken) {
          return 'API Key/令牌已被下游密钥排除';
        }
      }
    }

    return null;
  }

  private getCandidateEligibilityReasons(
    candidate: RouteChannelCandidate,
    options: CandidateEligibilityOptions,
  ): string[] {
    const reasonParts: string[] = [];
    const bypassSourceModelCheck = options.bypassSourceModelCheck ?? false;
    const excludeChannelIds = options.excludeChannelIds ?? [];
    const nowIso = options.nowIso ?? new Date().toISOString();

    if (!bypassSourceModelCheck && !channelSupportsRequestedModel(candidate.channel.sourceModel, options.requestedModel)) {
      reasonParts.push(`来源模型不匹配=${candidate.channel.sourceModel || ''}`);
    }

    if (!candidate.channel.enabled) reasonParts.push('通道禁用');

    if (isOauthRouteUnitCandidate(candidate)) {
      if (excludeChannelIds.includes(candidate.channel.id)) {
        // Route-unit failover should stay inside the same outer channel and switch members instead of
        // excluding the entire pool after one member fails.
      }

      if (this.getEligibleRouteUnitMembers(candidate, options).length === 0) {
        reasonParts.push(`路由池成员不可用（${candidate.routeUnit?.name || getOauthRouteUnitStrategyLabel(candidate.routeUnit?.strategy || 'round_robin')}）`);
      }
      return reasonParts;
    }

    if (isExplicitTokenChannel(candidate)) {
      if (candidate.account.status === 'disabled') {
        reasonParts.push(`账号状态=${candidate.account.status}`);
      }
    } else if (candidate.account.status !== 'active') {
      reasonParts.push(`账号状态=${candidate.account.status}`);
    }

    if (isSiteDisabled(candidate.site.status)) {
      reasonParts.push(`站点状态=${candidate.site.status || 'disabled'}`);
    }

    const downstreamExclusionReason = this.resolveDownstreamExclusionReason(candidate, options.downstreamPolicy);
    if (downstreamExclusionReason) {
      reasonParts.push(downstreamExclusionReason);
    }

    if (excludeChannelIds.includes(candidate.channel.id)) {
      reasonParts.push('当前请求已尝试');
    }

    const tokenValue = this.resolveChannelTokenValue(candidate);
    if (!tokenValue) reasonParts.push('令牌不可用');

    if (candidate.channel.cooldownUntil && candidate.channel.cooldownUntil > nowIso) {
      reasonParts.push('冷却中');
    }

    return reasonParts;
  }

  private getRoundRobinCandidates(candidates: RouteChannelCandidate[]): RouteChannelCandidate[] {
    return [...candidates].sort((left, right) => {
      const selectionOrder = compareNullableTimeAsc(
        left.channel.lastSelectedAt || left.channel.lastUsedAt,
        right.channel.lastSelectedAt || right.channel.lastUsedAt,
      );
      if (selectionOrder !== 0) return selectionOrder;

      const usedOrder = compareNullableTimeAsc(left.channel.lastUsedAt, right.channel.lastUsedAt);
      if (usedOrder !== 0) return usedOrder;

      return (left.channel.id ?? 0) - (right.channel.id ?? 0);
    });
  }

  private selectRoundRobinCandidate(candidates: RouteChannelCandidate[]): RouteChannelCandidate | null {
    return this.getRoundRobinCandidates(candidates)[0] ?? null;
  }

  private compareStableFirstCandidates(left: RouteChannelCandidate, right: RouteChannelCandidate): number {
    return compareStableFirstCandidateOrder(left, right);
  }

  private buildStableFirstRotationKey(routeId: number, requestedModel: string): string {
    const normalizedModel = normalizeModelAlias(requestedModel)
      || normalizeRouteDisplayName(requestedModel).toLowerCase()
      || String(routeId);
    return `${routeId}:${normalizedModel}`;
  }

  private getStableFirstSiteOrder(candidates: RouteChannelCandidate[], siteId: number): number {
    let order = Number.POSITIVE_INFINITY;
    for (const candidate of candidates) {
      if (candidate.site.id !== siteId) continue;
      order = Math.min(order, candidate.channel.priority ?? 0);
    }
    return Number.isFinite(order) ? order : 0;
  }

  private getStableFirstOrderedSiteLeaderIndices(
    candidates: RouteChannelCandidate[],
    stableSiteLeaderIndices: number[],
  ): number[] {
    return [...stableSiteLeaderIndices].sort((leftIndex, rightIndex) => {
      const leftSiteId = candidates[leftIndex]?.site.id ?? 0;
      const rightSiteId = candidates[rightIndex]?.site.id ?? 0;
      const orderDiff = this.getStableFirstSiteOrder(candidates, leftSiteId)
        - this.getStableFirstSiteOrder(candidates, rightSiteId);
      if (orderDiff !== 0) return orderDiff;
      return (candidates[leftIndex]?.channel.id ?? 0) - (candidates[rightIndex]?.channel.id ?? 0);
    });
  }

  private async recordChannelSelection(channelId: number): Promise<void> {
    const nowIso = new Date().toISOString();
    await db.update(schema.routeChannels).set({
      lastSelectedAt: nowIso,
    }).where(eq(schema.routeChannels.id, channelId)).run();

    patchCachedChannel(channelId, (channel) => {
      channel.lastSelectedAt = nowIso;
    });
  }

  private async finalizeSelectedCandidateForDispatch(
    selected: RouteChannelCandidate,
    match: RouteMatch,
    requestedModel: string,
    mappedModel: string,
    downstreamPolicy: DownstreamRoutingPolicy,
    recordSelection: boolean,
    nowIso: string,
    nowMs: number,
    stableFirstRotationKey?: string,
    stableFirstObservationKey?: string,
    usedObservation = false,
    excludeChannelIds: number[] = [],
  ): Promise<SelectedChannel | null> {
    let dispatchCandidate = selected;
    let resolvedRouteUnitMemberTokenValue: string | null = null;
    if (isOauthRouteUnitCandidate(selected)) {
      const member = this.selectRouteUnitMember(
        selected,
        requestedModel,
        downstreamPolicy,
        nowIso,
        nowMs,
        excludeChannelIds,
      );
      if (!member || !selected.routeUnit) return null;
      resolvedRouteUnitMemberTokenValue = this.resolveRouteUnitMemberTokenValue(member);
      dispatchCandidate = this.buildRouteUnitMemberDispatchCandidate(selected, member);
      if (recordSelection) {
        await this.recordRouteUnitMemberSelection(selected.routeUnit.id, member.account.id);
      }
    }

    const tokenValue = resolvedRouteUnitMemberTokenValue ?? this.resolveChannelTokenValue(dispatchCandidate);
    if (!tokenValue) return null;

    if (recordSelection) {
      if (stableFirstRotationKey && stableFirstObservationKey) {
        rememberStableFirstSiteSelectionForKey(
          usedObservation ? stableFirstObservationKey : stableFirstRotationKey,
          dispatchCandidate.site.id,
        );
        updateStableFirstObservationProgress(stableFirstRotationKey, {
          usedObservation,
          selectedSiteId: dispatchCandidate.site.id,
          nowMs,
        });
      }
      await this.recordChannelSelection(selected.channel.id);
    }

    const actualModel = resolveActualModelForSelectedChannel(
      requestedModel,
      match.route,
      mappedModel,
      selected.channel.sourceModel,
    );

    return {
      ...dispatchCandidate,
      channel: selected.channel,
      tokenValue,
      tokenName: dispatchCandidate.token?.name || 'default',
      actualModel,
    };
  }

  private weightedRandomSelect(
    candidates: RouteChannelCandidate[],
    modelName: string | ((candidate: RouteChannelCandidate) => string),
    downstreamPolicy: DownstreamRoutingPolicy,
    nowMs = Date.now(),
  ) {
    return this.calculateWeightedSelection(candidates, modelName, downstreamPolicy, nowMs, 'weighted').selected;
  }

  private stableFirstSelect(
    candidates: RouteChannelCandidate[],
    modelName: string | ((candidate: RouteChannelCandidate) => string),
    downstreamPolicy: DownstreamRoutingPolicy,
    nowMs = Date.now(),
    stableFirstRotationKey?: string,
  ) {
    return this.calculateWeightedSelection(
      candidates,
      modelName,
      downstreamPolicy,
      nowMs,
      'stable_first',
      stableFirstRotationKey,
    ).selected;
  }

  private calculateWeightedSelection(
    candidates: RouteChannelCandidate[],
    modelName: string | ((candidate: RouteChannelCandidate) => string),
    downstreamPolicy: DownstreamRoutingPolicy,
    nowMs = Date.now(),
    selectionMode: WeightedSelectionMode = 'weighted',
    stableFirstRotationKey?: string,
  ): WeightedSelectionResult {
    if (candidates.length === 0) {
      return {
        selected: null as RouteChannelCandidate | null,
        details: [] as Array<{ candidate: RouteChannelCandidate; probability: number; reason: string }>,
        stableSiteCount: 0,
      };
    }

    const {
      baseWeightFactor,
      valueScoreFactor,
      costWeight,
      balanceWeight,
      usageWeight,
      firstByteWeight,
      speedWeight,
      successWeight,
    } = config.routingWeights;
    const resolveModelName = typeof modelName === 'function'
      ? modelName
      : (() => modelName);
    const effectiveCosts = candidates.map((candidate) => resolveEffectiveUnitCost(candidate, resolveModelName(candidate)));
    const runtimeHealthDetails = candidates.map((candidate) => (
      getSiteRuntimeHealthDetails(candidate.site.id, resolveModelName(candidate), nowMs)
    ));
    const channelLoadSnapshots = candidates.map((candidate) => (
      proxyChannelCoordinator.getChannelLoadSnapshot({
        channelId: candidate.channel.id,
        accountExtraConfig: candidate.account.extraConfig,
        accountOauthProvider: candidate.account.oauthProvider,
      })
    ));
    const siteHistoricalHealthMetrics = buildSiteHistoricalHealthMetrics(candidates);

    // Each value-score component is normalized into [0,1] BEFORE the weighted sum.
    // The old raw-sum-then-min-max let one outlier (e.g. a balance quoted in
    // dollars) stretch the whole field and swallow every other component. Quality
    // components shrink toward the neutral score while samples are scarce, and the
    // success-rate component reuses the confidence-blended stable-first resolution,
    // so a fresh channel starts neutral instead of being flattened to zero and
    // never earning the traffic that would produce evidence.
    const componentScores = candidates.map((candidate, i) => {
      const unitCost = effectiveCosts[i]?.unitCost || 1;
      const balance = candidate.account.balance || 0;
      const totalUsed = (candidate.channel.successCount ?? 0) + (candidate.channel.failCount ?? 0);
      const recentUsage = Math.max(totalUsed, 1);
      const runtimeDetail = runtimeHealthDetails[i];
      // Step two of the channel-granularity rollout: first-byte / speed prefer the
      // channel's own EMA and fall back to the site detail; the SR component keeps
      // the site-level recent window but its historical fallback now uses the
      // channel's own lifetime counters, so a sibling's bad history can no longer
      // stain this credential (and a new channel no longer inherits a bad one).
      const channelEvidence = resolveChannelQualityEmaEvidence(candidate.channel.id, runtimeDetail);
      const firstByteScore = channelEvidence.firstByteEmaMs != null
        ? blendQualityComponentScore(
          clampNumber(SITE_RUNTIME_LATENCY_BASELINE_MS / Math.max(1, channelEvidence.firstByteEmaMs), 0, 1),
          channelEvidence.firstByteConfidence,
        )
        : NEUTRAL_VALUE_COMPONENT_SCORE;
      const speedScore = channelEvidence.tpsEma != null
        ? blendQualityComponentScore(
          clampNumber(channelEvidence.tpsEma / SITE_RUNTIME_SPEED_TARGET_TPS, 0, 1),
          channelEvidence.tpsConfidence,
        )
        : NEUTRAL_VALUE_COMPONENT_SCORE;
      const channelHistoricalSuccessRate = totalUsed > 0
        ? Math.max(0, candidate.channel.successCount ?? 0) / totalUsed
        : null;
      const successScore = resolveStableFirstSuccessRate(
        runtimeDetail,
        channelHistoricalSuccessRate,
      );
      return { unitCost, balance, recentUsage, firstByteScore, speedScore, successScore, channelEvidence, channelHistoricalSuccessRate };
    });
    const cheapestUnitCost = Math.min(...componentScores.map((c) => c.unitCost));
    const maxBalance = Math.max(...componentScores.map((c) => c.balance), 0);
    const leastRecentUsage = Math.min(...componentScores.map((c) => c.recentUsage));

    const valueScores = componentScores.map((c) => (
      costWeight * clampNumber(cheapestUnitCost / c.unitCost, 0, 1)
      + balanceWeight * (maxBalance > 0 ? clampNumber(c.balance / maxBalance, 0, 1) : NEUTRAL_VALUE_COMPONENT_SCORE)
      + usageWeight * clampNumber(leastRecentUsage / c.recentUsage, 0, 1)
      + firstByteWeight * c.firstByteScore
      + speedWeight * c.speedScore
      + successWeight * c.successScore
    ));

    const baseContributions = candidates.map((c, i) => {
      const weight = c.channel.weight ?? 10;
      return (weight + 10) * (baseWeightFactor + valueScores[i] * valueScoreFactor);
    });

    // Avoid over-favoring a site that has many tokens/channels for the same route.
    // Site-level total contribution remains comparable, then split across its channels.
    const siteChannelCounts = new Map<number, number>();
    for (const candidate of candidates) {
      siteChannelCounts.set(candidate.site.id, (siteChannelCounts.get(candidate.site.id) || 0) + 1);
    }

    const contributions = candidates.map((candidate, i) => {
      const siteChannels = Math.max(1, siteChannelCounts.get(candidate.site.id) || 1);
      const runtimeMultiplier = runtimeHealthDetails[i]?.combinedMultiplier ?? 1;
      const runtimeLoadMultiplier = resolveChannelRuntimeLoadMultiplier(channelLoadSnapshots[i]);
      if (selectionMode === 'stable_first') {
        const recentSuccessRate = resolveStableFirstSuccessRate(
          runtimeHealthDetails[i],
          siteHistoricalHealthMetrics.get(candidate.site.id)?.successRate,
        );
        let contribution = Math.max(1e-4, recentSuccessRate ** 2);
        contribution *= runtimeMultiplier;
        contribution *= runtimeLoadMultiplier;
        return contribution / siteChannels;
      }

      let contribution = baseContributions[i] / siteChannels;
      const downstreamSiteMultiplier = downstreamPolicy.siteWeightMultipliers[candidate.site.id] ?? 1;
      const normalizedDownstreamSiteMultiplier =
        (Number.isFinite(downstreamSiteMultiplier) && downstreamSiteMultiplier > 0)
          ? downstreamSiteMultiplier
          : 1;
      const siteGlobalWeight =
        (Number.isFinite(candidate.site.globalWeight) && (candidate.site.globalWeight || 0) > 0)
          ? (candidate.site.globalWeight as number)
          : 1;
      const combinedSiteWeight = siteGlobalWeight * normalizedDownstreamSiteMultiplier;
      if (combinedSiteWeight > 0 && Number.isFinite(combinedSiteWeight)) {
        contribution *= combinedSiteWeight;
      }

      contribution *= runtimeMultiplier;
      // Historical health (success rate + average latency) no longer damps the
      // weighted contribution: both signals moved into the value score as explicit,
      // user-tunable components, and multiplying them here would double-count every
      // failure and every slow response. The stable-first branch still consumes the
      // historical success rate through resolveStableFirstSuccessRate.
      contribution *= runtimeLoadMultiplier;

      // If upstream price is unknown and we are using fallback unit cost,
      // apply an explicit penalty so raising fallback cost meaningfully lowers probability.
      if (effectiveCosts[i]?.source === 'fallback') {
        contribution *= 1 / Math.max(1, effectiveCosts[i]?.unitCost || 1);
      }

      return contribution;
    });

    const totalContribution = contributions.reduce((a, b) => a + b, 0);
    const rankedIndices = candidates.map((_, index) => index)
      .sort((leftIndex, rightIndex) => {
        const contributionDiff = contributions[rightIndex] - contributions[leftIndex];
        if (Math.abs(contributionDiff) > 1e-9) {
          return contributionDiff > 0 ? 1 : -1;
        }
        return this.compareStableFirstCandidates(candidates[leftIndex], candidates[rightIndex]);
      });
    const rankByIndex = new Map<number, number>();
    rankedIndices.forEach((candidateIndex, rank) => {
      rankByIndex.set(candidateIndex, rank + 1);
    });
    const stableSiteLeaderIndices = selectionMode === 'stable_first'
      ? this.getStableFirstSiteLeaderIndices(candidates, contributions, rankedIndices)
      : [];
    const stableSiteIds = new Set(stableSiteLeaderIndices.map((index) => candidates[index]?.site.id).filter((siteId) => typeof siteId === 'number'));
    const details = candidates.map((candidate, i) => {
      const probability = totalContribution > 0 ? contributions[i] / totalContribution : 0;
      const weight = candidate.channel.weight ?? 10;
      const cost = effectiveCosts[i];
      const costSourceText = cost?.source === 'observed'
        ? '实测'
        : (cost?.source === 'configured' ? '配置' : (cost?.source === 'catalog' ? '目录' : '默认'));
      const siteChannels = Math.max(1, siteChannelCounts.get(candidate.site.id) || 1);
      const downstreamSiteMultiplier = downstreamPolicy.siteWeightMultipliers[candidate.site.id] ?? 1;
      const normalizedDownstreamSiteMultiplier =
        (Number.isFinite(downstreamSiteMultiplier) && downstreamSiteMultiplier > 0)
          ? downstreamSiteMultiplier
          : 1;
      const siteGlobalWeight =
        (Number.isFinite(candidate.site.globalWeight) && (candidate.site.globalWeight || 0) > 0)
          ? (candidate.site.globalWeight as number)
          : 1;
      const combinedSiteWeight = siteGlobalWeight * normalizedDownstreamSiteMultiplier;
      const siteRuntimeDetail = runtimeHealthDetails[i];
      const siteHistoricalHealth = siteHistoricalHealthMetrics.get(candidate.site.id);
      const historicalSuccessRateText = siteHistoricalHealth?.successRate == null
        ? '—'
        : `${(siteHistoricalHealth.successRate * 100).toFixed(1)}%`;
      const channelRuntimeLoad = channelLoadSnapshots[i];
      const runtimeHealthText = siteRuntimeDetail.modelKey
        ? `${siteRuntimeDetail.combinedMultiplier.toFixed(2)}（站点=${siteRuntimeDetail.globalMultiplier.toFixed(2)}，模型=${siteRuntimeDetail.modelMultiplier.toFixed(2)}）`
        : `${siteRuntimeDetail.globalMultiplier.toFixed(2)}`;
      const runtimeLoadText = formatChannelRuntimeLoad(channelRuntimeLoad);
      const recentSuccessRateText = `${(siteRuntimeDetail.recentSuccessRate * 100).toFixed(1)}%`;
      // Each mode consumes a different blend: stable-first scores the site-level
      // resolution, while weighted mode (step two) scores with channel-granular
      // evidence — own EMA, own lifetime history as the SR fallback. The reason
      // string must show the values its mode actually consumed.
      const stableFirstSuccessRate = resolveStableFirstSuccessRate(siteRuntimeDetail, siteHistoricalHealth?.successRate);
      const stableFirstSuccessRateText = `${(stableFirstSuccessRate * 100).toFixed(1)}%`;
      const weightedSuccessRate = resolveStableFirstSuccessRate(
        siteRuntimeDetail,
        componentScores[i].channelHistoricalSuccessRate,
      );
      const weightedSuccessRateText = `${(weightedSuccessRate * 100).toFixed(1)}%`;
      const channelEvidence = componentScores[i].channelEvidence;
      const firstByteEmaText = channelEvidence.firstByteEmaMs == null
        ? '—'
        : `${channelEvidence.firstByteEmaMs}ms${channelEvidence.firstByteFromChannel ? '·通道' : '·站点'}`;
      const tpsEmaText = channelEvidence.tpsEma == null
        ? '—'
        : `${channelEvidence.tpsEma.toFixed(1)}tps${channelEvidence.tpsFromChannel ? '·通道' : '·站点'}`;
      const valueScoreText = valueScores[i].toFixed(3);
      const stableSiteOrder = this.getStableFirstSiteOrder(candidates, candidate.site.id);
      const reasonPrefix = selectionMode === 'stable_first'
        ? (
          candidates.length === 1
            ? '稳定优先（唯一可用候选'
            : `稳定优先（综合评分第 ${rankByIndex.get(i) ?? 1} / ${candidates.length}`
        )
        : (
          candidates.length === 1
            ? '按权重随机（唯一可用候选'
            : '按权重随机'
        );
      const stablePoolText = selectionMode === 'stable_first'
        ? `，轮询顺位=P${stableSiteOrder}`
        : '';
      return {
        candidate,
        probability,
        reason: selectionMode === 'stable_first'
          ? `${reasonPrefix}，近期成功率=${recentSuccessRateText}（样本=${siteRuntimeDetail.recentSampleCount.toFixed(2)}，置信=${siteRuntimeDetail.recentConfidence.toFixed(2)}），回退成功率=${historicalSuccessRateText}，综合近期成功率=${stableFirstSuccessRateText}，运行时健康=${runtimeHealthText}，会话负载=${runtimeLoadText}，同站点通道=${siteChannels}${stablePoolText}，评分占比≈${(probability * 100).toFixed(1)}%）`
          : (
            candidates.length === 1
              ? `${reasonPrefix}，W=${weight}，成本=${costSourceText}:${(cost?.unitCost || 1).toFixed(6)}，站点权重=${siteGlobalWeight.toFixed(2)}x下游倍率=${normalizedDownstreamSiteMultiplier.toFixed(2)}=${combinedSiteWeight.toFixed(2)}，运行时健康=${runtimeHealthText}，会话负载=${runtimeLoadText}，价值分=${valueScoreText}（首字=${firstByteEmaText}，速度=${tpsEmaText}，成功率=${weightedSuccessRateText}），同站点通道=${siteChannels}，概率≈${(probability * 100).toFixed(1)}%）`
              : `按权重随机（W=${weight}，成本=${costSourceText}:${(cost?.unitCost || 1).toFixed(6)}，站点权重=${siteGlobalWeight.toFixed(2)}x下游倍率=${normalizedDownstreamSiteMultiplier.toFixed(2)}=${combinedSiteWeight.toFixed(2)}，运行时健康=${runtimeHealthText}，会话负载=${runtimeLoadText}，价值分=${valueScoreText}（首字=${firstByteEmaText}，速度=${tpsEmaText}，成功率=${weightedSuccessRateText}），同站点通道=${siteChannels}，概率≈${(probability * 100).toFixed(1)}%）`
          ),
      };
    });

    let selected = candidates[rankedIndices[0] ?? 0];
    if (selectionMode === 'weighted') {
      let rand = Math.random() * totalContribution;
      selected = candidates[candidates.length - 1];
      for (let i = 0; i < candidates.length; i++) {
        rand -= contributions[i];
        if (rand <= 0) {
          selected = candidates[i];
          break;
        }
      }
    } else {
      selected = this.selectStableFirstCandidate(
        candidates,
        contributions,
        rankedIndices,
        stableFirstRotationKey,
      ) ?? selected;
    }

    return {
      selected,
      details,
      stableSiteCount: stableSiteIds.size,
    };
  }

  private getStableFirstSiteLeaderIndices(
    candidates: RouteChannelCandidate[],
    contributions: number[],
    rankedIndices: number[],
  ): number[] {
    if (rankedIndices.length <= 1) return rankedIndices;

    const siteLeaderIndices: number[] = [];
    const seenSiteIds = new Set<number>();
    for (const index of rankedIndices) {
      const siteId = candidates[index]?.site.id;
      if (!Number.isFinite(siteId) || seenSiteIds.has(siteId)) continue;
      seenSiteIds.add(siteId);
      siteLeaderIndices.push(index);
    }

    if (siteLeaderIndices.length <= 1) return siteLeaderIndices;

    const bestContribution = contributions[siteLeaderIndices[0] ?? rankedIndices[0] ?? 0] ?? 0;
    const stableSiteLeaderIndices = siteLeaderIndices.filter((index) => (
      isContributionCloseToBest(contributions[index] ?? 0, bestContribution)
    ));

    return stableSiteLeaderIndices.length > 0 ? stableSiteLeaderIndices : siteLeaderIndices;
  }

  private selectStableFirstCandidate(
    candidates: RouteChannelCandidate[],
    contributions: number[],
    rankedIndices: number[],
    stableFirstRotationKey?: string,
  ): RouteChannelCandidate | null {
    const stableSiteLeaderIndices = this.getStableFirstSiteLeaderIndices(candidates, contributions, rankedIndices);
    if (stableSiteLeaderIndices.length <= 0) return candidates[rankedIndices[0] ?? 0] ?? null;

    const orderedSiteLeaderIndices = this.getStableFirstOrderedSiteLeaderIndices(candidates, stableSiteLeaderIndices);
    const lastSelectedSiteId = stableFirstRotationKey
      ? stableFirstLastSelectedSiteByKey.get(stableFirstRotationKey)
      : undefined;
    const lastSelectedIndex = typeof lastSelectedSiteId === 'number'
      ? orderedSiteLeaderIndices.findIndex((index) => candidates[index]?.site.id === lastSelectedSiteId)
      : -1;
    const selectedSiteLeader = orderedSiteLeaderIndices[lastSelectedIndex >= 0
      ? ((lastSelectedIndex + 1) % orderedSiteLeaderIndices.length)
      : 0];
    if (selectedSiteLeader == null) return candidates[rankedIndices[0] ?? 0] ?? null;

    const selectedSiteId = candidates[selectedSiteLeader]?.site.id;
    const topSiteCandidateIndex = rankedIndices.find((index) => candidates[index]?.site.id === selectedSiteId);
    return topSiteCandidateIndex == null ? (candidates[selectedSiteLeader] ?? null) : (candidates[topSiteCandidateIndex] ?? null);
  }
}

export const tokenRouter = new TokenRouter();

export const __tokenRouterTestUtils = {
  resolveMappedModel,
  getStableFirstRotationCacheSize: () => stableFirstLastSelectedSiteByKey.size,
  rememberStableFirstSiteSelectionForKey,
  applyFailureCooldownJitter,
  /**
   * Pins the cooldown jitter draw so a test can assert an exact cooldown instead of a
   * range. Pass null to restore `Math.random`.
   */
  setFailureCooldownJitterSource: (source: (() => number) | null) => {
    failureCooldownJitterSource = source ?? Math.random;
  },
};

