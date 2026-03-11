# 笔记发现模式 — Codex 实施规范

## 背景

当前 KOC 搜索只用小红书「用户」标签，按昵称匹配关键词。但真正的 KOC 不会把行业词写在昵称里（如搜"潮玩"只能找到"潮玩xxx"这类用户）。需要新增「笔记发现」模式：**搜帖子 → 提取作者 → 去重排序 → 获取资料**。

---

## 涉及文件

| 文件 | 改动量 | 说明 |
|---|---|---|
| `server/platforms/xiaohongshu.js` | 大 | 核心搜索逻辑 |
| `server/index.js` | 小 | API 参数透传 |
| `public/index.html` | 小 | UI 选择器 |
| `public/app.js` | 中 | 前端状态 + 展示 |
| `server/evaluator.js` | 小 | 评分增强 |

---

## 一、`server/platforms/xiaohongshu.js` 改动

### 1.1 新增 `focusNoteTab(page)` 方法

插入位置：`focusUserTab()` 方法之后（当前 L601-627）

```javascript
async focusNoteTab(page) {
    // 小红书搜索默认展示笔记/综合标签，尝试确认或点击
    const tabCandidates = [
        page.locator('[role="tab"]').filter({ hasText: /^笔记$/ }).first(),
        page.locator('button').filter({ hasText: /^笔记$/ }).first(),
        page.locator('a').filter({ hasText: /^笔记$/ }).first(),
        page.locator('div,span,li').filter({ hasText: /^笔记$/ }).first(),
        page.locator('[role="tab"]').filter({ hasText: /^综合$/ }).first(),
        page.locator('button').filter({ hasText: /^综合$/ }).first(),
    ];

    for (const locator of tabCandidates) {
        try {
            if (await locator.isVisible({ timeout: 1200 })) {
                await locator.click({ timeout: 2500 });
                await this.wait(1500);
                this.writeDebugLog('note_tab_clicked', { url: page.url() });
                return true;
            }
        } catch { /* continue */ }
    }

    // 默认页面已经是笔记标签
    this.writeDebugLog('note_tab_assumed_default', { url: page.url() });
    return true;
}
```

### 1.2 新增 `collectNoteCards(page)` 方法

插入位置：`collectUserCards()` 方法之后（当前 L629-842）

功能：在笔记搜索结果页面内，通过 `page.evaluate()` 提取帖子卡片。

每张卡片返回结构：
```javascript
{
    authorId: string,      // 从 a[href*="/user/profile/xxx"] 提取
    authorName: string,    // 作者昵称
    authorUrl: string,     // 作者主页链接
    title: string,         // 帖子标题
    likes: string,         // 点赞数（原始文本，如 "1.2万"）
    thumbnail: string,     // 缩略图 URL
    noteUrl: string,       // 帖子链接
    textPreview: string,   // 正文摘要（前 200 字）
}
```

实现要点：
- 在页面内找所有 `a[href*="/user/profile/"]` 锚点
- 向上遍历 DOM 找到合适的卡片容器（有标题+互动数+图片的区域）
- 从卡片容器中提取标题（`.title, [class*="title"], h3, h4`）
- 从卡片容器中提取点赞数（`[class*="like"], [class*="count"]` 或正则匹配文本中的数字）
- 从卡片容器中提取缩略图（`img` 元素）
- 从卡片容器中提取笔记链接（`a[href*="/explore/"]` 或 `a[href*="/discovery/"]`）
- 兜底策略：如果精确选择器找不到卡片，遍历所有含作者链接且文字长度 > 10 的 DOM 区域

### 1.3 新增 `aggregateAuthorsFromNotes(noteCards)` 方法

插入位置：`collectNoteCards()` 之后

