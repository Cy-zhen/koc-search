# 修改日志

## 2026-03-05 (第九轮) — 小红书号（redId）提取 + 昵称时间戳清洗 + KOC 关键字段确认

**修改人**: Claude (Opus 4.6)

### 修复内容

#### 1. 用户名从内部 ID 改为真实小红书号

**问题**: `username` 字段一直使用内部 MongoDB ID（如 `672e068f000000001c01b6e1`），而非用户可见的小红书号（如 `26283376919`）。

**修复**:
- `getProfileData` 的 `__INITIAL_STATE__` 提取中新增 `basicInfo.redId` 字段
- `searchByNotes` 和 `searchByUsers` 构建 KOC 数据时，`username` 改为 `profileData.redId || userId`（有 redId 用 redId，没有则 fallback 到内部 ID）
- debug 日志 `profile_page_extracted` 增加 `redId` 字段

**涉及文件**: `server/platforms/xiaohongshu.js`

#### 2. 前端卡片新增小红书号展示

**修复**:
- KOC 卡片名称下方新增一行 `@username`，展示真实小红书号
- 新增 `.koc-username-row` 样式（灰色小字，溢出省略）

**涉及文件**: `public/app.js`, `public/styles.css`

#### 3. 昵称混入帖子时间戳问题

**问题**: DOM 锚点提取 `authorName` 时，锚点元素内的文本包含发布时间（如 `可爱的小蛋彤2025-01-17`、`一个雌鹰一样的女人昨天 23:12`），导致昵称和时间戳粘连。

**修复**:
- `collectNoteCards` 的 `pushCard` 中新增 `stripTimeTail()` 函数，自动剥离尾部时间戳
- 支持的时间格式：`2025-01-17`、`昨天 23:12`、`刚刚`、`3小时前`、`01-17`、`23:12` 等
- 剥离出的时间保存为 `publishTime` 字段，不丢弃
- `aggregateAuthorsFromNotes` 修复：不再"选更长名称"（可能选到带时间的脏数据），改为仅在现有为空时更新
- `__INITIAL_STATE__` 路径同步提取 `node.time / publish_time / create_time` 作为 `publishTime`

**涉及文件**: `server/platforms/xiaohongshu.js`

#### 4. CSV 导出优化

**修复**:
- 列名 `用户名` 改为 `小红书号/用户名`
- 新增 `帖子发布时间` 列，单独记录各帖子的发布时间（`|` 分隔）
- 两个导出接口（GET `/api/export/:taskId` 和 POST `/api/export`）同步修改

**涉及文件**: `server/index.js`

#### 4. 确认 KOC 关键字段数据链路

用户需求的 4 个核心字段均已通过 `__INITIAL_STATE__` 提取并贯通前端 + CSV 导出：

| 字段 | 数据源 | 前端展示 | CSV 列名 |
|------|--------|----------|----------|
| 名称 | `basicInfo.nickname` | 卡片标题 | `名称` |
| 小红书号 | `basicInfo.redId` | `@xxx` 行 + 弹窗 | `小红书号/用户名` |
| 总粉丝量 | `interactions[type=fans].count` | 粉丝统计 | `粉丝数` |
| 总获赞数 | `interactions[type=interaction].count` | 获赞统计 | `获赞数` |

### 注意

- 只有成功访问 profile 页面的 KOC 才能获取到真实小红书号，超出 `maxProfileFetchesPerRun` 限制或被风控拦截的仍会 fallback 显示内部 ID
- 总粉丝量和总获赞数的提取在第五轮已通过 `__INITIAL_STATE__` 实现

### 验证

- `node --check server/platforms/xiaohongshu.js`

---

## 2026-03-05 (第八轮) — 登录误判修复（扫码前不再提前成功）

**修改人**: Codex

### 修复内容

#### 1. 自动成功判定改为“严格 + 稳定”双条件

**问题**: `npm run login:xhs` 存在扫码未完成即返回“登录成功”的误判风险。

