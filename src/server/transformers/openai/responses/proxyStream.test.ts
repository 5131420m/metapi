import { describe, expect, it } from 'vitest';

import { createResponsesProxyStreamSession } from './proxyStream.js';

describe('createResponsesProxyStreamSession', () => {
  it('serializes non-SSE fallback payloads into canonical responses SSE closeout events', () => {
    const lines: string[] = [];
    let ended = false;
    const usage = {
      promptTokens: 5,
      completionTokens: 3,
      totalTokens: 8,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      promptTokensIncludeCache: null,
    };
    const payload = {
      id: 'resp_fallback_1',
      object: 'response',
      status: 'completed',
      model: 'gpt-5.2',
      output_text: 'hello from responses upstream',
      output: [
        {
          id: 'msg_fallback_1',
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: 'hello from responses upstream' }],
        },
      ],
      usage: {
        input_tokens: usage.promptTokens,
        output_tokens: usage.completionTokens,
        total_tokens: usage.totalTokens,
      },
    };

    const session = createResponsesProxyStreamSession({
      modelName: 'gpt-5.2',
      successfulUpstreamPath: '/v1/responses',
      getUsage: () => usage,
      writeLines: (nextLines) => {
        lines.push(...nextLines);
      },
      writeRaw: () => {},
    });

    const result = session.consumeUpstreamFinalPayload(
      payload,
      JSON.stringify(payload),
      {
        end() {
          ended = true;
        },
      },
    );

    expect(result).toEqual({
      status: 'completed',
      errorMessage: null,
    });
    expect(ended).toBe(true);

    const output = lines.join('');
    expect(output).toContain('event: response.created');
    expect(output).toContain('event: response.completed');
    expect(output).toContain('"type":"response.completed"');
    expect(output).toContain('"output_text":"hello from responses upstream"');
    expect(output).toContain('data: [DONE]');
  });

  it('preserves the canonical [DONE] terminator after an explicit response.completed SSE event', async () => {
    const lines: string[] = [];
    let ended = false;
    const usage = {
      promptTokens: 5,
      completionTokens: 3,
      totalTokens: 8,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      promptTokensIncludeCache: null,
    };
    const chunk = [
      'event: response.completed',
      'data: {"type":"response.completed","response":{"id":"resp_stream_1","model":"gpt-5","usage":{"input_tokens":5,"output_tokens":3,"total_tokens":8}}}',
      '',
      'data: [DONE]',
      '',
    ].join('\n');

    const reader = {
      reads: 0,
      async read() {
        if (this.reads > 0) return { done: true };
        this.reads += 1;
        return { done: false, value: new TextEncoder().encode(chunk) };
      },
      async cancel() {
        return undefined;
      },
      releaseLock() {},
    };

    const session = createResponsesProxyStreamSession({
      modelName: 'gpt-5',
      successfulUpstreamPath: '/v1/responses',
      getUsage: () => usage,
      writeLines: (nextLines) => {
        lines.push(...nextLines);
      },
      writeRaw: () => {},
    });

    const result = await session.run(reader as any, {
      end() {
        ended = true;
      },
    });

    expect(result).toEqual({
      status: 'completed',
      errorMessage: null,
    });
    expect(ended).toBe(true);
    const output = lines.join('');
    expect(output).toContain('event: response.completed');
    expect(output).toContain('data: [DONE]');
  });

  it('preserves response.incomplete SSE terminals instead of coercing them to response.failed', async () => {
    const lines: string[] = [];
    let ended = false;
    const usage = {
      promptTokens: 5,
      completionTokens: 3,
      totalTokens: 8,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      promptTokensIncludeCache: null,
    };
    const chunk = [
      'event: response.incomplete',
      'data: {"type":"response.incomplete","response":{"id":"resp_incomplete_1","model":"gpt-5","status":"incomplete","incomplete_details":{"reason":"max_output_tokens"},"usage":{"input_tokens":5,"output_tokens":3,"total_tokens":8}}}',
      '',
      'data: [DONE]',
      '',
    ].join('\n');

    const reader = {
      reads: 0,
      async read() {
        if (this.reads > 0) return { done: true };
        this.reads += 1;
        return { done: false, value: new TextEncoder().encode(chunk) };
      },
      async cancel() {
        return undefined;
      },
      releaseLock() {},
    };

    const session = createResponsesProxyStreamSession({
      modelName: 'gpt-5',
      successfulUpstreamPath: '/v1/responses',
      getUsage: () => usage,
      writeLines: (nextLines) => {
        lines.push(...nextLines);
      },
      writeRaw: () => {},
    });

    const result = await session.run(reader as any, {
      end() {
        ended = true;
      },
    });

    expect(result).toEqual({
      status: 'completed',
      errorMessage: null,
    });
    expect(ended).toBe(true);
    const output = lines.join('');
    expect(output).toContain('event: response.incomplete');
    expect(output).toContain('"status":"incomplete"');
    expect(output).toContain('"incomplete_details":{"reason":"max_output_tokens"}');
    expect(output).not.toContain('event: response.failed');
    expect(output).toContain('data: [DONE]');
  });

  it('converts reader failures into an in-band response.failed terminal', async () => {
    const lines: string[] = [];
    let ended = false;
    let reads = 0;
    const usage = {
      promptTokens: 5,
      completionTokens: 1,
      totalTokens: 6,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      promptTokensIncludeCache: null,
    };
    const reader = {
      async read() {
        reads += 1;
        if (reads === 1) {
          return {
            done: false,
            value: new TextEncoder().encode('data: {"id":"chatcmpl-1","choices":[{"delta":{"content":"partial"}}]}\n\n'),
          };
        }
        throw new Error('upstream stream interrupted');
      },
      async cancel() {
        return undefined;
      },
      releaseLock() {},
    };

    const session = createResponsesProxyStreamSession({
      modelName: 'gpt-5',
      successfulUpstreamPath: '/v1/chat/completions',
      getUsage: () => usage,
      writeLines: (nextLines) => {
        lines.push(...nextLines);
      },
      writeRaw: () => {},
    });

    const result = await session.run(reader as any, {
      end() {
        ended = true;
      },
    });

    expect(result).toMatchObject({
      status: 'failed',
      errorMessage: 'upstream stream interrupted',
      failure: { status: 502, message: 'upstream stream interrupted' },
      meaningfulOutputSeen: true,
    });
    expect(ended).toBe(true);
    const output = lines.join('');
    expect(output).toContain('event: response.failed');
    expect(output).toContain('upstream stream interrupted');
    expect(output).toContain('data: [DONE]');
  });

  it('does not emit response.failed when the reader fails after response.completed', async () => {
    const lines: string[] = [];
    let reads = 0;
    const usage = {
      promptTokens: 5,
      completionTokens: 3,
      totalTokens: 8,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      promptTokensIncludeCache: null,
    };
    const reader = {
      async read() {
        reads += 1;
        if (reads === 1) {
          return {
            done: false,
            value: new TextEncoder().encode([
              'event: response.completed',
              'data: {"type":"response.completed","response":{"id":"resp_stream_1","model":"gpt-5","usage":{"input_tokens":5,"output_tokens":3,"total_tokens":8}}}',
              '',
              '',
            ].join('\n')),
          };
        }
        throw new Error('late reader failure');
      },
      async cancel() {
        return undefined;
      },
      releaseLock() {},
    };

    const session = createResponsesProxyStreamSession({
      modelName: 'gpt-5',
      successfulUpstreamPath: '/v1/responses',
      getUsage: () => usage,
      writeLines: (nextLines) => {
        lines.push(...nextLines);
      },
      writeRaw: () => {},
    });

    const result = await session.run(reader as any, { end() {} });

    expect(result).toEqual({
      status: 'completed',
      errorMessage: null,
    });
    const output = lines.join('');
    expect(output).toContain('event: response.completed');
    expect(output).not.toContain('event: response.failed');
    expect(output).toContain('data: [DONE]');
  });


  it('buffers an initial response.failed terminal and returns its typed upstream failure', async () => {
    const lines: string[] = [];
    const payload = {
      type: 'response.failed',
      response: {
        id: 'resp_failed_precommit',
        status: 'failed',
        error: {
          status: '429',
          type: 'rate_limit_error',
          code: 'rate_limit_exceeded',
          message: 'quota exhausted upstream',
        },
      },
    };
    const chunk = `event: response.failed\ndata: ${JSON.stringify(payload)}\n\ndata: [DONE]\n\n`;
    let reads = 0;
    const reader = {
      async read() {
        reads += 1;
        return reads === 1
          ? { done: false, value: new TextEncoder().encode(chunk) }
          : { done: true };
      },
      async cancel() { return undefined; },
      releaseLock() {},
    };
    const session = createResponsesProxyStreamSession({
      modelName: 'gpt-5',
      successfulUpstreamPath: '/v1/responses',
      getUsage: () => ({
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        promptTokensIncludeCache: null,
      }),
      writeLines: (nextLines) => lines.push(...nextLines),
      writeRaw: (chunk) => lines.push(chunk),
    });

    const result = await session.run(reader as any, { end() {} });

    expect(result).toEqual({
      status: 'failed',
      errorMessage: 'quota exhausted upstream',
      failure: {
        status: 429,
        type: 'rate_limit_error',
        code: 'rate_limit_exceeded',
        message: 'quota exhausted upstream',
        payload,
      },
      meaningfulOutputSeen: false,
    });
    expect(lines).toEqual([]);
  });

  it('preserves non-SSE incomplete fallback payloads as response.incomplete', () => {
    const lines: string[] = [];
    let ended = false;
    const usage = {
      promptTokens: 5,
      completionTokens: 3,
      totalTokens: 8,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      promptTokensIncludeCache: null,
    };
    const payload = {
      id: 'resp_incomplete_fallback_1',
      object: 'response',
      status: 'incomplete',
      incomplete_details: {
        reason: 'max_output_tokens',
      },
      model: 'gpt-5.2',
      output_text: 'partial answer',
      output: [
        {
          id: 'msg_incomplete_1',
          type: 'message',
          role: 'assistant',
          status: 'incomplete',
          content: [{ type: 'output_text', text: 'partial answer' }],
        },
      ],
      usage: {
        input_tokens: usage.promptTokens,
        output_tokens: usage.completionTokens,
        total_tokens: usage.totalTokens,
      },
    };

    const session = createResponsesProxyStreamSession({
      modelName: 'gpt-5.2',
      successfulUpstreamPath: '/v1/responses',
      getUsage: () => usage,
      writeLines: (nextLines) => {
        lines.push(...nextLines);
      },
      writeRaw: () => {},
    });

    const result = session.consumeUpstreamFinalPayload(
      payload,
      JSON.stringify(payload),
      {
        end() {
          ended = true;
        },
      },
    );

    expect(result).toEqual({
      status: 'completed',
      errorMessage: null,
    });
    expect(ended).toBe(true);

    const output = lines.join('');
    expect(output).toContain('event: response.incomplete');
    expect(output).toContain('"status":"incomplete"');
    expect(output).toContain('"output_text":"partial answer"');
    expect(output).not.toContain('event: response.completed');
    expect(output).toContain('data: [DONE]');
  });
});
