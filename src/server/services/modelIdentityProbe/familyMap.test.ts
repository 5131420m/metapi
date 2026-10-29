import { describe, expect, it } from 'vitest';
import {
  IDENTITY_FAMILY_PATTERNS,
  identityModelLineKey,
  isSameIdentityModelLine,
  normalizeIdentityModelKey,
  resolveClaimedIdentity,
  resolveIdentityFamilyByName,
} from './familyMap.js';

/**
 * The family ids of the reference bank built 2026-10-24 (read from the loaded bank). If the
 * bank adds or renames a family, update this list and the pattern table together.
 */
const BANK_FAMILIES = [
  'claude', 'gpt', 'gemini', 'grok', 'glm', 'qwen', 'kimi',
  'hunyuan', 'muse', 'mimo', 'step', 'deepseek', 'seed',
];

describe('normalizeIdentityModelKey', () => {
  it('drops vendor prefixes, dates and -latest, and dots versions', () => {
    expect(normalizeIdentityModelKey('anthropic/claude-opus-4-6')).toBe('claude-opus-4.6');
    expect(normalizeIdentityModelKey('claude-sonnet-4-6-20260101')).toBe('claude-sonnet-4.6');
    expect(normalizeIdentityModelKey('gemini-2.5-pro-latest')).toBe('gemini-2.5-pro');
    expect(normalizeIdentityModelKey('GPT-5.5')).toBe('gpt-5.5');
    expect(normalizeIdentityModelKey('deepseek-v4-pro-2026-08-13')).toBe('deepseek-v4-pro');
  });

  it('leaves single numbers and non-version hyphens alone', () => {
    expect(normalizeIdentityModelKey('kimi-k3')).toBe('kimi-k3');
    expect(normalizeIdentityModelKey('qwen3.8-27b')).toBe('qwen3.8-27b');
  });
});

describe('identityModelLineKey', () => {
  it('folds dated snapshots onto their model line', () => {
    expect(identityModelLineKey('deepseek-v4.1-flash-1017')).toBe('deepseek-v4.1-flash');
    expect(identityModelLineKey('deepseek-v4-flash-0731')).toBe('deepseek-v4-flash');
    expect(identityModelLineKey('deepseek-v4-pro-0813')).toBe('deepseek-v4-pro');
    expect(identityModelLineKey('qwen3.8-max-0902')).toBe('qwen3.8-max');
  });

  it('keeps different versions apart', () => {
    expect(identityModelLineKey('deepseek-v4-flash')).not.toBe(identityModelLineKey('deepseek-v4.1-flash-1017'));
  });

  it('leaves four digits that are not a month-day alone', () => {
    expect(identityModelLineKey('model-2048')).toBe('model-2048');
    expect(identityModelLineKey('model-1340')).toBe('model-1340');
  });
});

describe('isSameIdentityModelLine', () => {
  it('compares by line, spelling-insensitive', () => {
    expect(isSameIdentityModelLine('deepseek-v4.1-flash-1017', 'deepseek-v4-1-flash')).toBe(true);
    expect(isSameIdentityModelLine('deepseek-v4.1-flash-1017', 'deepseek-v4-flash')).toBe(false);
    expect(isSameIdentityModelLine('x', '')).toBe(false);
  });
});

describe('resolveIdentityFamilyByName', () => {
  it.each([
    ['claude-sonnet-4-5', 'claude'],
    ['gpt-5.4', 'gpt'],
    ['o3-mini', 'gpt'],
    ['gpt-5-codex', 'gpt'],
    ['gemini-3.1-pro-preview', 'gemini'],
    ['grok-4.5', 'grok'],
    ['deepseek-chat', 'deepseek'],
    ['qwen3.8-max', 'qwen'],
    ['glm-5.3', 'glm'],
    ['moonshot-v1-8k', 'kimi'],
    ['hunyuan-turbo', 'hunyuan'],
    ['mimo-v2.5-pro', 'mimo'],
    ['doubao-seed-2.0', 'seed'],
  ])('%s → %s', (name, family) => {
    expect(resolveIdentityFamilyByName(name)).toBe(family);
  });

  it('returns null for names outside the bank', () => {
    expect(resolveIdentityFamilyByName('llama-3.1-70b')).toBeNull();
    expect(resolveIdentityFamilyByName('mistral-large')).toBeNull();
    expect(resolveIdentityFamilyByName('')).toBeNull();
  });

  it('only targets family ids that exist in the reference bank', () => {
    for (const entry of IDENTITY_FAMILY_PATTERNS) {
      expect(BANK_FAMILIES).toContain(entry.family);
    }
  });
});

describe('resolveClaimedIdentity', () => {
  const candidates = [
    { model: 'gemini-2.5-pro', family: 'gemini', family_name: 'Gemini' },
    { model: 'claude-opus-4.6', family: 'claude', family_name: 'Claude' },
    { model: 'gpt-5.4', family: 'gpt', family_name: 'GPT' },
  ];

  it('resolves an exact bank model with its rank', () => {
    expect(resolveClaimedIdentity('claude-opus-4-6', candidates)).toEqual({
      claimedModel: 'claude-opus-4.6',
      claimedFamily: 'claude',
      claimedFamilyName: 'Claude',
      claimedRank: 2,
      claimedProbability: null,
      claimedFamilyInBank: true,
    });
  });

  it('falls back to the family when the exact model is not in the bank', () => {
    expect(resolveClaimedIdentity('gpt-5.9-preview', candidates)).toEqual({
      claimedModel: null,
      claimedFamily: 'gpt',
      claimedFamilyName: 'GPT',
      claimedRank: null,
      claimedProbability: null,
      claimedFamilyInBank: true,
    });
  });

  it('finds the claim through a dated snapshot and sums the line probability', () => {
    const ranked = [
      { model: 'deepseek-v4.1-flash-1017', family: 'deepseek', family_name: 'DeepSeek', probability: 0.8886 },
      { model: 'deepseek-v4.1-flash', family: 'deepseek', family_name: 'DeepSeek', probability: 0.0854 },
      { model: 'deepseek-v4-flash', family: 'deepseek', family_name: 'DeepSeek', probability: 0.001 },
    ];
    const result = resolveClaimedIdentity('deepseek-v4.1-flash', ranked);
    expect(result.claimedRank).toBe(1);
    expect(result.claimedModel).toBe('deepseek-v4.1-flash-1017');
    expect(result.claimedProbability).toBeCloseTo(0.974, 3);
    expect(resolveClaimedIdentity('deepseek-v4-flash', ranked).claimedRank).toBe(3);
  });

  it('marks a recognised family as not in the bank when no candidate carries it', () => {
    const result = resolveClaimedIdentity('grok-4.5', candidates);
    expect(result.claimedFamily).toBe('grok');
    expect(result.claimedFamilyInBank).toBe(false);
  });

  it('reports nothing for a name outside every family', () => {
    expect(resolveClaimedIdentity('llama-3.1-70b', candidates)).toEqual({
      claimedModel: null,
      claimedFamily: null,
      claimedFamilyName: null,
      claimedRank: null,
      claimedProbability: null,
      claimedFamilyInBank: false,
    });
  });
});
