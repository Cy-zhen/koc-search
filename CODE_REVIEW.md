# KOC Discovery Tool — 完整代码审查文档

> 供 Codex 审查：**可用性、可维护性、边界条件、回归风险**

---

## 1. 项目概览

多平台 KOC（Key Opinion Consumer）智能发现工具。用户输入关键词，自动在小红书、YouTube、抖音、TikTok 搜索 KOC，采集信息并评估质量。

**技术栈**: Node.js + Express + Playwright + 原生前端 (HTML/CSS/JS)  
**运行方式**: `npm run dev` → `http://localhost:3000`

---

## 2. 项目文件清单与职责

```
koc-discovery/
├── package.json                          # 项目配置 (ESM, 5个依赖)
├── .env.example                          # 环境变量模板
├── .gitignore                            # 忽略 node_modules, data/, .env
├── server/
│   ├── index.js              (331行)     # Express 服务入口 + SSE + API 路由
│   ├── browser-manager.js    (132行)     # Playwright 浏览器单例管理
│   ├── evaluator.js          (240行)     # KOC 5维质量评估引擎
│   └── platforms/
│       ├── base.js           (142行)     # 平台适配器抽象基类
│       ├── youtube.js        (173行)     # YouTube Data API v3 适配器
│       ├── xiaohongshu.js    (347行)     # 小红书 Playwright 适配器
│       ├── douyin.js         (352行)     # 抖音 Playwright 适配器
│       └── tiktok.js         (355行)     # TikTok Playwright 适配器
├── public/
│   ├── index.html            (224行)     # 前端页面结构
│   ├── styles.css           (1093行)     # 深色玻璃态样式系统
│   └── app.js               (673行)     # 前端交互逻辑
└── data/                                 # 运行时数据 (cookies, exports)
```

---

## 3. 模块详细说明

---

### 3.1 `server/index.js` — Express 服务入口

**依赖**: express, uuid, csv-stringify, dotenv, 所有平台适配器, evaluator

#### API 路由

| 方法 | 路径 | 功能 | 返回格式 |
|------|------|------|----------|
| GET | `/api/platforms` | 获取平台列表及登录状态 | JSON Array |
| POST | `/api/auth/:platform/login` | 触发平台登录流程 | `{success, message}` |
| GET | `/api/auth/:platform/status` | 检查平台登录状态 | `{loggedIn}` |
| GET | `/api/search?keyword=...&platforms=...` | 启动搜索任务 (SSE) | text/event-stream |
| GET | `/api/export/:taskId` | 通过 taskId 导出 CSV | text/csv |
| POST | `/api/export` | 客户端直接传数据导出 CSV | text/csv |

#### SSE 事件类型

| type | 字段 | 说明 |
|------|------|------|
| `start` | taskId, totalPlatforms | 搜索任务开始 |
| `platform_start` | platform, icon, name, index | 某平台开始搜索 |
| `progress` | overallProgress, message, kocs | 搜索进度更新（含已发现KOC） |
| `platform_done` | platform | 某平台搜索完成 |
| `platform_error` | platform, error | 某平台搜索出错 |
| `done` | totalKocs, kocs, duration | 全部搜索完成 |

#### 关键逻辑
- **平台注册**: 硬编码 4 个平台实例到 `platforms` 对象
- **任务存储**: 使用 `Map()` 存储搜索任务（内存中，无持久化）
- **搜索流程**: 依次（非并行）遍历选中的平台，对每个平台的 `search()` 异步迭代器消费结果
- **评估时机**: 在 SSE progress 推送前对每个新发现的 KOC 调用 `evaluateKOC()`
- **优雅关闭**: 监听 SIGINT，关闭所有浏览器上下文

---

### 3.2 `server/browser-manager.js` — Playwright 浏览器管理

**模式**: 单例 (module-level `new BrowserManager()`)

#### 类: `BrowserManager`