```javascript
aggregateAuthorsFromNotes(noteCards) {
    const authorMap = new Map();

    for (const note of noteCards) {
        if (!note.authorId) continue;

        const existing = authorMap.get(note.authorId);
        if (existing) {
            existing.noteCount++;
            existing.totalLikes += this.parseCount(note.likes);
            existing.posts.push({
                title: note.title,
                likes: note.likes,
                noteUrl: note.noteUrl,
            });
            if ((note.authorName || '').length > (existing.nickname || '').length) {
                existing.nickname = note.authorName;
            }
        } else {
            authorMap.set(note.authorId, {
                userId: note.authorId,
                nickname: note.authorName,
                profileUrl: note.authorUrl,
                noteCount: 1,
                totalLikes: this.parseCount(note.likes),
                posts: [{
                    title: note.title,
                    likes: note.likes,
                    noteUrl: note.noteUrl,
                }],
            });
        }
    }

    // 按出现频次 * 互动总量排序
    const authors = [...authorMap.values()];
    authors.sort((a, b) => {
        const scoreA = a.noteCount * 3 + Math.log10(a.totalLikes + 1) * 2;
        const scoreB = b.noteCount * 3 + Math.log10(b.totalLikes + 1) * 2;
        return scoreB - scoreA;
    });

    return authors;
}
```

### 1.4 新增 `searchByNotes()` 生成器方法

插入位置：`search()` 方法之前

这是笔记模式的核心搜索流程。签名：

```javascript
async * searchByNotes(page, tracker, searchPageUrl, keyword, maxResults, options) {
    // 步骤 1: 确保在笔记标签
    await this.focusNoteTab(page);

    // 步骤 2: 滚动收集帖子卡片（目标 50-80 张）
    const allNoteCards = [];
    let scrollAttempts = 0;
    const targetNotes = Math.max(maxResults * 4, 50);

    while (allNoteCards.length < targetNotes && scrollAttempts < 10) {
        this.assertNotCancelled(options);
        page = await this.ensureSearchResultsPage(page, tracker, searchPageUrl, keyword);
        await this.dismissLoginOverlay(page);

        const cards = await this.collectNoteCards(page);
        // 去重合并
        for (const card of cards) {
            if (card.authorId && !allNoteCards.find(c => c.noteUrl === card.noteUrl && c.authorId === card.authorId)) {
                allNoteCards.push(card);
            }
        }

        this.writeDebugLog('notes_collected', {
            keyword, collected: allNoteCards.length, scrollAttempts,
        });

        yield {
            progress: 15 + Math.min(25, Math.round((allNoteCards.length / targetNotes) * 25)),
            kocs: [],
            message: `正在采集帖子... 已找到 ${allNoteCards.length} 条笔记`,
        };

        scrollAttempts++;
        await page.humanScroll(500);
    }

    if (allNoteCards.length === 0) {
        const reason = await this.diagnoseZeroResult(page, keyword);
        await page.close().catch(() => {});
        tracker?.dispose();
        yield { progress: 100, kocs: [], error: reason || '未找到相关笔记' };
        return;
    }

    // 步骤 3: 聚合作者
    const authors = this.aggregateAuthorsFromNotes(allNoteCards);
    this.writeDebugLog('authors_aggregated', {
        keyword,
        totalNotes: allNoteCards.length,
        uniqueAuthors: authors.length,
    });

    yield {
        progress: 45,
        kocs: [],
        message: `从 ${allNoteCards.length} 条笔记中发现 ${authors.length} 位创作者，正在分析...`,
    };

    // 步骤 4: 对 top 作者获取资料页
    const kocs = [];
    let profileAccessBlocked = false;
    let profileFetchCount = 0;
    const candidateAuthors = authors.slice(0, maxResults);

    for (let i = 0; i < candidateAuthors.length; i++) {
        this.assertNotCancelled(options);
        const author = candidateAuthors[i];
        const progress = 45 + Math.round((i / candidateAuthors.length) * 50);

        try {
            const shouldFetchProfile =
                !profileAccessBlocked &&
                profileFetchCount < this.maxProfileFetchesPerRun;

            const card = {
                userId: author.userId,
                nickname: author.nickname,
                profileUrl: author.profileUrl,
                fans: '',
                description: '',
                avatar: '',
            };

            const profileData = shouldFetchProfile
                ? await this.getProfileData(page, card, options)
                : this.buildCardOnlyProfile(card);

            if (shouldFetchProfile) profileFetchCount++;

            if (profileData.authLimited && !profileData.cardOnly) {
                profileAccessBlocked = true;
            }

            const followers = this.parseCount(profileData.followers || '0');
            if (options.minFollowers && followers > 0 && followers < options.minFollowers) continue;
            if (options.maxFollowers && followers > 0 && followers > options.maxFollowers) continue;

            const kocData = this.normalizeData({
                userId: author.userId,
                username: author.userId,
                nickname: profileData.nickname || author.nickname,
                avatar: profileData.avatar || '',
                profileUrl: author.profileUrl || `${this.homeUrl}/user/profile/${author.userId}`,
                followers,
                following: this.parseCount(profileData.following),
                likes: this.parseCount(profileData.likes),
                posts: this.parseCount(profileData.posts),
                description: profileData.description || '',
                category: this.inferCategory(profileData.description || '', keyword),
                recentPosts: profileData.recentPosts || [],
                engagementRate: profileData.engagementRate || 0,
                // 笔记模式特有字段
                relatedPosts: author.posts || [],
                noteAppearances: author.noteCount || 0,
                searchContextText: author.posts.map(p => p.title).join(' | '),
                dataQuality: profileData.dataQuality || {
                    source: shouldFetchProfile ? 'profile_page' : 'note_discovery',
                    profileFetched: shouldFetchProfile,
                },
            });

            kocs.push(kocData);
        } catch (err) {
            if (err.code === 'TASK_ABORTED') throw err;
            this.writeDebugLog('note_author_profile_failed', {
                userId: author.userId, message: err.message,
            });
        }

        yield {
            progress,
            kocs: [...kocs],
            message: `已分析 ${i + 1}/${candidateAuthors.length} 位创作者`,
        };

        if (shouldFetchProfile) {
            await page.randomDelay(6500, 9500);
        } else {
            await page.randomDelay(800, 1500);
        }
    }

    await page.close().catch(() => {});
    tracker?.dispose();
    yield { progress: 100, kocs, message: `搜索完成，共找到 ${kocs.length} 个 KOC` };
}
```

