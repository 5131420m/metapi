/**
 * Client fingerprints for the candy-question probe.
 *
 * Why this exists: relays very often route by client identity. A channel that serves a
 * real model to Claude Code traffic may serve a cheaper backend to bare API traffic (or
 * the other way round). A probe that does not look like the client it is standing in for
 * therefore measures the wrong thing.
 *
 * Each profile supplies three things, all of which travel through the existing upstream
 * request builder:
 *
 * - `providerHeaders` — the unfiltered injection point, so client-specific headers
 *   (`Originator`, `Version`, `Session_id`, `User-Agent`, …) survive on any platform.
 * - `downstreamHeaders` — protocol-family passthrough (`anthropic-*`, `x-stainless-*`,
 *   `openai-*`), used where the builder already understands the family.
 * - bodies — the request shape per protocol. All three are supplied so that whichever
 *   endpoint the flow settles on receives a body that matches it.
 *
 * Deliberate fidelity boundary: header-level identity is reproduced faithfully, and the
 * two body-level markers we can state with confidence (Claude Code's identity system line
 * and its `metadata.user_id` shape) are reproduced too. Long, versioned payloads (Claude
 * Code's full tool list / billing line, Codex's full `instructions` blob) are NOT
 * fabricated — a wrong template is more identifiable than an absent one. Those can be
 * calibrated later from real `proxy_debug_traces` samples.
 *
 * The Codex family is split into two profiles, mirroring the two shapes real traffic takes:
 *
 * - `codex` — the CLI's native `/v1/responses` surface, with the full client-identity
 *   header set (`Originator`/`Version`/`Session_id`/`Conversation_id`) and the Codex
 *   session/turn synthesis (`client_metadata`, window/turn headers) the proxy applies for
 *   codex sites. Used for GPT/o-series/Codex models, which the CLI drives through
 *   `/v1/responses`.
 * - `codex_chat` — the extension variant: a Codex-CLI identity on `/v1/chat/completions`
 *   with ONLY `User-Agent` + `Originator`, and no session/turn metadata. This is the shape
 *   aggregator traffic actually wears when Codex-identified clients drive non-GPT models
 *   (deepseek/glm/kimi/…), and adding session headers there would describe a client that
 *   does not exist on that surface.
 */

import {
  CLAUDE_DEFAULT_USER_AGENT,
  CODEX_CLIENT_VERSION,
  CODEX_DEFAULT_USER_AGENT,
  uuidFromSeed,
} from '../../proxy-core/providers/headerUtils.js';

export type CandyFingerprintId = 'claude_code' | 'codex' | 'codex_chat' | 'generic_openai';

/**
 * Output cap for the probe's request bodies.
 *
 * This is not a real limit — it is headroom for the reasoning the question needs. The probe now
 * ASKS for reasoning and reads the conclusion from a dedicated `答案：` line, so a thinking model
 * spends most of the budget before writing that line: at 2048 it could exhaust the cap and emit
 * nothing, which the reader can only see as an unreadable sample.
 *
 * 16k rather than the old 8k, and deliberately not higher: some endpoints reject a `max_tokens`
 * above their own ceiling unless an extra beta header is present, and a rejection here costs a
 * whole sample. If an upstream does refuse it, the sample comes back as an upstream error the
 * reason names — never as a wrong answer.
 */
export const CANDY_PROBE_MAX_OUTPUT_TOKENS = 16_384;

export type CandyFingerprintRequestInput = {
  model: string;
  prompt: string;
  /** Stable per-channel scope: keeps synthesized session/user ids consistent across runs. */
  scopeKey: string;
};

export type CandyFingerprint = {
  id: CandyFingerprintId;
  label: string;
  /** Downstream protocol family the profile emulates; drives endpoint preference. */
  downstreamFormat: 'openai' | 'claude' | 'responses';
  /** Claude Code and Codex always stream; a non-stream probe is itself a mismatch. */
  stream: boolean;
  buildProviderHeaders(input: CandyFingerprintRequestInput): Record<string, string>;
  buildOpenAiBody(input: CandyFingerprintRequestInput): Record<string, unknown>;
  buildClaudeBody?(input: CandyFingerprintRequestInput): Record<string, unknown>;
  buildResponsesBody?(input: CandyFingerprintRequestInput): Record<string, unknown>;
};

/** The identity line Claude Code puts first in its system prompt. */
const CLAUDE_CODE_SYSTEM_LINE = "You are Claude Code, Anthropic's official CLI for Claude.";

