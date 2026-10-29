import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create } from 'react-test-renderer';

const apiMock = vi.hoisted(() => ({
  runChannelIdentityProbe: vi.fn(),
  getChannelIdentityProbe: vi.fn(),
}));
vi.mock('../../../api.js', () => ({ api: apiMock }));

import { formatSweepEstimate, useIdentityProbe } from './useIdentityProbe.js';
import type { RouteChannel } from '../types.js';

type Hook = ReturnType<typeof useIdentityProbe>;

function channel(id: number, overrides: Partial<RouteChannel> = {}): RouteChannel {
  return {
    id,
    routeId: 9,
    accountId: id,
    tokenId: null,
    sourceModel: 'deepseek-v4-flash',
    priority: 0,
    weight: 100,
    enabled: true,
    manualOverride: false,
    successCount: 0,
    failCount: 0,
    cooldownUntil: null,
    account: { username: 'u', accessToken: null, extraConfig: null, credentialMode: 'apikey' },
    site: { id: 1, name: 'hub', platform: 'new-api' },
    token: null,
    ...overrides,
  };
}

function mount(options: { channels: RouteChannel[]; confirm?: (message: string) => boolean }) {
  const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn() };
  const reloadChannels = vi.fn(async () => options.channels);
  const confirm = vi.fn(options.confirm ?? (() => true));
  let hook!: Hook;
  function Probe() {
    hook = useIdentityProbe({ toast, findChannelById: () => null, reloadChannels, confirm });
    return null;
  }
  void act(() => {
    create(<Probe />);
  });
  return { get hook() { return hook; }, toast, reloadChannels, confirm };
}

describe('useIdentityProbe route sweep', () => {
  beforeEach(() => {
    apiMock.runChannelIdentityProbe.mockReset();
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('runs the applicable channels one at a time and summarises by verdict', async () => {
    const verdicts: Record<number, string> = { 1: 'model_match', 2: 'version_mismatch', 3: 'likely_match' };
    let inFlight = 0;
    let maxInFlight = 0;
    apiMock.runChannelIdentityProbe.mockImplementation(async (channelId: number) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return { success: true, result: { channelId, verdict: verdicts[channelId] } };
    });
    const view = mount({
      channels: [channel(1), channel(2), channel(3), channel(4, { candyProbeApplicable: false })],
    });

    await act(async () => {
      await view.hook.runRouteSweep(9);
    });

    expect(apiMock.runChannelIdentityProbe.mock.calls.map((call) => call[0])).toEqual([1, 2, 3]);
    expect(maxInFlight).toBe(1);
    expect(view.confirm).toHaveBeenCalledTimes(1);
    expect(String(view.confirm.mock.calls[0]?.[0])).toContain('3 个通道');
    expect(String(view.confirm.mock.calls[0]?.[0])).toContain('9 个请求');
    expect(view.toast.error).toHaveBeenCalledWith(
      '模型指纹批量检测完成：疑似换版本 1 · 型号一致 1 · 倾向一致 1 · 跳过 1',
    );
    expect(view.hook.batchByRoute[9]).toBeUndefined();
    expect(view.hook.testingByChannel).toEqual({ 1: false, 2: false, 3: false });
  });

  it('sends nothing when the user declines', async () => {
    const view = mount({ channels: [channel(1)], confirm: () => false });
    await act(async () => {
      await view.hook.runRouteSweep(9);
    });
    expect(apiMock.runChannelIdentityProbe).not.toHaveBeenCalled();
    expect(view.hook.batchByRoute[9]).toBeUndefined();
  });

  it('counts a refused request apart from the verdicts', async () => {
    apiMock.runChannelIdentityProbe
      .mockResolvedValueOnce({ success: true, result: { channelId: 1, verdict: 'model_match' } })
      .mockRejectedValueOnce(new Error('通道没有可用的凭证'));
    const view = mount({ channels: [channel(1), channel(2)] });
    await act(async () => {
      await view.hook.runRouteSweep(9);
    });
    expect(view.toast.info).toHaveBeenCalledWith('模型指纹批量检测完成：型号一致 1 · 无法检测 1');
  });

  it('ignores a second click while the sweep is starting', async () => {
    let release!: () => void;
    apiMock.runChannelIdentityProbe.mockImplementation(() => new Promise((resolve) => {
      release = () => resolve({ success: true, result: { channelId: 1, verdict: 'model_match' } });
    }));
    const view = mount({ channels: [channel(1)] });
    let first!: Promise<void>;
    await act(async () => {
      first = view.hook.runRouteSweep(9);
      await view.hook.runRouteSweep(9);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(view.hook.batchByRoute[9]).toEqual({ done: 0, total: 1 });
    await act(async () => {
      release();
      await first;
    });
    expect(apiMock.runChannelIdentityProbe).toHaveBeenCalledTimes(1);
    expect(view.confirm).toHaveBeenCalledTimes(1);
  });

  it('says so when nothing on the route can be probed', async () => {
    const view = mount({ channels: [channel(1, { candyProbeApplicable: false })] });
    await act(async () => {
      await view.hook.runRouteSweep(9);
    });
    expect(view.confirm).not.toHaveBeenCalled();
    expect(view.toast.info).toHaveBeenCalledWith('该路由下没有可做模型指纹检测的通道（非对话模型不适用）');
  });
});

describe('formatSweepEstimate', () => {
  it('scales from minutes to hours', () => {
    expect(formatSweepEstimate(1)).toBe('约 1 分钟 – 5 分钟');
    expect(formatSweepEstimate(4)).toBe('约 4 分钟 – 20 分钟');
    expect(formatSweepEstimate(30)).toBe('约 30 分钟 – 2.5 小时');
  });
});
