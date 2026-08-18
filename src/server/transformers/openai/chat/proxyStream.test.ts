import { describe, expect, it } from 'vitest';

import { createChatProxyStreamSession } from './proxyStream.js';

type ReadResult = { done: boolean; value?: Uint8Array };

function createScriptedReader(chunks: string[], failWith?: string) {
  const encoder = new TextEncoder();
  let index = 0;
  return {
    async read(): Promise<ReadResult> {
      if (index < chunks.length) {
        const chunk = chunks[index];
        index += 1;
        return { done: false, value: encoder.encode(chunk) };
      }
      if (failWith) throw new Error(failWith);
      return { done: true };
    },
    async cancel() {
      return undefined;
    },
    releaseLock() {},
  };
}

it('uses a public-message sanitizer only for postcommit Chat terminal bytes', async () => {
  const lines: string[] = [];
  const session = createChatProxyStreamSession({
    downstreamFormat: 'openai',
    modelName: 'gpt-5',
    successfulUpstreamPath: '/v1/chat/completions',
    publicFailureMessage: () => 'sanitized postcommit failure',
    writeLines: (nextLines) => lines.push(...nextLines),
    writeRaw: (chunk) => lines.push(chunk),
  });
  const result = await session.run(
    createScriptedReader([
      'data: {"id":"chatcmpl-1","choices":[{"delta":{"content":"partial"}}]}\n\n',
    ], 'invalid api key sk-secret'),
    { end() {} },
  );

  expect(result.errorMessage).toBe('invalid api key sk-secret');
  expect(lines.join('')).toContain('sanitized postcommit failure');
  expect(lines.join('')).not.toContain('sk-secret');
});

function createSession(lines: string[], downstreamFormat: 'openai' | 'claude' = 'openai') {
  return createChatProxyStreamSession({
    downstreamFormat,
    modelName: 'gpt-4o-mini',
    successfulUpstreamPath: '/v1/chat/completions',
    writeLines: (nextLines) => {
      lines.push(...nextLines);
    },
    writeRaw: (chunk) => {
      lines.push(chunk);
    },
  });
}

