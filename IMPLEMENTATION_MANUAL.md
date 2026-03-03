# KOC Discovery 实施操作手册

本手册对应当前代码版本（含任务取消、MCP 网关、数据可信度评分）。

## 1. 目标

输入关键词后，系统自动在小红书 / YouTube / 抖音 / TikTok 搜索 KOC，并输出：

- 名称、粉丝量、赛道、联系方式（可提取到则输出）
- 质量评分（S/A/B/C/D）
- 数据可信度（0-100）
- CSV 导出

## 2. 你必须准备的资料（必填）

| 类别 | 必填项 | 说明 |
|---|---|---|
| 平台登录 | 小红书账号登录态 | 用于抓取小红书搜索与主页信息 |
| 平台登录 | 抖音账号登录态 | 用于抓取抖音搜索与主页信息 |
| 平台登录 | TikTok 账号登录态 | 用于抓取 TikTok 搜索与主页信息 |
| API Key | `YOUTUBE_API_KEY` | YouTube Data API v3 密钥 |
| 运行环境 | Node.js 20+ | 推荐 20/22 LTS |
| 浏览器 | Chromium（Playwright） | 首次需安装 Playwright 浏览器 |

## 3. 可选资料（MCP 模式）

如果你担心平台风控，建议启用 MCP 网关远端执行（浏览器不在本机跑）。

| 类别 | 可选项 | 说明 |
|---|---|---|
| MCP 网关 | `MCP_GATEWAY_URL` | 例如 `https://your-gateway.example.com` |
| MCP 鉴权 | `MCP_GATEWAY_TOKEN` | 网关 Bearer Token |
| 网关契约 | HTTP 接口 | 必须满足 [MCP_GATEWAY.md](/Users/cy-zhen/.gemini/antigravity/scratch/koc-discovery/MCP_GATEWAY.md) |

注意：本项目不强绑定某个 MCP 工具品牌，只要求网关实现固定契约。

## 4. 安装与启动（本地模式）

1. 安装依赖

```bash
npm install
```

2. 安装 Playwright Chromium

```bash
npx playwright install chromium
```

3. 配置环境变量

```bash
cp .env.example .env
```

至少填写：

- `YOUTUBE_API_KEY`
- 可按需调整 `TASK_TTL_MS`、`MAX_TASKS`

4. 启动服务

```bash
npm run dev
```

5. 访问

- `http://localhost:3000`

## 5. 启动与配置（MCP 模式）

1. 先准备并启动你的 MCP 网关服务（必须实现本项目约定的 `/platform/{platform}/{action}` 接口）。
2. 在 `.env` 中增加：

```env
MCP_GATEWAY_URL=https://your-gateway.example.com
MCP_GATEWAY_TOKEN=your_token_if_needed
```

3. 重启服务 `npm run dev`。
4. 前端“平台登录管理”中可看到 `mode: mcp`（表示走远端模式）。

## 6. 首次使用流程（运营同学）

1. 打开“平台登录管理”。
2. 对小红书/抖音/TikTok 完成登录（本地模式下会打开浏览器扫码）。
3. 输入关键词（如“运动鞋测评”）并选择平台。
4. 点击“开始搜索”，必要时可“取消搜索”。
5. 查看结果卡片：重点看 `质量评分 + 数据可信度 + 联系方式`。
6. 导出 CSV 给 BD / 投放团队。

## 6.1 关键词包含关系（已支持）

可直接在关键词输入框里用下面写法：

- `潮玩|盲盒|手办`：OR（包含任一词即可）
- `潮玩+盲盒`：AND（需要同时包含）
- `包含“潮玩”或包含“盲盒”`：自然语言 OR

说明：

- 平台本身不一定支持高级检索语法，系统会自动拆词多次搜索并在结果层做合并/筛选。

## 7. 你需要额外提供给研发/运维的信息

上线前请整理以下清单给技术侧：

- YouTube GCP 项目与 API Key（含配额策略）
- 三个平台的登录账号归属与轮换机制
- 是否使用 MCP 网关（是/否）
- 若使用 MCP：网关域名、Token、部署环境、限流规则
- 目标日调用量（决定限速和任务队列参数）
- 需要的导出字段（是否加品牌标签、地域、商务跟进状态）

## 8. 风控建议（务实版）

- 单账号限频：避免高并发同时抓取多个平台。
- 分时调度：错峰跑关键词批次。
- 账号池轮换：减少单账号被识别风险。
- 优先 MCP：将自动化执行放到独立基础设施，不与办公设备混跑。
- 对低可信度结果先人工复核，再用于合作决策。

## 9. API 与测试文档

- API 接口规范： [docs/API_SPEC.md](/Users/cy-zhen/.gemini/antigravity/scratch/koc-discovery/docs/API_SPEC.md)
- 测试集与验收用例： [tests/TESTSET.md](/Users/cy-zhen/.gemini/antigravity/scratch/koc-discovery/tests/TESTSET.md)
- 自动化 smoke 测试： [scripts/api_smoke_test.mjs](/Users/cy-zhen/.gemini/antigravity/scratch/koc-discovery/scripts/api_smoke_test.mjs)
