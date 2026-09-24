import { Bm25Index, tokenize } from './bm25';

describe('tokenize', () => {
  it('产出单字 + bigram,并剔除标点空白', () => {
    const grams = tokenize('正定,古城 夜游!');
    expect(grams).toContain('正');
    expect(grams).toContain('正定');
    expect(grams).toContain('定');
    expect(grams).toContain('古');
    expect(grams).not.toContain(',');
    expect(grams).not.toContain(' ');
  });

  it('空文本返回空数组', () => {
    expect(tokenize('')).toEqual([]);
    expect(tokenize('  ,.!')).toEqual([]);
  });
});

describe('Bm25Index', () => {
  const docs = ['牛肉板面筋道实惠', '正定古城墙夜景很美', '赵州桥是古代石拱桥'];
  let index: Bm25Index;

  beforeEach(() => {
    index = new Bm25Index();
    docs.forEach((d) => index.add(d));
  });

  it('size 反映文档数', () => {
    expect(index.size).toBe(3);
  });

  it('关键词命中的文档排在前面', () => {
    const hits = index.search('牛肉板面', 3);
    expect(hits[0].id).toBe(0);
  });

  it('未命中的文档不参与结果(得分>0 才返回)', () => {
    const hits = index.search('滹沱河', 5);
    expect(hits).toHaveLength(0);
  });

  it('稀有词区分度高于常见词(idf)', () => {
    const idx = new Bm25Index();
    idx.add('桥楼殿悬在崖壁'); // 只含 桥
    idx.add('桥边有座桥'); // 桥 重复且全库仅此高频
    idx.add('古城和桥的故事');
    // 「桥楼殿」只在 doc0 出现,查询它应把 doc0 排最前
    const hits = idx.search('桥楼殿', 3);
    expect(hits[0].id).toBe(0);
  });

  it('k 限制返回条数;k<=0 或空 query 返回空', () => {
    expect(index.search('桥', 1)).toHaveLength(1);
    expect(index.search('桥', 0)).toEqual([]);
    expect(index.search('', 3)).toEqual([]);
  });
});
