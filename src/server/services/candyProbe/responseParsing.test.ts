import { describe, expect, it } from 'vitest';
import { extractCandyProbeAnswerPayload } from './responseParsing.js';

function sse(events: unknown[]): string {
  return events.map((event) => `event: x\ndata: ${JSON.stringify(event)}\n\n`).join('');
}

describe('candy probe answer extraction', () => {
  it('reads an Anthropic messages stream', () => {
    const raw = sse([
      { type: 'message_start', message: { model: 'claude-sonnet-4-5', usage: { input_tokens: 12 } } },
      { type: 'content_block_delta', delta: { type: 'text_delta', text: '1: 9.9\n' } },
      { type: 'content_block_delta', delta: { type: 'text_delta', text: '2: 3' } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 8 } },
    ]);
    const payload = extractCandyProbeAnswerPayload(raw, 'text/event-stream');
    expect(payload.transport).toBe('sse');
    expect(payload.text).toBe('1: 9.9\n2: 3');
    expect(payload.model).toBe('claude-sonnet-4-5');
    expect(payload.stopReason).toBe('end_turn');
    expect(payload.usage).toMatchObject({ output_tokens: 8 });
  });

  it('reads an OpenAI chat completion stream', () => {
    const raw = sse([
      { model: 'gpt-5.4', choices: [{ delta: { content: '9.9' }, finish_reason: null }] },
      { model: 'gpt-5.4', choices: [{ delta: { content: '\n3' }, finish_reason: null }] },
      { model: 'gpt-5.4', choices: [{ delta: {}, finish_reason: 'stop' }], usage: { total_tokens: 20 } },
      { done: true },
    ]);
    const payload = extractCandyProbeAnswerPayload(raw, 'text/event-stream');
    expect(payload.text).toBe('9.9\n3');
    expect(payload.model).toBe('gpt-5.4');
    expect(payload.stopReason).toBe('stop');
    expect(payload.usage).toMatchObject({ total_tokens: 20 });
  });

  it('reads an OpenAI responses stream', () => {
    const raw = sse([
      { type: 'response.created', response: { model: 'gpt-5.4' } },
      { type: 'response.output_text.delta', delta: '1: 9.9' },
      { type: 'response.completed', response: { model: 'gpt-5.4', usage: { output_tokens: 5 } } },
    ]);
    const payload = extractCandyProbeAnswerPayload(raw, 'text/event-stream');
    expect(payload.text).toBe('1: 9.9');
    expect(payload.model).toBe('gpt-5.4');
    expect(payload.usage).toMatchObject({ output_tokens: 5 });
  });

  it('reports the failure status of a failed responses stream', () => {
    const raw = sse([
      { type: 'response.created', response: { model: 'gpt-5.4' } },
      { type: 'response.failed', response: { error: { message: 'backend exploded' } } },
    ]);
    const payload = extractCandyProbeAnswerPayload(raw, 'text/event-stream');
    expect(payload.errorMessage).toBe('backend exploded');
  });

  it('detects SSE from the body when the content type is missing', () => {
    const raw = `data: ${JSON.stringify({ choices: [{ delta: { content: '9.9' } }] })}\n\n`;
    const payload = extractCandyProbeAnswerPayload(raw, null);
    expect(payload.transport).toBe('sse');
    expect(payload.text).toBe('9.9');
  });

  it('reads the usage-only chat chunk, which carries no choices', () => {
    // OpenAI streams usage in a final `{ choices: [], usage: {...} }` chunk when
    // `stream_options.include_usage` is requested; reading usage only inside the
    // "choices present" branch is what made that request parameter do nothing.
    const raw = sse([
      { model: 'gpt-5.4', choices: [{ delta: { content: '1: 9.9' } }] },
      { choices: [], usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 } },
      { done: true },
    ]);
    const payload = extractCandyProbeAnswerPayload(raw, 'text/event-stream');
    expect(payload.text).toBe('1: 9.9');
    expect(payload.usage).toMatchObject({ prompt_tokens: 12, total_tokens: 17 });
  });

  it('reads the truncation reason out of an incomplete responses event', () => {
    // `incomplete_details` is an object, so passing it straight to a string field lost it.
    const raw = sse([
      { type: 'response.output_text.delta', delta: '1: 9.9' },
      { type: 'response.incomplete', response: { incomplete_details: { reason: 'max_output_tokens' } } },
    ]);
    const payload = extractCandyProbeAnswerPayload(raw, 'text/event-stream');
    expect(payload.stopReason).toBe('max_output_tokens');
  });

  it('unwraps the gemini-cli response envelope', () => {
    const raw = sse([
      { response: { modelVersion: 'gemini-3-pro', candidates: [{ content: { parts: [{ text: '1: 9.9' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 12 } } },
    ]);
    const payload = extractCandyProbeAnswerPayload(raw, 'text/event-stream');
    expect(payload.text).toBe('1: 9.9');
    expect(payload.model).toBe('gemini-3-pro');
    expect(payload.usage).toMatchObject({ promptTokenCount: 12 });
  });

  it('does not unwrap a responses event that merely has a response field', () => {
    const raw = sse([
      { type: 'response.completed', response: { model: 'gpt-5.4', usage: { output_tokens: 5 } } },
    ]);
    const payload = extractCandyProbeAnswerPayload(raw, 'text/event-stream');
    expect(payload.model).toBe('gpt-5.4');
    expect(payload.usage).toMatchObject({ output_tokens: 5 });
  });

  it('does not duplicate the text of a responses body that has both fields', () => {
    const responses = extractCandyProbeAnswerPayload(JSON.stringify({
      model: 'gpt-5.4',
      status: 'completed',
      output_text: '1: 9.9',
      output: [{ type: 'message', content: [{ type: 'output_text', text: '1: 9.9' }] }],
    }), 'application/json');
    expect(responses.text).toBe('1: 9.9');
  });

  it('reads buffered chat, anthropic and responses bodies', () => {
    const chat = extractCandyProbeAnswerPayload(JSON.stringify({
      model: 'gpt-5.4',
      choices: [{ message: { role: 'assistant', content: '1: 9.9' }, finish_reason: 'stop' }],
    }), 'application/json');
    expect(chat.transport).toBe('json');
    expect(chat.text).toBe('1: 9.9');
    expect(chat.stopReason).toBe('stop');

    const anthropic = extractCandyProbeAnswerPayload(JSON.stringify({
      model: 'claude-sonnet-4-5',
      content: [{ type: 'text', text: '1: 9.9' }],
      stop_reason: 'end_turn',
    }), 'application/json');
    expect(anthropic.text).toBe('1: 9.9');
    expect(anthropic.model).toBe('claude-sonnet-4-5');

    const responses = extractCandyProbeAnswerPayload(JSON.stringify({
      model: 'gpt-5.4',
      status: 'completed',
      output: [{ type: 'message', content: [{ type: 'output_text', text: '1: 9.9' }] }],
    }), 'application/json');
    expect(responses.text).toBe('1: 9.9');
  });

  it('preserves newlines, since the grader splits answers by line', () => {
    const payload = extractCandyProbeAnswerPayload(JSON.stringify({
      choices: [{ message: { content: '9.9\n3\nOK' } }],
    }), 'application/json');
    expect(payload.text.split('\n')).toEqual(['9.9', '3', 'OK']);
  });

  it('reads a Gemini native generateContent body', () => {
    const payload = extractCandyProbeAnswerPayload(JSON.stringify({
      modelVersion: 'gemini-2.5-pro',
      candidates: [{
        content: { parts: [{ text: '1: 9.9' }, { text: '\n2: 3' }] },
        finishReason: 'STOP',
      }],
      usageMetadata: { totalTokenCount: 30 },
    }), 'application/json');
    expect(payload.text).toBe('1: 9.9\n2: 3');
    expect(payload.model).toBe('gemini-2.5-pro');
    expect(payload.stopReason).toBe('STOP');
    expect(payload.usage).toMatchObject({ totalTokenCount: 30 });
  });

  it('degrades to an empty result instead of throwing on junk', () => {
    const payload = extractCandyProbeAnswerPayload('<html>gateway error</html>', 'text/html');
    expect(payload.transport).toBe('unknown');
    expect(payload.text).toBe('');
    expect(payload.model).toBeNull();
  });

  // A thinking model walks through candidate numbers before committing; any of that
  // reaching the graded text can flip a verdict. Every envelope gets the same shape:
  // the reasoning mentions 21, the committed answer is 20.
  it('never grades reasoning text, whatever buffered envelope carries it', () => {
    const chat = extractCandyProbeAnswerPayload(JSON.stringify({
      model: 'gpt-5.4',
      choices: [{ message: { content: [
        { type: 'reasoning', text: '先算最坏情况，可能要 21 颗……不对。' },
        { type: 'text', text: '答案：20' },
      ] } }],
    }), 'application/json');
    expect(chat.text).toBe('答案：20');

    const anthropic = extractCandyProbeAnswerPayload(JSON.stringify({
      model: 'claude-sonnet-4-5',
      content: [
        { type: 'thinking', text: '也许 21？再想想。' },
        { type: 'text', text: '答案：20' },
      ],
    }), 'application/json');
    expect(anthropic.text).toBe('答案：20');

    const responses = extractCandyProbeAnswerPayload(JSON.stringify({
      model: 'gpt-5.4',
      output: [
        { type: 'reasoning', content: [{ type: 'reasoning_text', text: '候选 21……' }] },
        { type: 'message', content: [{ type: 'output_text', text: '答案：20' }] },
      ],
    }), 'application/json');
    expect(responses.text).toBe('答案：20');

    const gemini = extractCandyProbeAnswerPayload(JSON.stringify({
      modelVersion: 'gemini-2.5-pro',
      candidates: [{ content: { parts: [
        { thought: true, text: '推理：21？' },
        { text: '答案：20' },
      ] } }],
    }), 'application/json');
    expect(gemini.text).toBe('答案：20');
  });

  it('never grades reasoning text in streaming envelopes either', () => {
    // thinking_delta carries no `text` in the real protocol — the second event is the
    // defensive case (a relay that puts thought text in `text` anyway).
    const anthropic = extractCandyProbeAnswerPayload(sse([
      { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: '21？' } },
      { type: 'content_block_delta', delta: { type: 'thinking_delta', text: '21？' } },
      { type: 'content_block_delta', delta: { type: 'text_delta', text: '答案：20' } },
    ]), 'text/event-stream');
    expect(anthropic.text).toBe('答案：20');

    // Chat streaming: a `reasoning` part inside delta.content, plus the usage-only chunk.
    const chat = extractCandyProbeAnswerPayload(sse([
      { model: 'gpt-5.4', choices: [{ delta: { content: [
        { type: 'reasoning', text: '21？' },
        { type: 'text', text: '答案：20' },
      ] } }] },
      { choices: [], usage: { total_tokens: 20 } },
    ]), 'text/event-stream');
    expect(chat.text).toBe('答案：20');

    // Gemini thought parts inside a streamed candidate.
    const gemini = extractCandyProbeAnswerPayload(sse([
      { response: { candidates: [{ content: { parts: [
        { thought: true, text: '21？' },
        { text: '答案：20' },
      ] } }] } },
    ]), 'text/event-stream');
    expect(gemini.text).toBe('答案：20');
  });

  it('yields empty text for a valid JSON body that carries only usage', () => {
    // The raw body's numbers are usage counters, not answers; falling back to it is how a
    // probe once graded "5099". Empty is the honest reading of "no answer came back".
    const payload = extractCandyProbeAnswerPayload(JSON.stringify({
      id: 'resp_1',
      usage: { prompt_tokens: 5099, total_tokens: 5100 },
    }), 'application/json');
    expect(payload.transport).toBe('json');
    expect(payload.text).toBe('');
  });
});