describe('createChatProxyStreamSession reader failures', () => {
  it('keeps a reader failure before meaningful output uncommitted', async () => {
    const lines: string[] = [];
    const session = createSession(lines);
    const reader = createScriptedReader([], 'upstream failed before output');

    const result = await session.run(reader, { end() {} });

    expect(result).toMatchObject({
      status: 'failed',
      errorMessage: 'upstream failed before output',
      failure: { status: 502, message: 'upstream failed before output' },
      meaningfulOutputSeen: false,
    });
    expect(lines).toEqual([]);
  });

  it('keeps a response.failed event before meaningful output uncommitted', async () => {
    const lines: string[] = [];
    const session = createSession(lines);
    const reader = createScriptedReader([
      'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_fail","status":"in_progress","output":[]}}\n\n',
      'event: response.failed\ndata: {"type":"response.failed","response":{"id":"resp_fail","status":"failed","error":{"message":"tool execution failed"}}}\n\n',
    ]);

    const result = await session.run(reader, { end() {} });

    expect(result).toMatchObject({
      status: 'failed',
      errorMessage: 'tool execution failed',
      meaningfulOutputSeen: false,
    });
    expect(lines).toEqual([]);
  });

  it('recognizes response.failed SSE event names even when payload type is missing', async () => {
    const lines: string[] = [];
    const session = createSession(lines);
    const reader = createScriptedReader([
      'event: response.failed\ndata: {"response":{"status":"failed","error":{"message":"named failure"}}}\n\n',
    ]);

    const result = await session.run(reader, { end() {} });

    expect(result).toMatchObject({
      status: 'failed',
      errorMessage: 'named failure',
      meaningfulOutputSeen: false,
    });
    expect(lines).toEqual([]);
  });
  it('emits one explicit error terminal when response.failed follows meaningful output', async () => {
    const lines: string[] = [];
    const session = createSession(lines);
    const reader = createScriptedReader([
      'data: {"id":"chatcmpl-partial","choices":[{"delta":{"content":"partial"},"finish_reason":null}]}\n\n',
      'event: response.failed\ndata: {"type":"response.failed","response":{"id":"resp_partial","status":"failed","error":{"message":"tool execution failed"}}}\n\n',
    ]);

    const result = await session.run(reader, { end() {} });

    expect(result).toMatchObject({
      status: 'failed',
      errorMessage: 'tool execution failed',
      meaningfulOutputSeen: true,
    });
    const output = lines.join('');
    expect(output).toContain('partial');
    expect(output).toContain('upstream_error');
    expect(output).toContain('tool execution failed');
    expect(output).not.toContain('"finish_reason":"stop"');
    expect(output.match(/upstream_error/g)).toHaveLength(1);
    expect(output.match(/data: \[DONE\]/g)).toHaveLength(1);
  });

  it('preserves a top-level HTTP status from an error event', async () => {
    const writes: string[] = [];
    const session = createChatProxyStreamSession({
      downstreamFormat: 'openai',
      modelName: 'gpt-5.6',
      successfulUpstreamPath: '/v1/chat/completions',
      writeLines: (lines) => writes.push(...lines),
      writeRaw: (chunk) => writes.push(chunk),
    });
    const reader = createScriptedReader([
      'event: error\ndata: {"type":"error","status":429,"error":{"type":"rate_limit_error","message":"quota"}}\n\n',
    ]);

    const result = await session.run(reader, { end() {} });

    expect(result).toMatchObject({
      status: 'failed',
      failure: { status: 429, type: 'rate_limit_error', message: 'quota' },
    });
  });

  it('keeps a non-SSE response.failed payload from becoming a successful chat response', () => {
    const lines: string[] = [];
    const session = createSession(lines);
    const result = session.consumeUpstreamFinalPayload({
      type: 'response.failed',
      response: {
        status: 'failed',
        error: { message: 'final failure' },
      },
    }, '', { end() {} });

    expect(result).toMatchObject({
      status: 'failed',
      errorMessage: 'final failure',
    });
    expect(lines).toEqual([]);
  });

  it('converts reader failures into an in-band upstream_error terminal', async () => {
    const lines: string[] = [];
    let ended = false;
    const session = createSession(lines);
    const reader = createScriptedReader(
      ['data: {"id":"chatcmpl-1","choices":[{"delta":{"content":"partial"},"finish_reason":null}]}\n\n'],
      'upstream stream interrupted',
    );

    const result = await session.run(reader, {
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
    expect(output).toContain('partial');
    expect(output).toContain('upstream_error');
    expect(output).toContain('upstream stream interrupted');
    expect(output).toContain('data: [DONE]');
  });

  it('keeps local processing failures distinct from upstream reader failures', async () => {
    const lines: string[] = [];
    const session = createChatProxyStreamSession({
      downstreamFormat: 'openai',
      modelName: 'gpt-5',
      successfulUpstreamPath: '/v1/chat/completions',
      writeLines: (nextLines) => lines.push(...nextLines),
      writeRaw: (chunk) => lines.push(chunk),
      onParsedPayload: () => {
        throw new Error('local callback failed');
      },
    });
    const reader = createScriptedReader([
      'data: {"id":"chatcmpl-local","choices":[{"delta":{"content":"partial"},"finish_reason":null}]}\n\n',
    ]);

    const result = await session.run(reader, { end() {} });

    expect(result).toMatchObject({
      status: 'failed',
      errorMessage: 'stream processing failed',
      failure: { type: 'server_error', message: 'stream processing failed' },
    });
    expect(lines.join('')).not.toContain('local callback failed');
  });


  it('does not emit a second terminal when the reader fails after a clean [DONE]', async () => {
    const lines: string[] = [];
    const session = createSession(lines);
    const reader = createScriptedReader(
      [
        'data: {"id":"chatcmpl-2","choices":[{"delta":{"content":"hello"},"finish_reason":"stop"}]}\n\n',
        'data: [DONE]\n\n',
      ],
      'late reader failure',
    );

    const result = await session.run(reader, { end() {} });

    expect(result).toEqual({
      status: 'completed',
      errorMessage: null,
    });
    const output = lines.join('');
    expect(output).toContain('hello');
    expect(output).not.toContain('upstream_error');
    expect(output).not.toContain('late reader failure');
    expect(output.match(/data: \[DONE\]/g)).toHaveLength(1);
  });

  it('fails the stream instead of completing a partially streamed tool call', async () => {
    const lines: string[] = [];
    const session = createSession(lines);
    const reader = createScriptedReader(
      [
        'data: {"id":"chatcmpl-3","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"terminal","arguments":"{\\"comm"}}]},"finish_reason":null}]}\n\n',
      ],
      'upstream stream interrupted mid tool call',
    );

    const result = await session.run(reader, { end() {} });

    expect(result.status).toBe('failed');
    expect(result.errorMessage).toBe('upstream stream interrupted mid tool call');
    const output = lines.join('');
    expect(output).toContain('upstream_error');
    expect(output).not.toContain('"finish_reason":"tool_calls"');
    expect(output).not.toContain('"finish_reason":"stop"');
    expect(output.match(/data: \[DONE\]/g)).toHaveLength(1);
  });

  it('keeps a Claude reader failure before meaningful output uncommitted', async () => {
    const lines: string[] = [];
    const session = createSession(lines, 'claude');
    const reader = createScriptedReader(
      ['event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","model":"claude","content":[]}}\n\n'],
      'claude upstream interrupted',
    );

    const result = await session.run(reader, { end() {} });

    expect(result.status).toBe('failed');
    expect(result.errorMessage).toBe('claude upstream interrupted');
    expect(result).toMatchObject({
      meaningfulOutputSeen: false,
      failure: { status: 502, message: 'claude upstream interrupted' },
    });
    expect(lines).toEqual([]);
  });

  it('emits one Claude error terminal when a reader failure follows meaningful output', async () => {
    const lines: string[] = [];
    const session = createSession(lines, 'claude');
    const reader = createScriptedReader(
      [
        'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_2","model":"claude","content":[]}}\n\n',
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"partial"}}\n\n',
      ],
      'claude failed after output',
    );

    const result = await session.run(reader, { end() {} });

    expect(result).toMatchObject({ status: 'failed', meaningfulOutputSeen: true });
    const output = lines.join('');
    expect(output).toContain('partial');
    expect(output).toContain('event: error');
    expect(output).toContain('claude failed after output');
    expect(output).not.toContain('event: message_stop');
    expect(output.match(/event: error/g)).toHaveLength(1);
  });

  it('marks a native Claude error event as a failed stream terminal', async () => {
    const lines: string[] = [];
    const session = createSession(lines, 'claude');
    const reader = createScriptedReader([
      'event: error\ndata: {"type":"error","error":{"type":"api_error","code":"rate_limit_exceeded","status":429,"message":"upstream overloaded"}}\n\n',
    ]);

    const result = await session.run(reader, { end() {} });

    expect(result).toMatchObject({
      status: 'failed',
      errorMessage: 'upstream overloaded',
      failureSource: 'upstream',
      failure: {
        status: 429,
        type: 'api_error',
        code: 'rate_limit_exceeded',
        message: 'upstream overloaded',
        payload: {
          type: 'error',
          error: {
            type: 'api_error',
            code: 'rate_limit_exceeded',
            status: 429,
            message: 'upstream overloaded',
          },
        },
      },
      meaningfulOutputSeen: false,
    });
    expect(lines).toEqual([]);
    const output = lines.join('');
    expect(output).not.toContain('event: error');
    expect(output).not.toContain('upstream overloaded');
    expect(output).not.toContain('event: message_stop');
  });
});