### 1.5 修改 `search()` 方法

当前位置：L872 起

改动：
1. 从 `options` 读取 `searchMode`（默认 `'notes'`）
2. URL 的 `target_search` 根据模式选择 `'notes'` 或 `'users'`
3. 在 `yield { progress: 15 }` 之后分流：
   - `searchMode === 'notes'` → `yield* this.searchByNotes(page, tracker, searchPageUrl, keyword, maxResults, options); return;`
   - 否则继续现有用户搜索逻辑

```diff
 async * search(keyword, options = {}) {
     const maxResults = options.maxResults || 20;
+    const searchMode = options.searchMode || 'notes';
     ...
-    // 搜索用户
+    const targetSearch = searchMode === 'notes' ? 'notes' : 'users';
     const searchPageUrl = `${this.searchUrl}?${new URLSearchParams({
         keyword,
-        target_search: 'users',
+        target_search: targetSearch,
         source: 'deeplink',
     }).toString()}`;
     ...
     yield { progress: 15, kocs: [], message: '正在加载搜索结果...' };

+    // 根据搜索模式分流
+    if (searchMode === 'notes') {
+        yield* this.searchByNotes(page, tracker, searchPageUrl, keyword, maxResults, options);
+        return;
+    }
+
+    // ===== 用户模式（原逻辑不变） =====
     await this.focusUserTab(page);
```

### 1.6 修改 `buildSearchEntryUrls()` 方法

当前位置：L433

改动：增加 `searchMode` 参数

```diff
-buildSearchEntryUrls(keyword, searchPageUrl) {
+buildSearchEntryUrls(keyword, searchPageUrl, searchMode = 'users') {
+    const targetSearch = searchMode === 'notes' ? 'notes' : 'users';
     const query = new URLSearchParams({
         keyword: keyword || '',
-        target_search: 'users',
+        target_search: targetSearch,
         source: 'deeplink',
     }).toString();
```

### 1.7 `normalizeData` 新增字段

在 `base.js` 的 `normalizeData()` 中追加：

```diff
 normalizeData(rawData) {
     return {
         ...
         dataQuality: rawData.dataQuality || null,
+        relatedPosts: rawData.relatedPosts || [],
+        noteAppearances: rawData.noteAppearances || 0,
         rawData: rawData,
     };
 }
```

---

## 二、`server/index.js` 改动

### 2.1 解析 `searchMode` 参数

当前位置：L338 附近的 `/api/search` handler

