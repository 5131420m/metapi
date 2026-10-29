import { describe, expect, it, vi } from 'vitest';
import { act, create } from 'react-test-renderer';
import { DndContext } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { SortableChannelRow } from './SortableChannelRow.js';
import type { IdentityProbeSnapshot, RouteChannel } from './types.js';

function buildChannel(overrides: Partial<RouteChannel> = {}): RouteChannel {
  return {
    id: 301,
    routeId: 88,
    accountId: 7,
    tokenId: null,
    sourceModel: 'claude-opus-4-6',
    priority: 0,
    weight: 100,
    enabled: true,
    manualOverride: true,
    successCount: 12,
    failCount: 1,
    cooldownUntil: null,
    account: { username: 'cc', accessToken: null, extraConfig: null, credentialMode: 'apikey' },
    site: { id: 99, name: 'relay', platform: 'new-api' },
    token: null,
    ...overrides,
  };
}

function buildSnapshot(overrides: Partial<IdentityProbeSnapshot> = {}): IdentityProbeSnapshot {
  return {
    channelId: 301,
    routeId: 88,
    model: 'claude-opus-4-6',
    verdict: 'mismatch',
    reason: '最像 gemini-2.5-pro（82%）',
    decision: 'scored',
    prediction: { model: 'gemini-2.5-pro', displayName: 'gemini-2.5-pro', family: 'gemini', familyName: 'Gemini', probability: 0.82 },
    probability: 0.82,
    probabilityStatus: 'reference_calibrated',
    claimedModel: 'claude-opus-4.6',
    claimedFamily: 'claude',
    claimedFamilyName: 'Claude',
    claimedRank: 2,
    claimedProbability: 0.1,
    modelLike: true,
    usedOutputs: 3,
    requestFormat: 'claude',
    endpoint: 'messages',
    actualModel: null,
    latencyMs: 60_000,
    checkedAt: new Date().toISOString(),
    config: { model: 'claude-opus-4-6', accountId: 7, tokenId: null, bankBuiltAt: 'bank' },
    trigger: 'manual',
    fresh: true,
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    ...overrides,
  };
}

function renderRow(channel: RouteChannel, handlers: {
  onRunIdentityProbe?: () => void;
  onOpenIdentityProbeDetail?: () => void;
  identityProbeTesting?: boolean;
} = {}) {
  let root!: WebTestRenderer;
  void act(() => {
    root = create(
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
            identityProbeTesting={handlers.identityProbeTesting}
            onRunIdentityProbe={handlers.onRunIdentityProbe}
            onOpenIdentityProbeDetail={handlers.onOpenIdentityProbeDetail}
          />
        </SortableContext>
      </DndContext>,
    );
  });
  return root;
}

function textOf(node: { children: unknown[] }): string {
  return node.children.map((child) => (typeof child === 'string' ? child : '')).join('');
}

function findButtons(root: WebTestRenderer, label: string) {
  return root.root.findAll((node) => node.type === 'button' && textOf(node).includes(label));
}

describe('SortableChannelRow model fingerprint probe', () => {
  it('offers the run button and calls the handler', () => {
    const onRun = vi.fn();
    const root = renderRow(buildChannel(), { onRunIdentityProbe: onRun });
    const buttons = findButtons(root, '测身份');
    expect(buttons.length).toBeGreaterThan(0);
    void act(() => buttons[0]!.props.onClick());
    expect(onRun).toHaveBeenCalledTimes(1);
  });

  it('disables the button while a run is going', () => {
    const root = renderRow(buildChannel(), { onRunIdentityProbe: vi.fn(), identityProbeTesting: true });
    const buttons = findButtons(root, '检测中');
    expect(buttons.length).toBeGreaterThan(0);
    expect(buttons[0]!.props.disabled).toBe(true);
  });

  it('hides the button for channels that cannot be probed', () => {
    const root = renderRow(buildChannel({ candyProbeApplicable: false }), { onRunIdentityProbe: vi.fn() });
    expect(findButtons(root, '测身份')).toHaveLength(0);
  });

  it('shows no badge before the first run', () => {
    const root = renderRow(buildChannel());
    expect(findButtons(root, '🔍')).toHaveLength(0);
  });

  it('shows the verdict badge and opens the detail on click', () => {
    const onOpen = vi.fn();
    const root = renderRow(buildChannel({ identityProbe: buildSnapshot() }), { onOpenIdentityProbeDetail: onOpen });
    const badges = findButtons(root, '🔍 疑似换皮');
    expect(badges.length).toBeGreaterThan(0);
    expect(String(badges[0]!.props['data-tooltip'])).toContain('gemini-2.5-pro');
    void act(() => badges[0]!.props.onClick({ stopPropagation: () => undefined }));
    expect(onOpen).toHaveBeenCalled();
  });

  it('dims a stale verdict', () => {
    const root = renderRow(buildChannel({ identityProbe: buildSnapshot({ verdict: 'model_match', fresh: false }) }));
    const badge = findButtons(root, '🔍 型号一致')[0]!;
    expect(badge.props.style.opacity).toBe(0.6);
  });
});
