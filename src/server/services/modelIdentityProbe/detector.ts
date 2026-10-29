/**
 * The ONLY module that imports `lmfpd-sdk` (the lm-detector SDK).
 *
 * The SDK is young (0.1.0), so every call into it is funnelled through here: an API change
 * then touches one file. The architecture test pins this.
 *
 * What we take from the SDK: challenge generation, the request BODY for each protocol (so the
 * prompt environment matches the one the reference bank was sampled under), number parsing,
 * scoring, and reference-data loading. What we do NOT take: its HTTP path (`detect`,
 * `requestSample`). Upstream requests go through metapi's own probe pipeline, so the site's
 * endpoint pool, leases, forwarding proxy, usage log and debug traces all apply, and no key
 * ever leaves this box.
 */

import { join } from 'node:path';
import {
  buildRequest,
  generateChallenges,
  loadDetector,
  parseNumbers,
  type Analysis,
  type Challenge,
  type Detector,
  type Output,
} from 'lmfpd-sdk';
import { config } from '../../config.js';
import { IDENTITY_PROBE_CHALLENGE_COUNT } from '../../../shared/modelIdentityProbe.js';

export type { Analysis as IdentityAnalysis, Challenge as IdentityChallenge, Output as IdentityOutput };

/** The scoring surface the service needs; an interface so tests can stand one in. */
export type IdentityDetector = {
  builtAt: string;
  analyze(outputs: Output[]): Analysis;
};

/** The three downstream shapes metapi can send, mapped to the SDK's API names. */
export type IdentityRequestFormat = 'openai' | 'claude' | 'responses';

const SDK_API_BY_FORMAT = {
  openai: 'chat_completions',
  claude: 'messages',
  responses: 'responses',
} as const;

/**
 * `buildRequest` validates a full config; these placeholders satisfy it. Only the BODY is
 * used — URL and headers are discarded, so neither value can reach the wire.
 */
const PLACEHOLDER_BASE_URL = 'https://placeholder.invalid/v1';
const PLACEHOLDER_API_KEY = 'unused';

let detectorPromise: Promise<IdentityDetector> | null = null;
let lastLoadedBuiltAt: string | null = null;

function resolveLoadOptions(): { source?: string | string[]; cache: string; ttl: number } {
  const sources = config.modelIdentityDataSource;
  return {
    ...(sources.length > 0 ? { source: sources.length === 1 ? sources[0]! : sources } : {}),
    cache: join(config.dataDir, 'lmfpd', 'data.bin'),
    ttl: config.modelIdentityDataTtlSeconds,
  };
}

function wrapDetector(detector: Detector): IdentityDetector {
  return {
    builtAt: detector.builtAt,
    analyze: (outputs) => detector.analyze(outputs),
  };
}

/**
 * The loaded reference bank, as a process-wide singleton.
 *
 * A failed load clears the singleton so the next click retries (the SDK's error already
 * lists every source it tried). A loaded detector stays for the process lifetime; the SDK
 * refreshes its cache file in the background, and the next process picks the update up.
 */
export function getIdentityDetector(): Promise<IdentityDetector> {
  if (!detectorPromise) {
    detectorPromise = loadDetector(resolveLoadOptions())
      .then((detector) => {
        const wrapped = wrapDetector(detector);
        lastLoadedBuiltAt = wrapped.builtAt;
        return wrapped;
      })
      .catch((error) => {
        detectorPromise = null;
        throw error;
      });
  }
  return detectorPromise;
}

/**
 * `builtAt` of the bank this process has loaded, or null before the first load.
 *
 * The channel list uses it to hide verdicts scored against an older bank — without ever
 * triggering a download itself.
 */
export function getLoadedIdentityBankBuiltAt(): string | null {
  return lastLoadedBuiltAt;
}

/** Three challenges with distinct counts (292–332), each in a random language. */
export function generateIdentityChallenges(): Challenge[] {
  return generateChallenges(IDENTITY_PROBE_CHALLENGE_COUNT);
}

/**
 * The request body the SDK would send for this prompt, on this protocol.
 *
 * Using the SDK's own body (rather than a metapi-built one) keeps the sampling environment
 * identical to what the reference bank was built from. A `{ error }` here means a bug in
 * this module's placeholders, not a channel problem, so it throws.
 */
export function buildIdentityRequestBody(
  format: IdentityRequestFormat,
  model: string,
  prompt: string,
): Record<string, unknown> {
  const built = buildRequest({
    baseUrl: PLACEHOLDER_BASE_URL,
    apiKey: PLACEHOLDER_API_KEY,
    model,
    api: SDK_API_BY_FORMAT[format],
  }, prompt);
  if ('error' in built) {
    throw new Error(`lmfpd-sdk buildRequest rejected the probe config: ${built.error}`);
  }
  return structuredClone(built.body);
}

/** The integers 1–355 of the longest run in a reply. */
export function parseIdentityNumbers(text: string): number[] {
  return parseNumbers(text);
}

/**
 * Minimum integers a reply needs to be scored: `max(80, ceil(0.55 × expected))`, the
 * SDK's own rule (restated so the detail panel can say why a reply was dropped).
 */
export function minimumIdentityNumbers(expectedCount: number): number {
  return Math.max(80, Math.ceil(expectedCount * 0.55));
}

export function resetIdentityDetectorForTests(): void {
  detectorPromise = null;
  lastLoadedBuiltAt = null;
}
