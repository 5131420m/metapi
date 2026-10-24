import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../components/Toast.js';
import Settings from './Settings.js';

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    getAuthInfo: vi.fn(),
    getRuntimeSettings: vi.fn(),
    getDownstreamApiKeys: vi.fn(),
    getRoutesLite: vi.fn(),
    getRuntimeDatabaseConfig: vi.fn(),
    getBrandList: vi.fn(),
    updateRuntimeSettings: vi.fn(),
    getModelTokenCandidates: vi.fn(),
  },
}));

vi.mock('../api.js', () => ({
  api: apiMock,
}));

vi.mock('../components/BrandIcon.js', () => ({
  BrandGlyph: () => null,
  InlineBrandIcon: () => null,
  getBrand: () => null,
  normalizeBrandIconKey: (key: string) => key,
}));

function collectText(node: ReactTestInstance): string {
  return (node.children || []).map((child) => {
    if (typeof child === 'string') return child;
    return collectText(child as ReactTestInstance);
  }).join('');
}

async function flushMicrotasks() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** The payload every test renders against; tests override individual fields. */
const BASE_RUNTIME_SETTINGS = {
  checkinCron: '0 8 * * *',
  checkinScheduleMode: 'interval',
  checkinIntervalHours: 6,
  balanceRefreshCron: '0 * * * *',
  logCleanupCron: '15 4 * * *',
  logCleanupUsageLogsEnabled: true,
  logCleanupProgramLogsEnabled: true,
  logCleanupRetentionDays: 14,
  routingFallbackUnitCost: 1,
  proxyFirstByteTimeoutSec: 0,
  routingWeights: {},
  tokenRouterFailureCooldownMaxSec: 30 * 24 * 60 * 60,
  candyProbeScheduleEnabled: false,
  candyProbeScheduleRecheckHours: 12,
  adminIpAllowlist: [] as string[],
  systemProxyUrl: '',
};

describe('Settings candy probe schedule', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.getAuthInfo.mockResolvedValue({ masked: 'sk-****' });
    apiMock.getRuntimeSettings.mockResolvedValue({ ...BASE_RUNTIME_SETTINGS });
    apiMock.getDownstreamApiKeys.mockResolvedValue({ items: [] });
    apiMock.getRoutesLite.mockResolvedValue([]);
    apiMock.getBrandList.mockResolvedValue({ brands: [] });
    apiMock.getRuntimeDatabaseConfig.mockResolvedValue({
      active: { dialect: 'sqlite', connection: '(default sqlite path)', ssl: false },
      saved: null,
      restartRequired: false,
    });
    apiMock.updateRuntimeSettings.mockResolvedValue({ success: true });
    apiMock.getModelTokenCandidates.mockResolvedValue({ models: {} });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('hides the candy probe schedule section while it is parked, without corrupting its saved values', async () => {
    let root!: ReactTestRenderer;
    try {
      await act(async () => {
        root = create(
          <MemoryRouter>
            <ToastProvider>
              <Settings />
            </ToastProvider>
          </MemoryRouter>,
        );
      });
      await flushMicrotasks();

      // The section is parked (CANDY_PROBE_SCHEDULE_UI_HIDDEN): neither the toggle nor the
      // cadence select may render, so an operator cannot flip a schedule the UI no longer
      // explains.
      const toggleLabels = root.root.findAll((node) => (
        node.type === 'label' && collectText(node).includes('定时巡检糖果题')
      ));
      expect(toggleLabels).toHaveLength(0);

      const cadenceSelects = root.root.findAll((node) => (
        node.type === 'select' && node.props['aria-label'] === '糖果题巡检复测周期'
      ));
      expect(cadenceSelects).toHaveLength(0);

      // While parked, a routing save must not write values the operator cannot see: the
      // server keeps whatever it holds (env or an earlier explicit choice).
      const saveButton = root.root.find((node) => (
        node.type === 'button'
        && typeof node.props.onClick === 'function'
        && collectText(node).trim() === '保存路由策略'
      ));
      await act(async () => {
        saveButton.props.onClick();
      });
      await flushMicrotasks();

      expect(apiMock.updateRuntimeSettings).toHaveBeenCalledTimes(1);
      const payload = apiMock.updateRuntimeSettings.mock.calls[0]?.[0] ?? {};
      expect(payload).not.toHaveProperty('candyProbeScheduleEnabled');
      expect(payload).not.toHaveProperty('candyProbeScheduleRecheckHours');
    } finally {
      root?.unmount();
    }
  });

  it('shows the parked-schedule notice with a working off switch while the schedule runs', async () => {
    // An instance that enabled the schedule before the UI was parked keeps sweeping with
    // no visible toggle to stop it — the notice plus button is the only way out.
    apiMock.getRuntimeSettings.mockResolvedValue({ ...BASE_RUNTIME_SETTINGS, candyProbeScheduleEnabled: true });
    let root!: ReactTestRenderer;
    try {
      await act(async () => {
        root = create(
          <MemoryRouter>
            <ToastProvider>
              <Settings />
            </ToastProvider>
          </MemoryRouter>,
        );
      });
      await flushMicrotasks();

      const notice = root.root.findAll((node) => (
        typeof node.type === 'string'
        && collectText(node).includes('糖果题定时巡检当前处于开启状态')
      ))[0];
      expect(notice).toBeTruthy();

      const offButton = root.root.find((node) => (
        node.type === 'button'
        && typeof node.props.onClick === 'function'
        && collectText(node).trim() === '关闭巡检'
      ));
      await act(async () => {
        offButton.props.onClick();
      });
      await flushMicrotasks();

      expect(apiMock.updateRuntimeSettings).toHaveBeenCalledWith(expect.objectContaining({
        candyProbeScheduleEnabled: false,
      }));
      // The notice follows the local state update and disappears once the schedule is off.
      expect(root.root.findAll((node) => (
        typeof node.type === 'string'
        && collectText(node).includes('糖果题定时巡检当前处于开启状态')
      ))).toHaveLength(0);
    } finally {
      root?.unmount();
    }
  });

  it('shows no parked-schedule notice while the schedule is off', async () => {
    let root!: ReactTestRenderer;
    try {
      await act(async () => {
        root = create(
          <MemoryRouter>
            <ToastProvider>
              <Settings />
            </ToastProvider>
          </MemoryRouter>,
        );
      });
      await flushMicrotasks();

      expect(root.root.findAll((node) => (
        typeof node.type === 'string'
        && collectText(node).includes('糖果题定时巡检当前处于开启状态')
      ))).toHaveLength(0);
      expect(root.root.findAll((node) => (
        node.type === 'button'
        && typeof node.props.onClick === 'function'
        && collectText(node).trim() === '关闭巡检'
      ))).toHaveLength(0);
    } finally {
      root?.unmount();
    }
  });
});