```diff
 app.get('/api/search', async (req, res) => {
-    const { keyword, platforms: platformList, maxResults, minFollowers, maxFollowers } = req.query;
+    const { keyword, platforms: platformList, maxResults, minFollowers, maxFollowers, searchMode } = req.query;
```

然后在构造 `options` 时添加：

```diff
     const options = {
         maxResults: toInt(maxResults, 20),
         minFollowers: toInt(minFollowers, 0),
         maxFollowers: toInt(maxFollowers, 0),
+        searchMode: searchMode || 'notes',
         signal: abortController.signal,
     };
```

### 2.2 CSV 导出增加新字段

当前位置：L600+ 的 `/api/export` handler，CSV 列定义中添加：

```javascript
'相关帖子数': koc.noteAppearances || 0,
'帖子标题': (koc.relatedPosts || []).map(p => p.title).join(' | ').slice(0, 200),
```

---

## 三、`public/index.html` 改动

在搜索表单的 `<div class="search-options">` 中、平台选择之后添加搜索模式选择器：

```html
<div class="search-mode-select">
    <label>搜索模式</label>
    <div class="mode-chips" id="modeChips">
        <button class="mode-chip active" data-mode="notes">
            <span>📝</span>
            <span>笔记发现</span>
            <small>从帖子内容找创作者（推荐）</small>
        </button>
        <button class="mode-chip" data-mode="users">
            <span>👤</span>
            <span>用户搜索</span>
            <small>按昵称匹配关键词</small>
        </button>
    </div>
</div>
```

同时在 `styles.css` 中为 `.mode-chips` / `.mode-chip` 添加样式（参考现有 `.platform-chips` 样式）。

---

## 四、`public/app.js` 改动

### 4.1 State 新增

```diff
 const state = {
     keyword: '',
+    searchMode: 'notes',
     selectedPlatforms: ['xiaohongshu', 'youtube', 'douyin', 'tiktok'],
```

### 4.2 init() 绑定模式切换

```javascript
// Mode chips
const modeChips = $('#modeChips');
if (modeChips) {
    modeChips.addEventListener('click', (e) => {
        const chip = e.target.closest('.mode-chip');
        if (!chip) return;
        $$('.mode-chip').forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
        state.searchMode = chip.dataset.mode;
    });
}
```

### 4.3 startSearch() 传递 searchMode

```diff
 const params = new URLSearchParams({
     keyword,
     platforms: state.selectedPlatforms.join(','),
+    searchMode: state.searchMode,
     maxResults: $('#maxResults').value,
     minFollowers: $('#minFollowers').value || '0',
     maxFollowers: $('#maxFollowers').value || '0',
 });
```

### 4.4 详情弹窗增加相关帖子

在 `openDetailModal(koc)` 中，如果 `koc.relatedPosts.length > 0`，在联系方式区域之前添加：

```javascript
const relatedPostsHtml = (koc.relatedPosts || []).length > 0
    ? `<div class="modal-related-posts">
        <h4>📝 相关帖子 (${koc.noteAppearances || koc.relatedPosts.length})</h4>
        ${koc.relatedPosts.slice(0, 5).map(p => `
          <div class="related-post-row">
            <span class="related-post-title">${escapeHtml(p.title)}</span>
            <span class="related-post-likes">${p.likes || '-'} 赞</span>
          </div>
        `).join('')}
      </div>`
    : '';
```

然后在 `modalContent.innerHTML` 模板中插入 `${relatedPostsHtml}`。

---

## 五、`server/evaluator.js` 改动

### 5.1 `scoreContentRelevance()` 增强

当前位置：L173-212

如果 KOC 数据含有 `relatedPosts`，将帖子标题拼接参与关键词匹配：

```diff
 function scoreContentRelevance(koc, keyword) {
-    const text = `${koc.description || ''} ${koc.category || ''}`.toLowerCase();
+    const postTitles = (koc.relatedPosts || []).map(p => p.title || '').join(' ');
+    const text = `${koc.description || ''} ${koc.category || ''} ${postTitles}`.toLowerCase();
```

额外加分项：`noteAppearances >= 2` → 内容相关度 +15 分加成（上限 100）。

### 5.2 `scoreActivityLevel()` 增强

