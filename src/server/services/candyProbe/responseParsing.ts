/**
 * Pull the assistant's text out of one upstream response, whatever protocol answered.
 *
 * The probe asks one candy question per sample, and needs the model's raw completion, but the
 * endpoint flow may settle on `chat`, `messages` or `responses` — and each of those can answer
 * either as a buffered JSON body or as an SSE stream (the CLI fingerprints always stream, so
 * SSE is the common case, not the exception).
 *
 * Text is preserved verbatim, newlines included: the answer is read from a dedicated conclusion
 * line, so collapsing whitespace here would destroy the very structure the reader relies on.
 *
 * Two invariants this module owes the grader:
 *
 * - Reasoning is never an answer. A thinking model walks through candidate numbers before
 *   committing, so any of it reaching the graded text can flip a verdict. Every envelope's
 *   reasoning carrier is dropped here — chat `reasoning` parts, Responses `reasoning` items,
 *   Anthropic `thinking` blocks, Gemini `thought: true` parts.
 * - A valid JSON body with no readable answer yields EMPTY text. It never falls back to the
 *   raw body, whose numbers are usage counters, not answers (octopus graded one of those as
 *   "5099" once).
 */

import { unwrapGeminiCliPayload } from '../../transformers/gemini/generate-content/cliBridge.js';

export type CandyProbeAnswerPayload = {
  text: string;
  model: string | null;
  stopReason: string | null;
  usage: Record<string, unknown> | null;
  errorMessage: string | null;
  transport: 'sse' | 'json' | 'unknown';
};

/**
 * Whether a stop reason means the model was cut off mid-answer.
 *
 * Truncation must not be graded as a wrong answer: the conclusion line is usually the last
 * thing written, so a cut-off answer is missing an answer we never got to see. Each protocol
 * spells it differently — OpenAI `length`, Anthropic `max_tokens`, Gemini `MAX_TOKENS`, and a
 * Responses payload that reports `status: incomplete`.
 */
export function isTruncatedStopReason(stopReason: string | null | undefined): boolean {
  if (typeof stopReason !== 'string') return false;
  const normalized = stopReason.trim().toLowerCase();
  return normalized === 'length'
    || normalized === 'max_tokens'
    || normalized === 'maxtokens'
    || normalized === 'max_output_tokens'
    || normalized === 'incomplete';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function asTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readStringField(record: Record<string, unknown> | null, key: string): string {
  if (!record) return '';
  return asTrimmedString(record[key]);
}

/**
 * Whether one content part/block carries reasoning rather than the model's answer.
 *
 * Each protocol marks it differently: `reasoning` / `reasoning_text` parts (chat,
 * Responses), `thinking` / `redacted_thinking` blocks (Anthropic), and Gemini's
 * `thought: true` flag — which needs no `type` at all.
 */
function isReasoningItem(item: Record<string, unknown>): boolean {
  const type = asTrimmedString(item.type).toLowerCase();
  if (type === 'reasoning' || type === 'reasoning_text' || type === 'thinking' || type === 'redacted_thinking') {
    return true;
  }
  return item.thought === true;
}

/**
 * Read text out of a content value, which arrives in several shapes:
 * a plain string, a chat content block array, an Anthropic text-block array, or a
 * Responses `output_text` part array. Reasoning parts are skipped: they discuss candidate
 * answers, they are not one.
 */
function readContentText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value
    .map((item) => {
      if (typeof item === 'string') return item;
      if (!isRecord(item)) return '';
      if (isReasoningItem(item)) return '';
      const text = item.text;
      return typeof text === 'string' ? text : '';
    })
    .join('');
}

function readUsage(record: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!record || !isRecord(record.usage)) return null;
  return record.usage;
}

type PayloadAccumulator = {
  chunks: string[];
  model: string | null;
  stopReason: string | null;
  usage: Record<string, unknown> | null;
  errorMessage: string | null;
};

function createAccumulator(): PayloadAccumulator {
  return { chunks: [], model: null, stopReason: null, usage: null, errorMessage: null };
}

function appendChunk(accumulator: PayloadAccumulator, text: unknown): void {
  if (typeof text !== 'string' || !text) return;
  accumulator.chunks.push(text);
}

function noteModel(accumulator: PayloadAccumulator, value: unknown): void {
  const model = asTrimmedString(value);
  if (model && !accumulator.model) accumulator.model = model;
}

function noteStopReason(accumulator: PayloadAccumulator, value: unknown): void {
  const reason = asTrimmedString(value);
  if (reason && !accumulator.stopReason) accumulator.stopReason = reason;
}

function noteUsage(accumulator: PayloadAccumulator, value: unknown): void {
  if (!isRecord(value)) return;
  // Merged rather than first-wins: Anthropic splits usage across `message_start`
  // (input tokens) and `message_delta` (output tokens), and both halves matter.
  accumulator.usage = { ...(accumulator.usage ?? {}), ...value };
}

