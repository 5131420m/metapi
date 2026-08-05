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

    expect(result).toEqual({
      status: 'failed',
      errorMessage: 'upstream stream interrupted',
    });
    expect(ended).toBe(true);
    const output = lines.join('');
    expect(output).toContain('partial');
    expect(output).toContain('upstream_error');
    expect(output).toContain('upstream stream interrupted');
    expect(output).toContain('data: [DONE]');
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

  it('emits a claude-shaped error event for claude downstream reader failures', async () => {
    const lines: string[] = [];
    const session = createSession(lines, 'claude');
    const reader = createScriptedReader(
      ['event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","model":"claude","content":[]}}\n\n'],
      'claude upstream interrupted',
    );

    const result = await session.run(reader, { end() {} });

    expect(result.status).toBe('failed');
    expect(result.errorMessage).toBe('claude upstream interrupted');
    const output = lines.join('');
    expect(output).toContain('event: error');
    expect(output).toContain('claude upstream interrupted');
    expect(output).not.toContain('data: [DONE]');
  });
});
