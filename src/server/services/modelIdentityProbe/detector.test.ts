import { describe, expect, it } from 'vitest';
import {
  buildIdentityRequestBody,
  generateIdentityChallenges,
  minimumIdentityNumbers,
  parseIdentityNumbers,
} from './detector.js';

/**
 * These run the real SDK (no network: none of these functions load reference data). The body
 * snapshots exist so an SDK upgrade that changes what is sent shows up as a diff here — the
 * body is part of the sampling environment the reference bank was built in.
 */
describe('identity detector adapter', () => {
  it('builds the SDK chat body', () => {
    expect(buildIdentityRequestBody('openai', 'm', 'PROMPT')).toEqual({
      model: 'm',
      messages: [{ role: 'user', content: 'PROMPT' }],
      stream: true,
      stream_options: { include_usage: true },
    });
  });

  it('builds the SDK messages body', () => {
    expect(buildIdentityRequestBody('claude', 'm', 'PROMPT')).toEqual({
      model: 'm',
      messages: [{ role: 'user', content: 'PROMPT' }],
      max_tokens: 8192,
      stream: true,
    });
  });

  it('builds the SDK responses body', () => {
    expect(buildIdentityRequestBody('responses', 'm', 'PROMPT')).toEqual({
      model: 'm',
      input: [{ role: 'user', content: 'PROMPT' }],
      stream: true,
      store: false,
    });
  });

  it('returns a fresh body each time (callers may not share mutations)', () => {
    const first = buildIdentityRequestBody('openai', 'm', 'PROMPT');
    (first.messages as Array<{ content: string }>)[0]!.content = 'changed';
    expect((buildIdentityRequestBody('openai', 'm', 'PROMPT').messages as Array<{ content: string }>)[0]!.content)
      .toBe('PROMPT');
  });

  it('generates three challenges with distinct counts in 292–332', () => {
    const challenges = generateIdentityChallenges();
    expect(challenges).toHaveLength(3);
    const counts = challenges.map((challenge) => challenge.expected_count);
    expect(new Set(counts).size).toBe(3);
    for (const count of counts) {
      expect(count).toBeGreaterThanOrEqual(292);
      expect(count).toBeLessThanOrEqual(332);
    }
    for (const challenge of challenges) expect(challenge.prompt).toContain(String(challenge.expected_count));
  });

  it('parses the longest 1–355 run', () => {
    expect(parseIdentityNumbers('a 1, 2, 300 x 5 6 7 8')).toEqual([5, 6, 7, 8]);
  });

  it('states the minimum the SDK requires', () => {
    expect(minimumIdentityNumbers(100)).toBe(80);
    expect(minimumIdentityNumbers(300)).toBe(165);
  });
});