| 方法 | 参数 | 功能 |
|------|------|------|
| `getBrowser()` | — | 获取/创建 Chromium 浏览器实例 |
| `getContext(platform)` | platform: string | 获取/创建平台专属浏览器上下文 |
| `saveCookies(platform)` | platform: string | 将平台 Cookie 持久化到 `data/cookies/{platform}.json` |
| `newPage(platform)` | platform: string | 创建新页面，附带 `randomDelay()` 和 `humanScroll()` 辅助方法 |
| `closeContext(platform)` | platform: string | 关闭指定平台的上下文（先保存 Cookie） |
| `closeAll()` | — | 关闭所有上下文和浏览器 |

#### 反检测措施
- `navigator.webdriver` 设为 `false`
- `navigator.plugins` 伪造为 `[1,2,3,4,5]`
- `navigator.languages` 设为 `['zh-CN', 'zh', 'en']`
- `window.chrome = { runtime: {} }`
- 浏览器启动参数: `--disable-blink-features=AutomationControlled`, `--no-sandbox`

#### Cookie 管理
- 路径: `data/cookies/{platform}.json`
- 加载: 上下文创建时自动加载（如存在）
- 保存: `closeContext()` 时自动保存；`login()` 成功后手动调用

---

### 3.3 `server/evaluator.js` — KOC 质量评估引擎

#### 主函数: `evaluateKOC(kocData, keyword)`

**输入**: 标准化的 KOC 数据对象 + 搜索关键词  
**输出**:
```json
{
  "totalScore": 72.5,
  "grade": "A",
  "scores": { "engagementRate": 85, "followerFit": 95, ... },
  "tags": ["优质KOC", "高互动", "有联系方式"],
  "recommendation": "✅ 推荐合作，综合表现良好"
}
```

#### 5 个评分维度

| 维度 | 权重 | 评分函数 | 评分逻辑摘要 |
|------|------|----------|-------------|
| 互动率 | 30% | `scoreEngagementRate()` | 根据 engagement rate 划分5档: <1%→35, 1-3%→55, 3-6%→70, 6-10%→85, >10%→100 |
| 粉丝适配 | 15% | `scoreFollowerFit()` | 按粉丝区间匹配: 1k-5k→100, 5k-10k→95, 10k-50k→85, 50k-100k→65, 100k-500k→40, 500k+→20, <1k→50 |
| 活跃度 | 20% | `scoreActivityLevel()` | 若有 recentPosts 则算平均发帖间隔；否则按总帖数给估计分 |
| 相关度 | 20% | `scoreContentRelevance()` | 关键词在描述/分类/近期帖标题中的匹配比率 |
| 增长趋势 | 15% | `scoreGrowthTrend()` | 优先用 growthRate；降级用 likes/followers 比值估计 |

#### 等级划分
- S: ≥85, A: ≥70, B: ≥55, C: ≥40, D: <40

#### 标签生成规则 (`generateTags`)
- 粉丝 1k-50k → "优质KOC"；>50k → "KOL"
- 各维度 ≥80/85 → 对应标签（高互动/高活跃/强相关/粉丝适配/增长快）
- 有联系方式 → "有联系方式"

---

### 3.4 `server/platforms/base.js` — 平台适配器基类

#### 抽象方法（子类必须实现）

| 方法 | 签名 | 说明 |
|------|------|------|
| `search()` | `async *search(keyword, options)` | AsyncGenerator，yield `{progress, kocs, message?, error?}` |
| `getProfile()` | `async getProfile(userId)` | 获取用户详情 |
| `isLoggedIn()` | `async isLoggedIn()` | 检查登录状态 |
| `login()` | `async login()` | 触发登录流程 |

#### 工具方法

| 方法 | 功能 |
|------|------|
| `normalizeData(rawData)` | 将原始数据标准化为统一格式（含 contactInfo 提取） |
| `extractContactInfo(text)` | 从文本提取邮箱/微信/手机/QQ/Instagram/Telegram |
| `parseCount(str)` | 解析中文数字缩写（1.2万→12000, 3.5k→3500, 2亿→200000000） |

#### 联系方式提取正则

