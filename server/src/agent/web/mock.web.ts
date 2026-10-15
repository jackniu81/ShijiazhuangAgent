/**
 * Mock 网站查询数据源(chat-tools-spec web_search 工具):无外部依赖,返回确定性的
 * "联网查询"占位文案。当前即为正式数据源,后续可替换为真实搜索/官网抓取 API。
 */
export function mockWebSearch(query: string): Promise<string> {
  const trimmed = query.trim();
  if (!trimmed) return Promise.resolve('查询内容为空,未获取到联网信息。');
  return Promise.resolve(
    `【网站查询】关于「${trimmed}」的联网结果(示例数据):\n` +
      '- 最新开放时间、票价与预约方式以官方渠道为准,出行前请再次核实。\n' +
      '- 如需购票或预约,建议访问景区官方网站或官方公众号。',
  );
}