**修复**:
- 自动判定成功（`auto_validation`）现在必须同时满足：
  - 搜索探测通过（`validation.ok`）
  - 当前活跃页不在登录相关 URL（非 `/login`、`/website-login/*`、协议页）
  - 页面无登录/验证码提示文案
  - 有效登录 Cookie 已就绪（`web_session` + `a1/id_token`）
- 并且上述严格条件需**连续 2 次轮询通过**才返回成功，避免瞬时抖动导致误判。

**涉及文件**: `server/auth/xiaohongshu-login.js`

#### 2. 手动关闭窗口分支加上登录 Cookie 强校验

**问题**: 旧逻辑在“窗口关闭”分支只看探测结果，可能出现误判成功。

**修复**:
- `manual_window_close` 分支新增 `hasValidAuthCookie` 必要条件；
- 只有“探测通过 + 有效登录 Cookie”才会保存 cookie 并返回成功。

**涉及文件**: `server/auth/xiaohongshu-login.js`

#### 3. 增强登录日志用于复盘

**修复**:
- `login_probe_validation` 增加字段：
  - `hasAuthCookie`
  - `strictReady`
  - `stableAuthPassCount`
  - `activeUrl`
- `login_cookie_detected` / `login_final_validation` 增加关键认证 Cookie 摘要（脱敏前缀）。

**涉及文件**: `server/auth/xiaohongshu-login.js`

### 验证

- `node --check server/auth/xiaohongshu-login.js`

---

## 2026-03-05 (第七轮) — 0 结果修复（笔记抓取增加状态树回退）+ 登录态稳定性增强

**修改人**: Codex

### 修复内容

#### 1. 解决“已登录但 notes 模式一直 0 条”问题

**问题**: 搜索页 DOM 结构变化后，`collectNoteCards` 仅依赖 `a[href*="/user/profile/"]` 的方案可能拿不到任何卡片，导致 `notes_collected` 长期为 0。

**修复**:
- 保留原 DOM anchor 抓取
- 当 DOM 抓取结果为 0 时，新增 `window.__INITIAL_STATE__` 回退提取：
  - 递归扫描状态树中的笔记节点（title/note/user/author/likes 等特征）
  - 自动组装 `authorId/authorUrl/noteId/noteUrl/title/likes`
  - 统一去重后并入笔记卡片结果

**涉及文件**: `server/platforms/xiaohongshu.js`

#### 2. 登录态判定增加 recent meta 兜底

**问题**: `isLoggedIn()` 在 cookie 存在但探测请求偶发失败时，可能误判未登录。

**修复**:
- `isLoggedIn()` 保持“cookie + 探测”主路径
- 探测失败时，增加 `xiaohongshu.meta.json` 的最近成功登录兜底（24h）

**涉及文件**: `server/platforms/xiaohongshu.js`

### 验证

- `node --check server/platforms/xiaohongshu.js`
- `node --check server/auth/xiaohongshu-login.js`
- `npm run -s test:evaluator`

## 2026-03-05 (第六轮) — 登录回归修复（扫码成功自动完成）+ 登录态探测加固

**修改人**: Codex

### 修复内容

#### 1. 修复扫码后必须手动关窗口才会成功的问题

**问题**: 登录流程之前仅在“浏览器窗口被关闭”时才做最终校验，导致即使用户已扫码成功，也会一直轮询到超时（`login_timeout`）。

**修复**:
- 登录轮询中新增定时主动校验（默认每 6 秒）：
  - 成功访问小红书搜索结果页且无登录/验证码提示时，立即判定登录成功
  - 自动保存 cookie，并写入 `verified: true` 的 meta
- 不再要求“必须手动关闭窗口”才返回成功
- 新增直接登录入口 URL 优先打开：`/login?redirectPath=/explore`

**涉及文件**: `server/auth/xiaohongshu-login.js`

#### 2. 修复“仅凭 cookie 误判已登录”导致无法重新扫码

**问题**: `isLoggedIn()` 仅检查 cookie 是否存在，可能把无效/游客态误判为已登录，前端会显示“已连接”，但实际无法正常抓取 KOC。

**修复**:
- `isLoggedIn()` 改为双重检查：
  - 先检查 auth cookie
  - 再主动探测搜索页可访问性（无登录提示、无验证码、确实在搜索结果页）
