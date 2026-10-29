import { describe, expect, it } from 'vitest';
import {
  BUILTIN_CLAUDE_CODE_USER_AGENT,
  BUILTIN_CODEX_USER_AGENT,
  buildClaudeCodeUserId,
  CANDY_FINGERPRINTS,
  CANDY_FINGERPRINT_IDS,
  CANDY_PROBE_MAX_OUTPUT_TOKENS,
  getCandyFingerprint,
  isCandyFingerprintId,
  resolveCandyFingerprintIdForModel,
} from './fingerprints.js';
import { detectCliProfile } from '../../proxy-core/cliProfiles/registry.js';
import {
  CLAUDE_DEFAULT_USER_AGENT,
  CODEX_DEFAULT_USER_AGENT,
} from '../../proxy-core/providers/headerUtils.js';

describe('candy fingerprint selection by model family', () => {
  it('routes Claude models to the Claude Code profile', () => {
    expect(resolveCandyFingerprintIdForModel('claude-sonnet-4-5')).toBe('claude_code');
    expect(resolveCandyFingerprintIdForModel('anthropic/claude-opus-4-1')).toBe('claude_code');
  });

  it('routes GPT, o-series and Codex models to the Codex profile', () => {
    expect(resolveCandyFingerprintIdForModel('gpt-5.4')).toBe('codex');
    expect(resolveCandyFingerprintIdForModel('gpt-4.1-mini')).toBe('codex');
    expect(resolveCandyFingerprintIdForModel('o3-mini')).toBe('codex');
    expect(resolveCandyFingerprintIdForModel('codex-mini-latest')).toBe('codex');
  });

  it('falls back to the Codex chat variant for everything else', () => {
    // The aggregator reality from the production traces: deepseek/glm/kimi/grok traffic
    // arrives wearing a Codex-CLI identity on /v1/chat/completions, so the probe wears
    // that instead of a neutral SDK the channels' real traffic never uses.
    expect(resolveCandyFingerprintIdForModel('deepseek-v4.1-flash')).toBe('codex_chat');
    expect(resolveCandyFingerprintIdForModel('glm-5.3')).toBe('codex_chat');
    expect(resolveCandyFingerprintIdForModel('kimi-k3')).toBe('codex_chat');
    expect(resolveCandyFingerprintIdForModel('gemini-2.5-pro')).toBe('codex_chat');
    expect(resolveCandyFingerprintIdForModel('grok-4')).toBe('codex_chat');
    expect(resolveCandyFingerprintIdForModel('')).toBe('codex_chat');
  });
});

