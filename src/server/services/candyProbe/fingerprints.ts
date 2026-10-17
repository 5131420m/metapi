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
 */

import {
  CLAUDE_DEFAULT_USER_AGENT,
  CODEX_CLIENT_VERSION,
  CODEX_DEFAULT_USER_AGENT,
  uuidFromSeed,
} from '../../proxy-core/providers/headerUtils.js';

export type CandyFingerprintId = 'claude_code' | 'codex' | 'generic_openai';

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

/** Generic OpenAI SDK-ish identity for models that have no dedicated CLI client. */
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
      max_tokens: 2048,
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
      max_output_tokens: 2048,
      prompt_cache_key: uuidFromSeed(`metapi:candy:codex-cache:${scopeKey}`),
    };
  },
};

const genericOpenAiFingerprint: CandyFingerprint = {
  id: 'generic_openai',
  label: 'OpenAI SDK',
  downstreamFormat: 'openai',
  stream: true,
  buildProviderHeaders() {
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
    // No token cap and no temperature: the widest relay compatibility, and a rejected
    // parameter would otherwise surface as an inconclusive probe rather than a verdict.
    // `stream_options.include_usage` IS requested: without it a streaming chat upstream
    // reports no usage at all, so the probe's usage-log row would show no tokens even
    // though the run really consumed some.
    return {
      model,
      messages: [{ role: 'user', content: prompt }],
      stream: true,
      stream_options: { include_usage: true },
    };
  },
};

export const CANDY_FINGERPRINTS: Record<CandyFingerprintId, CandyFingerprint> = {
  claude_code: claudeCodeFingerprint,
  codex: codexFingerprint,
  generic_openai: genericOpenAiFingerprint,
};

export function getCandyFingerprint(id: CandyFingerprintId): CandyFingerprint {
  return CANDY_FINGERPRINTS[id];
}

/**
 * Default fingerprint by model family:
 * Claude → Claude Code, GPT/o-series/Codex → Codex CLI, everything else → generic SDK.
 */
export function resolveCandyFingerprintIdForModel(modelName: string): CandyFingerprintId {
  const normalized = String(modelName || '').trim().toLowerCase();
  if (!normalized) return 'generic_openai';
  if (normalized.includes('claude')) return 'claude_code';
  if (
    normalized.startsWith('gpt')
    || normalized.includes('codex')
    || normalized.includes('chatgpt')
    || /(^|[-_/])o[1-9](?:[-_/]|$)/.test(normalized)
  ) {
    return 'codex';
  }
  return 'generic_openai';
}
