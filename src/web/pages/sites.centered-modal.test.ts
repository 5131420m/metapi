import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('Sites centered modal adoption', () => {
  it('uses CenteredModal for add/edit site flows instead of inline form panels', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/web/pages/Sites.tsx'), 'utf8');

    expect(source).toContain("import CenteredModal from '../components/CenteredModal.js'");
    expect(source).toContain('<CenteredModal');
    expect(source).not.toContain('editorPresence.shouldRender && activeEditor && (');
  });

  it('uses API request wording for dedicated site endpoint copy', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/web/pages/Sites.tsx'), 'utf8');

    expect(source).toContain('API 请求地址池');
    expect(source).toContain('+ 添加 API 地址');
    expect(source).toContain('准确主站点 URL（面板/登录/签到地址，如 https://nih.cc）');
    expect(source).toContain('API 请求地址（如 https://api.nih.cc）');
    expect(source).toContain('label="API 请求地址"');
    expect(source).toContain('API 地址: {buildSiteApiEndpointSummary(site)}');
    expect(source).toContain('地址池耗尽后回退主站点 URL');
    expect(source).toContain('关闭后永不将主站用于 AI API');
    expect(source).toContain('独立冷却 5 分钟');
    expect(source).toContain('条启用 · ${fallbackLabel}');
    expect(source).not.toContain('站点 URL（面板/登录/签到地址，如 https://console.example.com）');
    expect(source).not.toContain('API 请求地址（如 https://api.example.com）');
    expect(source).not.toContain('AI 请求地址池');
    expect(source).not.toContain('+ 添加 AI 地址');
    expect(source).not.toContain('label="AI 请求地址"');
    expect(source).not.toContain('AI 地址: {buildSiteApiEndpointSummary(site)}');
  });
});
