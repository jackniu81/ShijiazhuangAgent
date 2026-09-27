# 金标评估集(eval)使用指南

> 现势文档 · 对应 issue #58。回答两个问题:**怎么跑一轮质量回归**、**结果怎么看**。

## 1. 这是什么

固定 46 道题(42 chat + 4 plan,8 类目)锚定 `data/` 21 篇语料事实,通过 WebSocket 对运行中的 server 逐题实跑并自动判分,形成可回归的质量基线。

- 数据集:`server/src/eval/dataset/questions.json`(出题规则与校验见 `eval.types.ts`,jest 会守住其完整性)
- 判分:`eval.matcher.ts` —— 关键词断言(`keywords_all`/`keywords_any`/`forbid`)+ RAG 来源命中(`sources_any`);空白与大小写不敏感(`2元`≡`2 元`)
- 基线:`server/src/eval/baseline/*.json` —— 某轮完整报告的快照,后续轮次逐题 diff

## 2. 怎么跑

```powershell
# 1) 启动 server(任意 provider;建议快模型,见 docs/llm-providers.md 基准)
npm run start -w server

# 2) 另开终端:跑评估(对比最新基线)
npm run eval -w server

# 常用参数
node server\dist\eval\eval.main.js --out report.json        # 导出本轮报告
node server\dist\eval\eval.main.js --update-baseline        # 本轮结果固化为新基线
node server\dist\eval\eval.main.js --baseline path\to.json  # 指定对比基线
```

退出码:`0` 无回归 / `1` 存在回归(或无基线时有 FAIL)/ `2` 连接失败。单题超时默认 180s,可用 `EVAL_TIMEOUT_MS` 覆盖。

## 3. 什么时候更新基线

- 语料 `data/` 更新并同步核对题目后
- prompt / RAG / 模型选型变更且确认新表现是期望行为后
- 数据集版本(`questions.json.version`)变更时——不同版本的报告会被拒绝对比

## 4. 当前基线

| 基线 | provider | 结果 | 说明 |
|------|----------|------|------|
| `baseline-2026-09-27-mock.json` | mock | 10/46 | **harness 自检用**:mock provider 输出模板文,事实题预期 FAIL;用于验证 runner/判分/对比链路本身,不代表真实质量水位 |

真实质量水位基线(SiliconFlow 快模型)待环境验证阶段补充;免费池拥堵时单轮 46 题可能 30min+,建议先按 docs/llm-providers.md 基准切 `THUDM/GLM-4-9B-0414`。

## 5. 出题约定(维护数据集时遵守)

- 事实必须出自语料,`note` 写出处;语料更新须同步核对
- 数字类关键词只写核心位(`40` 而非 `40 元`),空白变体交给 normalize
- `robustness` 题允许仅 `forbid` 断言(防附和错误前提类)
- plan 题 `expect.days` 必须等于 `input.days`

## 6. 已知限制

- 未命中时不重试(LLM 有随机性,单轮 FAIL 需人工复核再固化基线)
- sources 判定依赖 chat:done 事件回传,plan 题暂无来源断言
- 串行执行,全量一轮耗时 = 46 × 单题延迟(mock 实测约 2 分钟)