/**
 * The neutral SDK identity for models that are neither Claude nor GPT.
 *
 * Paired with the `X-Stainless-*` markers below, which are Node SDK headers — consistent with
 * each other and with the chat endpoint they are sent to.
 */
const GENERIC_SDK_USER_AGENT = 'OpenAI/JS 4.104.0';

/**
 * Claude Code's `metadata.user_id` shape:
 * `user_<64 hex>_account__session_<uuid>`.
 *
 * Synthesized deterministically from the channel scope so repeat runs look like the same
 * installation, and so metapi's own `cliProfiles` detector recognizes the probe as
 * Claude Code traffic.
 */
export function buildClaudeCodeUserId(scopeKey: string): string {
  const hex = uuidFromSeed(`metapi:candy:claude-user:${scopeKey}`).replace(/-/g, '');
  const doubled = `${hex}${hex}`.slice(0, 64);
  const sessionId = uuidFromSeed(`metapi:candy:claude-session:${scopeKey}`);
  return `user_${doubled}_account__session_${sessionId}`;
}

const claudeCodeFingerprint: CandyFingerprint = {
  id: 'claude_code',
  label: 'Claude Code',
  downstreamFormat: 'claude',
  stream: true,
  buildProviderHeaders() {
    return {
      // buildClaudeRuntimeHeaders() already defaults these; stating them here keeps the
      // probe's identity explicit and makes the version easy to bump in one place.
      'User-Agent': CLAUDE_DEFAULT_USER_AGENT,
      'X-App': 'cli',
    };
  },
  buildOpenAiBody({ model, prompt }) {
    return {
      model,
      messages: [{ role: 'user', content: prompt }],
      stream: true,
    };
  },
  buildClaudeBody({ model, prompt, scopeKey }) {
    return {
      model,
      // Reasoning models charge their thinking against this budget; at 2048 a thinking
      // model could spend it all before writing a single answer line, which reads as an
      // empty completion and then as "未完成"（inconclusive）.
      max_tokens: CANDY_PROBE_MAX_OUTPUT_TOKENS,
      stream: true,
      system: [{ type: 'text', text: CLAUDE_CODE_SYSTEM_LINE }],
      metadata: { user_id: buildClaudeCodeUserId(scopeKey) },
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
    };
  },
};

const codexFingerprint: CandyFingerprint = {
  id: 'codex',
  label: 'Codex CLI',
  downstreamFormat: 'responses',
  stream: true,
  buildProviderHeaders({ scopeKey }) {
    const sessionId = uuidFromSeed(`metapi:candy:codex-session:${scopeKey}`);
    return {
      'User-Agent': CODEX_DEFAULT_USER_AGENT,
      Originator: 'codex_cli_rs',
      Version: CODEX_CLIENT_VERSION,
      Session_id: sessionId,
      Conversation_id: sessionId,
    };
  },
  buildOpenAiBody({ model, prompt }) {
    return {
      model,
      messages: [{ role: 'user', content: prompt }],
      stream: true,
    };
  },
  buildResponsesBody({ model, prompt, scopeKey }) {
    return {
      model,
      input: [{
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: prompt }],
      }],
      stream: true,
      store: false,
      // Same reasoning as the Claude body: the reasoning budget and the answer share this
      // cap, so a tight one turns a working channel into an empty response.
      max_output_tokens: CANDY_PROBE_MAX_OUTPUT_TOKENS,
      prompt_cache_key: uuidFromSeed(`metapi:candy:codex-cache:${scopeKey}`),
    };
  },
};

/**
 * The extension variant: a Codex-CLI identity driving `/v1/chat/completions`.
 *
 * Real aggregator traffic reaches non-GPT models (deepseek/glm/kimi/…) through
 * Codex-CLI clients wearing exactly two identity headers — `User-Agent` and `Originator` —
 * with no session/conversation/turn metadata: those belong to the responses surface. The
 * probe mirrors that shape so a relay that routes by client identity serves the probe what
 * it serves the traffic this channel actually carries.
 */
const codexChatFingerprint: CandyFingerprint = {
  id: 'codex_chat',
  label: 'Codex CLI (Chat)',
  downstreamFormat: 'openai',
  stream: true,
  buildProviderHeaders() {
    // Deliberately ONLY the two headers the extension variant carries. Adding
    // Session_id/Conversation_id/Version here would describe a client that does not exist
    // on this surface — the same self-contradiction the generic profile avoids.
    return {
      'User-Agent': CODEX_DEFAULT_USER_AGENT,
      Originator: 'codex_cli_rs',
    };
  },
  buildOpenAiBody({ model, prompt }) {
    // Same output-cap and usage reasons as the generic SDK profile: a relay's own default
    // cap is what truncates a thinking model's answer, and without `include_usage` a
    // streaming chat upstream reports no usage at all.
    return {
      model,
      messages: [{ role: 'user', content: prompt }],
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: CANDY_PROBE_MAX_OUTPUT_TOKENS,
    };
  },
};