- 搜索开始前增加登录态预检：
  - 失效时直接返回明确错误“请重新扫码登录”，不再静默跑出 0 结果

**涉及文件**: `server/platforms/xiaohongshu.js`

### 验证

- `node --check server/auth/xiaohongshu-login.js`
- `node --check server/platforms/xiaohongshu.js`
- `npm run -s test:evaluator`

## 2026-03-05 (第五轮) — Profile 数据提取重构 + 粉丝过滤修正

**修改人**: Claude (Opus 4.6)

### 修复内容

#### 1. Profile 数据提取从 DOM 正则改为 `__INITIAL_STATE__` 提取

**问题**: `getProfileData` 使用 `innerText` + 正则匹配页面文本中的"粉丝"/"关注"/"获赞"行来提取数据，但小红书前端更新后页面文本结构变化，导致正则全部匹配失败 → 所有 profile 页面返回 `followers: ""`, `following: ""`, `likes: ""`，最终解析为 0。

**修复**:
- **优先从 `window.__INITIAL_STATE__`** 提取数据（这是小红书 Vue SSR 注入的结构化 JSON，远比 DOM 文本稳定）
- 数据路径: `__INITIAL_STATE__.user.userPageData.basicInfo`（昵称/简介/头像）+ `interactions`（粉丝/关注/获赞）
- `interactions` 数组中 `type: 'fans'` = 粉丝, `type: 'follows'` = 关注, `type: 'interaction'` = 获赞与收藏
- 同时从 `state.user.notes[0]` 提取最近笔记列表
- 保留原 DOM 正则解析作为 fallback（万一 `__INITIAL_STATE__` 不存在）
- 日志中新增 `source` 字段标记数据来源（`__INITIAL_STATE__` / `dom_fallback`）

**涉及文件**: `server/platforms/xiaohongshu.js`

#### 2. 撤回过严的 minFollowers 过滤

**问题**: 第四轮 Codex 将 minFollowers 过滤改为 `followers < minFollowers`（不检查 `followers > 0`）。当 profile 提取失败导致 followers=0 时，所有 KOC 都被过滤掉 → 首页显示 0 条结果。

**修复**:
- 笔记模式和用户模式的三处 minFollowers 过滤统一恢复为 `followers > 0 && followers < minFollowers`
- 即：粉丝数未知（=0）的 KOC 不会被最小粉丝阈值拦截，仅已知粉丝数的才过滤
- maxFollowers 过滤保持不变（已有 `followers > 0` 条件）

**涉及文件**: `server/platforms/xiaohongshu.js`

### 验证

- `node --check server/platforms/xiaohongshu.js`

---

## 2026-03-05 (第四轮) — 最小粉丝过滤修正 + 二次验证扫码等待

**修改人**: Codex

### 修复内容

#### 1. 最小粉丝数过滤改为严格生效

**问题**: 小红书分支原先使用 `followers > 0 && followers < minFollowers` 才过滤，导致粉丝数未取到/解析为 `0` 的账号不会被最小粉丝阈值拦截。

**修复**:
- 小红书 `notes` 模式和 `users` 模式统一改为 `followers < minFollowers` 直接过滤
- `users` 模式的卡片预过滤同步改为严格最小粉丝过滤
- 这样当你设置最小粉丝数时，不会再放进“粉丝数不达标”的账号

**涉及文件**: `server/platforms/xiaohongshu.js`

#### 2. 进入 profile 命中 captcha 时增加扫码等待窗口

**问题**: 命中 `website-login/captcha` 时，旧逻辑立即返回 `authLimited`，不会在同一次 profile 采集里等待人工扫码通过。

**修复**:
- 新增 `isCaptchaOrLoginUrl()` 与 `waitForCaptchaResolution()`：
  - 检测到验证码页后，轮询等待页面跳出验证码
  - 默认最多等待 `45s`，轮询间隔 `1.5s`
  - 扫码通过后继续当前 profile 解析；超时才降级为 `authLimited`