function noteError(accumulator: PayloadAccumulator, value: unknown): void {
  if (accumulator.errorMessage) return;
  if (typeof value === 'string') {
    accumulator.errorMessage = value.trim() || null;
    return;
  }
  if (isRecord(value)) {
    const message = readStringField(value, 'message');
    if (message) accumulator.errorMessage = message;
  }
}

/**
 * Fold one decoded event/body object into the accumulator. Written shape-first rather
 * than protocol-first so an unexpected variant degrades to "text missing" instead of
 * throwing.
 */
function applyPayloadObject(rawPayload: unknown, accumulator: PayloadAccumulator): void {
  if (!isRecord(rawPayload)) return;
  // gemini-cli upstreams wrap every payload in `{ response: … }`. The OpenAI Responses
  // protocol ALSO carries a `response` field (on `response.created` and friends), so the
  // unwrap has to be gated on the discriminator: only the gemini wrapper lacks `type`.
  // Unwrapping unconditionally would turn a Responses event into its own inner object and
  // lose the model, the usage and the stop reason with it.
  const payload = rawPayload.type === undefined
    ? unwrapGeminiCliPayload(rawPayload)
    : rawPayload;
  if (!isRecord(payload)) return;

  if (payload.error) noteError(accumulator, payload.error);

  const eventType = asTrimmedString(payload.type);
  if (eventType) {
    switch (eventType) {
      // Anthropic Messages streaming
      case 'message_start': {
        const message = isRecord(payload.message) ? payload.message : null;
        noteModel(accumulator, message?.model);
        noteUsage(accumulator, message?.usage);
        noteStopReason(accumulator, message?.stop_reason);
        break;
      }
      case 'content_block_delta': {
        const delta = isRecord(payload.delta) ? payload.delta : null;
        // `thinking_delta` / `signature_delta` carry their text in `thinking`/`signature`,
        // so the guard is defensive — but it means a relay that DOES put thought text in
        // `text` still cannot leak it into the graded answer.
        const deltaType = delta ? asTrimmedString(delta.type) : '';
        if (!deltaType || deltaType === 'text_delta') appendChunk(accumulator, delta?.text);
        break;
      }
      case 'message_delta': {
        const delta = isRecord(payload.delta) ? payload.delta : null;
        noteStopReason(accumulator, delta?.stop_reason);
        noteUsage(accumulator, payload.usage);
        break;
      }
      case 'error': {
        noteError(accumulator, payload.error ?? payload.message);
        break;
      }
      // OpenAI Responses streaming
      case 'response.created':
      case 'response.in_progress':
      case 'response.completed':
      case 'response.incomplete':
      case 'response.failed': {
        const response = isRecord(payload.response) ? payload.response : null;
        noteModel(accumulator, response?.model);
        noteUsage(accumulator, response?.usage);
        // `incomplete_details` is an OBJECT ({ reason: 'max_output_tokens' }); passing it
        // straight to a string field discarded the truncation signal entirely.
        const incomplete = isRecord(response?.incomplete_details) ? response?.incomplete_details : null;
        noteStopReason(
          accumulator,
          response?.stop_reason ?? readStringField(incomplete, 'reason'),
        );
        if (eventType === 'response.failed') noteError(accumulator, response?.error);
        break;
      }
      case 'response.output_text.delta': {
        appendChunk(accumulator, payload.delta);
        break;
      }
      case 'response.output_text.done': {
        // Only used when no delta ever arrived: some relays buffer and emit the final text.
        if (accumulator.chunks.length <= 0) appendChunk(accumulator, payload.text);
        break;
      }
      default: {
        // Chat-completions chunks carry no `type` discriminator in practice, but some
        // relays add one; fall through to the shared shape handling below.
        break;
      }
    }
  }

  // Chat Completions (buffered or streaming)
  const choices = Array.isArray(payload.choices) ? payload.choices : null;
  if (choices && choices.length > 0) {
    const choice = isRecord(choices[0]) ? choices[0] : null;
    const delta = choice && isRecord(choice.delta) ? choice.delta : null;
    const message = choice && isRecord(choice.message) ? choice.message : null;
    if (delta) appendChunk(accumulator, readContentText(delta.content));
    if (message) appendChunk(accumulator, readContentText(message.content));
    noteStopReason(accumulator, choice?.finish_reason);
  }
  // Model/usage live OUTSIDE the `choices.length > 0` guard on purpose: OpenAI streams the
  // usage-only final chunk as `{ choices: [], usage: {...} }`, so reading them only when a
  // choice is present is how `stream_options.include_usage` ended up doing nothing.
  if (choices) {
    noteModel(accumulator, payload.model);
    noteUsage(accumulator, payload.usage);
  }

  // Buffered Anthropic Messages
  const content = payload.content;
  if (Array.isArray(content)) {
    appendChunk(accumulator, readContentText(content));
    noteModel(accumulator, payload.model);
    noteUsage(accumulator, payload.usage);
    noteStopReason(accumulator, payload.stop_reason);
  }

  // Buffered OpenAI Responses.
  //
  // `output_text` is a convenience mirror of `output[]`, so a body carrying both (which
  // some relays do) would otherwise append the same answer twice and push the line-based
  // format out of alignment. The structured array wins; the flat field is only a fallback.
  const output = payload.output;
  const outputItems = Array.isArray(output)
    ? output.filter((item): item is Record<string, unknown> => isRecord(item))
    : [];
  if (outputItems.length > 0) {
    for (const item of outputItems) {
      // `reasoning` items are the scratchpad (their content parts also carry `reasoning_text`,
      // which `readContentText` would skip on its own — skipping the whole item is belt and
      // braces for the `item.text` read below); `function_call*` items are tool traffic the
      // probe never asks for. Neither is the answer.
      const itemType = asTrimmedString(item.type).toLowerCase();
      if (itemType === 'reasoning' || itemType.startsWith('function_call')) continue;
      appendChunk(accumulator, readContentText(item.content));
      if (typeof item.text === 'string') appendChunk(accumulator, item.text);
    }
    noteModel(accumulator, payload.model);
    noteUsage(accumulator, payload.usage);
    noteStopReason(accumulator, payload.status === 'incomplete' ? 'incomplete' : null);
  } else if (typeof payload.output_text === 'string') {
    appendChunk(accumulator, payload.output_text);
    noteModel(accumulator, payload.model);
    noteUsage(accumulator, payload.usage);
    noteStopReason(accumulator, payload.status === 'incomplete' ? 'incomplete' : null);
  }

  // Gemini native (gemini-cli / antigravity upstreams)
  const candidates = Array.isArray(payload.candidates) ? payload.candidates : null;
  if (candidates && candidates.length > 0) {
    for (const candidate of candidates) {
      if (!isRecord(candidate)) continue;
      const content = isRecord(candidate.content) ? candidate.content : null;
      const parts = content && Array.isArray(content.parts) ? content.parts : null;
      if (!parts) continue;
      for (const part of parts) {
        if (!isRecord(part)) continue;
        // Gemini flags its thought summaries with `thought: true`; they discuss candidate
        // answers and must not be graded.
        if (part.thought === true) continue;
        appendChunk(accumulator, part.text);
      }
      noteStopReason(accumulator, candidate.finishReason);
    }
    noteModel(accumulator, payload.modelVersion ?? payload.model);
    noteUsage(accumulator, payload.usageMetadata);
  }
}

