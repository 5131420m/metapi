import { describe, expect, it, vi } from 'vitest';
import { create } from 'react-test-renderer';
import { DndContext } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { SortableChannelRow } from './SortableChannelRow.js';
import type { RouteChannel } from './types.js';

function buildChannel(overrides: Partial<RouteChannel> = {}): RouteChannel {
  return {
    id: 301,
    routeId: 88,
    accountId: 7,
    tokenId: null,
    sourceModel: 'gpt-4.1',
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

function renderRow(channel: RouteChannel) {
  return create(
    <DndContext>
      <SortableContext items={[channel.id]} strategy={verticalListSortingStrategy}>
        <SortableChannelRow
          channel={channel}
          decisionCandidate={undefined}
          isExactRoute
          loadingDecision={false}
          isSavingPriority={false}
          tokenOptions={[
            {
              id: 501,
              name: 'shared-token',
              isDefault: true,
            },
          ]}
          activeTokenId={0}
          isUpdatingToken={false}
          onTokenDraftChange={vi.fn()}
          onSaveToken={vi.fn()}
          onDeleteChannel={vi.fn()}
          onToggleEnabled={vi.fn()}
          onSiteBlockModel={vi.fn()}
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

function collectBadgeTexts(root: ReturnType<typeof renderRow>): string[] {
  return root.root
    .findAll((node) => typeof node.type === 'string' && node.type === 'span' && String(node.props.className || '').includes('badge'))
    .map((node) => collectNodeText(node))
    .filter((text) => text.length > 0);
}

describe('SortableChannelRow channel quality badges', () => {
  it('renders measured first-byte, throughput and the merged recent-window stats badge', () => {
    const channel = buildChannel({
      quality: {
        firstByteEmaMs: 320,
        firstByteSampleCount: 12,
        tpsEma: 42.5,
        tpsSampleCount: 9,
        recentSuccessCount: 39,
        recentFailureCount: 1,
        recentSuccessRate: 0.983,
        recentSampleCount: 40,
        lastUpdatedAtMs: Date.now(),
      },
    });
    const root = renderRow(channel);
    const badgeTexts = collectBadgeTexts(root);
    expect(badgeTexts.some((text) => text.includes('首字 320ms'))).toBe(true);
    expect(badgeTexts.some((text) => text.includes('速度 42.5tps'))).toBe(true);
    // Merged badge: recent-window counts and rate, one shared timescale.
    expect(badgeTexts.some((text) => text.includes('成功率39/1/98%'))).toBe(true);
    // The lifetime counters must NOT leak into the badge.
    expect(badgeTexts.some((text) => text.includes('成功率12/1'))).toBe(false);
  });

  it('renders em-dash quality badges with zeroed recent-window counts', () => {
    const channel = buildChannel({
      quality: {
        firstByteEmaMs: null,
        firstByteSampleCount: 0,
        tpsEma: null,
        tpsSampleCount: 0,
        recentSuccessCount: 0,
        recentFailureCount: 0,
        recentSuccessRate: null,
        recentSampleCount: 0,
        lastUpdatedAtMs: null,
      },
    });
    const root = renderRow(channel);
    const badgeTexts = collectBadgeTexts(root);
    expect(badgeTexts.some((text) => text.includes('首字 —'))).toBe(true);
    expect(badgeTexts.some((text) => text.includes('速度 —'))).toBe(true);
    expect(badgeTexts.some((text) => text.includes('成功率0/0/—'))).toBe(true);
  });

  it('renders an all-em-dash merged badge when the payload carries no quality field', () => {
    const root = renderRow(buildChannel());
    const badgeTexts = collectBadgeTexts(root);
    expect(badgeTexts.some((text) => text.includes('首字'))).toBe(false);
    expect(badgeTexts.some((text) => text.includes('速度'))).toBe(false);
    expect(badgeTexts.some((text) => text.includes('成功率—/—'))).toBe(true);
  });

  it('anchors the quality strip in the row header and not on the probability line', () => {
    const channel = buildChannel({
      quality: {
        firstByteEmaMs: 200,
        firstByteSampleCount: 10,
        tpsEma: null,
        tpsSampleCount: 0,
        recentSuccessCount: 3,
        recentFailureCount: 0,
        recentSuccessRate: null,
        recentSampleCount: 3,
        lastUpdatedAtMs: Date.now(),
      },
    });
    const root = renderRow(channel);
    // The strip container carries the auto margin that pins it to the row's right edge.
    const strip = root.root.findAll((node) => (
      typeof node.type === 'string' && node.type === 'div'
      && node.props.style?.marginLeft === 'auto'
      && Array.isArray(node.children)
      && (node.children as Array<{ children?: unknown[] }>).some((child) => Array.isArray(child.children))
    ));
    expect(strip.length).toBeGreaterThan(0);
    const stripText = strip.map((node) => collectNodeText(node)).join(' ');
    expect(stripText).toContain('首字 200ms');
  });

  it('colors the first-byte badge through the shared tone helper thresholds', () => {
    const qualityBase = {
      firstByteSampleCount: 10,
      tpsEma: null,
      tpsSampleCount: 0,
      recentSuccessCount: 0,
      recentFailureCount: 0,
      recentSuccessRate: null,
      recentSampleCount: 0,
      lastUpdatedAtMs: Date.now(),
    } as const;
    const fast = renderRow(buildChannel({
      quality: { ...qualityBase, firstByteEmaMs: 200 },
    }));
    const slow = renderRow(buildChannel({
      quality: { ...qualityBase, firstByteEmaMs: 4000 },
    }));

    const findBadge = (root: ReturnType<typeof renderRow>, text: string) => root.root.findAll((node) => (
      typeof node.type === 'string' && node.type === 'span' && collectNodeText(node).includes(text)
    ))[0];

    expect(findBadge(fast, '首字 200ms')?.props.style?.color).toBe('var(--color-primary)');
    expect(findBadge(slow, '首字 4.0s')?.props.style?.color).toBe('var(--color-danger)');
  });
});
