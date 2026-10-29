import { describe, expect, it } from 'vitest';
import { act, create } from 'react-test-renderer';
import IdentityProbeDetailModal from './IdentityProbeDetailModal.js';
import type { CandyProbeSnapshot, IdentityProbeResult } from '../types.js';

function buildResult(overrides: Partial<IdentityProbeResult> = {}): IdentityProbeResult {
  const top = { model: 'gemini-2.5-pro', displayName: 'gemini-2.5-pro', family: 'gemini', familyName: 'Gemini', probability: 0.82 };
  return {
    channelId: 301,
    routeId: 88,
    model: 'claude-opus-4-6',
    verdict: 'mismatch',
    reason: '最像 gemini-2.5-pro（82%），与声称的 Claude 家族不符',
    decision: 'scored',
    prediction: top,
    candidates: [
      top,
      { model: 'claude-opus-4.6', displayName: 'claude-opus-4.6', family: 'claude', familyName: 'Claude', probability: 0.1 },
    ],
    probability: 0.82,
    probabilityStatus: 'reference_calibrated',
    claimedModel: 'claude-opus-4.6',
    claimedFamily: 'claude',
    claimedFamilyName: 'Claude',
    claimedRank: 2,
    claimedProbability: 0.1,
    modelLike: true,
    usedOutputs: 3,
    samples: [
      { index: 1, state: 'complete', count: 301, expectedCount: 301, accepted: true, responseModel: 'x', latencyMs: 10, error: null },
      { index: 2, state: 'failed', count: 0, expectedCount: 320, accepted: false, responseModel: null, latencyMs: 10, error: 'HTTP 429' },
    ],
    requestFormat: 'claude',
    endpoint: 'messages',
    actualModel: 'x',
    latencyMs: 61_000,
    checkedAt: new Date().toISOString(),
    config: { model: 'claude-opus-4-6', accountId: 1, tokenId: 2, bankBuiltAt: '2026-10-24T14:34:42.076881+00:00' },
    trigger: 'manual',
    ...overrides,
  };
}

function render(props: Partial<Parameters<typeof IdentityProbeDetailModal>[0]> = {}) {
  let root!: WebTestRenderer;
  void act(() => {
    root = create(<IdentityProbeDetailModal open onClose={() => undefined} result={buildResult()} {...props} />);
  });
  return root;
}

function allText(root: WebTestRenderer): string {
  return root.root.findAll((node) => typeof node.type === 'string')
    .map((node) => node.children.filter((child) => typeof child === 'string').join(''))
    .join('|');
}

describe('IdentityProbeDetailModal', () => {
  it('shows the verdict, the candidates and every sample', () => {
    const root = render();
    const text = allText(root);
    expect(text).toContain('疑似换皮');
    expect(text).toContain('gemini-2.5-pro');
    expect(text).toContain('claude-opus-4.6');
    expect(text).toContain('HTTP 429');
    expect(text).toContain('第 2 名（10%）');
    expect(text).toContain('不是身份证明');
  });

  it('adds the combined reading when a fresh candy verdict is present', () => {
    const candy = { verdict: 'pass', expectation: 'expected', fresh: true } as CandyProbeSnapshot;
    const root = render({ candy });
    const box = root.root.findAll((node) => node.props?.['data-testid'] === 'probe-combined-summary');
    expect(box).toHaveLength(1);
    expect(allText(root)).toContain('挂名');
  });

  it('omits the combined reading without a candy verdict', () => {
    const root = render({ candy: null });
    expect(root.root.findAll((node) => node.props?.['data-testid'] === 'probe-combined-summary')).toHaveLength(0);
  });

  it('shows the empty state without a result', () => {
    const root = render({ result: null });
    expect(allText(root)).toContain('还没有模型指纹检测结果');
  });
});
