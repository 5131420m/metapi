import { describe, expect, it } from 'vitest';

import {
  buildFailureSignature,
  isDeterminateRequestShapeText,
  isIndeterminate4xx,
  isUpstreamWrapperFailureText,
} from './upstreamFailureSignals.js';

describe('isIndeterminate4xx', () => {
  it('treats 400 and 422 as indeterminate', () => {
    expect(isIndeterminate4xx(400)).toBe(true);
    expect(isIndeterminate4xx(422)).toBe(true);
  });

  it('gates 413 behind includePayloadTooLarge', () => {
    expect(isIndeterminate4xx(413)).toBe(false);
    expect(isIndeterminate4xx(413, { includePayloadTooLarge: false })).toBe(false);
    expect(isIndeterminate4xx(413, { includePayloadTooLarge: true })).toBe(true);
  });

  it('leaves statuses with an unambiguous meaning alone', () => {
    // 404/401/403/429 already have their own routing rules; 500s are retried by status.
    for (const status of [401, 403, 404, 409, 429, 500, 502, 503]) {
      expect(isIndeterminate4xx(status, { includePayloadTooLarge: true })).toBe(false);
    }
  });
});

describe('buildFailureSignature', () => {
  it('uses type and code when present, ignoring message noise', () => {
    const first = buildFailureSignature({
      status: 422,
      type: 'openai_error',
      code: 'bad_upstream',
      message: 'failed (request_id req_aaaaaaaa1111)',
    });
    const second = buildFailureSignature({
      status: 422,
      type: 'openai_error',
      code: 'bad_upstream',
      message: 'failed (request_id req_bbbbbbbb2222)',
    });
    expect(first).toBe(second);
  });

  it('separates different rejection identities on the same status', () => {
    const invalidModel = buildFailureSignature({ status: 400, type: 'invalid_model' });
    const missingMessages = buildFailureSignature({ status: 400, type: 'missing_messages' });
    expect(invalidModel).not.toBe(missingMessages);
  });

  it('separates the same identity seen on different statuses', () => {
    expect(buildFailureSignature({ status: 400, type: 'openai_error' }))
      .not.toBe(buildFailureSignature({ status: 422, type: 'openai_error' }));
  });

  it('falls back to a normalized message when type and code are absent', () => {
    // Upstream text routinely carries a fresh request id / timestamp / duration per
    // attempt. Comparing raw messages would make two identical faults look different and
    // turn "retry while the error keeps changing" into "always spend the whole budget".
    const attemptOne = buildFailureSignature({
      status: 400,
      message: 'rejected at 2026-08-23T10:00:00Z after 1200ms (trace 4f8a2b1c9d0e7f36)',
    });
    const attemptTwo = buildFailureSignature({
      status: 400,
      message: 'rejected at 2026-08-23T11:30:45Z after 87ms (trace a1b2c3d4e5f60718)',
    });
    expect(attemptOne).toBe(attemptTwo);
  });

  it('still distinguishes genuinely different messages in the fallback path', () => {
    expect(buildFailureSignature({ status: 400, message: 'model is required' }))
      .not.toBe(buildFailureSignature({ status: 400, message: 'messages is required' }));
  });

  it('does not let an incidental message difference mask a repeated identity', () => {
    // type/code win outright; the message is a fallback dimension, not an extra one.
    const withMessage = buildFailureSignature({
      status: 422,
      type: 'openai_error',
      message: 'first wording',
    });
    const withOtherMessage = buildFailureSignature({
      status: 422,
      type: 'openai_error',
      message: 'completely different wording',
    });
    expect(withMessage).toBe(withOtherMessage);
  });
});

describe('isDeterminateRequestShapeText', () => {
  it('recognizes upstream complaints about the request shape', () => {
    // These name a defect in the body itself, so every channel rejects them identically.
    expect(isDeterminateRequestShapeText('Upstream returned HTTP 400: invalid json')).toBe(true);
    expect(isDeterminateRequestShapeText('Upstream returned HTTP 400: validation failed')).toBe(true);
    expect(isDeterminateRequestShapeText('Upstream returned HTTP 422: missing required parameter model')).toBe(true);
    expect(isDeterminateRequestShapeText('Upstream returned HTTP 400: unknown parameter: foo')).toBe(true);
    expect(isDeterminateRequestShapeText('Upstream returned HTTP 400: malformed request')).toBe(true);
  });

  it('does not claim an unexplained rejection is determinate', () => {
    // The whole point of the indeterminate family: nothing in the text says whose fault
    // it is, so a sibling channel might well accept the same bytes.
    expect(isDeterminateRequestShapeText('Upstream returned HTTP 422: rejected')).toBe(false);
    expect(isDeterminateRequestShapeText('Upstream returned HTTP 422: openai_error')).toBe(false);
    expect(isDeterminateRequestShapeText('Upstream returned HTTP 400: Mistral Console requires at least one message')).toBe(false);
    expect(isDeterminateRequestShapeText('')).toBe(false);
    expect(isDeterminateRequestShapeText(null)).toBe(false);
  });
});

describe('isUpstreamWrapperFailureText', () => {
  it('still recognizes the relay wrapper markers', () => {
    expect(isUpstreamWrapperFailureText('openai_error')).toBe(true);
    expect(isUpstreamWrapperFailureText('bad response status code 422')).toBe(true);
    expect(isUpstreamWrapperFailureText('Mistral Console requires at least one message')).toBe(true);
  });

  it('does not match ordinary request-shape complaints', () => {
    expect(isUpstreamWrapperFailureText('messages[0].role is invalid')).toBe(false);
    expect(isUpstreamWrapperFailureText('')).toBe(false);
    expect(isUpstreamWrapperFailureText(null)).toBe(false);
  });
});