如果有 `noteAppearances`，增加活跃度分数：

```javascript
if (koc.noteAppearances && koc.noteAppearances >= 2) {
    score = Math.min(100, score + koc.noteAppearances * 5);
}
```

---

## 六、历史去重（跨轮搜索不重复）

### 问题

小红书同一关键词两次搜索结果约 70-80% 重叠。如果用户多次搜索同一关键词想积累更多 KOC，大部分结果都是重复的。

### 方案

用本地 JSON 文件记录已发现的 userId，下次搜索时自动跳过。

### 涉及文件

| 文件 | 改动 |
|---|---|
| `server/platforms/xiaohongshu.js` | 读写已见用户集合 |
| `server/index.js` | API 增加 `skipSeen` 参数 |
| `public/app.js` + `index.html` | 增加"跳过已搜过的"复选框 |

### 6.1 `xiaohongshu.js` — 新增已见用户管理

新增常量和方法：

```javascript
const XHS_SEEN_PATH = path.join(__dirname, '..', '..', 'data', 'xhs-seen-users.json');

// 读取已见用户集合
loadSeenUsers() {
    try {
        if (fs.existsSync(XHS_SEEN_PATH)) {
            const data = JSON.parse(fs.readFileSync(XHS_SEEN_PATH, 'utf8'));
            return new Set(data.userIds || []);
        }
    } catch { /* ignore */ }
    return new Set();
}

// 追加已见用户
saveSeenUsers(newUserIds, existingSet = null) {
    try {
        const seen = existingSet || this.loadSeenUsers();
        for (const id of newUserIds) seen.add(id);
        const dir = path.dirname(XHS_SEEN_PATH);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(XHS_SEEN_PATH, JSON.stringify({
            userIds: [...seen],
            updatedAt: new Date().toISOString(),
            count: seen.size,
        }, null, 2));
    } catch { /* ignore */ }
}

// 清空已见用户（用于重新开始）
clearSeenUsers() {
    try {
        if (fs.existsSync(XHS_SEEN_PATH)) fs.unlinkSync(XHS_SEEN_PATH);
    } catch { /* ignore */ }
}
```

### 6.2 在搜索流程中集成

在 `searchByNotes()` 和 `search()` 中：

```javascript
// 搜索开始时加载已见集合
const seenUsers = options.skipSeen ? this.loadSeenUsers() : new Set();

// 聚合作者后过滤
const authors = this.aggregateAuthorsFromNotes(allNoteCards)
    .filter(a => !seenUsers.has(a.userId));

// 搜索结束时保存新发现的用户
if (options.skipSeen && kocs.length > 0) {
    this.saveSeenUsers(kocs.map(k => k.userId), seenUsers);
}
```

对用户模式（原逻辑）同理：在 `userCardMap` 过滤阶段跳过 `seenUsers` 中的 userId。

### 6.3 `server/index.js` — API 参数

```diff
-const { keyword, platforms: platformList, maxResults, minFollowers, maxFollowers, searchMode } = req.query;
+const { keyword, platforms: platformList, maxResults, minFollowers, maxFollowers, searchMode, skipSeen } = req.query;
```

```diff
 const options = {
     ...
     searchMode: searchMode || 'notes',
+    skipSeen: skipSeen === 'true' || skipSeen === '1',
     signal: abortController.signal,
 };
```

新增清空接口：

```javascript
app.post('/api/seen/clear', (req, res) => {
    const platform = platforms.xiaohongshu;
    platform.clearSeenUsers();
    res.json({ success: true, message: '已清空历史记录' });
});
```

### 6.4 前端

在搜索表单中添加复选框：

```html
<label class="skip-seen-label">
    <input type="checkbox" id="skipSeen" checked>
    <span>跳过已搜过的用户（多次搜索不重复）</span>
</label>
```

`startSearch()` 中传参：

```javascript
skipSeen: $('#skipSeen')?.checked ? 'true' : 'false',
```

---

## 七、关联词自动扩展

### 问题

搜"潮玩"只能找到帖子里包含"潮玩"的 KOC。但同一个领域的 KOC 还会用"盲盒"、"潮流玩具"、"开箱"等词发帖。

### 方案

每个搜索关键词自动扩展出 2-4 个关联词，依次搜索后合并去重。

