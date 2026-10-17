import { Fragment, useState, type CSSProperties, type ReactNode } from 'react';
import ModernSelect from '../../components/ModernSelect.js';
import type { RouteChannel, SortableChannelRowProps } from './types.js';
import {
  buildFixedTokenOptionDescription,
  buildFixedTokenOptionLabel,
  describeTokenBinding,
  resolveTokenBindingConnectionMode,
} from './tokenBindingPresentation.js';
import { getChannelDecisionState, getPriorityTagStyle, getProbabilityColor } from './utils.js';
import {
  buildCandyProbeBadgeLabel,
  formatCandyProbeCheckedAt,
  formatCandyProbeFingerprint,
  resolveCandyProbeTone,
} from './candyProbe/presentation.js';
import {
  firstByteTone,
  qualityToneBgColor,
  qualityToneColor,
  successRateTone,
  tokensPerSecondTone,
} from '../helpers/qualityBadges.js';

function getRouteUnitStrategyLabel(strategy: string | null | undefined): string {
  return strategy === 'stick_until_unavailable' ? '单个用到不可用再切' : '轮询';
}

function formatRouteUnitMemberLabel(member: { accountId: number; username: string | null; siteName: string | null }): string {
  const accountLabel = member.username?.trim() || `account-${member.accountId}`;
  const siteLabel = member.siteName?.trim();
  return siteLabel ? `${accountLabel} @ ${siteLabel}` : accountLabel;
}

const CHANNEL_QUALITY_STALE_MS = 30 * 60 * 1000;
const CHANNEL_QUALITY_MIN_SAMPLES = 3;