| 类型 | 正则模式 |
|------|----------|
| 邮箱 | `[\w.+-]+@[\w-]+\.[\w.]+` |
| 微信 | `(?:微信\|wx\|wechat\|V信\|v信\|薇信\|WX)[：:号]?\s*([a-zA-Z0-9_-]{5,20})` |
| 手机 | `1[3-9]\d{9}` |
| QQ | `(?:QQ\|qq)[：:号]?\s*(\d{5,12})` |
| Instagram | `(?:ins\|ig\|instagram)[：:]?\s*@?([a-zA-Z0-9_.]+)` |
| Telegram | `(?:tg\|telegram)[：:]?\s*@?([a-zA-Z0-9_]+)` |

---

### 3.5 `server/platforms/youtube.js` — YouTube 适配器

**数据来源**: YouTube Data API v3（HTTP fetch，无 Playwright）  
**认证方式**: 环境变量 `YOUTUBE_API_KEY`

#### 方法

| 方法 | 功能 |
|------|------|
| `search(keyword, options)` | 搜索频道 → 批量获取详情 → 逐个获取近期视频 → yield 结果 |
| `getRecentVideos(channelId)` | 获取频道最近5个视频的统计数据 |
| `isLoggedIn()` | 检查 API Key 是否已配置 |
| `login()` | 返回提示需配置 API Key |

#### API 调用链
1. `search?q={keyword}&type=channel` → 获取频道列表
2. `channels?id={ids}&part=snippet,statistics,brandingSettings` → 批量获取频道详情
3. `search?channelId={id}&type=video&order=date&maxResults=5` → 获取近期视频 ID
4. `videos?id={ids}&part=statistics,snippet` → 获取视频统计

#### 注意
- `likes` 字段实际映射的是 `viewCount`（频道总播放量），不是 YouTube 的"喜欢"
- `following` 始终为 0（YouTube 不提供此数据）
- `category` 使用 `brandingSettings.channel.keywords`，降级为描述前30字

---

### 3.6 `xiaohongshu.js` / `douyin.js` / `tiktok.js` — Playwright 适配器

三者结构高度一致，差异在于：URL、选择器、分类关键词。

#### 通用流程

```
login()     → 打开平台首页 → 等待用户扫码(120s) → 保存Cookie → 返回结果
isLoggedIn()→ 打开首页 → 检测头像元素是否存在
search()    → 1. 打开搜索页 (5%)
              2. 切换到"用户"标签 (15%)
              3. 滚动收集用户卡片 (15%-45%, 最多8次无新增则停)
              4. 逐个访问用户主页获取详情 (45%-95%)
              5. 返回最终结果 (100%)
```

#### 小红书特有
- 搜索 URL: `xiaohongshu.com/search_result?keyword=...&type=1`
- 主页 URL: `xiaohongshu.com/user/profile/{userId}`
- 中文分类体系: 美妆/穿搭/美食/旅行/健身/母婴/数码/家居/宠物/学习
- `getProfileData()` 内会为每个用户打开新 page 并抓取详情

#### 抖音特有
- 搜索 URL: `douyin.com/search/{keyword}?type=1`
- 主页 URL: `douyin.com/user/{userId}`
- 中文分类体系: 美妆/穿搭/美食/旅行/健身/搞笑/知识/音乐/舞蹈/游戏

#### TikTok 特有
- 搜索 URL: `tiktok.com/search/user?q={keyword}`
- 主页 URL: `tiktok.com/@{userId}`
- 英文分类体系: Beauty/Fashion/Food/Travel/Fitness/Comedy/Education/Music/Dance/Gaming/Tech
- 浏览器上下文使用 `en-US` locale 和 `America/New_York` 时区

---

### 3.7 `public/app.js` — 前端逻辑

#### 全局状态 (`state`)
```js
{ keyword, selectedPlatforms, kocs[], taskId, searching, currentFilter, currentSort }
```

#### 核心函数

