/**
 * Client fingerprints for the candy-question probe.
 *
 * Why this exists: relays very often route by client identity. A channel that serves a
 * real model to Claude Code traffic may serve a cheaper backend to bare API traffic (or
 * the other way round). A probe that does not look like the client it is standing in for
 * therefore measures the wrong thing.
 *
 * These profiles are the BUILT-IN fallback. The identity a probe actually wears comes from
 * `observedClientIdentity.ts` — what real traffic on this box was seen to send — and only
 * falls back to the headers below when nothing has been observed yet. Either way the
 * identity headers travel as DOWNSTREAM headers, so the upstream builder filters them with
 * exactly the passthrough rules a real request meets (an earlier version injected them as
 * provider headers, which skipped those rules and dropped Claude's Stainless set).
 *
 * Each profile supplies:
 *
 * - identity headers (`buildProviderHeaders`) — the built-in template identity;
 * - bodies — the request shape per protocol. All three are supplied so that whichever
 *   endpoint the flow settles on receives a body that matches it. With observed body traits
 *   the bodies follow the observed shape instead of the template.
 *
 * Deliberate fidelity boundary: the template reproduces the two body-level markers we can
 * state with confidence (Claude Code's identity system line and its `metadata.user_id`
 * shape). Long, versioned payloads (Claude Code's full tool list / billing line, Codex's
 * full `instructions` blob) are NOT fabricated — a wrong template is more identifiable than
 * an absent one.
 *
 * The Codex family is split into two profiles, mirroring the two shapes real traffic takes:
 *
 * - `codex` — the CLI's native `/v1/responses` surface: user agent, originator and a
 *   `session-id`, plus the Codex session/turn synthesis (`client_metadata`, window/turn
 *   headers) the proxy applies when the site enables it. Used for GPT/o-series/Codex models,
 *   which the CLI drives through `/v1/responses`.
 * - `codex_chat` — the extension variant: a Codex-CLI identity on `/v1/chat/completions`
 *   with ONLY `User-Agent` + `Originator`, and no session/turn metadata. This is the shape
 *   aggregator traffic actually wears when Codex-identified clients drive non-GPT models
 *   (deepseek/glm/kimi/…), and adding session headers there would describe a client that
 *   does not exist on that surface.
 */

import { uuidFromSeed } from '../../proxy-core/providers/headerUtils.js';

/**
 * The built-in template's client identity strings.
 *
 * Deliberately separate from the proxy runtime defaults in `headerUtils.ts`
 * (`CLAUDE_DEFAULT_USER_AGENT`, `CODEX_DEFAULT_USER_AGENT`): those fill in an identity for
 * every real proxied request that lacks one, and for the OAuth quota probe, so moving them
 * is a box-wide change with its own upstream risk. These only dress the synthetic requests
 * (candy probe, model identity probe, playground) when no real client has been observed.
 *
 * Both are real, published releases: Claude Code 2.1.280 is the baseline CLIProxyAPI measured
 * its full Messages fingerprint against, and Codex 0.165.0 is the current official release.
 */
export const BUILTIN_CLAUDE_CODE_USER_AGENT = 'claude-cli/2.1.280 (external, cli)';
export const BUILTIN_CODEX_USER_AGENT = 'codex_cli_rs/0.165.0 (Mac OS 26.0.1; arm64) Apple_Terminal/464';

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
  /**
   * Body shape observed on real traffic of this client (see `observedClientIdentity.ts`).
   * Absent → the built-in template shape, unchanged.
   */
  bodyTraits?: CandyBodyTraits | null;
  /** The session id the identity headers carry, so a body-level session id can match it. */
  sessionId?: string | null;
};

