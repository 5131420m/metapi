import { describe, expect, it } from 'vitest';

import {
  normalizeResponsesInputForCompatibility,
  normalizeResponsesMessageContentBlocks,
  normalizeResponsesMessageItem,
} from './normalization.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

describe('responses input normalization', () => {
  it('drops a role-only assistant item that carries no representable content', () => {
    // Reproduces the tool-call continuation shape that a Responses client sends:
    // an empty assistant placeholder sits between the reasoning item and the
    // function calls it issued. Emitting it as `{"role":"assistant",
    // "type":"message"}` makes native Responses upstreams reject the request.
    const normalized = normalizeResponsesInputForCompatibility([
      { role: 'user', content: 'inspect the repo' },
      {
        type: 'reasoning',
        encrypted_content: 'opaque-provider-state',
        summary: [{ type: 'summary_text', text: '**Planning inspection**' }],
      },
      { role: 'assistant', content: '' },
      {
        type: 'function_call',
        call_id: 'call_1',
        name: 'skill_view',
        arguments: '{"name":"metapi"}',
      },
      { type: 'function_call_output', call_id: 'call_1', output: '{"ok":true}' },
    ]);

    expect(Array.isArray(normalized)).toBe(true);
    const items = normalized as unknown[];

    // The empty assistant placeholder is gone; everything else survives.
    expect(items).toHaveLength(4);
    expect(items.map((item) => (isRecord(item) ? item.type : undefined))).toEqual([
      'message',
      'reasoning',
      'function_call',
      'function_call_output',
    ]);

    // The tool lifecycle is untouched.
    const call = items[2] as Record<string, unknown>;
    expect(call.call_id).toBe('call_1');
    expect(call.name).toBe('skill_view');
    expect(call.arguments).toBe('{"name":"metapi"}');
    const output = items[3] as Record<string, unknown>;
    expect(output.call_id).toBe('call_1');
    expect(output.output).toBe('{"ok":true}');

    // Replayed reasoning is preserved here; stripping it is a separate,
    // provider-specific concern owned by the upstream request builder.
    const reasoning = items[1] as Record<string, unknown>;
    expect(reasoning.encrypted_content).toBe('opaque-provider-state');
  });

  it('never serializes an assistant message item without a content key', () => {
    // The actual wire symptom: `content: undefined` survives in the object but
    // JSON.stringify silently drops the key, so a body that looks fine in
    // memory reaches upstream as `{"role":"assistant","type":"message"}`.
    const normalized = normalizeResponsesInputForCompatibility([
      { role: 'assistant', content: '' },
      { role: 'assistant' },
      { role: 'assistant', content: '   ' },
    ]);

    const serialized = JSON.stringify(normalized);
    expect(serialized).not.toContain('"type":"message"');
    expect(normalized).toEqual([]);

    for (const item of normalized as unknown[]) {
      if (!isRecord(item)) continue;
      if (item.type !== 'message') continue;
      expect(Object.prototype.hasOwnProperty.call(item, 'content')).toBe(true);
    }
  });

  it('keeps assistant items that do carry content', () => {
    const normalized = normalizeResponsesInputForCompatibility([
      { role: 'assistant', content: 'here is the answer' },
    ]) as unknown[];

    expect(normalized).toHaveLength(1);
    const item = normalized[0] as Record<string, unknown>;
    expect(item.type).toBe('message');
    expect(item.role).toBe('assistant');
    expect(item.content).toEqual([{ type: 'output_text', text: 'here is the answer' }]);
  });

  it('drops an empty role-only item passed as a bare object', () => {
    expect(normalizeResponsesInputForCompatibility({ role: 'assistant', content: '' })).toEqual([]);
  });

  it('preserves an explicit message item even when its content is empty', () => {
    // An explicit `type: 'message'` item takes the earlier branch and keeps its
    // content key, so it stays representable and must not be dropped.
    const normalized = normalizeResponsesMessageItem({
      type: 'message',
      role: 'assistant',
      content: '',
    });

    expect(Object.prototype.hasOwnProperty.call(normalized, 'content')).toBe(true);
    expect(normalized.role).toBe('assistant');
  });

  it('still resolves content blocks for an empty assistant message', () => {
    // normalizeResponsesMessageContentBlocks always supplies type:'message',
    // so it must not be affected by the role-only drop path.
    expect(normalizeResponsesMessageContentBlocks('assistant', '')).toEqual([]);
    expect(normalizeResponsesMessageContentBlocks('assistant', 'hello')).toEqual([
      { type: 'output_text', text: 'hello' },
    ]);
  });
});
