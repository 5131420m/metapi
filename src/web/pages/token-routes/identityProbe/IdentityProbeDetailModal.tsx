/**
 * Detail panel for one model fingerprint run: the ranking, each challenge's outcome, and the
 * combined reading with the candy probe.
 */

import type { CSSProperties } from 'react';
import CenteredModal from '../../../components/CenteredModal.js';
import { qualityToneBgColor, qualityToneColor } from '../../helpers/qualityBadges.js';
import { buildProbeCombinedSummary } from '../probeSummary.js';
import {
  formatIdentityCandidate,
  formatIdentityClaimedRank,
  formatIdentityProbability,
  formatIdentityProbeVerdict,
  IDENTITY_PROBE_DISCLAIMER,
  IDENTITY_PROBE_VERDICT_EXPLANATIONS,
  resolveIdentityProbeTone,
} from './presentation.js';
import type { CandyProbeSnapshot, IdentityProbeResult } from '../types.js';
import { identityModelLineKey } from '../../../../shared/modelIdentityProbe.js';

type IdentityProbeDetailModalProps = {
  open: boolean;
  onClose: () => void;
  result: IdentityProbeResult | null;
  /** The channel's candy verdict, for the combined reading; null when there is none. */
  candy?: CandyProbeSnapshot | null;
  /** Whether the stored result is still fresh (from the list snapshot). */
  fresh?: boolean;
  loading?: boolean;
  channelLabel?: string | null;
};

const labelStyle: CSSProperties = { fontSize: 11, color: 'var(--color-text-muted)' };
const valueStyle: CSSProperties = { fontSize: 12, color: 'var(--color-text-primary)', overflowWrap: 'anywhere' };
const noteBoxStyle: CSSProperties = {
  fontSize: 11.5,
  lineHeight: 1.5,
  color: 'var(--color-text-secondary)',
  background: 'color-mix(in srgb, var(--color-text-muted) 10%, transparent)',
  borderRadius: 8,
  padding: '8px 10px',
};
const cellStyle: CSSProperties = { padding: '5px 8px', fontSize: 11.5, borderBottom: '1px solid var(--color-border-light)', textAlign: 'left' };

const SAMPLE_STATE_LABELS: Record<string, string> = {
  complete: '完整',
  truncated: '截断（数量已够）',
  failed: '失败',
};

const FORMAT_LABELS: Record<string, string> = {
  openai: 'Chat Completions',
  claude: 'Anthropic Messages',
  responses: 'OpenAI Responses',
};

function SummaryItem({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
      <span style={labelStyle}>{label}</span>
      <span style={valueStyle}>{value}</span>
    </div>
  );
}