/** The subset of observed body traits the probe bodies honor. */
export type CandyBodyTraits = {
  hasTopLevelSystem?: boolean;
  hasMetadataUserId?: boolean;
  reasoningEffort?: string | null;
  include?: string[] | null;
  store?: boolean | null;
  hasMaxOutputTokens?: boolean;
  hasPromptCacheKey?: boolean;
  parallelToolCalls?: boolean | null;
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
export function buildClaudeCodeUserId(scopeKey: string, sessionIdOverride?: string | null): string {
  const hex = uuidFromSeed(`metapi:candy:claude-user:${scopeKey}`).replace(/-/g, '');
  const doubled = `${hex}${hex}`.slice(0, 64);
  const sessionId = sessionIdOverride || uuidFromSeed(`metapi:candy:claude-session:${scopeKey}`);
  return `user_${doubled}_account__session_${sessionId}`;
}

const claudeCodeFingerprint: CandyFingerprint = {
  id: 'claude_code',
  label: 'Claude Code',
  downstreamFormat: 'claude',
  stream: true,
  buildProviderHeaders({ scopeKey }) {
    return {
      // Stated explicitly rather than left to buildClaudeRuntimeHeaders(): the runtime
      // default is an older version, and the template should not inherit it.
      'User-Agent': BUILTIN_CLAUDE_CODE_USER_AGENT,
      'X-App': 'cli',
      // Real Claude Code traffic carries its session id as a header as well.
      'x-claude-code-session-id': uuidFromSeed(`metapi:candy:claude-session:${scopeKey}`),
    };
  },
  buildOpenAiBody({ model, prompt }) {
    return {
      model,
      messages: [{ role: 'user', content: prompt }],
      stream: true,
    };
  },
  buildClaudeBody({ model, prompt, scopeKey, bodyTraits, sessionId }) {
    // Without observed traits: the template (identity system line + user id). With them:
    // only what real traffic carries — the box's Claude traffic sends neither, and a probe
    // that adds them describes a client that does not talk to this box.
    const withSystem = bodyTraits ? bodyTraits.hasTopLevelSystem === true : true;
    const withUserId = bodyTraits ? bodyTraits.hasMetadataUserId === true : true;
    return {
      model,
      // Reasoning models charge their thinking against this budget; at 2048 a thinking
      // model could spend it all before writing a single answer line, which reads as an
      // empty completion and then as "未完成"（inconclusive）.
      max_tokens: CANDY_PROBE_MAX_OUTPUT_TOKENS,
      stream: true,
      ...(withSystem ? { system: [{ type: 'text', text: CLAUDE_CODE_SYSTEM_LINE }] } : {}),
      ...(withUserId ? { metadata: { user_id: buildClaudeCodeUserId(scopeKey, sessionId) } } : {}),
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
    // The built-in fallback mirrors what real Codex traffic on the responses surface was
    // observed to carry: user agent, originator and a hyphenated `session-id` — no
    // `Version`, no `Conversation_id`, no underscored `Session_id`. An observed identity
    // (see `observedClientIdentity.ts`) replaces this whenever one exists.
    return {
      'User-Agent': BUILTIN_CODEX_USER_AGENT,
      Originator: 'codex_cli_rs',
      'session-id': uuidFromSeed(`metapi:candy:codex-session:${scopeKey}`),
    };
  },
  buildOpenAiBody({ model, prompt }) {
    return {
      model,
      messages: [{ role: 'user', content: prompt }],
      stream: true,
    };
  },
  buildResponsesBody({ model, prompt, scopeKey, bodyTraits, sessionId }) {
    const input = [{
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: prompt }],
    }];
    if (!bodyTraits) {
      return {
        model,
        input,
        stream: true,
        store: false,
        // Same reasoning as the Claude body: the reasoning budget and the answer share this
        // cap, so a tight one turns a working channel into an empty response.
        max_output_tokens: CANDY_PROBE_MAX_OUTPUT_TOKENS,
        prompt_cache_key: uuidFromSeed(`metapi:candy:codex-cache:${scopeKey}`),
      };
    }
    // Observed shape. `max_output_tokens` follows real traffic too: real Codex sends none,
    // and the cap is then the upstream's own. A thinking model cut off by it reads as
    // "输出被截断" (inconclusive), never as a wrong answer — see the answer reader.
    return {
      model,
      instructions: '',
      input,
      stream: true,
      ...(bodyTraits.reasoningEffort ? { reasoning: { effort: bodyTraits.reasoningEffort } } : {}),
      ...(typeof bodyTraits.parallelToolCalls === 'boolean' ? { parallel_tool_calls: bodyTraits.parallelToolCalls } : {}),
      ...(bodyTraits.include && bodyTraits.include.length > 0 ? { include: [...bodyTraits.include] } : {}),
      store: typeof bodyTraits.store === 'boolean' ? bodyTraits.store : false,
      ...(bodyTraits.hasMaxOutputTokens === false ? {} : { max_output_tokens: CANDY_PROBE_MAX_OUTPUT_TOKENS }),
      ...(bodyTraits.hasPromptCacheKey === false
        ? {}
        : { prompt_cache_key: sessionId || uuidFromSeed(`metapi:candy:codex-cache:${scopeKey}`) }),
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
      'User-Agent': BUILTIN_CODEX_USER_AGENT,
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
