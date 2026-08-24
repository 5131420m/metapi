/**
 * Shared classification of upstream failure text.
 *
 * This is a dependency-free leaf module on purpose. Two layers need the same
 * "is this really the upstream's fault?" answer:
 *
 *   - `proxyRetryPolicy.ts`      — decides whether to try another channel (routing)
 *   - `downstreamErrorPolicy.ts` — decides what the client is told (presentation)
 *
 * Neither may import the other: routing must not depend on presentation, and a test
 * that mocks one must not silently blank out the other's classification. Keeping the
 * predicate here lets both import it without coupling them together.
 */

/**
 * Signals that the upstream is relaying a failure of its OWN upstream, rather than
 * rejecting the shape of our request.
 *
 * These arrive either as a wrapper type/code with no usable detail (`openai_error`,
 * `bad_response_status_code` — emitted when the relay had no error message to pass
 * on), or as a vendor-console constraint that a sibling channel would accept. All of
 * them are channel-local: another channel can succeed with a byte-identical body, so
 * they must not be read as deterministic client errors even when carried on a
 * 400/413/422.
 */
export const UPSTREAM_WRAPPER_FAILURE_PATTERNS: RegExp[] = [
  /bad[_\s-]?response[_\s-]?status[_\s-]?code/i,
  /\bopenai_error\b/i,
  /\bupstream_error\b/i,
  /\bconvert_request_failed\b/i,
  /\b[\w.-]+\s+console\s+requires\b/i,
];

/** True when the text carries an upstream relay/wrapper failure marker. */
export function isUpstreamWrapperFailureText(rawMessage?: string | null): boolean {
  const text = (rawMessage || '').trim();
  if (!text) return false;
  return UPSTREAM_WRAPPER_FAILURE_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Signals that the REQUEST itself is malformed in a way every channel rejects
 * identically — a missing field, unparseable JSON, an unknown parameter.
 *
 * Match these against the SUMMARIZED error text only. `summarizeUpstreamError()` keeps
 * `error.message`, so a genuine complaint about the request shape lands there; matching
 * raw JSON instead widens them badly — a `"type":"validation_error"` envelope wrapping a
 * channel-level fault would read as the caller's fault — and turns missed retries into
 * wrong terminal errors.
 *
 * This lives in the leaf module rather than in either consumer because two layers need
 * the same answer, and a determinate body is exactly the case where spending another
 * channel only re-uploads it:
 *
 *   - `proxyRetryPolicy.ts`            — refuses another channel outright
 *   - `surfaces/sharedSurface.ts`      — refuses to spend an indeterminate-4xx probe
 */
export const DETERMINATE_REQUEST_SHAPE_PATTERNS: RegExp[] = [
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

/**
 * True when the text names a request-shape defect that would fail the same way on every
 * channel. Pass the summarized message, never the raw body.
 */
export function isDeterminateRequestShapeText(rawMessage?: string | null): boolean {
  const text = (rawMessage || '').trim();
  if (!text) return false;
  return DETERMINATE_REQUEST_SHAPE_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Statuses where "the request is malformed" and "this channel refuses a body a sibling
 * channel accepts" are indistinguishable from the response alone.
 *
 * A relay can answer 400/422 either because our body really is broken or because that
 * particular vendor imposes a constraint of its own; nothing in the HTTP layer tells
 * the two apart. The only way to find out is to try a different channel and compare.
 *
 * 413 is opt-in (`includePayloadTooLarge`): a different upstream may well accept a
 * larger body, but retrying re-uploads the whole payload and the first upstream may
 * already have billed for the input, so the cost profile is not the same as 400/422.
 */
export function isIndeterminate4xx(
  status: number,
  options?: { includePayloadTooLarge?: boolean },
): boolean {
  if (status === 400 || status === 422) return true;
  if (status === 413) return options?.includePayloadTooLarge === true;
  return false;
}

/**
 * Strips the parts of an upstream message that differ between two otherwise identical
 * failures — request ids, trace ids, timestamps, durations, bare numbers.
 *
 * Without this, comparing raw messages is useless: upstream error text routinely
 * embeds a fresh `request_id` per attempt, so two identical faults never compare equal
 * and a "retry while the error keeps changing" rule degenerates into always spending
 * the full budget.
 */
function normalizeMessageFingerprint(rawMessage?: string | null): string {
  return (rawMessage || '')
    .toLowerCase()
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<uuid>')
    .replace(/\b[0-9a-f]{16,}\b/g, '<hex>')
    .replace(/\d{4}-\d{2}-\d{2}[t\s]\d{2}:\d{2}:\d{2}(?:\.\d+)?z?/g, '<ts>')
    .replace(/\b\d+(?:\.\d+)?(?:ms|s)\b/g, '<dur>')
    .replace(/\b\d+\b/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

/**
 * Pulls `error.type` / `error.code` out of an upstream body.
 *
 * `summarizeUpstreamError()` keeps `error.message` and drops type/code whenever a
 * message exists, so these are the stable identity fields that only survive in the
 * raw payload — and they are what the repeat-rejection signature is built from.
 *
 * Lives here rather than inside a surface closure because it is the input half of
 * `buildFailureSignature()`: any caller that needs a repeat-rejection signature needs
 * this first, and a second copy would let the two drift apart while both look correct.
 */
export function extractOriginalErrorIdentity(payload: unknown): {
  type?: string;
  code?: string;
} {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return {};
  const record = payload as Record<string, unknown>;
  const error = record.error && typeof record.error === 'object' && !Array.isArray(record.error)
    ? record.error as Record<string, unknown>
    : record;
  const type = typeof error.type === 'string' ? error.type.trim() : '';
  const code = typeof error.code === 'string'
    ? error.code.trim()
    : typeof error.code === 'number'
      ? String(error.code)
      : '';
  return {
    ...(type ? { type } : {}),
    ...(code ? { code } : {}),
  };
}

/**
 * Identity of a failure for "have I already seen this exact rejection?" comparison.
 *
 * `error.type` / `error.code` are preferred because they are the stable machine-readable
 * part of the response. They are frequently absent, so the normalized message acts as
 * the fallback dimension rather than being mixed in unconditionally — including it
 * alongside a present type/code would let an incidental message difference mask a
 * genuinely repeated rejection.
 */
export function buildFailureSignature(input: {
  status: number;
  type?: string | null;
  code?: string | null;
  message?: string | null;
}): string {
  const type = (input.type || '').trim().toLowerCase();
  const code = (input.code || '').trim().toLowerCase();
  if (type || code) return `${input.status}|${type}|${code}`;
  return `${input.status}|msg:${normalizeMessageFingerprint(input.message)}`;
}
