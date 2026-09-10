import { describe, expect, it } from 'vitest';
import { Headers } from 'undici';
import { mergeHeadersWithSiteCustomHeaders } from './siteCustomHeaders.js';

describe('mergeHeadersWithSiteCustomHeaders', () => {
  it('keeps site custom headers authoritative by default', () => {
    // 本 fork 默认“站点头优先”，与上游默认（请求头优先）相反。
    const merged = new Headers(mergeHeadersWithSiteCustomHeaders(
      JSON.stringify({ 'User-Agent': 'site-agent', 'X-Site-Scope': 'internal' }),
      { 'user-agent': 'request-agent' },
    ));

    expect(merged.get('user-agent')).toBe('site-agent');
    expect(merged.get('x-site-scope')).toBe('internal');
  });

  it('lets request headers win when the site explicitly opts out of site priority', () => {
    const merged = new Headers(mergeHeadersWithSiteCustomHeaders(
      JSON.stringify({ 'User-Agent': 'site-agent', 'X-Site-Scope': 'internal' }),
      { 'user-agent': 'request-agent' },
      { priority: 'request' },
    ));

    expect(merged.get('user-agent')).toBe('request-agent');
    expect(merged.get('x-site-scope')).toBe('internal');
  });

  it('lets site custom headers override request headers when site priority is enabled', () => {
    const merged = new Headers(mergeHeadersWithSiteCustomHeaders(
      JSON.stringify({ 'User-Agent': 'site-agent', 'X-Site-Scope': 'internal' }),
      { 'user-agent': 'request-agent', 'X-Trace-Id': 'trace-1' },
      { priority: 'site' },
    ));

    expect(merged.get('user-agent')).toBe('site-agent');
    expect(merged.get('x-site-scope')).toBe('internal');
    expect(merged.get('x-trace-id')).toBe('trace-1');
  });

  it('returns the original request headers when no site custom headers are configured', () => {
    const requestHeaders = { 'X-Trace-Id': 'trace-1' };

    expect(mergeHeadersWithSiteCustomHeaders(null, requestHeaders)).toBe(requestHeaders);
  });
});
