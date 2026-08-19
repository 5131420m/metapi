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

vi.mock('../api.js', () => ({ api: apiMock }));
vi.mock('../components/BrandIcon.js', () => ({
  BrandGlyph: () => null,
  InlineBrandIcon: () => null,
  getBrand: () => null,
  normalizeBrandIconKey: (icon: string) => icon,
}));

function collectText(node: ReactTestInstance): string {
  return (node.children || []).map((child) => typeof child === 'string' ? child : collectText(child)).join('');
}

async function flushMicrotasks() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('Settings downstream error policy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.getAuthInfo.mockResolvedValue({ masked: 'sk-****' });
    apiMock.getRuntimeSettings.mockResolvedValue({
      checkinCron: '0 8 * * *',
      balanceRefreshCron: '0 * * * *',
      logCleanupCron: '0 6 * * *',
      logCleanupUsageLogsEnabled: false,
      logCleanupProgramLogsEnabled: false,
      logCleanupRetentionDays: 30,
      routingWeights: {},
      adminIpAllowlist: [],
      systemProxyUrl: '',
      proxyErrorKeywords: [],
      proxyEmptyContentFailEnabled: false,
      downstreamErrorPolicy: { mode: 'off', downstreamApiKeyIds: [] },
    });
    apiMock.getDownstreamApiKeys.mockResolvedValue({
      items: [
        { id: 12, name: 'CPA dedicated', keyMasked: 'sk-c****1234' },
        { id: 13, name: 'Other client', keyMasked: 'sk-o****5678' },
      ],
    });
    apiMock.getRoutesLite.mockResolvedValue([]);
    apiMock.getBrandList.mockResolvedValue({ brands: [] });
    apiMock.getRuntimeDatabaseConfig.mockResolvedValue({
      active: { dialect: 'sqlite', connection: '(default sqlite path)', ssl: false },
      saved: null,
      restartRequired: false,
    });
    apiMock.getModelTokenCandidates.mockResolvedValue({ models: {} });
    apiMock.updateRuntimeSettings.mockResolvedValue({
      proxyErrorKeywords: [],
      proxyEmptyContentFailEnabled: false,
      downstreamErrorPolicy: { mode: 'resilient', downstreamApiKeyIds: [12] },
    });
  });

  afterEach(() => vi.clearAllMocks());

  it('saves resilient mode scoped to the selected dedicated downstream key', async () => {
    let root!: ReactTestRenderer;
    try {
      await act(async () => {
        root = create(<MemoryRouter><ToastProvider><Settings /></ToastProvider></MemoryRouter>);
      });
      await flushMicrotasks();

      const policySelect = root.root.find((node) => node.type === 'select'
        && node.props.value === 'off'
        && node.children.some((child) => typeof child !== 'string' && collectText(child).includes('韧性模式')));
      expect(policySelect.children.some((child) => typeof child !== 'string' && collectText(child).includes('原样透传'))).toBe(false);
      await act(async () => policySelect.props.onChange({ target: { value: 'resilient' } }));

      const keyLabel = root.root.find((node) => node.type === 'label' && collectText(node).includes('CPA dedicated'));
      await act(async () => keyLabel.findByType('input').props.onChange({ target: { checked: true } }));

      const saveButton = root.root.find((node) => node.type === 'button'
        && typeof node.props.onClick === 'function'
        && collectText(node).trim() === '保存失败规则');
      await act(async () => saveButton.props.onClick());
      await flushMicrotasks();

      expect(apiMock.updateRuntimeSettings).toHaveBeenCalledWith({
        proxyErrorKeywords: [],
        proxyEmptyContentFailEnabled: false,
        downstreamErrorPolicy: {
          mode: 'resilient',
          downstreamApiKeyIds: [12],
        },
      });
    } finally {
      root?.unmount();
    }
  });


});
