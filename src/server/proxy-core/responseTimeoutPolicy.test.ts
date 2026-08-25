import { describe, expect, it } from 'vitest';

import {
  isMediaDownstreamPath,
  requestsImageGeneration,
  resolveResponseTimeoutKind,
  resolveResponseTimeoutMs,
} from './responseTimeoutPolicy.js';

const settings = {
  proxyFirstByteTimeoutSec: 45,
  proxyNonStreamTimeoutSec: 120,
  proxyMediaTimeoutSec: 600,
};

describe('resolveResponseTimeoutKind', () => {
  it('separates streaming from non-streaming chat turns', () => {
    expect(resolveResponseTimeoutKind({
      downstreamPath: '/v1/chat/completions',
      isStream: true,
    })).toBe('stream');
    expect(resolveResponseTimeoutKind({
      downstreamPath: '/v1/chat/completions',
      isStream: false,
    })).toBe('non-stream');
  });

  it('treats an absent isStream flag as non-streaming', () => {
    expect(resolveResponseTimeoutKind({ downstreamPath: '/v1/embeddings' })).toBe('non-stream');
  });

  it('classifies the media endpoints by path', () => {
    for (const downstreamPath of ['/v1/images/generations', '/v1/images/edits', '/v1/videos']) {
      expect(resolveResponseTimeoutKind({ downstreamPath })).toBe('media');
    }
  });

  it('classifies a Responses request that declares the native image_generation tool', () => {
    expect(resolveResponseTimeoutKind({
      downstreamPath: '/v1/responses',
      isStream: false,
      body: { tools: [{ type: 'function', name: 'read_file' }, { type: 'image_generation' }] },
    })).toBe('media');
  });

  it('classifies image generation declared inside a Responses Lite additional_tools item', () => {
    expect(resolveResponseTimeoutKind({
      downstreamPath: '/v1/responses',
      isStream: false,
      body: {
        input: [
          { type: 'message', role: 'user', content: 'draw a cat' },
          { type: 'additional_tools', role: 'developer', tools: [{ type: 'image_generation' }] },
        ],
      },
    })).toBe('media');
  });

  it('keeps media classification for a STREAMED image generation', () => {
    // The generator still has to finish before anything meaningful arrives, so the
    // stream budget would abort a healthy request.
    expect(resolveResponseTimeoutKind({
      downstreamPath: '/v1/responses',
      isStream: true,
      body: { tools: [{ type: 'image_generation' }] },
    })).toBe('media');
  });

  it('does not classify an ordinary function tool as media', () => {
    expect(resolveResponseTimeoutKind({
      downstreamPath: '/v1/responses',
      isStream: true,
      body: { tools: [{ type: 'function', name: 'generate_image' }] },
    })).toBe('stream');
  });

  it('does not infer media from the model name', () => {
    // Channel forwarding rewrites the model to the channel's own sourceModel, so a
    // name-based rule would be both wrong and unstable.
    expect(resolveResponseTimeoutKind({
      downstreamPath: '/v1/chat/completions',
      isStream: false,
      body: { model: 'gpt-image-1' },
    })).toBe('non-stream');
  });

  it('ignores unrelated paths and malformed bodies', () => {
    expect(isMediaDownstreamPath('/v1/videos/abc123')).toBe(false);
    expect(isMediaDownstreamPath(null)).toBe(false);
    expect(requestsImageGeneration(null)).toBe(false);
    expect(requestsImageGeneration('nope')).toBe(false);
    expect(requestsImageGeneration({ tools: 'nope' })).toBe(false);
    expect(requestsImageGeneration({ input: [null, 7] })).toBe(false);
  });
});

describe('resolveResponseTimeoutMs', () => {
  it('reads the budget belonging to each kind', () => {
    expect(resolveResponseTimeoutMs('stream', settings)).toBe(45_000);
    expect(resolveResponseTimeoutMs('non-stream', settings)).toBe(120_000);
    expect(resolveResponseTimeoutMs('media', settings)).toBe(600_000);
  });

  it('treats 0 / missing / invalid as disabled', () => {
    expect(resolveResponseTimeoutMs('media', { ...settings, proxyMediaTimeoutSec: 0 })).toBe(0);
    expect(resolveResponseTimeoutMs('media', {})).toBe(0);
    expect(resolveResponseTimeoutMs('non-stream', { proxyNonStreamTimeoutSec: -5 })).toBe(0);
    expect(resolveResponseTimeoutMs('stream', { proxyFirstByteTimeoutSec: Number.NaN })).toBe(0);
  });

  it('does not let one shape borrow another shape budget', () => {
    // The whole point of the split: a media request must not inherit the 45s stream value.
    const streamOnly = { proxyFirstByteTimeoutSec: 45 };
    expect(resolveResponseTimeoutMs('media', streamOnly)).toBe(0);
    expect(resolveResponseTimeoutMs('non-stream', streamOnly)).toBe(0);
  });
});
