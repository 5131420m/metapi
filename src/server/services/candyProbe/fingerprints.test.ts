import { describe, expect, it } from 'vitest';
import {
  buildClaudeCodeUserId,
  CANDY_FINGERPRINTS,
  CANDY_FINGERPRINT_IDS,
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

  it('falls back to the generic SDK profile for everything else', () => {
    expect(resolveCandyFingerprintIdForModel('gemini-2.5-pro')).toBe('generic_openai');
    expect(resolveCandyFingerprintIdForModel('grok-4')).toBe('generic_openai');
    expect(resolveCandyFingerprintIdForModel('deepseek-v3')).toBe('generic_openai');
    expect(resolveCandyFingerprintIdForModel('')).toBe('generic_openai');
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

  it('uses the Codex CLI-disguised chat profile for unmatched families, with no token cap', () => {
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
    });
    expect(profile.buildClaudeBody).toBeUndefined();
  });

  it('disguises the chat profile as Codex CLI, without contradictory SDK markers', () => {
    const profile = getCandyFingerprint('generic_openai');
    const headers = profile.buildProviderHeaders({ model: 'deepseek-v3', prompt: 'Q', scopeKey: '4:9' });

    expect(headers['User-Agent']).toBe(CODEX_DEFAULT_USER_AGENT);
    expect(headers.Originator).toBe('codex_cli_rs');
    expect(headers.Version).toBe(CODEX_CLIENT_VERSION);
    // `X-Stainless-*` are Node SDK markers; next to a Rust CLI user agent they describe a
    // client that cannot exist, which is exactly what a relay fingerprints.
    expect(Object.keys(headers).filter((key) => key.startsWith('X-Stainless'))).toEqual([]);
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
