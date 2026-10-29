/**
 * Model fingerprint probe state for the token-routes page: which channels are running, the
 * manual run, and the detail panel.
 *
 * Kept out of `TokenRoutes.tsx` (which already owns the candy probe's equivalent inline) so
 * the page only wires it up. The callbacks it returns are stable across renders, which the
 * memoized route cards rely on.
 */

import { useCallback, useRef, useState } from 'react';
import { api } from '../../../api.js';
import {
  buildIdentityProbeBatchSummary,
  buildIdentityProbeToast,
  createIdentityProbeBatchTally,
  resolveIdentityProbeBatchToastKind,
} from './presentation.js';
import type { IdentityProbeResult, RouteChannel } from '../types.js';

type Toast = {
  success: (message: string) => void;
  error: (message: string) => void;
  info: (message: string) => void;
};

export type IdentityProbeDetailState = {
  channelId: number;
  label: string;
  result: IdentityProbeResult | null;
};

export function useIdentityProbe(input: {
  toast: Toast;
  findChannelById: (channelId: number) => RouteChannel | null;
  /** Reload one route's channels; resolves to the fresh channel list. */
  reloadChannels: (routeId: number) => Promise<unknown>;
  /** Confirmation before a route sweep; defaults to `window.confirm`. Injected by tests. */
  confirm?: (message: string) => boolean;
}) {
  const [testingByChannel, setTestingByChannel] = useState<Record<number, boolean>>({});
  const [detail, setDetail] = useState<IdentityProbeDetailState | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const detailRequestRef = useRef(0);
  const testingRef = useRef<Set<number>>(new Set());
  /** Route sweeps in progress, by route id: present only while a sweep runs. */
  const [batchByRoute, setBatchByRoute] = useState<Record<number, { done: number; total: number }>>({});
  // Synchronous guard: the progress state is only set after the channel list loads and the
  // confirm returns, so a second click in between would otherwise start a second sweep.
  const batchStartingRef = useRef<Set<number>>(new Set());
  // The latest inputs, read by the stable callbacks below.
  const inputRef = useRef(input);
  inputRef.current = input;

  const runProbe = useCallback(async (channelId: number, routeId: number) => {
    if (testingRef.current.has(channelId)) return;
    testingRef.current.add(channelId);
    setTestingByChannel((prev) => ({ ...prev, [channelId]: true }));
    const { toast } = inputRef.current;
    toast.info('模型指纹检测已开始：将发送 3 个请求，约需 1–5 分钟');
    try {
      const response = await api.runChannelIdentityProbe(channelId);
      const result = response?.result as IdentityProbeResult | null | undefined;
      if (result) {
        const message = buildIdentityProbeToast(result);
        toast[message.kind](message.message);
      } else {
        toast.info('模型指纹检测未返回结果');
      }
      try {
        await inputRef.current.reloadChannels(routeId);
      } catch {
        toast.info('检测已完成，但通道列表刷新失败');
      }
    } catch (e: any) {
      toast.error(e?.message || '模型指纹检测失败');
    } finally {
      testingRef.current.delete(channelId);
      setTestingByChannel((prev) => ({ ...prev, [channelId]: false }));
    }
  }, []);

  const openDetail = useCallback(async (channelId: number) => {
    // Sequence guard, as for the candy panel: a late response must not write to a newer view.
    const requestId = detailRequestRef.current + 1;
    detailRequestRef.current = requestId;
    const isCurrent = () => detailRequestRef.current === requestId;

    const channel = inputRef.current.findChannelById(channelId);
    const label = channel
      ? `${channel.sourceModel || '未知模型'} @ ${channel.site?.name || '未知站点'} #${channelId}`
      : `通道 #${channelId}`;
    setDetail({ channelId, label, result: null });
    setDetailLoading(true);
    try {
      const response = await api.getChannelIdentityProbe(channelId);
      if (!isCurrent()) return;
      setDetail((current) => (
        current && current.channelId === channelId
          ? { ...current, result: (response?.result as IdentityProbeResult | null) ?? null }
          : current
      ));
    } catch (e: any) {
      if (!isCurrent()) return;
      inputRef.current.toast.error(e?.message || '读取模型指纹检测结果失败');
      setDetail(null);
    } finally {
      if (isCurrent()) setDetailLoading(false);
    }
  }, []);

  const closeDetail = useCallback(() => {
    detailRequestRef.current += 1;
    setDetail(null);
    setDetailLoading(false);
  }, []);

  /**
   * Route sweep: run the fingerprint probe on every applicable channel of a route.
   *
   * ONE channel at a time, unlike the candy sweep's two workers: each run is already three
   * upstream completions of ~300 numbers, so a route of N channels is 3N requests, and the
   * server caps fingerprint runs at two concurrent slots shared with every other caller.
   * Client-driven so badges fill in as it advances and one stalled channel cannot hold the
   * rest hostage — the per-channel endpoint is the unit of truth, as for the candy sweep.
   */
  const runRouteSweep = useCallback(async (routeId: number) => {
    if (batchStartingRef.current.has(routeId)) return;
    batchStartingRef.current.add(routeId);
    const { toast } = inputRef.current;
    try {
      let targets: RouteChannel[] = [];
      try {
        const loaded = await inputRef.current.reloadChannels(routeId);
        targets = Array.isArray(loaded) ? loaded as RouteChannel[] : [];
      } catch {
        toast.error('读取通道列表失败，无法批量检测');
        return;
      }
      if (targets.length <= 0) {
        toast.info('该路由下没有通道');
        return;
      }
      // Same applicability rule as the row button: a non-conversation model can only come
      // back rejected, so it is counted as 跳过 and never sent.
      const probeable = targets.filter((channel) => channel.candyProbeApplicable !== false);
      const skipped = targets.length - probeable.length;
      if (probeable.length <= 0) {
        toast.info('该路由下没有可做模型指纹检测的通道（非对话模型不适用）');
        return;
      }

      const confirmFn = inputRef.current.confirm ?? defaultConfirm;
      const confirmed = confirmFn(
        `将对 ${probeable.length} 个通道依次做模型指纹检测，共约 ${probeable.length * 3} 个请求、${formatSweepEstimate(probeable.length)}。`
        + '每次检测写入使用日志，结果只做展示，不改变路由。确认开始？',
      );
      if (!confirmed) return;

      setBatchByRoute((prev) => ({ ...prev, [routeId]: { done: 0, total: probeable.length } }));
      const tally = createIdentityProbeBatchTally();
      let alreadyRunning = 0;
      for (const channel of probeable) {
        // A single run of this channel may already be going (row button): skip it — that run
        // records its own verdict, and a second request would only join it server-side.
        if (testingRef.current.has(channel.id)) {
          alreadyRunning += 1;
        } else {
          testingRef.current.add(channel.id);
          setTestingByChannel((prev) => ({ ...prev, [channel.id]: true }));
          try {
            const response = await api.runChannelIdentityProbe(channel.id);
            const result = response?.result as IdentityProbeResult | null | undefined;
            if (result && result.verdict in tally) tally[result.verdict] += 1;
            else tally.inconclusive += 1;
          } catch {
            // A channel the probe could not even reach is not evidence about the model.
            tally.rejected += 1;
          } finally {
            testingRef.current.delete(channel.id);
            setTestingByChannel((prev) => ({ ...prev, [channel.id]: false }));
          }
        }
        setBatchByRoute((prev) => {
          const current = prev[routeId];
          return current ? { ...prev, [routeId]: { done: current.done + 1, total: current.total } } : prev;
        });
        // Refresh as the sweep advances, so each badge appears as soon as its run is done.
        try {
          await inputRef.current.reloadChannels(routeId);
        } catch {
          // The final refresh below reports a failure once; a mid-sweep miss is not worth a toast.
        }
      }

      setBatchByRoute((prev) => {
        const next = { ...prev };
        delete next[routeId];
        return next;
      });
      const summary = buildIdentityProbeBatchSummary(tally, skipped + alreadyRunning);
      toast[resolveIdentityProbeBatchToastKind(tally)](`模型指纹批量检测完成：${summary}`);
      try {
        await inputRef.current.reloadChannels(routeId);
      } catch {
        toast.info('检测已完成，但通道列表刷新失败');
      }
    } finally {
      batchStartingRef.current.delete(routeId);
    }
  }, []);

  return {
    testingByChannel,
    runProbe,
    openDetail,
    closeDetail,
    detail,
    detailLoading,
    batchByRoute,
    runRouteSweep,
  };
}

function defaultConfirm(message: string): boolean {
  if (typeof window === 'undefined' || typeof window.confirm !== 'function') return true;
  return window.confirm(message);
}

/** Sweep duration at the single-run 1–5 minute estimate the row toast uses. */
export function formatSweepEstimate(channelCount: number): string {
  const low = Math.max(1, channelCount);
  const high = Math.max(1, channelCount * 5);
  const format = (minutes: number) => (minutes >= 60
    ? `${Math.round((minutes / 60) * 10) / 10} 小时`
    : `${minutes} 分钟`);
  return `约 ${format(low)} – ${format(high)}`;
}
