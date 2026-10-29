/**
 * Per-question detail for one candy-probe run.
 *
 * The row badge only carries the verdict; this panel is what makes the verdict auditable:
 * which question was asked, what the channel answered, and what was expected.
 */

import type { CSSProperties } from 'react';
import CenteredModal from '../../../components/CenteredModal.js';
import { qualityToneBgColor, qualityToneColor } from '../../helpers/qualityBadges.js';
import {
  buildCandyProbeVerdictLabel,
  formatCandyProbeCheckedAt,
  formatCandyProbeFingerprint,
  formatCandyProbeTrigger,
  resolveCandyProbeTone,
} from './presentation.js';
import { buildProbeCombinedSummary } from '../probeSummary.js';
import type { CandyProbeResult, CandyProbeSnapshot, IdentityProbeSnapshot } from '../types.js';

type CandyProbeDetailModalProps = {
  open: boolean;
  onClose: () => void;
  result: CandyProbeResult | null;
  loading?: boolean;
  channelLabel?: string | null;
  /** The list snapshot of this verdict (carries freshness), for the combined reading. */
  candySnapshot?: CandyProbeSnapshot | null;
  /** The channel's model fingerprint verdict, for the combined reading. */
  identity?: IdentityProbeSnapshot | null;
};

const labelStyle: CSSProperties = {
  fontSize: 11,
  color: 'var(--color-text-muted)',
};

const valueStyle: CSSProperties = {
  fontSize: 12,
  color: 'var(--color-text-primary)',
  overflowWrap: 'anywhere',
};

function SummaryItem({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
      <span style={labelStyle}>{label}</span>
      <span style={valueStyle}>{value}</span>
    </div>
  );
}