const genericOpenAiFingerprint: CandyFingerprint = {
  id: 'generic_openai',
  label: 'OpenAI SDK',
  downstreamFormat: 'openai',
  stream: true,
  buildProviderHeaders() {
    // A neutral, internally consistent SDK identity for everything that is neither Claude nor
    // GPT. It deliberately does NOT wear the Codex CLI identity: Codex CLI only speaks
    // /v1/responses, so a `codex_cli_rs` user agent on /v1/chat/completions describes a client
    // that cannot exist — the same self-contradiction as pairing a Rust CLI agent with Node
    // SDK markers, which is why the Stainless set belongs here and nowhere near Codex.
    return {
      'User-Agent': GENERIC_SDK_USER_AGENT,
      'X-Stainless-Lang': 'js',
      'X-Stainless-Package-Version': '4.104.0',
      'X-Stainless-Os': 'MacOS',
      'X-Stainless-Arch': 'arm64',
      'X-Stainless-Runtime': 'node',
      'X-Stainless-Runtime-Version': 'v22.14.0',
    };
  },
  buildOpenAiBody({ model, prompt }) {
    // `max_tokens` IS set, deliberately contradicting the older rule here. The probe now asks
    // for reasoning, so a relay's own default cap is what truncates the answer: leaving it to
    // the upstream meant a thinking model could be cut off before its `答案：` line, and a
    // truncated sample is indistinguishable from a model that answered nothing.
    //
    // No temperature: that parameter is the one relays most often reject, and a rejection here
    // costs the whole sample. `stream_options.include_usage` is requested because without it a
    // streaming chat upstream reports no usage at all, so the probe's usage-log row would show
    // no tokens even though the run really consumed some.
    return {
      model,
      messages: [{ role: 'user', content: prompt }],
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: CANDY_PROBE_MAX_OUTPUT_TOKENS,
    };
  },
};

export const CANDY_FINGERPRINTS: Record<CandyFingerprintId, CandyFingerprint> = {
  claude_code: claudeCodeFingerprint,
  codex: codexFingerprint,
  codex_chat: codexChatFingerprint,
  generic_openai: genericOpenAiFingerprint,
};

/**
 * The fingerprint ids, derived from the registry rather than restated.
 *
 * Three other places used to keep their own literal list (the API route's validation set,
 * the result store's normalizer, the web labels). A new fingerprint therefore compiled
 * everywhere and was rejected at the boundary by a set nobody remembered to update.
 */
export const CANDY_FINGERPRINT_IDS: readonly CandyFingerprintId[] = Object.keys(
  CANDY_FINGERPRINTS,
) as CandyFingerprintId[];

export function isCandyFingerprintId(value: unknown): value is CandyFingerprintId {
  return typeof value === 'string'
    && (CANDY_FINGERPRINT_IDS as readonly string[]).includes(value);
}

export function getCandyFingerprint(id: CandyFingerprintId): CandyFingerprint {
  return CANDY_FINGERPRINTS[id];
}

/**
 * Models the Codex CLI drives through its native `/v1/responses` surface.
 */
export function isCandyCodexResponsesModel(modelName: string): boolean {
  const normalized = String(modelName || '').trim().toLowerCase();
  if (!normalized) return false;
  return (
    normalized.startsWith('gpt')
    || normalized.includes('codex')
    || normalized.includes('chatgpt')
    || /(^|[-_/])o[1-9](?:[-_/]|$)/.test(normalized)
  );
}

/**
 * Default fingerprint by model family:
 * Claude → Claude Code (/v1/messages); GPT/o-series/Codex → Codex CLI on /v1/responses
 * with the full client identity; everything else → the Codex extension variant on
 * /v1/chat/completions with the minimal two-header identity, because that is the shape
 * the traffic on those channels actually wears. `generic_openai` stays in the registry
 * for manual selection and for reading persisted results recorded under it.
 */
export function resolveCandyFingerprintIdForModel(modelName: string): CandyFingerprintId {
  const normalized = String(modelName || '').trim().toLowerCase();
  if (normalized.includes('claude')) return 'claude_code';
  if (isCandyCodexResponsesModel(normalized)) return 'codex';
  return 'codex_chat';
}