export default function IdentityProbeDetailModal({
  open,
  onClose,
  result,
  candy = null,
  fresh = true,
  loading = false,
  channelLabel = null,
}: IdentityProbeDetailModalProps) {
  const tone = result ? resolveIdentityProbeTone(result.verdict) : 'warning';
  const combined = result ? buildProbeCombinedSummary(candy, { verdict: result.verdict, fresh }) : null;

  return (
    <CenteredModal open={open} onClose={onClose} title="模型指纹检测明细" maxWidth={760} closeOnBackdrop closeOnEscape>
      {loading ? (
        <div style={{ padding: '24px 0', textAlign: 'center', color: 'var(--color-text-muted)' }}>
          <span className="spinner spinner-sm" /> 正在读取检测结果...
        </div>
      ) : !result ? (
        <div style={{ padding: '24px 0', textAlign: 'center', color: 'var(--color-text-muted)' }}>
          该通道还没有模型指纹检测结果
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span
              className="badge"
              style={{ fontSize: 12, padding: '3px 10px', color: qualityToneColor(tone), background: qualityToneBgColor(tone) }}
            >
              {formatIdentityProbeVerdict(result.verdict)}
            </span>
            {channelLabel ? <span style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>{channelLabel}</span> : null}
          </div>

          <div style={noteBoxStyle}>
            {IDENTITY_PROBE_VERDICT_EXPLANATIONS[result.verdict]}
            {result.reason ? <><br />{result.reason}</> : null}
          </div>

          {combined ? (
            <div
              data-testid="probe-combined-summary"
              style={{ ...noteBoxStyle, color: qualityToneColor(combined.tone), background: qualityToneBgColor(combined.tone) }}
            >
              与糖果题结合：{combined.text}
            </div>
          ) : null}

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 10 }}>
            <SummaryItem label="声称模型" value={result.model} />
            <SummaryItem label="库内最像" value={formatIdentityCandidate(result.prediction)} />
            <SummaryItem label="声称型号排名" value={formatIdentityClaimedRank(result)} />
            <SummaryItem label="最像候选置信度" value={formatIdentityProbability(result.probability)} />
            <SummaryItem label="有效回答" value={`${result.usedOutputs} / 3`} />
            <SummaryItem label="实际返回" value={result.actualModel || '—'} />
            <SummaryItem label="请求格式" value={FORMAT_LABELS[result.requestFormat] ?? result.requestFormat} />
            <SummaryItem label="上游端点" value={result.endpoint || '—'} />
            <SummaryItem label="耗时" value={result.latencyMs == null ? '—' : `${(result.latencyMs / 1000).toFixed(1)} s`} />
            <SummaryItem label="检测时间" value={new Date(result.checkedAt).toLocaleString()} />
            <SummaryItem label="参考库版本" value={result.config.bankBuiltAt ? new Date(result.config.bankBuiltAt).toLocaleString() : '—'} />
          </div>

          {result.candidates.length > 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <span style={{ ...labelStyle, fontWeight: 600 }}>候选排名</span>
              <table style={{ borderCollapse: 'collapse', width: '100%' }}>
                <thead>
                  <tr>
                    <th style={cellStyle}>#</th>
                    <th style={cellStyle}>模型</th>
                    <th style={cellStyle}>家族</th>
                    <th style={cellStyle}>置信度</th>
                  </tr>
                </thead>
                <tbody>
                  {result.candidates.map((candidate, index) => (
                    <tr
                      key={candidate.model}
                      style={identityModelLineKey(candidate.model) === identityModelLineKey(result.model)
                        ? { background: qualityToneBgColor('primary') }
                        : undefined}
                    >
                      <td style={cellStyle}>{index + 1}</td>
                      <td style={cellStyle}><code>{candidate.displayName}</code></td>
                      <td style={cellStyle}>{candidate.familyName}</td>
                      <td style={cellStyle}>{formatIdentityProbability(candidate.probability)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}

          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={{ ...labelStyle, fontWeight: 600 }}>挑战样本</span>
            <table style={{ borderCollapse: 'collapse', width: '100%' }}>
              <thead>
                <tr>
                  <th style={cellStyle}>#</th>
                  <th style={cellStyle}>状态</th>
                  <th style={cellStyle}>整数 / 要求</th>
                  <th style={cellStyle}>返回模型</th>
                  <th style={cellStyle}>说明</th>
                </tr>
              </thead>
              <tbody>
                {result.samples.map((sample) => (
                  <tr key={sample.index}>
                    <td style={cellStyle}>{sample.index}</td>
                    <td style={{ ...cellStyle, color: sample.accepted ? 'var(--color-text-primary)' : 'var(--color-warning)' }}>
                      {SAMPLE_STATE_LABELS[sample.state] ?? sample.state}
                    </td>
                    <td style={cellStyle}>{sample.count} / {sample.expectedCount}</td>
                    <td style={cellStyle}>{sample.responseModel || '—'}</td>
                    <td style={{ ...cellStyle, overflowWrap: 'anywhere' }}>{sample.error || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div style={{ fontSize: 10.5, lineHeight: 1.5, color: 'var(--color-text-muted)' }}>
            {IDENTITY_PROBE_DISCLAIMER}
            本检测让模型写出约 300 个 1–355 的整数，用 lm-detector 参考库比对数值分布；请求以普通 SDK 身份发送，
            与糖果题使用的客户端身份不同，按客户端分流的中转站可能让两项结果不一致。
            判定结果仅用于展示，不影响通道路由与健康；请求经过站点 API 请求池，会计入端点的成功/失败记录。
          </div>
        </div>
      )}
    </CenteredModal>
  );
}
