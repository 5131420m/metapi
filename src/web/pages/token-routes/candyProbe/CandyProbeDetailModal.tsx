/**
 * Per-question detail for one candy-probe run.
 *
 * The row badge only carries the verdict; this panel is what makes the verdict auditable:
 * which questions were asked, what the channel answered, and what was expected.
 */

import type { CSSProperties } from 'react';
import CenteredModal from '../../../components/CenteredModal.js';
import { qualityToneBgColor, qualityToneColor } from '../../helpers/qualityBadges.js';
import {
  buildCandyProbeVerdictLabel,
  formatCandyProbeCheckedAt,
  formatCandyProbeFingerprint,
  resolveCandyProbeTone,
} from './presentation.js';
import type { CandyProbeResult } from '../types.js';

type CandyProbeDetailModalProps = {
  open: boolean;
  onClose: () => void;
  result: CandyProbeResult | null;
  loading?: boolean;
  channelLabel?: string | null;
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
}: CandyProbeDetailModalProps) {
  const tone = result ? resolveCandyProbeTone(result.verdict) : 'warning';

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
              {buildCandyProbeVerdictLabel(result.verdict)} {result.score}/{result.total}
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
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={{ ...labelStyle, fontWeight: 600 }}>逐题明细</span>
            {result.questions.length <= 0 ? (
              <span style={{ fontSize: 11.5, color: 'var(--color-text-muted)' }}>
                本次探测没有拿到可判分的回答。
              </span>
            ) : (
              result.questions.map((question, index) => (
                <div
                  key={`${question.id}-${index}`}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'auto minmax(0, 1fr)',
                    gap: 8,
                    padding: '8px 10px',
                    borderRadius: 10,
                    border: '1px solid var(--color-border-light)',
                    background: question.correct
                      ? 'color-mix(in srgb, var(--color-primary) 5%, transparent)'
                      : 'color-mix(in srgb, var(--color-danger) 6%, transparent)',
                  }}
                >
                  <span
                    style={{
                      fontSize: 11,
                      fontWeight: 600,
                      color: question.correct ? 'var(--color-primary)' : 'var(--color-danger)',
                    }}
                  >
                    {question.correct ? '✓' : '✗'}
                  </span>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 }}>
                    <span style={{ fontSize: 12, color: 'var(--color-text-primary)' }}>
                      {index + 1}. {question.prompt}
                    </span>
                    <span style={{ fontSize: 11, color: 'var(--color-text-secondary)' }}>
                      期望 <code>{question.expected}</code>
                      {' · '}
                      回答 <code>{question.answer || '（空）'}</code>
                    </span>
                  </div>
                </div>
              ))
            )}
          </div>

          <div style={{ fontSize: 10.5, lineHeight: 1.5, color: 'var(--color-text-muted)' }}>
            结果仅用于展示，不影响路由选择与通道健康。糖果题只能发现明显降智（被换成弱得多的模型），
            对量化、采样参数级别的细微退化无感知。
          </div>
        </div>
      )}
    </CenteredModal>
  );
}
