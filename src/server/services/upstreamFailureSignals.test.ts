import { describe, expect, it } from 'vitest';

import {
  buildFailureSignature,
  extractOriginalErrorIdentity,
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

describe('extractOriginalErrorIdentity', () => {
  it('reads the identity out of a nested error envelope', () => {
    expect(extractOriginalErrorIdentity({
      error: { message: 'nope', type: 'validation_error', code: 'invalid_body' },
    })).toEqual({ type: 'validation_error', code: 'invalid_body' });
  });

  it('falls back to the top level when there is no error envelope', () => {
    expect(extractOriginalErrorIdentity({ type: 'openai_error', code: 'upstream' }))
      .toEqual({ type: 'openai_error', code: 'upstream' });
  });

  it('accepts a numeric code, since upstreams disagree on its type', () => {
    expect(extractOriginalErrorIdentity({ error: { code: 40301 } }))
      .toEqual({ code: '40301' });
  });

  it('omits absent, blank and non-string identity fields instead of reporting empties', () => {
    // An empty string must not become a present dimension: `buildFailureSignature` treats
    // any present type/code as "identity known" and stops consulting the message, so a
    // blank one would collapse two genuinely different rejections into one signature.
    expect(extractOriginalErrorIdentity({ error: { message: 'nope' } })).toEqual({});
    expect(extractOriginalErrorIdentity({ error: { type: '   ', code: '' } })).toEqual({});
    expect(extractOriginalErrorIdentity({ error: { type: { nested: true } } })).toEqual({});
  });

  it('treats a non-object body as carrying no identity', () => {
    expect(extractOriginalErrorIdentity(undefined)).toEqual({});
    expect(extractOriginalErrorIdentity(null)).toEqual({});
    expect(extractOriginalErrorIdentity('bad gateway')).toEqual({});
    expect(extractOriginalErrorIdentity(502)).toEqual({});
    // Array row documents the contract but cannot falsify the top-level `Array.isArray`
    // guard: payloads reach here via `JSON.parse`, and a parsed array never carries an
    // own `type`/`code`, so dropping that guard changes nothing observable. Only the
    // inner `record.error` array guard is falsifiable — see the next case.
    expect(extractOriginalErrorIdentity([{ type: 'validation_error' }])).toEqual({});
  });

  it('ignores an array-shaped error member and reads the top level instead', () => {
    expect(extractOriginalErrorIdentity({ error: ['nope'], type: 'openai_error' }))
      .toEqual({ type: 'openai_error' });
  });

  it('feeds buildFailureSignature so one rejection keeps one signature across attempts', () => {
    // The pair only earns its keep together: identity survives in the raw payload while
    // the message carries per-attempt noise, so two relays of the SAME rejection must
    // compare equal and a different rejection must not.
    const first = { error: { message: 'refused (request_id=a1b2c3d4e5f60718)', type: 'validation_error' } };
    const second = { error: { message: 'refused (request_id=99887766554433aa)', type: 'validation_error' } };
    const other = { error: { message: 'refused', type: 'permission_error' } };

    const sign = (payload: unknown, message: string) => buildFailureSignature({
      status: 400,
      ...extractOriginalErrorIdentity(payload),
      message,
    });

    expect(sign(first, 'refused (request_id=a1b2c3d4e5f60718)'))
      .toBe(sign(second, 'refused (request_id=99887766554433aa)'));
    expect(sign(first, 'refused')).not.toBe(sign(other, 'refused'));
  });
});