- 新增可调参数：
  - `XHS_CAPTCHA_WAIT_MS`（默认 `45000`）
  - `XHS_CAPTCHA_POLL_MS`（默认 `1500`）

**涉及文件**: `server/platforms/xiaohongshu.js`

#### 3. users 模式 `profileFetched` 标记修正

**问题**: `users` 模式 fallback 中 `profileFetched` 仍用 `shouldFetchProfile`，在验证码拦截时会误报“已抓取 profile”。

**修复**: 改为 `profileFetched: shouldFetchProfile && !profileData.authLimited`。

**涉及文件**: `server/platforms/xiaohongshu.js`

### 验证

- `node --check server/platforms/xiaohongshu.js`
- `npm run -s test:evaluator`

---

## 2026-03-04 (第三轮) — CSV导出修复 + 200结果 + Profile策略 + 评估优化

**修改人**: Claude (Opus 4.6)

### 修复内容

#### 1. CSV 导出 PayloadTooLargeError

**问题**: 导出 CSV 时前端发送完整 kocs 数据（含 `rawData`），超出 Express 默认 100KB body 限制，返回 HTML 错误页面而非 CSV。

**修复**:
- Express JSON body limit 从 100KB 提升至 `10mb`
- 前端导出时剥离 `rawData` 字段减少传输体积

**涉及文件**: `server/index.js`, `public/app.js`

#### 2. 最大结果数支持 200

**修复**: 前端 `maxResults` 下拉增加 100/150/200 选项。

**涉及文件**: `public/index.html`

#### 3. Profile 获取策略重构 — 头像和粉丝数

**问题**: `getProfileData` 每次打开**新 tab** 访问 profile，XHS 检测到异常立即触发 captcha → 第一次就被拦截 → 全部放弃。

**修复**:
- **复用当前页面导航**（原地 goto profile URL），模拟真人"点 profile → 返回"行为，降低风控触发率
- 被拦截后**不立即放弃**，等待 25-40 秒后重试，连续失败 3 次才彻底停止
- 每次 profile 获取间延迟从 6.5-9.5s 增加到 **8-13s**
- 进度条实时提示"触发风控，等待 Xs 后重试..."

**涉及文件**: `server/platforms/xiaohongshu.js`

#### 4. 质量评估优化（笔记模式适配）

**问题**: 笔记模式下 profile 数据缺失（followers=0, recentPosts=[]），5 个评分维度中有 3 个只能给默认低分，导致几乎所有 KOC 评分偏低。

**修复**:
- **动态权重**: 笔记模式下（有 noteAppearances 但无 followers），降低无数据维度权重（互动率 30%→10%, 粉丝适配 15%→5%），提升有数据维度（内容相关度 20%→40%, 活跃度 20%→30%）
- **互动率**: 无粉丝数时用 relatedPosts 的平均点赞数估算互动水平（>=1000 赞 85 分, >=500 赞 75 分...）
- **粉丝适配**: 未知粉丝数给中性分 55（原来落入 0-1000 区间给 50）
- **增长趋势**: 多次出现 + 高点赞 → 有增长潜力加分
- **数据质量**: relatedPosts 也算有效数据信号（不再全部判为 low）
- **标签**: 新增"高频创作"（>=3 次出现）、"深耕赛道"（>=2 次 + 相关度高）

**涉及文件**: `server/evaluator.js`

---

## 2026-03-04 (第二轮) — 粉丝数获取失败诊断与修复

**修改人**: Claude (Opus 4.6)

### 问题诊断

通过新增 debug 日志发现粉丝数读取不到的根因：

```
profile_fetch_auth_blocked: XHS 访问个人主页触发 captcha 验证
profile_access_blocked: 第 1 次 profile 获取就被拦截 → profileAccessBlocked = true
→ 后续所有作者全部跳过 profile 获取 → 粉丝数全部为 0
```

### 修复内容

#### 1. 修复 `dataQuality.profileFetched` 误判

**问题**: 当 profile 获取被 captcha 拦截时，`getProfileData` 返回 `authLimited: true` 但未设置 `dataQuality`。`searchByNotes` 中 fallback 使用 `profileFetched: shouldFetchProfile`（true），导致前端误认为 profile 已成功获取，粉丝数显示为 "0" 而非 "未获取"。

