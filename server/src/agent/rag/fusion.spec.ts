import { metaBoostScore, rrfFuse, RRF_K } from './fusion';
import { DocMeta } from './rag.types';

const meta = (over: Partial<DocMeta> = {}): DocMeta => ({
  title: 't',
  tags: [],
  source: 's.md',
  ...over,
});

describe('rrfFuse', () => {
  it('按 1/(k+rank+1) 计分', () => {
    const fused = rrfFuse([[7, 3]]);
    expect(fused.get(7)).toBeCloseTo(1 / (RRF_K + 1));
    expect(fused.get(3)).toBeCloseTo(1 / (RRF_K + 2));
  });

  it('两路都上榜的文档胜过只上单路的文档', () => {
    const fused = rrfFuse([
      [0, 1], // 向量路
      [0, 2], // 关键词路
    ]);
    // doc0 双路第一 ≈ 2/61;doc1/Doc2 各只上单路第 2 名 ≈ 1/62
    expect(fused.get(0)).toBeGreaterThan(fused.get(1) as number);
    expect(fused.get(0)).toBeGreaterThan(fused.get(2) as number);
    expect(fused.has(2)).toBe(true); // 单路独有候选也被保留
  });

  it('空输入返回空 Map', () => {
    expect(rrfFuse([]).size).toBe(0);
    expect(rrfFuse([[]]).size).toBe(0);
  });
});

describe('metaBoostScore(tag/region 规则 rerank)', () => {
  it('无命中不加分', () => {
    expect(metaBoostScore('随便逛逛', meta({ tags: ['爬山'], region: '市区' }))).toBe(0);
  });

  it('query 含 tag 加分,多个 tag 累加', () => {
    const one = metaBoostScore('想去爬山', meta({ tags: ['爬山'] }));
    const two = metaBoostScore('想去爬山看山水', meta({ tags: ['爬山', '山水'] }));
    expect(one).toBeGreaterThan(0);
    expect(two).toBeGreaterThan(one);
  });

  it('region 命中也有加分', () => {
    expect(metaBoostScore('井陉县怎么走', meta({ region: '井陉县' }))).toBeGreaterThan(0);
  });
});
