/**
 * Resolves which observed-timeout budget applies to one upstream attempt.
 *
 * `fetchWithObservedFirstByte()` always measures the same thing: the wait until the
 * first readable body chunk. What that instant MEANS depends on the response shape:
 *
 * - streaming upstream: the first chunk is the first SSE frame, so the budget really is
 *   a "首字" timeout and a short value is a healthy failover trigger;
 * - non-streaming upstream: the body arrives only once generation has finished, so the
 *   same budget silently becomes a total response deadline;
 * - media generation (images/videos): same as non-stream, except normal completion takes
 *   tens of seconds to minutes, so a stream-shaped budget aborts healthy requests.
 *
 * One knob therefore cannot serve all three. This module keeps the mechanism unchanged
 * and only chooses the budget, so the surfaces stay free of shape-detection logic.
 *
 * Deliberately dependency-free: ~13 test files install explicit `vi.mock` factories over
 * modules in `services/`, and a config-reading import here would resolve to `undefined`
 * under them. Callers pass their own already-imported config object instead.
 */

export type ResponseTimeoutKind = 'stream' | 'non-stream' | 'media';

export interface ResponseTimeoutSettingsLike {
  proxyFirstByteTimeoutSec?: number | null;
  proxyNonStreamTimeoutSec?: number | null;
  proxyMediaTimeoutSec?: number | null;
}

const TIMEOUT_SETTING_KEY_BY_KIND: Record<ResponseTimeoutKind, keyof ResponseTimeoutSettingsLike> = {
  stream: 'proxyFirstByteTimeoutSec',
  'non-stream': 'proxyNonStreamTimeoutSec',
  media: 'proxyMediaTimeoutSec',
};

/**
 * Media endpoints whose upstream call is a generation job rather than a chat turn.
 * `/v1/videos` covers only task creation; status polling is a plain read and is
 * classified as `non-stream` by its caller.
 */
const MEDIA_DOWNSTREAM_PATHS: ReadonlySet<string> = new Set([
  '/v1/images/generations',
  '/v1/images/edits',
  '/v1/videos',
]);

export function isMediaDownstreamPath(downstreamPath?: string | null): boolean {
  const normalized = (downstreamPath || '').trim().toLowerCase();
  if (!normalized) return false;
  return MEDIA_DOWNSTREAM_PATHS.has(normalized);
}

function declaresImageGenerationTool(tools: unknown): boolean {
  if (!Array.isArray(tools)) return false;
  return tools.some((tool) => (
    !!tool
    && typeof tool === 'object'
    && (tool as { type?: unknown }).type === 'image_generation'
  ));
}

/**
 * A Responses request can ask for image generation without touching `/v1/images/*`:
 * the capability arrives as a native `tools[].type === 'image_generation'` entry. Codex
 * Responses Lite may instead carry it inside an `input[]` item of type
 * `additional_tools`, so both placements are inspected. Model name is never consulted —
 * generation is a tool here, and channel forwarding rewrites the model to the channel's
 * own `sourceModel` anyway.
 */
export function requestsImageGeneration(body: unknown): boolean {
  if (!body || typeof body !== 'object') return false;
  const record = body as { tools?: unknown; input?: unknown };
  if (declaresImageGenerationTool(record.tools)) return true;
  if (!Array.isArray(record.input)) return false;
  return record.input.some((item) => (
    !!item
    && typeof item === 'object'
    && (item as { type?: unknown }).type === 'additional_tools'
    && declaresImageGenerationTool((item as { tools?: unknown }).tools)
  ));
}

/**
 * Media wins over the stream/non-stream split: a streamed image generation still waits
 * for the generator, so the media budget is the meaningful one.
 */
export function resolveResponseTimeoutKind(input: {
  downstreamPath?: string | null;
  isStream?: boolean;
  body?: unknown;
}): ResponseTimeoutKind {
  if (isMediaDownstreamPath(input.downstreamPath)) return 'media';
  if (requestsImageGeneration(input.body)) return 'media';
  return input.isStream ? 'stream' : 'non-stream';
}

/** `0` (and any unset/invalid value) means the budget is disabled for that shape. */
export function resolveResponseTimeoutMs(
  kind: ResponseTimeoutKind,
  settings: ResponseTimeoutSettingsLike,
): number {
  const raw = settings[TIMEOUT_SETTING_KEY_BY_KIND[kind]];
  // The `<= 0` arm is load-bearing, not decoration: it is what turns a disabled (0) or
  // negative setting into "no budget" rather than a negative millisecond value.
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return 0;
  return Math.trunc(raw * 1000);
}