**修复**: 改为 `profileFetched: shouldFetchProfile && !profileData.authLimited`，auth 被拦截时正确标记为未获取。

**涉及文件**: `server/platforms/xiaohongshu.js` (L807-810)

#### 2. 新增 profile 获取阶段的 debug 日志

新增日志事件便于后续排查：
- `profile_loop_entry` — 每个作者进入 profile 循环时的状态
- `profile_fetch_start` — 开始获取 profile
- `profile_page_extracted` — profile 页面提取到的原始数据（粉丝数、关注数等）
- `profile_fetch_auth_blocked` — 被 captcha/登录拦截的重定向 URL
- `profile_access_blocked` — 标记 profile 获取被全局阻断

**涉及文件**: `server/platforms/xiaohongshu.js`

### 当前行为

- 搜索正常收集笔记并聚合作者
- 尝试获取前 5 个作者的 profile（粉丝数等）
- 如果被 XHS captcha 拦截，自动降级：粉丝数显示"未获取"
- 其他笔记数据（帖子标题、点赞数等）不受影响

---

## 2026-03-04 (第一轮) — 笔记模式 Bug 修复

**修改人**: Claude (Opus 4.6) + cy-zhen

### 修复内容

#### 1. 自己的账户出现在搜索结果中

**问题**: 笔记模式搜索时，`collectNoteCards` 使用 `a[href*="/user/profile/"]` 匹配页面上所有作者链接，会把登录用户自己（导航栏/侧边栏中的个人资料链接）也当作搜索结果收录。

**修复**: 新增 `detectSelfUserId(page)` 方法，从页面导航区域或 `__INITIAL_STATE__` 检测当前登录用户 ID，在 `searchByNotes` 聚合作者后将其过滤掉。

**涉及文件**: `server/platforms/xiaohongshu.js`

#### 2. 笔记模式粉丝数缺失

**问题**: 笔记卡片不包含粉丝数信息，粉丝数只能通过访问个人主页获取。但 `maxProfileFetchesPerRun` 默认值为 2，导致只有前 2 个作者有粉丝数据，其余全部显示为 0。

**修复**:
- `maxProfileFetchesPerRun` 默认值从 `2` 提升为 `5`（可通过环境变量 `XHS_MAX_PROFILE_FETCHES` 调整）
- 前端新增 `formatFollowers(koc)` 函数：当粉丝数为 0 且 `dataQuality.profileFetched === false` 时，显示"未获取"而非"0"

**涉及文件**: `server/platforms/xiaohongshu.js`, `public/app.js`

#### 3. 撤回过激的 DOM 层过滤

**问题**: 初次修复时在 `collectNoteCards` 中加了 `anchor.closest('header, nav, [class*="sidebar"]...')` 过滤，但小红书笔记卡片本身可能在含这些 class 的容器内，导致所有笔记被过滤为 0。

**修复**: 撤回 DOM 层过滤，仅保留 `detectSelfUserId` 的逻辑层过滤。

**涉及文件**: `server/platforms/xiaohongshu.js`

#### 4. 登录态过期导致搜索结果为 0

**问题**: 修复过程中小红书登录态（`web_session` cookie）过期，`isLoggedIn()` 只检查 cookie 是否存在不验证有效性，因此 API 返回 `loggedIn: true` 但实际页面弹出登录弹窗，导致 `collectNoteCards` 采集不到任何笔记。

**处理**: 重新调用 `POST /api/auth/xiaohongshu/login` 完成登录后恢复正常。

---

### 注意事项

- 如果搜索结果量大时粉丝数仍不够，可通过环境变量增加：`XHS_MAX_PROFILE_FETCHES=10`
- 但值设太高会增加触发小红书风控/登录弹窗的风险
- 登录状态过期需要重新通过 `POST /api/auth/xiaohongshu/login` 完成登录
- `isLoggedIn()` 仅检查 cookie 存在性，不验证有效性，后续可考虑增强