describe('candy fingerprints', () => {
  it('keeps the Claude Code uid in the shape metapi itself recognizes', () => {
    const userId = buildClaudeCodeUserId('1:42');
    expect(userId).toMatch(/^user_[0-9a-f]{64}_account__session_[0-9a-f-]{36}$/i);
    // Deterministic per scope: repeat runs must look like the same installation.
    expect(buildClaudeCodeUserId('1:42')).toBe(userId);
    expect(buildClaudeCodeUserId('1:43')).not.toBe(userId);
  });

  it('produces a Claude Code body that our own detector classifies as Claude Code', () => {
    const profile = getCandyFingerprint('claude_code');
    const body = profile.buildClaudeBody!({ model: 'claude-sonnet-4-5', prompt: 'hi', scopeKey: '9:1' });
    const headers = profile.buildProviderHeaders({ model: 'claude-sonnet-4-5', prompt: 'hi', scopeKey: '9:1' });

    // The emulate → detect round trip has to hold, otherwise the probe is not wearing the
    // identity it claims to wear.
    const detected = detectCliProfile({
      downstreamPath: '/v1/messages',
      headers: { ...headers, 'user-agent': BUILTIN_CLAUDE_CODE_USER_AGENT },
      body,
    });
    expect(detected.id).toBe('claude_code');
  });

  it('pins the built-in template to real releases, independent of the runtime defaults', () => {
    // Claude Code 2.1.280 is CLIProxyAPI's measured baseline; Codex 0.165.0 the current release.
    expect(BUILTIN_CLAUDE_CODE_USER_AGENT).toBe('claude-cli/2.1.280 (external, cli)');
    expect(BUILTIN_CODEX_USER_AGENT).toBe('codex_cli_rs/0.165.0 (Mac OS 26.0.1; arm64) Apple_Terminal/464');
    // The template must not follow the proxy runtime's fallback identity: that one is the
    // identity of every real proxied request and moves on its own schedule.
    expect(BUILTIN_CLAUDE_CODE_USER_AGENT).not.toBe(CLAUDE_DEFAULT_USER_AGENT);
    expect(BUILTIN_CODEX_USER_AGENT).not.toBe(CODEX_DEFAULT_USER_AGENT);

    const claude = getCandyFingerprint('claude_code').buildProviderHeaders({ model: 'claude-x', prompt: '', scopeKey: '1:1' });
    expect(claude['User-Agent']).toBe(BUILTIN_CLAUDE_CODE_USER_AGENT);
    for (const id of ['codex', 'codex_chat'] as const) {
      const codex = getCandyFingerprint(id).buildProviderHeaders({ model: 'gpt-x', prompt: '', scopeKey: '1:1' });
      expect(codex['User-Agent']).toBe(BUILTIN_CODEX_USER_AGENT);
      // The user agent's leading client name must match the originator: upstreams that gate
      // on official Codex clients reject a mismatched pair.
      expect(codex['User-Agent'].startsWith(`${codex.Originator}/`)).toBe(true);
    }
  });

  it('sends the Claude Code identity line and user id in the Claude body', () => {
    const body = CANDY_FINGERPRINTS.claude_code.buildClaudeBody!({
      model: 'claude-sonnet-4-5',
      prompt: 'Q',
      scopeKey: '2:7',
    }) as Record<string, any>;
    expect(body.stream).toBe(true);
    expect(body.system[0].text).toContain('You are Claude Code');
    expect(body.metadata.user_id).toContain('_account__session_');
    expect(body.messages[0].content[0].text).toBe('Q');
  });

  it('carries Codex identity headers and a responses-shaped body', () => {
    const profile = getCandyFingerprint('codex');
    expect(profile.downstreamFormat).toBe('responses');
    const headers = profile.buildProviderHeaders({ model: 'gpt-5.4', prompt: 'Q', scopeKey: '3:8' });
    expect(headers['User-Agent']).toBe(BUILTIN_CODEX_USER_AGENT);
    expect(headers.Originator).toBe('codex_cli_rs');
    // The shape real Codex traffic was observed to carry: a hyphenated session-id and
    // nothing else — no Version, no Conversation_id, no underscored Session_id.
    expect(headers['session-id']).toMatch(/^[0-9a-f-]{36}$/i);
    expect(Object.keys(headers).sort()).toEqual(['Originator', 'User-Agent', 'session-id']);

    const body = profile.buildResponsesBody!({ model: 'gpt-5.4', prompt: 'Q', scopeKey: '3:8' }) as Record<string, any>;
    expect(body.store).toBe(false);
    expect(body.stream).toBe(true);
    expect(body.input[0].content[0].text).toBe('Q');
  });

  it('carries a Claude Code session header in the built-in template', () => {
    const headers = getCandyFingerprint('claude_code').buildProviderHeaders({ model: 'claude-x', prompt: '', scopeKey: '9:1' });
    expect(headers['x-claude-code-session-id']).toMatch(/^[0-9a-f-]{36}$/i);
    // The same session the template user id names.
    expect(buildClaudeCodeUserId('9:1')).toContain(headers['x-claude-code-session-id']);
  });

  it('follows observed body traits instead of the template on Claude', () => {
    const body = CANDY_FINGERPRINTS.claude_code.buildClaudeBody!({
      model: 'claude-opus-5-5',
      prompt: 'Q',
      scopeKey: '2:7',
      bodyTraits: { hasTopLevelSystem: false, hasMetadataUserId: false },
      sessionId: '11111111-2222-5333-8444-555555555555',
    }) as Record<string, any>;
    expect(body.system).toBeUndefined();
    expect(body.metadata).toBeUndefined();
    expect(body.max_tokens).toBe(CANDY_PROBE_MAX_OUTPUT_TOKENS);

    const withUserId = CANDY_FINGERPRINTS.claude_code.buildClaudeBody!({
      model: 'claude-opus-5-5',
      prompt: 'Q',
      scopeKey: '2:7',
      bodyTraits: { hasTopLevelSystem: false, hasMetadataUserId: true },
      sessionId: '11111111-2222-5333-8444-555555555555',
    }) as Record<string, any>;
    // The body-level session id matches the session header the identity carries.
    expect(withUserId.metadata.user_id).toMatch(/_account__session_11111111-2222-5333-8444-555555555555$/);
  });

  it('follows observed body traits on Codex responses', () => {
    const body = CANDY_FINGERPRINTS.codex.buildResponsesBody!({
      model: 'gpt-5.6-luna',
      prompt: 'Q',
      scopeKey: '3:8',
      bodyTraits: {
        reasoningEffort: 'medium',
        include: ['reasoning.encrypted_content'],
        store: false,
        hasMaxOutputTokens: false,
        hasPromptCacheKey: true,
        parallelToolCalls: true,
      },
      sessionId: '11111111-2222-5333-8444-555555555555',
    }) as Record<string, any>;
    expect(body).toEqual({
      model: 'gpt-5.6-luna',
      instructions: '',
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Q' }] }],
      stream: true,
      reasoning: { effort: 'medium' },
      parallel_tool_calls: true,
      include: ['reasoning.encrypted_content'],
      store: false,
      prompt_cache_key: '11111111-2222-5333-8444-555555555555',
    });
  });

  it('wears the extension variant on chat: Codex identity, minimal headers, no session metadata', () => {
    const profile = getCandyFingerprint('codex_chat');
    expect(profile.downstreamFormat).toBe('openai');
    const headers = profile.buildProviderHeaders({ model: 'deepseek-v4.1-flash', prompt: 'Q', scopeKey: '5:2' });
    // Exactly the two identity headers the extension variant carries: adding
    // Session_id/Conversation_id/Version would describe a client that does not exist on
    // the chat surface.
    expect(headers['User-Agent']).toBe(BUILTIN_CODEX_USER_AGENT);
    expect(headers.Originator).toBe('codex_cli_rs');
    expect(headers.Session_id).toBeUndefined();
    expect(headers.Conversation_id).toBeUndefined();
    expect(headers.Version).toBeUndefined();

    const body = profile.buildOpenAiBody({ model: 'deepseek-v4.1-flash', prompt: 'Q', scopeKey: '5:2' }) as Record<string, any>;
    expect(body).toEqual({
      model: 'deepseek-v4.1-flash',
      messages: [{ role: 'user', content: 'Q' }],
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: CANDY_PROBE_MAX_OUTPUT_TOKENS,
    });
    expect(profile.buildClaudeBody).toBeUndefined();
    expect(profile.buildResponsesBody).toBeUndefined();
  });

  it('uses a neutral SDK profile for unmatched families, with a reasoning-sized cap', () => {
    const profile = getCandyFingerprint('generic_openai');
    expect(profile.downstreamFormat).toBe('openai');
    const body = profile.buildOpenAiBody({ model: 'deepseek-v3', prompt: 'Q', scopeKey: '4:9' }) as Record<string, any>;
    expect(body).toEqual({
      model: 'deepseek-v3',
      messages: [{ role: 'user', content: 'Q' }],
      stream: true,
      // Without this a streaming chat upstream reports no usage at all, so the probe's
      // usage-log row would show no tokens even though the run consumed some.
      stream_options: { include_usage: true },
      // The probe asks for reasoning, so the cap must leave room for it: an upstream's own
      // default is what truncates a thinking model before its `答案：` line.
      max_tokens: CANDY_PROBE_MAX_OUTPUT_TOKENS,
    });
    expect(profile.buildClaudeBody).toBeUndefined();
  });

  it('keeps the chat profile internally consistent instead of mixing identities', () => {
    const profile = getCandyFingerprint('generic_openai');
    const headers = profile.buildProviderHeaders({ model: 'deepseek-v3', prompt: 'Q', scopeKey: '4:9' });

    // A neutral SDK identity: it must NOT claim to be Codex CLI, because Codex CLI only
    // speaks /v1/responses and this profile talks /v1/chat/completions — a client that
    // cannot exist. The Node SDK markers belong with the Node SDK user agent.
    expect(headers['User-Agent']).toBe('OpenAI/JS 4.104.0');
    expect(headers.Originator).toBeUndefined();
    expect(headers.Session_id).toBeUndefined();
    expect(headers['X-Stainless-Lang']).toBe('js');
    expect(profile.label).toBe('OpenAI SDK');
  });

  it('derives the fingerprint id set from the registry', () => {
    expect([...CANDY_FINGERPRINT_IDS].sort()).toEqual(Object.keys(CANDY_FINGERPRINTS).sort());
    for (const id of CANDY_FINGERPRINT_IDS) {
      expect(isCandyFingerprintId(id)).toBe(true);
    }
    expect(isCandyFingerprintId('claude')).toBe(false);
    expect(isCandyFingerprintId(undefined)).toBe(false);
  });

  it('always streams, because both CLI clients always stream', () => {
    for (const profile of Object.values(CANDY_FINGERPRINTS)) {
      expect(profile.stream).toBe(true);
    }
  });
});
