import type { AppConfig } from '../../config/configuration';
import { mockWebSearch } from './mock.web';
import { duckduckgoWebSearch } from './duckduckgo.web';

/**
 * web_search 工具数据源工厂:按 config.web.provider 选择真实引擎,
 * 未配置/非法回退 mock(确定性、无外部依赖)。返回与 deps.webSearch 一致的契约。
 */
export function createWebSearch(
  web: AppConfig['web'],
): (query: string, signal?: AbortSignal) => Promise<string> {
  if (web.provider === 'duckduckgo') {
    return (query, signal) =>
      duckduckgoWebSearch(query, { topK: web.topK, timeoutMs: web.timeoutMs, signal });
  }
  // 'mock'(默认):在线能力未启用或环境不可达时保持确定性占位文案
  return (query) => mockWebSearch(query);
}