| 函数 | 功能 |
|------|------|
| `init()` | 绑定所有事件监听器（搜索/平台选择/标签/排序/导出/模态框/键盘） |
| `startSearch()` | 发起 GET `/api/search` → ReadableStream 读取 SSE → 解析并分发事件 |
| `handleSSEEvent(data)` | 根据 type 分发到不同处理函数 |
| `updateProgress(data)` | 更新进度条 + 增量收集 KOC 到 state |
| `handleSearchDone(data)` | 用最终 kocs 替换 state → 显示结果区域 |
| `renderKocs()` | 根据当前 filter/sort 渲染 KOC 卡片网格（含入场动画） |
| `createKocCard(koc)` | 创建单个 KOC 卡片 DOM 元素 |
| `openDetailModal(koc)` | 显示 KOC 详情模态框（含各维度评分条） |
| `openAuthModal()` | 从 `/api/platforms` 获取状态并渲染登录管理面板 |
| `exportCSV()` | POST `/api/export` → 下载 Blob 为 CSV 文件 |
| `formatCount(num)` | 数字格式化: >=1亿→X亿, >=1万→X万, >=1000→Xk |
| `escapeHtml(str)` | XSS 防护: 使用 DOM textContent → innerHTML 转义 |

---

### 3.8 `public/index.html` — 页面结构

| 区域 | ID | 说明 |
|------|-----|------|
| Header | `header` | Logo + 平台登录按钮 |
| 搜索面板 | `searchSection` | 关键词输入 + 平台选择chips + 筛选条件 |
| 进度面板 | `progressSection` | spinner + 进度条 + 平台状态chips + 消息 (默认 hidden) |
| 结果区域 | `resultsSection` | 统计卡片 + 筛选标签 + 排序 + 导出 + KOC 网格 (默认 hidden) |
| 详情模态框 | `modalOverlay` | KOC 详情弹窗 (默认 hidden) |
| 登录模态框 | `authOverlay` | 平台登录管理弹窗 (默认 hidden) |

---

### 3.9 `public/styles.css` — 样式系统 (1093行)

| 模块 | 行范围 | 说明 |
|------|--------|------|
| CSS 变量 | 1-42 | 颜色/阴影/圆角/过渡等设计令牌 |
| Reset | 44-58 | 全局重置 + body 基础样式 |
| 背景光晕 | 60-72 | body::before 径向渐变装饰 |
| Glass Card | 82-95 | 毛玻璃卡片基类 (backdrop-filter) |
| Header | 97-137 | 固定顶部导航 |
| Buttons | 139-196 | primary/secondary/ghost 三种按钮样式 |
| Search | 198-351 | 搜索输入框/平台chips/筛选网格 |
| Progress | 353-466 | 进度条/spinner/平台状态chips +动画 |
| Stats | 467-497 | 4列统计卡片 |
| Toolbar | 499-570 | 结果筛选标签/排序下拉 |
| KOC Grid | 572-765 | 自适应网格 + 卡片样式 + 评分条 + 标签 |
| Modal | 767-994 | 详情弹窗 + 评分条式雷达图 + 联系方式 + 推荐 |
| Auth Modal | 996-1069 | 登录管理弹窗 |
| Responsive | 1076-1093 | 768px/480px 两个断点 |

---

### 3.10 配置文件

#### `package.json`
```json
{
  "type": "module",
  "scripts": { "dev": "node server/index.js", "start": "node server/index.js" },
  "dependencies": {
    "express": "^4.18.2",
    "playwright": "^1.42.0",
    "csv-stringify": "^6.4.0",
    "dotenv": "^16.4.0",
    "uuid": "^9.0.0"
  }
}
```

#### `.env.example`
```env
YOUTUBE_API_KEY=your_youtube_api_key_here
PORT=3000
BROWSER_HEADLESS=false
BROWSER_SLOW_MO=100
```

---

## 4. 数据流

```
用户输入关键词 → 前端 GET /api/search (SSE)
    → server/index.js 依次遍历各平台
        → platform.search() (AsyncGenerator)
            → [YouTube] fetch API
            → [XHS/DY/TK] Playwright 打开搜索页 → 滚动收集 → 逐个访问主页
        → evaluateKOC() 评估每个 KOC
        → SSE 推送 progress/done
    → 前端 renderKocs() 渲染卡片
    → 用户点击卡片 → openDetailModal()
    → 用户点击导出 → POST /api/export → 下载 CSV
```