export default function CandyProbeDetailModal({
  open,
  onClose,
  result,
  loading = false,
  channelLabel = null,
  candySnapshot = null,
  identity = null,
}: CandyProbeDetailModalProps) {
  const tone = result ? resolveCandyProbeTone(result.verdict, result.expectation) : 'warning';
  const combined = result
    ? buildProbeCombinedSummary(
      { verdict: result.verdict, expectation: result.expectation, fresh: candySnapshot?.fresh ?? true },
      identity,
    )
    : null;

  return (
    <CenteredModal
      open={open}
      onClose={onClose}
      title="糖果题检测明细"
      maxWidth={720}
      closeOnBackdrop
      closeOnEscape
    >
      {loading ? (
        <div style={{ padding: '24px 0', textAlign: 'center', color: 'var(--color-text-muted)' }}>
          <span className="spinner spinner-sm" /> 正在读取检测结果...
        </div>
      ) : !result ? (
        <div style={{ padding: '24px 0', textAlign: 'center', color: 'var(--color-text-muted)' }}>
          该通道还没有糖果题检测结果
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span
              className="badge"
              style={{
                fontSize: 12,
                padding: '3px 10px',
                color: qualityToneColor(tone),
                background: qualityToneBgColor(tone),
              }}
            >
              {buildCandyProbeVerdictLabel(result.verdict, result.expectation)}
            </span>
            {channelLabel ? (
              <span style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>{channelLabel}</span>
            ) : null}
          </div>

          {result.reason ? (
            <div
              style={{
                fontSize: 11.5,
                lineHeight: 1.5,
                color: 'var(--color-text-secondary)',
                background: 'color-mix(in srgb, var(--color-text-muted) 10%, transparent)',
                borderRadius: 8,
                padding: '8px 10px',
              }}
            >
              {result.reason}
            </div>
          ) : null}

          {combined ? (
            <div
              data-testid="probe-combined-summary"
              style={{
                fontSize: 11.5,
                lineHeight: 1.5,
                borderRadius: 8,
                padding: '8px 10px',
                color: qualityToneColor(combined.tone),
                background: qualityToneBgColor(combined.tone),
              }}
            >
              与模型指纹结合：{combined.text}
            </div>
          ) : null}

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
              gap: 10,
            }}
          >
            <SummaryItem label="模型" value={result.model} />
            <SummaryItem label="实际返回" value={result.actualModel || '—'} />
            <SummaryItem label="客户端指纹" value={formatCandyProbeFingerprint(result.fingerprint)} />
            <SummaryItem label="上游端点" value={result.endpoint || '—'} />
            <SummaryItem label="耗时" value={result.latencyMs == null ? '—' : `${result.latencyMs} ms`} />
            <SummaryItem label="检测时间" value={formatCandyProbeCheckedAt(result.checkedAt)} />
            <SummaryItem label="来源" value={formatCandyProbeTrigger(result.trigger)} />
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={{ ...labelStyle, fontWeight: 600 }}>题目</span>
            <div
              style={{
                fontSize: 11.5,
                lineHeight: 1.6,
                color: 'var(--color-text-secondary)',
                background: 'color-mix(in srgb, var(--color-text-muted) 10%, transparent)',
                borderRadius: 8,
                padding: '8px 10px',
                whiteSpace: 'pre-wrap',
              }}
            >
              {result.question.prompt}
            </div>
            <span style={{ fontSize: 11.5, color: 'var(--color-text-muted)' }}>
              正确答案 <code>{result.question.expected}</code>
              {' · '}
              题目 <code>{result.question.id}</code>
            </span>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={{ ...labelStyle, fontWeight: 600 }}>回答</span>
            {(result.samples[0]?.answer ?? '') === '' ? (
              <span style={{ fontSize: 11.5, color: 'var(--color-text-muted)' }}>
                本次探测没有拿到可判读的回答。
              </span>
            ) : (
              (() => {
                // The card mirrors the badge's own vocabulary: a pass is a ✓ in the
                // primary tone, a fail is a ✗ whose colour depends on the expectation
                // (只有 expected 模型才用红色), and an inconclusive run is a "?" — the
                // answer text was read, but it could not be graded, which is NOT a wrong
                // answer and must not be coloured like one.
                const symbol = result.verdict === 'pass' ? '✓' : result.verdict === 'fail' ? '✗' : '?';
                const tone = resolveCandyProbeTone(result.verdict, result.expectation);
                const symbolColor = result.verdict === 'pass'
                  ? 'var(--color-primary)'
                  : result.verdict === 'fail' && result.expectation === 'expected'
                    ? 'var(--color-danger)'
                    : 'var(--color-warning)';
                return (
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'flex-start',
                      gap: 8,
                      padding: '8px 10px',
                      borderRadius: 10,
                      border: '1px solid var(--color-border-light)',
                      background: qualityToneBgColor(tone),
                    }}
                  >
                    <span style={{ fontSize: 11, fontWeight: 600, color: symbolColor }}>{symbol}</span>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 }}>
                      <span
                        style={{
                          fontSize: 12,
                          color: result.verdict === 'inconclusive'
                            ? 'var(--color-text-secondary)'
                            : 'var(--color-text-primary)',
                          overflowWrap: 'anywhere',
                        }}
                      >
                        <code>{result.samples[0]?.answer}</code>
                      </span>
                      {result.samples[0]?.note ? (
                        <span style={{ fontSize: 11, color: 'var(--color-text-secondary)' }}>{result.samples[0]?.note}</span>
                      ) : null}
                    </div>
                  </div>
                );
              })()
            )}
          </div>

          <div style={{ fontSize: 10.5, lineHeight: 1.5, color: 'var(--color-text-muted)' }}>
            判定结果仅用于展示，不影响通道路由与健康；检测请求与真实请求一样经过站点 API 请求池，会计入端点的成功/失败记录。糖果题只能发现明显降智（被换成弱得多的模型），
            对量化、温度参数级别的细微退化无感知。
          </div>
        </div>
      )}
    </CenteredModal>
  );
}
