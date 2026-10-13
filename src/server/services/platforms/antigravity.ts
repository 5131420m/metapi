import { BasePlatformAdapter, type BalanceInfo, type CheckinResult, type UserInfo } from './base.js';
import {
  ANTIGRAVITY_CLIENT_METADATA,
  ANTIGRAVITY_GOOGLE_API_CLIENT,
  ANTIGRAVITY_UPSTREAM_BASE_URL,
  ANTIGRAVITY_USER_AGENT,
} from '../oauth/antigravityProvider.js';
import {
  markConfirmedEmptyModelList,
  unreadableModelListError,
} from './modelListEvidence.js';

function normalizeBaseUrl(baseUrl: string): string {
  return (baseUrl || '').replace(/\/+$/, '');
}

/**
 * Parse the upstream model map. Returns null when the payload carries no
 * `models` field at all, so callers can treat it as a failure instead of an
 * empty account. See modelListEvidence.ts.
 */
function extractAntigravityModelNames(payload: unknown): string[] | null {
  if (!payload || typeof payload !== 'object') return null;
  const record = payload as { models?: unknown };
  if (record.models && typeof record.models === 'object' && !Array.isArray(record.models)) {
    return markConfirmedEmptyModelList(
      Object.keys(record.models).map((name) => name.trim()).filter(Boolean),
    );
  }
  if (Array.isArray(record.models)) {
    return markConfirmedEmptyModelList(record.models.flatMap((item) => {
      if (typeof item === 'string') return item.trim() ? [item.trim()] : [];
      if (!item || typeof item !== 'object') return [];
      const id = typeof (item as { id?: unknown }).id === 'string'
        ? (item as { id: string }).id.trim()
        : (typeof (item as { name?: unknown }).name === 'string'
          ? (item as { name: string }).name.trim()
          : '');
      return id ? [id] : [];
    }));
  }
  return null;
}

export class AntigravityAdapter extends BasePlatformAdapter {
  readonly platformName = 'antigravity';

  async detect(url: string): Promise<boolean> {
    const normalized = (url || '').toLowerCase();
    return normalized.includes('antigravity');
  }

  override async login(_baseUrl: string, _username: string, _password: string) {
    return { success: false, message: 'login endpoint not supported' };
  }

  override async getUserInfo(_baseUrl: string, _accessToken: string): Promise<UserInfo | null> {
    return null;
  }

  async checkin(_baseUrl: string, _accessToken: string): Promise<CheckinResult> {
    return { success: false, message: 'checkin endpoint not supported' };
  }

  async getBalance(_baseUrl: string, _accessToken: string): Promise<BalanceInfo> {
    return { balance: 0, used: 0, quota: 0 };
  }

  async getModels(baseUrl: string, accessToken: string): Promise<string[]> {
    // Failures are rethrown rather than flattened into an empty list: model
    // refresh must be able to tell "this account has no models" from "the pull
    // failed", or a single upstream hiccup would clear the synced models. See
    // modelListEvidence.ts.
    const url = `${normalizeBaseUrl(baseUrl || ANTIGRAVITY_UPSTREAM_BASE_URL)}/v1internal:fetchAvailableModels`;
    const payload = await this.fetchJson<{ models?: unknown }>(
      url,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/json',
          'User-Agent': ANTIGRAVITY_USER_AGENT,
          'X-Goog-Api-Client': ANTIGRAVITY_GOOGLE_API_CLIENT,
          'Client-Metadata': ANTIGRAVITY_CLIENT_METADATA,
        },
        body: JSON.stringify({}),
      },
    );
    const models = extractAntigravityModelNames(payload);
    if (models === null) throw unreadableModelListError(url, payload);
    return models;
  }
}
