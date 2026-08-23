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