function decodeJson(raw: string): unknown {
  const text = raw.trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function parseSseDataLines(raw: string): unknown[] {
  const payloads: unknown[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trimStart();
    if (!trimmed.startsWith('data:')) continue;
    const data = trimmed.slice('data:'.length).trim();
    if (!data || data === '[DONE]') continue;
    const decoded = decodeJson(data);
    if (decoded !== null) payloads.push(decoded);
  }
  return payloads;
}

function looksLikeSse(raw: string, contentType: string | null): boolean {
  if (contentType && /text\/event-stream/i.test(contentType)) return true;
  return /(^|\n)\s*data:/.test(raw);
}

export function extractCandyProbeAnswerPayload(
  rawText: string,
  contentType?: string | null,
): CandyProbeAnswerPayload {
  const accumulator = createAccumulator();
  const raw = typeof rawText === 'string' ? rawText : '';
  const normalizedContentType = contentType ?? null;

  if (looksLikeSse(raw, normalizedContentType)) {
    const payloads = parseSseDataLines(raw);
    for (const payload of payloads) applyPayloadObject(payload, accumulator);
    if (payloads.length > 0) {
      return {
        text: accumulator.chunks.join(''),
        model: accumulator.model,
        stopReason: accumulator.stopReason,
        usage: accumulator.usage,
        errorMessage: accumulator.errorMessage,
        transport: 'sse',
      };
    }
  }

  const decoded = decodeJson(raw);
  if (decoded !== null) {
    applyPayloadObject(decoded, accumulator);
    return {
      text: accumulator.chunks.join(''),
      model: accumulator.model,
      stopReason: accumulator.stopReason,
      usage: accumulator.usage,
      errorMessage: accumulator.errorMessage,
      transport: 'json',
    };
  }

  return {
    text: accumulator.chunks.join(''),
    model: accumulator.model,
    stopReason: accumulator.stopReason,
    usage: accumulator.usage,
    errorMessage: accumulator.errorMessage,
    transport: 'unknown',
  };
}