---

## 5. 已知限制与风险提示

### 可用性风险
1. **平台选择器脆弱**: Playwright 适配器使用 CSS 选择器抓取数据，平台前端改版会导致全面失败
2. **登录依赖人工**: 小红书/抖音/TikTok 需用户手动扫码，120秒超时
3. **无并发搜索**: 平台顺序搜索，4平台各20个KOC可能耗时数分钟
4. **Cookie 过期**: 没有自动检测/刷新机制，过期后静默失败

### 可维护性风险
1. **三个 Playwright 适配器高度重复**: xiaohongshu/douyin/tiktok 代码结构几乎相同（search/getProfileData/inferCategory），应抽取公共基类
2. **选择器硬编码**: 所有 CSS 选择器散落在代码中，无集中管理
3. **无测试**: 没有单元测试或集成测试
4. **无日志系统**: 仅 console.log/warn，无结构化日志

### 边界条件
1. **`parseCount`**: 输入 `null`/`undefined`/空字符串 → 返回 0 ✅; 输入 `"abc"` → 返回 0 ✅; 输入 `"1.2万万"` → 仅匹配第一个万 ⚠️
2. **`scoreEngagementRate`**: 当 `followers=0` 时返回 50 ✅; 当 `rate` 为 NaN 时走 fallback ✅
3. **`scoreFollowerFit`**: `IDEAL_FOLLOWER_RANGES` 中 `{min:0, max:1000}` 排在最后，但 `for...of` 遍历时 `{min:500000, max:Infinity}` 会先匹配到 500k+ 的用户 ✅; 粉丝正好等于区间边界值(如 5000) → 匹配到 `{min:5000, max:10000, score:95}` ✅
4. **`extractContactInfo`**: 多个邮箱只取第一个; 微信号正则要求5-20位，过短的会漏掉
5. **SSE 缓冲**: 前端用 `buffer.split('\n')` 处理，但 SSE 标准分隔符是 `\n\n`，当前靠 `data: ` 前缀判断可能在极端情况下拼接不完整消息
6. **`tasks` Map 无清理**: 内存泄漏风险，长期运行会积累所有历史搜索结果
7. **CSV 导出 XSS/注入**: CSV 单元格未转义，含 `=` 或 `,` 的内容可能导致公式注入
8. **并发搜索请求**: 多用户同时搜索时共享 BrowserManager 单例，可能产生上下文冲突

### 回归风险
1. **平台 URL 变更**: 小红书/抖音/TikTok 的搜索 URL 格式任何变化都会导致对应适配器完全失效
2. **API 限流**: YouTube Data API 有每日配额限制，大量搜索可能触发 403
3. **Playwright 版本升级**: 反检测脚本可能与新版 Playwright 不兼容
4. **evaluator 权重调整**: 修改 WEIGHTS 或阈值会影响所有历史数据的可比性
5. **Express 静态文件服务**: 无版本化，browser cache 可能导致前端更新不生效
6. **前端 `escapeHtml`**: 使用 DOM API 转义，在无 DOM 环境（如 SSR）下会报错

---

## 6. 源代码文件引用

以下是项目中所有源代码文件的完整路径，审查时可直接打开查看：

| 文件 | 路径 |
|------|------|
| 服务入口 | `server/index.js` |
| 浏览器管理 | `server/browser-manager.js` |
| 评估引擎 | `server/evaluator.js` |
| 适配器基类 | `server/platforms/base.js` |
| YouTube | `server/platforms/youtube.js` |
| 小红书 | `server/platforms/xiaohongshu.js` |
| 抖音 | `server/platforms/douyin.js` |
| TikTok | `server/platforms/tiktok.js` |
| 前端HTML | `public/index.html` |
| 前端CSS | `public/styles.css` |
| 前端JS | `public/app.js` |
| 项目配置 | `package.json` |
| 环境变量 | `.env.example` |
