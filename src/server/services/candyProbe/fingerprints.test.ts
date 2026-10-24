import { describe, expect, it } from 'vitest';
import {
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
  CODEX_CLIENT_VERSION,
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
      headers: { ...headers, 'user-agent': CLAUDE_DEFAULT_USER_AGENT },
      body,
    });
    expect(detected.id).toBe('claude_code');
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
    expect(headers['User-Agent']).toBe(CODEX_DEFAULT_USER_AGENT);
    expect(headers.Originator).toBe('codex_cli_rs');
    expect(headers.Session_id).toMatch(/^[0-9a-f-]{36}$/i);

    const body = profile.buildResponsesBody!({ model: 'gpt-5.4', prompt: 'Q', scopeKey: '3:8' }) as Record<string, any>;
    expect(body.store).toBe(false);
    expect(body.stream).toBe(true);
    expect(body.input[0].content[0].text).toBe('Q');
  });

  it('wears the extension variant on chat: Codex identity, minimal headers, no session metadata', () => {
    const profile = getCandyFingerprint('codex_chat');
    expect(profile.downstreamFormat).toBe('openai');
    const headers = profile.buildProviderHeaders({ model: 'deepseek-v4.1-flash', prompt: 'Q', scopeKey: '5:2' });
    // Exactly the two identity headers the extension variant carries: adding
    // Session_id/Conversation_id/Version would describe a client that does not exist on
    // the chat surface.
    expect(headers['User-Agent']).toBe(CODEX_DEFAULT_USER_AGENT);
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