function formatQualityLatency(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

/**
 * The channel's right-corner quality strip: recent first-byte latency, stream
 * throughput, and one merged stats badge carrying the lifetime success/fail counts
 * beside the recent-window success rate. All measured on THIS channel's own traffic;
 * routing scoring currently consumes the site-level signals, and the tooltip says so,
 * because for multi-channel sites the two numbers are legitimately different.
 *
 * When the payload carries no quality object at all (older backend), the merged
 * stats badge still renders so the lifetime counts keep a home.
 */
function buildChannelQualityBadges(channel: RouteChannel, suppressTooltips: boolean) {
  const quality = channel.quality ?? null;
  const stale = quality?.lastUpdatedAtMs != null
    && (Date.now() - quality.lastUpdatedAtMs) > CHANNEL_QUALITY_STALE_MS;
  const staleNote = stale ? '；最近 30 分钟无流量，数据可能过时' : '';
  const scoringNote = '。首字/速度/成功率为通道自身实测，路由评分当前按站点×模型聚合';

  const badges: Array<{ key: string; node: ReactNode }> = [];

  if (quality) {
    if (quality.firstByteEmaMs != null && Number.isFinite(quality.firstByteEmaMs)) {
      const insufficient = quality.firstByteSampleCount < CHANNEL_QUALITY_MIN_SAMPLES
        ? '；样本不足，仅供参考'
        : '';
      badges.push({
        key: 'firstByte',
        node: (
          <span
            className="badge"
            style={{
              fontSize: 10,
              background: qualityToneBgColor(firstByteTone(quality.firstByteEmaMs)),
              color: qualityToneColor(firstByteTone(quality.firstByteEmaMs)),
              opacity: stale ? 0.6 : 1,
              fontVariantNumeric: 'tabular-nums',
            }}
            data-tooltip={suppressTooltips ? undefined : `近期首字延迟 ${Math.round(quality.firstByteEmaMs)}ms（${quality.firstByteSampleCount} 个样本${insufficient}${staleNote}${scoringNote}）`}
          >
            首字 {formatQualityLatency(quality.firstByteEmaMs)}
          </span>
        ),
      });
    } else {
      badges.push({
        key: 'firstByte',
        node: (
          <span className="badge badge-muted" style={{ fontSize: 10 }} data-tooltip={suppressTooltips ? undefined : '该通道尚无首字延迟样本'}>
            首字 —
          </span>
        ),
      });
    }

    if (quality.tpsEma != null && Number.isFinite(quality.tpsEma) && quality.tpsEma > 0) {
      const insufficient = quality.tpsSampleCount < CHANNEL_QUALITY_MIN_SAMPLES
        ? '；样本不足，仅供参考'
        : '';
      badges.push({
        key: 'speed',
        node: (
          <span
            className="badge"
            style={{
              fontSize: 10,
              background: qualityToneBgColor(tokensPerSecondTone(quality.tpsEma)),
              color: qualityToneColor(tokensPerSecondTone(quality.tpsEma)),
              opacity: stale ? 0.6 : 1,
              fontVariantNumeric: 'tabular-nums',
            }}
            data-tooltip={suppressTooltips ? undefined : `近期流式吞吐 ${quality.tpsEma.toFixed(1)} tokens/s（${quality.tpsSampleCount} 个样本${insufficient}${staleNote}${scoringNote}）`}
          >
            速度 {quality.tpsEma.toFixed(1)}tps
          </span>
        ),
      });
    } else {
      badges.push({
        key: 'speed',
        node: (
          <span className="badge badge-muted" style={{ fontSize: 10 }} data-tooltip={suppressTooltips ? undefined : '该通道尚无流式吞吐样本（非流式请求不计入速度统计）'}>
            速度 —
          </span>
        ),
      });
    }
  }

  const lifetimeSuccess = Math.max(0, channel.successCount || 0);
  const lifetimeFail = Math.max(0, channel.failCount || 0);
  const recentSuccess = quality?.recentSuccessCount != null && Number.isFinite(quality.recentSuccessCount)
    ? quality.recentSuccessCount
    : null;
  const recentFail = quality?.recentFailureCount != null && Number.isFinite(quality.recentFailureCount)
    ? quality.recentFailureCount
    : null;
  const recentRate = quality?.recentSuccessRate != null && Number.isFinite(quality.recentSuccessRate)
    ? quality.recentSuccessRate
    : null;
  const rateTone = recentRate != null ? successRateTone(recentRate) : null;
  const mergedTooltipParts = [];
  if (recentSuccess != null && recentFail != null) {
    mergedTooltipParts.push(`近期成功/失败 ${recentSuccess.toFixed(2)}/${recentFail.toFixed(2)}（30 分钟半衰窗口，随时间指数遗忘）`);
  } else {
    mergedTooltipParts.push('近期成功/失败：尚无样本');
  }
  if (recentRate != null) {
    const insufficient = (quality?.recentSampleCount ?? 0) < CHANNEL_QUALITY_MIN_SAMPLES
      ? '；样本不足，仅供参考'
      : '';
    mergedTooltipParts.push(`近期成功率 ${(recentRate * 100).toFixed(1)}%（${quality?.recentSampleCount ?? 0} 个样本${insufficient}${staleNote}）`);
  } else {
    mergedTooltipParts.push('近期成功率：尚无样本');
  }
  mergedTooltipParts.push(`累计成功/失败 ${lifetimeSuccess}/${lifetimeFail}（自通道创建起，供参考）`);
  badges.push({
    key: 'stats',
    node: (
      <span
        className={`badge ${rateTone ? '' : 'badge-muted'}`}
        style={{
          fontSize: 10,
          fontVariantNumeric: 'tabular-nums',
          opacity: stale ? 0.6 : 1,
        }}
        data-tooltip={suppressTooltips ? undefined : mergedTooltipParts.join('；')}
      >
        成功率
        {recentSuccess != null && recentFail != null ? (
          <>
            <span style={{ color: 'var(--color-success)', fontWeight: 600 }}>{Math.round(recentSuccess)}</span>
            <span style={{ color: 'var(--color-text-muted)' }}>/</span>
            <span style={{ color: 'var(--color-danger)', fontWeight: 600 }}>{Math.round(recentFail)}</span>
          </>
        ) : (
          <span>—</span>
        )}
        <span style={{ color: 'var(--color-text-muted)' }}>/</span>
        {recentRate != null ? (
          <span style={{ color: rateTone ? qualityToneColor(rateTone) : 'var(--color-text-secondary)' }}>
            {(recentRate * 100).toFixed(0)}%
          </span>
        ) : (
          <span>—</span>
        )}
      </span>
    ),
  });

  return badges.map((badge) => <Fragment key={badge.key}>{badge.node}</Fragment>);
}

/**
 * The candy-question (degrade check) marker.
 *
 * Always rendered so "never tested" is visible as a state rather than as absence — a
 * channel without a verdict is not the same as a channel that passed. Display-only: the
 * badge never reflects routing state, because no routing rule reads the verdict yet.
 */
function buildCandyProbeBadge(
  channel: RouteChannel,
  suppressTooltips: boolean,
  onOpenDetail?: () => void,
) {
  const probe = channel.candyProbe ?? null;

  if (!probe) {
    return (
      <span
        className="badge badge-muted"
        style={{ fontSize: 10 }}
        data-tooltip={suppressTooltips ? undefined : '尚未做过糖果题测试'}
      >
        🍬 未测
      </span>
    );
  }

  const tone = resolveCandyProbeTone(probe.verdict);
  const label = buildCandyProbeBadgeLabel(probe);
  const tooltipParts = [
    `${formatCandyProbeFingerprint(probe.fingerprint)} 指纹`,
    `模型 ${probe.model}`,
    probe.actualModel ? `实际 ${probe.actualModel}` : null,
    probe.endpoint ? `端点 ${probe.endpoint}` : null,
    `检测于 ${formatCandyProbeCheckedAt(probe.checkedAt)}`,
    probe.fresh ? null : '已过期',
    probe.reason,
    onOpenDetail ? '点击查看每题明细' : null,
  ].filter(Boolean);

  return (
    <button
      type="button"
      className="badge"
      onClick={(event) => {
        event.stopPropagation();
        onOpenDetail?.();
      }}
      data-tooltip={suppressTooltips ? undefined : tooltipParts.join(' · ')}
      style={{
        fontSize: 10,
        fontFamily: 'inherit',
        border: 'none',
        color: qualityToneColor(tone),
        background: qualityToneBgColor(tone),
        opacity: probe.fresh ? 1 : 0.6,
        cursor: onOpenDetail ? 'pointer' : 'default',
      }}
    >
      {label}
    </button>
  );
}

function ChannelQualityStrip({ channel, suppressTooltips, style, onOpenCandyProbeDetail }: {
  channel: RouteChannel;
  suppressTooltips: boolean;
  style?: CSSProperties;
  onOpenCandyProbeDetail?: () => void;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap', ...style }}>
      {buildCandyProbeBadge(channel, suppressTooltips, onOpenCandyProbeDetail)}
      {buildChannelQualityBadges(channel, suppressTooltips)}
    </div>
  );
}

export function SortableChannelRow({
  channel,
  displayPriority,
  showPriorityBadge = true,
  dragging = false,
  dragHandleProps,
  dragHandleRef,
  decisionCandidate,
  isExactRoute,
  loadingDecision,
  isSavingPriority,
  readOnly = false,
  channelManagementDisabled = false,
  dragInProgress = false,
  mobile = false,
  tokenOptions,
  activeTokenId,
  isUpdatingToken,
  onTokenDraftChange,
  onSaveToken,
  onDeleteChannel,
  onToggleEnabled,
  onSiteBlockModel,
  clearingCooldown = false,
  onClearCooldown,
  candyProbeTesting = false,
  onRunCandyProbe,
  onOpenCandyProbeDetail,
}: SortableChannelRowProps) {
  const resolvedPriority = displayPriority ?? channel.priority ?? 0;
  const managementLocked = readOnly || channelManagementDisabled;
  const suppressTooltips = dragInProgress || dragging;
  const rowTransition = [
    'box-shadow 180ms ease',
    'background-color 180ms ease',
    'border-color 180ms ease',
    'opacity 180ms ease',
  ].filter(Boolean).join(', ');
  const dragHandleStyle: CSSProperties = {
    width: 22,
    minWidth: 22,
    height: 22,
    padding: 0,
    border: `1px solid ${dragging ? 'color-mix(in srgb, var(--color-info) 34%, var(--color-border-light))' : 'var(--color-border-light)'}`,
    borderRadius: 10,
    backgroundColor: dragging
      ? 'color-mix(in srgb, var(--color-bg-card) 80%, var(--color-info) 20%)'
      : 'color-mix(in srgb, var(--color-bg-card) 90%, white 10%)',
    boxShadow: 'inset 0 1px 0 rgba(255, 255, 255, 0.62)',
    color: dragging ? 'var(--color-text-primary)' : 'var(--color-text-muted)',
    cursor: isSavingPriority || managementLocked ? 'not-allowed' : 'grab',
    opacity: managementLocked ? 0.65 : 1,
    transition: 'background-color 0.16s ease, border-color 0.16s ease, box-shadow 0.16s ease, color 0.16s ease',
  };

  const rowStyle: CSSProperties = {
    transition: rowTransition || undefined,
    opacity: dragging ? 0.92 : channel.enabled === false ? 0.56 : 1,
    display: 'grid',
    gridTemplateColumns: managementLocked || mobile ? 'minmax(0, 1fr)' : 'minmax(0, 1fr) auto auto auto',
    alignItems: mobile ? 'stretch' : 'center',
    gap: mobile ? 8 : 6,
    padding: mobile ? '8px 9px' : '5px 8px',
    border: `1px solid ${dragging ? 'color-mix(in srgb, var(--color-info) 38%, var(--color-border-light))' : 'color-mix(in srgb, var(--color-border-light) 92%, transparent)'}`,
    borderRadius: 14,
    backgroundColor: dragging
      ? 'color-mix(in srgb, var(--color-bg-card) 82%, var(--color-info) 18%)'
      : 'color-mix(in srgb, var(--color-bg-card) 96%, white 4%)',
    boxShadow: dragging
      ? '0 18px 34px rgba(15, 23, 42, 0.12)'
      : '0 10px 22px rgba(15, 23, 42, 0.04), inset 0 1px 0 rgba(255, 255, 255, 0.7)',
  };

  const decisionState = getChannelDecisionState(decisionCandidate, channel, isExactRoute, loadingDecision);
  const tokenBinding = describeTokenBinding(
    tokenOptions,
    activeTokenId,
    channel.token?.name ?? null,
    {
      connectionMode: resolveTokenBindingConnectionMode(channel.account),
      accountName: channel.account?.username || `account-${channel.accountId}`,
    },
  );
  const routeUnit = channel.routeUnit ?? null;
  const routeUnitName = routeUnit?.name?.trim() || 'OAuth 路由池';
  const routeUnitStrategyLabel = routeUnit ? getRouteUnitStrategyLabel(routeUnit.strategy) : '';
  const routeUnitMemberSummary = routeUnit?.members?.length
    ? routeUnit.members.map((member) => formatRouteUnitMemberLabel(member)).join('、')
    : null;
  const routeUnitMemberSummaryText = routeUnitMemberSummary ? `成员：${routeUnitMemberSummary}` : null;

  const [mobileDetailsOpen, setMobileDetailsOpen] = useState(false);

  if (mobile) {
    return (
      <div data-layer-root style={{ ...rowStyle, display: 'block' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
          <button
            type="button"
            ref={dragHandleRef}
            {...dragHandleProps}
            disabled={isSavingPriority || managementLocked}
            className="btn btn-ghost"
            style={{
              marginTop: 2,
              ...dragHandleStyle,
            }}
            data-tooltip={suppressTooltips ? undefined : (managementLocked ? '该路由当前不可编辑优先级' : '拖拽调整优先级桶')}
            aria-label="拖拽调整优先级桶"
          >
            <svg width="12" height="12" fill="currentColor" viewBox="0 0 12 12" aria-hidden>
              <circle cx="3" cy="2" r="1" />
              <circle cx="9" cy="2" r="1" />
              <circle cx="3" cy="6" r="1" />
              <circle cx="9" cy="6" r="1" />
              <circle cx="3" cy="10" r="1" />
              <circle cx="9" cy="10" r="1" />
            </svg>
          </button>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0, flex: 1 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
              {showPriorityBadge ? (
                <span
                  className="badge"
                  style={{
                    fontSize: 10,
                    fontWeight: 700,
                    letterSpacing: 0.1,
                    ...getPriorityTagStyle(resolvedPriority),
                  }}
                >
                  P{resolvedPriority}
                </span>
              ) : null}

              <span style={{ fontWeight: 600, color: 'var(--color-text-primary)', fontSize: 14, minWidth: 0 }}>
                {channel.account?.username || `account-${channel.accountId}`}
              </span>

              <span className="badge badge-muted" style={{ fontSize: 10 }}>
                {channel.site?.name || 'unknown'}
              </span>

              <ChannelQualityStrip channel={channel} suppressTooltips={suppressTooltips} style={{ marginLeft: 'auto' }} onOpenCandyProbeDetail={onOpenCandyProbeDetail} />
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap' }}>
              <span
                className="badge"
                style={{
                  fontSize: 10,
                  background: tokenBinding.badgeTone === 'info'
                    ? 'color-mix(in srgb, var(--color-info) 15%, transparent)'
                    : 'color-mix(in srgb, var(--color-warning) 15%, transparent)',
                  color: tokenBinding.badgeTone === 'info' ? 'var(--color-info)' : 'var(--color-warning)',
                }}
              >
                {tokenBinding.bindingModeLabel}
              </span>

              <span
                className="badge"
                style={{
                  fontSize: 10,
                  background: 'var(--color-info-soft)',
                  color: 'var(--color-info)',
                  maxWidth: 220,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
                data-tooltip={suppressTooltips ? undefined : `当前生效：${tokenBinding.effectiveTokenName}`}
              >
                当前生效：{tokenBinding.effectiveTokenName}
              </span>

              {channel.sourceModel ? (
                <span className="badge badge-info" style={{ fontSize: 10 }}>
                  {channel.sourceModel}
                </span>
              ) : null}

              {channel.manualOverride ? (
                <span
                  className="badge badge-warning"
                  style={{ fontSize: 10 }}
                  data-tooltip={suppressTooltips ? undefined : '该通道由用户手动添加，而非系统自动生成'}
                >
                  手动配置
                </span>
              ) : null}

              {routeUnit ? (
                <>
                  <span className="badge badge-muted" style={{ fontSize: 10 }}>
                    OAuth 路由池
                  </span>
                  <span className="badge badge-info" style={{ fontSize: 10 }}>
                    {routeUnitName}
                  </span>
                  <span className="badge badge-muted" style={{ fontSize: 10 }}>
                    {routeUnit.memberCount} 成员
                  </span>
                  <span className="badge badge-muted" style={{ fontSize: 10 }}>
                    {routeUnitStrategyLabel}
                  </span>
                </>
              ) : null}
            </div>

            {routeUnitMemberSummaryText ? (
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 11, color: 'var(--color-text-muted)', whiteSpace: 'nowrap' }}>
                  成员摘要（{routeUnit?.memberCount || 0} 个成员 · {routeUnitStrategyLabel}）
                </span>
                <span style={{ fontSize: 11, color: 'var(--color-text-secondary)', lineHeight: 1.45 }}>
                  {routeUnitMemberSummaryText}
                </span>
              </div>
            ) : null}

            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 11, color: 'var(--color-text-muted)', whiteSpace: 'nowrap' }}>选中概率</span>
              <div style={{ display: 'inline-flex', alignItems: 'center', gap: 5, minWidth: 96 }}>
                <div
                  data-tooltip={suppressTooltips ? undefined : (decisionState.probability <= 0 ? decisionState.reasonText : undefined)}
                  style={{
                    width: 60,
                    height: 4,
                    background: 'color-mix(in srgb, var(--color-border) 88%, white 12%)',
                    borderRadius: 999,
                    overflow: 'hidden',
                  }}
                >
                  <div
                    style={{
                      width: `${Math.max(0, Math.min(100, decisionState.probability))}%`,
                      height: '100%',
                      background: getProbabilityColor(decisionState.probability),
                      borderRadius: 999,
                      transition: 'width 0.24s ease, background-color 0.18s ease',
                    }}
                  />
                </div>
                <span
                  data-tooltip={suppressTooltips ? undefined : (decisionState.probability <= 0 ? decisionState.reasonText : undefined)}
                  style={{
                    fontSize: 11,
                    color: decisionState.probability > 0 ? 'var(--color-text-secondary)' : decisionState.reasonColor,
                    fontVariantNumeric: 'tabular-nums',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {decisionState.probability.toFixed(1)}%
                </span>
              </div>

              {!managementLocked && (
                <button
                  type="button"
                  className="btn btn-link"
                  onClick={() => setMobileDetailsOpen((current) => !current)}
                  style={{ marginLeft: 'auto' }}
                >
                  {mobileDetailsOpen ? '收起配置' : '配置通道'}
                </button>
              )}
            </div>

            {!managementLocked && mobileDetailsOpen && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, paddingTop: 6, borderTop: '1px solid var(--color-border-light)' }}>
                <div style={{ width: '100%' }}>
                  <ModernSelect
                    size="sm"
                    value={String(activeTokenId || 0)}
                    onChange={(nextValue) => onTokenDraftChange(channel.id, Number.parseInt(nextValue, 10) || 0)}
                    disabled={isUpdatingToken}
                    options={[
                      {
                        value: '0',
                        label: tokenBinding.followOptionLabel,
                        description: tokenBinding.followOptionDescription,
                      },
                      ...tokenOptions.map((token) => ({
                        value: String(token.id),
                        label: buildFixedTokenOptionLabel(token, { includeDefaultTag: true }),
                        description: buildFixedTokenOptionDescription(token),
                      })),
                    ]}
                    placeholder="选择令牌绑定方式"
                  />
                  <div style={{ marginTop: 3, fontSize: 10.5, color: 'var(--color-text-muted)', lineHeight: 1.35 }}>
                    {tokenBinding.helperText}
                  </div>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 10, flexWrap: 'wrap' }}>
                  <button
                    onClick={onSaveToken}
                    disabled={isUpdatingToken}
                    className="btn btn-link btn-link-info"
                  >
                    {isUpdatingToken ? <span className="spinner spinner-sm" /> : '保存'}
                  </button>

                  <button
                    onClick={() => onToggleEnabled(channel.enabled === false)}
                    className={`btn btn-link ${channel.enabled === false ? 'btn-link-info' : 'btn-link-warning'}`}
                  >
                    {channel.enabled === false ? '启用' : '禁用'}
                  </button>

                  {onRunCandyProbe ? (
                    <button
                      onClick={onRunCandyProbe}
                      disabled={candyProbeTesting}
                      className="btn btn-link btn-link-info"
                    >
                      {candyProbeTesting ? '测试中...' : '🍬 测智商'}
                    </button>
                  ) : null}

                  {onClearCooldown ? (
                    <button
                      onClick={onClearCooldown}
                      disabled={clearingCooldown}
                      className="btn btn-link btn-link-info"
                    >
                      {clearingCooldown ? '清除中...' : '清除冷却'}
                    </button>
                  ) : null}

                  {onSiteBlockModel && channel.site?.id ? (
                    <button
                      onClick={onSiteBlockModel}
                      className="btn btn-link btn-link-warning"
                    >
                      站点屏蔽
                    </button>
                  ) : null}

                  <button
                    onClick={onDeleteChannel}
                    className="btn btn-link btn-link-danger"
                  >
                    移除
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div data-layer-root style={rowStyle}>
      <div style={{ display: 'flex', alignItems: mobile ? 'stretch' : 'center', flexDirection: mobile ? 'column' : 'row', gap: 6, fontSize: 12, flexWrap: 'wrap', minWidth: 0 }}>
        <button
          type="button"
          ref={dragHandleRef}
          {...dragHandleProps}
          disabled={isSavingPriority || managementLocked}
          className="btn btn-ghost"
          style={dragHandleStyle}
          data-tooltip={suppressTooltips ? undefined : (managementLocked ? '该路由当前不可编辑优先级' : '拖拽调整优先级桶')}
          aria-label="拖拽调整优先级桶"
        >
          <svg width="12" height="12" fill="currentColor" viewBox="0 0 12 12" aria-hidden>
            <circle cx="3" cy="2" r="1" />
            <circle cx="9" cy="2" r="1" />
            <circle cx="3" cy="6" r="1" />
            <circle cx="9" cy="6" r="1" />
            <circle cx="3" cy="10" r="1" />
            <circle cx="9" cy="10" r="1" />
          </svg>
        </button>

        {showPriorityBadge ? (
          <span
            className="badge"
            style={{
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: 0.1,
              ...getPriorityTagStyle(resolvedPriority),
            }}
          >
            P{resolvedPriority}
          </span>
        ) : null}

        <span style={{ fontWeight: 600, color: 'var(--color-text-primary)' }}>
          {channel.account?.username || `account-${channel.accountId}`}
        </span>

        <span className="badge badge-muted" style={{ fontSize: 10 }}>
          {channel.site?.name || 'unknown'}
        </span>

        <span
          className="badge"
          style={{
            fontSize: 10,
            background: tokenBinding.badgeTone === 'info'
              ? 'color-mix(in srgb, var(--color-info) 15%, transparent)'
              : 'color-mix(in srgb, var(--color-warning) 15%, transparent)',
            color: tokenBinding.badgeTone === 'info' ? 'var(--color-info)' : 'var(--color-warning)',
          }}
        >
          {tokenBinding.bindingModeLabel}
        </span>

        <span
          className="badge"
          style={{
            fontSize: 10,
            background: 'var(--color-info-soft)',
            color: 'var(--color-info)',
            maxWidth: 220,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
          data-tooltip={suppressTooltips ? undefined : `当前生效：${tokenBinding.effectiveTokenName}`}
        >
          当前生效：{tokenBinding.effectiveTokenName}
        </span>

        {channel.sourceModel ? (
          <span className="badge badge-info" style={{ fontSize: 10 }}>
            {channel.sourceModel}
          </span>
        ) : null}

        {channel.manualOverride ? (
          <span
            className="badge badge-warning"
            style={{ fontSize: 10 }}
            data-tooltip={suppressTooltips ? undefined : '该通道由用户手动添加，而非系统自动生成'}
          >
            手动配置
          </span>
        ) : null}

        {channel.enabled === false ? (
          <span className="badge badge-muted" style={{ fontSize: 10 }}>已禁用</span>
        ) : null}

        {routeUnit ? (
          <>
            <span className="badge badge-muted" style={{ fontSize: 10 }}>
              OAuth 路由池
            </span>
            <span className="badge badge-info" style={{ fontSize: 10 }}>
              {routeUnitName}
            </span>
            <span className="badge badge-muted" style={{ fontSize: 10 }}>
              {routeUnit.memberCount} 成员
            </span>
            <span className="badge badge-muted" style={{ fontSize: 10 }}>
              {routeUnitStrategyLabel}
            </span>
          </>
        ) : null}

        <ChannelQualityStrip channel={channel} suppressTooltips={suppressTooltips} style={{ marginLeft: 'auto' }} onOpenCandyProbeDetail={onOpenCandyProbeDetail} />

        {routeUnitMemberSummaryText ? (
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6, width: '100%', flexWrap: 'wrap' }}>
            <span style={{ fontSize: 11, color: 'var(--color-text-muted)', whiteSpace: 'nowrap' }}>
              成员摘要（{routeUnit?.memberCount || 0} 个成员 · {routeUnitStrategyLabel}）
            </span>
            <span style={{ fontSize: 11, color: 'var(--color-text-secondary)', lineHeight: 1.45 }}>
              {routeUnitMemberSummaryText}
            </span>
          </div>
        ) : null}

        <div style={{ display: 'flex', alignItems: 'center', gap: 6, width: '100%', marginTop: mobile ? 0 : 1, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 11, color: 'var(--color-text-muted)', whiteSpace: 'nowrap' }}>选中概率</span>
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 5, minWidth: 96 }}>
            <div
              data-tooltip={suppressTooltips ? undefined : (decisionState.probability <= 0 ? decisionState.reasonText : undefined)}
              style={{
                width: 60,
                height: 4,
                background: 'color-mix(in srgb, var(--color-border) 88%, white 12%)',
                borderRadius: 999,
                overflow: 'hidden',
              }}
            >
              <div
                style={{
                  width: `${Math.max(0, Math.min(100, decisionState.probability))}%`,
                  height: '100%',
                  background: getProbabilityColor(decisionState.probability),
                  borderRadius: 999,
                  transition: 'width 0.24s ease, background-color 0.18s ease',
                }}
              />
            </div>
            <span
              data-tooltip={suppressTooltips ? undefined : (decisionState.probability <= 0 ? decisionState.reasonText : undefined)}
              style={{
                fontSize: 11,
                color: decisionState.probability > 0 ? 'var(--color-text-secondary)' : decisionState.reasonColor,
                fontVariantNumeric: 'tabular-nums',
                whiteSpace: 'nowrap',
              }}
            >
              {decisionState.probability.toFixed(1)}%
            </span>
          </div>
        </div>
      </div>

      {!managementLocked ? (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <div style={{ minWidth: 220, flex: 1 }}>
              <ModernSelect
                size="sm"
                value={String(activeTokenId || 0)}
                onChange={(nextValue) => onTokenDraftChange(channel.id, Number.parseInt(nextValue, 10) || 0)}
                disabled={isUpdatingToken}
                options={[
                  {
                    value: '0',
                    label: tokenBinding.followOptionLabel,
                    description: tokenBinding.followOptionDescription,
                  },
                  ...tokenOptions.map((token) => ({
                    value: String(token.id),
                    label: buildFixedTokenOptionLabel(token, { includeDefaultTag: true }),
                    description: buildFixedTokenOptionDescription(token),
                  })),
                ]}
                placeholder="选择令牌绑定方式"
              />
              <div style={{ marginTop: 3, fontSize: 10.5, color: 'var(--color-text-muted)', lineHeight: 1.35 }}>
                {tokenBinding.helperText}
              </div>
            </div>
            <button
              onClick={onSaveToken}
              disabled={isUpdatingToken}
              className="btn btn-link btn-link-info"
            >
              {isUpdatingToken ? <span className="spinner spinner-sm" /> : '保存'}
            </button>
          </div>

          <button
            onClick={() => onToggleEnabled(channel.enabled === false)}
            className={`btn btn-link ${channel.enabled === false ? 'btn-link-info' : 'btn-link-warning'}`}
            data-tooltip={suppressTooltips ? undefined : (channel.enabled === false ? '启用此通道' : '禁用此通道')}
          >
            {channel.enabled === false ? '启用' : '禁用'}
          </button>

          <div style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
            {onRunCandyProbe ? (
              <button
                onClick={onRunCandyProbe}
                disabled={candyProbeTesting}
                className="btn btn-link btn-link-info"
                data-tooltip={suppressTooltips ? undefined : '用糖果题探测该通道是否降智（只记录结果，不改变路由）'}
              >
                {candyProbeTesting ? '测试中...' : '🍬 测智商'}
              </button>
            ) : null}

            {onClearCooldown ? (
              <button
                onClick={onClearCooldown}
                disabled={clearingCooldown}
                className="btn btn-link btn-link-info"
                data-tooltip={suppressTooltips ? undefined : '清空此通道的失败计数与冷却，使其立即可被选中'}
              >
                {clearingCooldown ? '清除中...' : '清除冷却'}
              </button>
            ) : null}

            {onSiteBlockModel && channel.site?.id ? (
              <button
                onClick={onSiteBlockModel}
                className="btn btn-link btn-link-warning"
                data-tooltip={suppressTooltips ? undefined : `将此模型加入站点「${channel.site?.name || '未知'}」的禁用列表，rebuild 后该站点的此模型通道将不再生成`}
              >
                站点屏蔽
              </button>
            ) : null}

            <button
              onClick={onDeleteChannel}
              className="btn btn-link btn-link-danger"
            >
              移除
            </button>
          </div>
        </>
      ) : null}
    </div>
  );
}
