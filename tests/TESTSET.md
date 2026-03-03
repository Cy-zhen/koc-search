# 测试集（API + 业务验收）

## 1. 执行前提

- 服务已启动：`npm run dev`
- 默认地址：`http://127.0.0.1:3000`
- 若测 YouTube 正常结果：需要有效 `YOUTUBE_API_KEY`
- 若测小红书/抖音/TikTok：需要对应登录态或 MCP 网关

## 2. 自动化 Smoke（可直接执行）

```bash
npm run test:api:smoke
```

可选环境变量：

```bash
BASE_URL=http://127.0.0.1:3000 npm run test:api:smoke
```

覆盖点：

- 平台列表接口
- 登录状态接口
- 搜索 SSE 最小闭环（start/progress/done）
- 任务状态接口
- 任务取消接口（已完成状态幂等）
- CSV 导出接口

## 2.1 评分离线测试

```bash
npm run test:evaluator
```

基于 fixture 自动断言 `grade/confidence` 区间。

## 3. 业务验收测试集（手工）

| 用例ID | 关键词 | 平台 | 前置条件 | 期望结果 |
|---|---|---|---|---|
| BIZ-001 | 健身 | youtube | `YOUTUBE_API_KEY` 有效 | 返回 >0 KOC，含评分与可信度 |
| BIZ-002 | 美妆 | xiaohongshu | 已登录小红书 | 返回 KOC，至少部分含联系方式字段 |
| BIZ-003 | 数码评测 | douyin | 已登录抖音 | 可正常搜索并导出 CSV |
| BIZ-004 | running shoes | tiktok | 已登录 TikTok 或 MCP | 评分不再因点赞缺失全体偏低 |
| BIZ-005 | 健身 | 全平台 | 三平台登录 + YouTube key | `summary.avgConfidence` 正常输出 |
| BIZ-006 | 任意 | 全平台 | 搜索中点击取消 | 收到 `cancelled` 事件，保留已抓到数据 |
| BIZ-007 | 任意 | 未登录平台 | 未登录 xhs/douyin/tiktok | 对应平台返回 `AUTH_REQUIRED`，整体任务不中断 |

## 4. API 契约测试集

| 用例ID | 接口 | 请求 | 断言 |
|---|---|---|---|
| API-001 | `GET /api/platforms` | 无 | 返回数组，包含 `id/requiresLogin/loggedIn/mode` |
| API-002 | `GET /api/auth/youtube/status` | 无 | `loggedIn` 为布尔值 |
| API-003 | `GET /api/search` | `keyword=健身&platforms=youtube` | SSE 至少有 `start` 和 `done/cancelled` |
| API-004 | `GET /api/tasks/:id` | 用搜索返回 taskId | `status`、`summary` 字段存在 |
| API-005 | `POST /api/tasks/:id/cancel` | 用已完成 taskId | 成功返回，状态幂等 |
| API-006 | `POST /api/export` | 见 `fixtures/export_payload.json` | 返回 `text/csv`，含 `数据可信度` 列 |

## 5. 评分测试集（离线）

文件： [tests/fixtures/evaluator_cases.json](/Users/cy-zhen/.gemini/antigravity/scratch/koc-discovery/tests/fixtures/evaluator_cases.json)

目标：

- 验证互动率模式（engagement）评分区分
- 验证浏览量模式（reach）对 TikTok 可用
- 验证低质量数据会拉低 `confidence`