### 涉及文件

| 文件 | 改动 |
|---|---|
| `server/platforms/xiaohongshu.js` | 新增 `expandKeywords()` 方法 |
| `server/index.js` | 扩展词逻辑编排 |
| `public/index.html` + `app.js` | 显示扩展词 + 开关 |

### 7.1 `xiaohongshu.js` — 新增关联词映射

```javascript
// 内置关联词库（运营常见场景）
static KEYWORD_EXPANSIONS = {
    '潮玩': ['盲盒', '潮流玩具', '开箱测评', '手办'],
    '美妆': ['化妆教程', '护肤', '口红试色', '彩妆'],
    '健身': ['减脂', '增肌训练', '运动vlog', '健身餐'],
    '穿搭': ['OOTD', '时尚搭配', '日常穿搭', '通勤穿搭'],
    '美食': ['美食探店', '家常菜', '烘焙', '食谱'],
    '母婴': ['育儿', '宝宝辅食', '亲子', '孕期'],
    '家居': ['家居好物', '收纳整理', '装修', '软装'],
    '数码': ['数码测评', '手机推荐', '电子产品', '科技'],
    '旅行': ['旅行攻略', '景点推荐', '旅行vlog', '自驾游'],
    '宠物': ['猫咪日常', '养狗', '宠物用品', '萌宠'],
};

expandKeywords(keyword) {
    // 1. 精确匹配内置库
    const base = keyword.trim();
    if (XiaohongshuPlatform.KEYWORD_EXPANSIONS[base]) {
        return [base, ...XiaohongshuPlatform.KEYWORD_EXPANSIONS[base]];
    }

    // 2. 模糊匹配：如果关键词包含某个已知领域词
    for (const [domain, expansions] of Object.entries(XiaohongshuPlatform.KEYWORD_EXPANSIONS)) {
        if (base.includes(domain) || domain.includes(base)) {
            return [base, ...expansions.filter(e => e !== base)];
        }
    }

    // 3. 无匹配，只用原词 + 通用后缀
    return [base, `${base}推荐`, `${base}测评`];
}
```

### 7.2 在搜索流程中集成

修改 `search()` 和 `searchByNotes()`，当 `options.expandKeywords === true` 时：

```javascript
const keywords = options.expandKeywords
    ? this.expandKeywords(keyword)
    : [keyword];

// 对每个关键词执行搜索，合并去重
for (const kw of keywords) {
    yield { message: `正在搜索关联词: ${kw}` };
    // ... 执行 collectNoteCards 或 collectUserCards
    // 合并到 allNoteCards，去重 by noteUrl + authorId
}
```

> **注意**：这里不需要为每个关联词重新打开页面。只需在搜索页修改搜索框输入内容后回车，或直接改 URL 中的 keyword 参数。

### 7.3 `server/index.js` — API 参数

```diff
+expandKeywords: expandKeywords === 'true' || expandKeywords === '1',
```

### 7.4 前端

在搜索模式选择器旁添加复选框：

```html
<label class="expand-kw-label">
    <input type="checkbox" id="expandKeywords">
    <span>自动扩展关联词（覆盖更多相关创作者）</span>
</label>
```

搜索时传参：`expandKeywords: $('#expandKeywords')?.checked ? 'true' : 'false'`

进度条中显示当前正在搜索的关联词：`正在搜索关联词: 盲盒 (2/5)`。

---

## 八、验证清单

1. `npm run test:api:smoke` — 确认不传 `searchMode` / `skipSeen` / `expandKeywords` 时兼容
2. `npm run test:evaluator` — 确认评分逻辑未 break
3. 手动测试：关键词「潮玩」，笔记模式，结果应来自发过潮玩帖子的作者
4. 手动测试：关键词「潮玩」，用户模式，行为与修改前一致
5. CSV 导出确认新字段存在
6. **历史去重测试**：搜索「潮玩」两次，第二次结果应全部不同于第一次
7. **关联词测试**：勾选扩展，搜索「潮玩」，进度条应显示搜索"盲盒"、"潮流玩具"等关联词，最终结果覆盖面更广
8. **清空历史**：调用 `POST /api/seen/clear` 后重新搜索，应恢复到第一次搜索的行为
