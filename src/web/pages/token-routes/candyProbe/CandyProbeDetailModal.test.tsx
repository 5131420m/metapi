import { describe, expect, it } from 'vitest';
import { act, create } from 'react-test-renderer';
import CandyProbeDetailModal from './CandyProbeDetailModal.js';
import type { CandyProbeResult } from '../types.js';

function buildResult(overrides: Partial<CandyProbeResult> = {}): CandyProbeResult {
  return {
    channelId: 301,
    routeId: 88,
    model: 'claude-sonnet-4-5',
    fingerprint: 'claude_code',
    verdict: 'pass',
    score: 1,
    total: 1,
    endpoint: 'messages',
    actualModel: 'claude-sonnet-4-5-20250929',
    latencyMs: 900,
    checkedAt: new Date().toISOString(),
    reason: null,
    question: {
      id: 'candy-bag-reference',
      prompt: '在一个黑色的袋子里放有三种口味的糖果…',
      expected: '21',
    },
    samples: [{ index: 1, answer: '答案：21', correct: true, note: null }],
    validSampleCount: 1,
    expectation: 'expected',
    trigger: 'manual',
    ...overrides,
  };
}

function renderModal(result: CandyProbeResult | null) {
  let root!: WebTestRenderer;
  void act(() => {
    root = create(
      <CandyProbeDetailModal open onClose={() => undefined} result={result} />,
    );
  });
  return root;
}

function collectNodeText(node: { children: unknown[] }): string {
  return (node.children || [])
    .map((child) => {
      if (typeof child === 'string') return child;
      if (child && typeof child === 'object' && Array.isArray((child as { children?: unknown[] }).children)) {
        return collectNodeText(child as { children: unknown[] });
      }
      return '';
    })
    .join('');
}

/** The answer card's symbol span: bold, fontSize 11, carrying exactly the symbol text. */
function findSymbol(root: WebTestRenderer, symbol: string) {
  return root.root.findAll((node) => (
    typeof node.type === 'string'
    && node.type === 'span'
    && node.props.style?.fontWeight === 600
    && collectNodeText(node) === symbol
  ))[0];
}

describe('CandyProbeDetailModal answer card', () => {
  it('marks a pass with a check in the primary tone', () => {
    const root = renderModal(buildResult());
    const symbol = findSymbol(root, '✓');
    expect(symbol).toBeTruthy();
    expect(symbol?.props.style.color).toBe('var(--color-primary)');
  });

  it('marks an expected model\'s wrong answer with a cross in the danger tone', () => {
    const root = renderModal(buildResult({
      verdict: 'fail',
      score: 0,
      expectation: 'expected',
      samples: [{ index: 1, answer: '答案：20', correct: false, note: null }],
    }));
    const symbol = findSymbol(root, '✗');
    expect(symbol).toBeTruthy();
    expect(symbol?.props.style.color).toBe('var(--color-danger)');
  });

  it('marks a model without a baseline with a cross in the warning tone, not danger', () => {
    const root = renderModal(buildResult({
      verdict: 'fail',
      score: 0,
      expectation: 'reference-only',
      samples: [{ index: 1, answer: '答案：20', correct: false, note: null }],
    }));
    const symbol = findSymbol(root, '✗');
    expect(symbol).toBeTruthy();
    expect(symbol?.props.style.color).toBe('var(--color-warning)');
  });

  it('marks an inconclusive run with a question mark, never like a wrong answer', () => {
    // The answer text WAS read (an ambiguous line), but the run could not be graded:
    // a red ✗ here would read as 答错, which it is not.
    const root = renderModal(buildResult({
      verdict: 'inconclusive',
      score: 0,
      validSampleCount: 0,
      reason: '答案为 20 或 21',
      samples: [{ index: 1, answer: '答案：20 或 21', correct: false, note: null }],
    }));
    const symbol = findSymbol(root, '?');
    expect(symbol).toBeTruthy();
    expect(symbol?.props.style.color).toBe('var(--color-warning)');
    expect(findSymbol(root, '✗')).toBeFalsy();
  });

  it('says so when nothing readable came back', () => {
    const root = renderModal(buildResult({
      verdict: 'inconclusive',
      score: 0,
      validSampleCount: 0,
      reason: '上游返回 502',
      samples: [{ index: 1, answer: '', correct: false, note: '上游返回 502' }],
    }));
    const empty = root.root.findAll((node) => (
      typeof node.type === 'string'
        && collectNodeText(node).includes('本次探测没有拿到可判读的回答')
    ))[0];
    expect(empty).toBeTruthy();
  });
});
