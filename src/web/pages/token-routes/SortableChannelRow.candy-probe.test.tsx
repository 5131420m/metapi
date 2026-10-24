import { describe, expect, it, vi } from 'vitest';
import { create } from 'react-test-renderer';
import { DndContext } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { SortableChannelRow } from './SortableChannelRow.js';
import type { CandyProbeSnapshot, RouteChannel } from './types.js';

function buildChannel(overrides: Partial<RouteChannel> = {}): RouteChannel {
  return {
    id: 301,
    routeId: 88,
    accountId: 7,
    tokenId: null,
    sourceModel: 'claude-sonnet-4-5',
    priority: 0,
    weight: 100,
    enabled: true,
    manualOverride: true,
    successCount: 12,
    failCount: 1,
    cooldownUntil: null,
    account: {
      username: 'cc',
      accessToken: null,
      extraConfig: null,
      credentialMode: 'oauth',
    },
    site: {
      id: 99,
      name: 'codelab',
      platform: 'openai',
    },
    token: null,
    ...overrides,
  };
}

function buildProbe(overrides: Partial<CandyProbeSnapshot> = {}): CandyProbeSnapshot {
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
    validSampleCount: 1,
    expectation: 'expected',
    fresh: true,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    ...overrides,
  };
}

function renderRow(channel: RouteChannel, handlers: {
  onRunCandyProbe?: () => void;
  onOpenCandyProbeDetail?: () => void;
  candyProbeTesting?: boolean;
} = {}) {
  return create(
    <DndContext>
      <SortableContext items={[channel.id]} strategy={verticalListSortingStrategy}>
        <SortableChannelRow
          channel={channel}
          decisionCandidate={undefined}
          isExactRoute
          loadingDecision={false}
          isSavingPriority={false}
          tokenOptions={[{ id: 501, name: 'shared-token', isDefault: true }]}
          activeTokenId={0}
          isUpdatingToken={false}
          onTokenDraftChange={vi.fn()}
          onSaveToken={vi.fn()}
          onDeleteChannel={vi.fn()}
          onToggleEnabled={vi.fn()}
          onSiteBlockModel={vi.fn()}
          candyProbeTesting={handlers.candyProbeTesting}
          onRunCandyProbe={handlers.onRunCandyProbe}
          onOpenCandyProbeDetail={handlers.onOpenCandyProbeDetail}
        />
      </SortableContext>
    </DndContext>,
  );
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

function findButton(root: ReturnType<typeof renderRow>, text: string) {
  return root.root.findAll((node) => (
    typeof node.type === 'string'
    && node.type === 'button'
    && collectNodeText(node).includes(text)
  ))[0];
}

function findNodeText(root: ReturnType<typeof renderRow>, text: string) {
  return root.root.findAll((node) => (
    typeof node.type === 'string'
    && collectNodeText(node).includes(text)
  ))[0];
}

describe('SortableChannelRow candy probe marker', () => {
  it('shows an explicit "not tested" state instead of hiding the feature', () => {
    const root = renderRow(buildChannel());
    expect(findNodeText(root, '🍬 未测')).toBeTruthy();
  });

  it('renders a pass marker without a tally', () => {
    const root = renderRow(buildChannel({ candyProbe: buildProbe() }));
    const badge = findButton(root, '🍬 通过');
    expect(badge).toBeTruthy();
    expect(badge?.props.style.color).toBe('var(--color-primary)');
  });

  it('renders a degradation marker in the danger tone', () => {
    const root = renderRow(buildChannel({
      candyProbe: buildProbe({ verdict: 'fail', score: 0, reason: '答案为 20' }),
    }));
    const badge = findButton(root, '🍬 疑似降智');
    expect(badge).toBeTruthy();
    expect(badge?.props.style.color).toBe('var(--color-danger)');
    expect(String(badge?.props['data-tooltip'])).toContain('答案为 20');
  });

  it('renders a plain wrong answer in the warning tone for models without a baseline', () => {
    const root = renderRow(buildChannel({
      candyProbe: buildProbe({ verdict: 'fail', score: 0, expectation: 'reference-only', reason: '答案为 20' }),
    }));
    const badge = findButton(root, '🍬 答错');
    expect(badge).toBeTruthy();
    expect(badge?.props.style.color).toBe('var(--color-warning)');
  });

  it('renders an inconclusive marker in the warning tone', () => {
    const root = renderRow(buildChannel({
      candyProbe: buildProbe({ verdict: 'inconclusive', score: 0, reason: '上游返回 404' }),
    }));
    const badge = findButton(root, '🍬 未完成');
    expect(badge).toBeTruthy();
    expect(badge?.props.style.color).toBe('var(--color-warning)');
  });

  it('dims a stale verdict and says so in the tooltip', () => {
    const root = renderRow(buildChannel({
      candyProbe: buildProbe({ fresh: false, checkedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString() }),
    }));
    const badge = findButton(root, '🍬 通过');
    expect(badge?.props.style.opacity).toBe(0.6);
    expect(String(badge?.props['data-tooltip'])).toContain('已过期');
  });

  it('says where the verdict came from and how long it stays fresh', () => {
    const scheduled = renderRow(buildChannel({
      candyProbe: buildProbe({ trigger: 'schedule' }),
    }));
    const scheduleTooltip = String(findButton(scheduled, '🍬 通过')?.props['data-tooltip']);
    expect(scheduleTooltip).toContain('来源 巡检');
    expect(scheduleTooltip).toContain('有效至');

    const manual = renderRow(buildChannel({ candyProbe: buildProbe() }));
    expect(String(findButton(manual, '🍬 通过')?.props['data-tooltip'])).toContain('来源 手动');
  });

  it('hides the marker for a channel the probe cannot test', () => {
    // An embedding channel can never run the question, so "未测" would read as a todo for
    // something that is never going to happen.
    const untested = renderRow(buildChannel({ candyProbeApplicable: false }));
    expect(findNodeText(untested, '🍬 未测')).toBeFalsy();

    // Even a stored verdict must not show once the model changed to something untestable.
    const previouslyTested = renderRow(buildChannel({
      candyProbeApplicable: false,
      candyProbe: buildProbe(),
    }));
    expect(findButton(previouslyTested, '🍬 通过')).toBeFalsy();
  });

  it('opens the detail panel when the marker is clicked', () => {
    const onOpen = vi.fn();
    const root = renderRow(buildChannel({ candyProbe: buildProbe() }), { onOpenCandyProbeDetail: onOpen });
    findButton(root, '🍬 通过')?.props.onClick({ stopPropagation: vi.fn() });
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('does not open a detail panel when there is no verdict yet', () => {
    const onOpen = vi.fn();
    const root = renderRow(buildChannel(), { onOpenCandyProbeDetail: onOpen });
    // The "not tested" marker is a plain span, not a clickable badge.
    expect(findButton(root, '🍬 未测')).toBeFalsy();
    expect(onOpen).not.toHaveBeenCalled();
  });
});

describe('SortableChannelRow candy probe action', () => {
  it('renders the probe button and triggers the handler', () => {
    const onRun = vi.fn();
    const root = renderRow(buildChannel(), { onRunCandyProbe: onRun });
    const button = findButton(root, '🍬 测智商');
    expect(button).toBeTruthy();
    button?.props.onClick();
    expect(onRun).toHaveBeenCalledTimes(1);
  });

  it('shows progress and disables the button while a probe runs', () => {
    const root = renderRow(buildChannel(), { onRunCandyProbe: vi.fn(), candyProbeTesting: true });
    const button = findButton(root, '测试中...');
    expect(button).toBeTruthy();
    expect(button?.props.disabled).toBe(true);
  });

  it('hides the probe button when the channel is not applicable', () => {
    // RouteCard already withholds the handler for inapplicable channels; the row re-checks
    // so its own contract cannot be broken by a future caller forgetting that gate.
    const root = renderRow(buildChannel({ candyProbeApplicable: false }), { onRunCandyProbe: vi.fn() });
    expect(findButton(root, '🍬 测智商')).toBeFalsy();
  });

  it('hides the probe button when the row is read-only', () => {
    const root = create(
      <DndContext>
        <SortableContext items={[301]} strategy={verticalListSortingStrategy}>
          <SortableChannelRow
            channel={buildChannel()}
            decisionCandidate={undefined}
            isExactRoute
            loadingDecision={false}
            isSavingPriority={false}
            readOnly
            tokenOptions={[]}
            activeTokenId={0}
            isUpdatingToken={false}
            onTokenDraftChange={vi.fn()}
            onSaveToken={vi.fn()}
            onDeleteChannel={vi.fn()}
            onToggleEnabled={vi.fn()}
            onRunCandyProbe={vi.fn()}
          />
        </SortableContext>
      </DndContext>,
    );
    expect(findButton(root, '🍬 测智商')).toBeFalsy();
  });
});
