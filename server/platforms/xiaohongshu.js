import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import BasePlatform from './base.js';
import browserManager from '../browser-manager.js';
import { runXiaohongshuLoginFlow } from '../auth/xiaohongshu-login.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const XHS_LOG_DIR = path.join(__dirname, '..', '..', 'data', 'logs');
const XHS_SEARCH_LOG = path.join(XHS_LOG_DIR, 'xhs-search.log');
const XHS_SEEN_PATH = path.join(__dirname, '..', '..', 'data', 'xhs-seen-users.json');
const XHS_META_PATH = path.join(__dirname, '..', '..', 'data', 'cookies', 'xiaohongshu.meta.json');

/**
 * 小红书适配器 — Playwright 浏览器自动化
 */
export default class XiaohongshuPlatform extends BasePlatform {
    static KEYWORD_EXPANSIONS = {
        潮玩: ['盲盒', '潮流玩具', '开箱测评', '手办'],
        美妆: ['化妆教程', '护肤', '口红试色', '彩妆'],
        健身: ['减脂', '增肌训练', '运动vlog', '健身餐'],
        穿搭: ['OOTD', '时尚搭配', '日常穿搭', '通勤穿搭'],
        美食: ['美食探店', '家常菜', '烘焙', '食谱'],
        母婴: ['育儿', '宝宝辅食', '亲子', '孕期'],
        家居: ['家居好物', '收纳整理', '装修', '软装'],
        数码: ['数码测评', '手机推荐', '电子产品', '科技'],
        旅行: ['旅行攻略', '景点推荐', '旅行vlog', '自驾游'],
        宠物: ['猫咪日常', '养狗', '宠物用品', '萌宠'],
    };

    constructor() {
        super('xiaohongshu', '📕');
        this.homeUrl = 'https://www.xiaohongshu.com';
        this.searchUrl = 'https://www.xiaohongshu.com/search_result';
        this.authCookieNames = ['web_session'];
        this.maxProfileFetchesPerRun = Number.parseInt(
            process.env.XHS_MAX_PROFILE_FETCHES || '5',
            10
        );
        this.captchaWaitMs = Number.parseInt(process.env.XHS_CAPTCHA_WAIT_MS || '45000', 10);
        this.captchaPollMs = Number.parseInt(process.env.XHS_CAPTCHA_POLL_MS || '1500', 10);
    }

    writeDebugLog(message, payload = null) {
        try {
            if (!fs.existsSync(XHS_LOG_DIR)) {
                fs.mkdirSync(XHS_LOG_DIR, { recursive: true });
            }
            const line = [
                `[${new Date().toISOString()}]`,
                message,
                payload ? JSON.stringify(payload) : '',
            ]
                .filter(Boolean)
                .join(' ');
            fs.appendFileSync(XHS_SEARCH_LOG, `${line}\n`);
        } catch {
            // ignore log errors
        }
    }

    wait(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    isCaptchaOrLoginUrl(url) {
        return /\/website-login\/captcha/i.test(String(url || '')) || /\/login\?redirectPath=/i.test(String(url || ''));
    }

    async waitForCaptchaResolution(page, profileUrl, options = {}) {
        const startedAt = Date.now();
        while (Date.now() - startedAt < this.captchaWaitMs) {
            this.assertNotCancelled(options);
            const currentUrl = page.url();
            if (!this.isCaptchaOrLoginUrl(currentUrl)) {
                this.writeDebugLog('profile_captcha_resolved', {
                    userId: profileUrl.split('/').pop() || '',
                    currentUrl,
                });
                return true;
            }
            await this.wait(this.captchaPollMs);
        }

        this.writeDebugLog('profile_captcha_timeout', {
            userId: profileUrl.split('/').pop() || '',
            timeoutMs: this.captchaWaitMs,
        });
        return false;
    }

    async hasAuthCookie() {
        try {
            const context = await browserManager.getContext('xiaohongshu');
            const cookies = await context.cookies(this.homeUrl);
            return cookies.some(
                (c) =>
                    this.authCookieNames.includes(c.name) &&
                    typeof c.value === 'string' &&
                    c.value.trim().length > 10
            );
        } catch {
            return false;
        }
    }

    hasRecentVerifiedMeta(maxAgeMs = 24 * 60 * 60 * 1000) {
        try {
            if (!fs.existsSync(XHS_META_PATH)) return false;
            const meta = JSON.parse(fs.readFileSync(XHS_META_PATH, 'utf8'));
            if (!meta?.verified) return false;
            const ts = new Date(meta.verifiedAt || meta.updatedAt || 0).getTime();
            if (!ts) return false;
            return Date.now() - ts <= maxAgeMs;
        } catch {
            return false;
        }
    }

    inspectSearchHtml(url, bodyText) {
        const pathname = (() => {
            try {
                return new URL(url).pathname;
            } catch {
                return '';
            }
        })();
        const isSearchPath = pathname === '/search_result' || pathname === '/search_result/';
        return {
            url,
            isSearchPath,
            hasLogin: /扫码登录|手机号登录|立即登录|请先登录|登录后查看/i.test(bodyText),
            hasCaptcha: /验证码|安全验证|请完成验证|验证后继续/i.test(bodyText),
            isHomeFeed: !isSearchPath && /发现|推荐|关注/.test((bodyText || '').slice(0, 220)),
        };
    }

    async validateSearchAccess(context = null) {
        try {
            const ctx = context || await browserManager.getContext('xiaohongshu');
            const probeUrl = `${this.searchUrl}/?keyword=${encodeURIComponent('潮玩')}&type=51`;
            const response = await ctx.request.get(probeUrl, { timeout: 20000 });
            const bodyText = await response.text();
            const info = this.inspectSearchHtml(response.url(), bodyText);
            const ok = info.isSearchPath && !info.hasLogin && !info.hasCaptcha && !info.isHomeFeed;
            this.writeDebugLog('auth_probe', { ok, ...info });
            return ok;
        } catch (err) {
            this.writeDebugLog('auth_probe_failed', { message: err.message });
            return false;
        }
    }

    loadSeenUsers() {
        try {
            if (fs.existsSync(XHS_SEEN_PATH)) {
                const data = JSON.parse(fs.readFileSync(XHS_SEEN_PATH, 'utf8'));
                return new Set(data.userIds || []);
            }
        } catch {
            // ignore
        }
        return new Set();
    }

    saveSeenUsers(newUserIds, existingSet = null) {
        try {
            const seen = existingSet || this.loadSeenUsers();
            for (const id of newUserIds || []) {
                if (id) seen.add(id);
            }
            const dir = path.dirname(XHS_SEEN_PATH);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(
                XHS_SEEN_PATH,
                JSON.stringify(
                    {
                        userIds: [...seen],
                        updatedAt: new Date().toISOString(),
                        count: seen.size,
                    },
                    null,
                    2
                )
            );
        } catch {
            // ignore
        }
    }

    clearSeenUsers() {
        try {
            if (fs.existsSync(XHS_SEEN_PATH)) {
                fs.unlinkSync(XHS_SEEN_PATH);
            }
        } catch {
            // ignore
        }
    }

    expandKeywords(keyword) {
        const base = String(keyword || '').trim();
        if (!base) return [];

        if (XiaohongshuPlatform.KEYWORD_EXPANSIONS[base]) {
            return [base, ...XiaohongshuPlatform.KEYWORD_EXPANSIONS[base]];
        }

        for (const [domain, expansions] of Object.entries(XiaohongshuPlatform.KEYWORD_EXPANSIONS)) {
            if (base.includes(domain) || domain.includes(base)) {
                return [base, ...expansions.filter((item) => item !== base)];
            }
        }

        return [base, `${base}推荐`, `${base}测评`];
    }

    buildCardOnlyProfile(card) {
        return {
            nickname: card.nickname,
            description: card.description,
            avatar: card.avatar,
            followers: card.fans,
            following: '0',
            likes: '0',
            posts: '0',
            recentPosts: [],
            engagementRate: 0,
            cardOnly: true,
            dataQuality: {
                source: 'search_card',
                profileFetched: false,
            },
        };
    }

    mergeUserCard(existing, incoming) {
        if (!existing) return { ...incoming };

        const existingFans = this.parseCount(existing.fans);
        const incomingFans = this.parseCount(incoming.fans);
        const existingDescLen = (existing.description || '').trim().length;
        const incomingDescLen = (incoming.description || '').trim().length;
        const existingTextLen = (existing.searchContextText || '').trim().length;
        const incomingTextLen = (incoming.searchContextText || '').trim().length;

        return {
            ...existing,
            nickname:
                (incoming.nickname || '').trim().length > (existing.nickname || '').trim().length
                    ? incoming.nickname
                    : existing.nickname,
            fans: incomingFans > existingFans ? incoming.fans : existing.fans,
            description: incomingDescLen > existingDescLen ? incoming.description : existing.description,
            avatar: existing.avatar || incoming.avatar,
            profileUrl:
                (incoming.profileUrl || '').length > (existing.profileUrl || '').length
                    ? incoming.profileUrl
                    : existing.profileUrl,
            searchContextText:
                incomingTextLen > existingTextLen
                    ? incoming.searchContextText
                    : existing.searchContextText,
            followerText:
                (incoming.followerText || '').length > (existing.followerText || '').length
                    ? incoming.followerText
                    : existing.followerText,
        };
    }

    buildSearchEntryUrls(keyword, searchPageUrl, searchMode = 'users') {
        const targetSearch = searchMode === 'notes' ? 'notes' : 'users';
        const query = new URLSearchParams({
            keyword: keyword || '',
            target_search: targetSearch,
            source: 'deeplink',
        }).toString();

        return [
            searchPageUrl,
            `${this.searchUrl}?${query}`,
            `${this.searchUrl}/?${query}`,
            `${this.homeUrl}/search_result?${query}`,
            `${this.homeUrl}/search_result/?${query}`,
        ];
    }

    isSearchResultsUrl(url, keyword = '') {
        const text = String(url || '');
        return /xiaohongshu\.com\/search_result/i.test(text) && (!keyword || text.includes(encodeURIComponent(keyword)));
    }

    async openSearchEntryPage(page, keyword, searchPageUrl, searchMode = 'users') {
        const urls = this.buildSearchEntryUrls(keyword, searchPageUrl, searchMode);

        for (const url of urls) {
            try {
                await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
                await page.randomDelay(1200, 2200);
                this.writeDebugLog('search_entry_opened', {
                    keyword,
                    requestedUrl: searchPageUrl,
                    url: page.url(),
                    searchMode,
                });
                return page;
            } catch (err) {
                this.writeDebugLog('search_entry_open_failed', {
                    keyword,
                    url,
                    searchMode,
                    message: err.message,
                });
            }
        }

        throw new Error('无法打开小红书搜索页');
    }

    async ensureSearchResultsPage(page, searchPageUrl, keyword, searchMode = 'users') {
        if (!this.isSearchResultsUrl(page.url(), keyword)) {
            page = await this.openSearchEntryPage(page, keyword, searchPageUrl, searchMode);
        }
        this.writeDebugLog('ensure_search_page_ok', {
            keyword,
            url: page.url(),
        });
        return page;
    }

    async dismissLoginOverlay(page) {
        const locators = [
            page.locator('button:has-text("知道了")').first(),
            page.locator('button:has-text("关闭")').first(),
            page.locator('button:has-text("稍后")').first(),
            page.locator('[aria-label="关闭"]').first(),
        ];

        for (const locator of locators) {
            try {
                if (await locator.isVisible({ timeout: 600 })) {
                    await locator.click({ timeout: 1200 });
                    await page.randomDelay(400, 800);
                    return;
                }
            } catch {
                // continue
            }
        }
    }

    async focusUserTab(page) {
        const tabCandidates = [
            page.locator('[role="tab"]').filter({ hasText: /^用户$/ }).first(),
            page.locator('button').filter({ hasText: /^用户$/ }).first(),
            page.locator('a').filter({ hasText: /^用户$/ }).first(),
            page.locator('div,span,li').filter({ hasText: /^用户$/ }).first(),
            page.locator('text=用户').first(),
        ];

        for (const locator of tabCandidates) {
            try {
                if (await locator.isVisible({ timeout: 1200 })) {
                    await locator.click({ timeout: 2500 });
                    await this.wait(1500);
                    this.writeDebugLog('user_tab_clicked', { url: page.url() });
                    return true;
                }
            } catch {
                // continue
            }
        }

        this.writeDebugLog('user_tab_not_found', { url: page.url() });
        return false;
    }

    async focusNoteTab(page) {
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
            } catch {
                // continue
            }
        }

        this.writeDebugLog('note_tab_assumed_default', { url: page.url() });
        return true;
    }

    async collectUserCards(page) {
        return page.evaluate(() => {
            const toText = (value) => String(value || '').replace(/\s+/g, ' ').trim();
            const linesOf = (text) =>
                String(text || '')
                    .split('\n')
                    .map((line) => line.trim())
                    .filter(Boolean);
            const normalizeUrl = (href) => {
                if (!href) return '';
                try {
                    return new URL(href, window.location.origin).toString();
                } catch {
                    return '';
                }
            };
            const extractUserId = (href) => {
                const match = String(href || '').match(/\/user\/profile\/([a-zA-Z0-9]+)/);
                return match ? match[1] : '';
            };
            const findCardRoot = (anchor) => {
                let node = anchor;
                let fallback = anchor.parentElement;
                for (let depth = 0; node && depth < 7; depth += 1) {
                    const text = toText(node.innerText || node.textContent || '');
                    if (text.length >= 10) {
                        fallback = node;
                    }
                    if (/小红书号|粉丝|笔记|关注/.test(text)) {
                        return node;
                    }
                    node = node.parentElement;
                }
                return fallback || anchor;
            };

            const anchors = Array.from(document.querySelectorAll('a[href*="/user/profile/"]'));
            const cards = [];
            const seen = new Set();

            for (const anchor of anchors) {
                const profileUrl = normalizeUrl(anchor.getAttribute('href') || anchor.href);
                const userId = extractUserId(profileUrl);
                if (!userId || seen.has(userId)) continue;

                const root = findCardRoot(anchor);
                const rootText = toText(root?.innerText || root?.textContent || '');
                const rootLines = linesOf(rootText);

                const nickname =
                    toText(
                        root?.querySelector('.user-name, .name, [class*="name"], h3, h4')
                            ?.textContent ||
                        anchor.textContent
                    ) || '';
                const followerLine = rootLines.find((line) =>
                    /(?:粉丝|关注者)\s*[：:・·• ]?\s*[0-9.]+[千萬万亿wWkK+]?|[0-9.]+[千萬万亿wWkK+]?\s*(?:粉丝|关注者)/.test(
                        line
                    )
                ) || '';
                const fansMatch = followerLine.match(
                    /(?:粉丝|关注者)\s*[：:・·• ]?\s*([0-9.]+[千萬万亿wWkK+]?)|([0-9.]+[千萬万亿wWkK+]?)(?=\s*(?:粉丝|关注者))/
                );
                const fans = fansMatch?.[1] || fansMatch?.[2] || '';

                const description = rootLines
                    .filter((line) => line !== nickname && line !== followerLine && !/小红书号|笔记|关注/.test(line))
                    .slice(0, 2)
                    .join(' ');
                const avatar = root?.querySelector('img')?.src || '';

                cards.push({
                    userId,
                    nickname,
                    fans,
                    followerText: followerLine,
                    description,
                    avatar,
                    profileUrl,
                    searchContextText: rootText.slice(0, 240),
                    rootPreview: rootLines.slice(0, 6).join('\n'),
                });
                seen.add(userId);
            }

            return cards;
        });
    }

    async collectNoteCards(page) {
        return page.evaluate(() => {
            const toText = (value) => String(value || '').replace(/\s+/g, ' ').trim();
            const linesOf = (text) =>
                String(text || '')
                    .split('\n')
                    .map((line) => line.trim())
                    .filter(Boolean);

            // 剥离尾部时间戳，返回 { name, time }
            const TIME_TAIL_RE = /\s*(\d{4}[-/]\d{1,2}[-/]\d{1,2}(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?|(?:昨天|今天|前天)\s*\d{1,2}:\d{2}|刚刚|\d+\s*(?:小时|分钟|天|周|月|年)前|\d{1,2}[-/]\d{1,2}|\d{1,2}:\d{2})\s*$/;
            const stripTimeTail = (text) => {
                const s = String(text || '').trim();
                const m = s.match(TIME_TAIL_RE);
                if (m) return { name: s.slice(0, m.index).trim(), time: m[1].trim() };
                return { name: s, time: '' };
            };

            const normalizeUrl = (href) => {
                if (!href) return '';
                try {
                    return new URL(href, window.location.origin).toString();
                } catch {
                    return '';
                }
            };
            const extractUserId = (href) => {
                const match = String(href || '').match(/\/user\/profile\/([a-zA-Z0-9]+)/);
                return match ? match[1] : '';
            };
            const buildNoteUrl = (noteId) =>
                noteId ? new URL(`/explore/${noteId}`, window.location.origin).toString() : '';
            const buildAuthorUrl = (authorId) =>
                authorId ? new URL(`/user/profile/${authorId}`, window.location.origin).toString() : '';

            const pushCard = (cards, seen, raw) => {
                const authorId =
                    String(
                        raw.authorId ||
                        raw.userId ||
                        raw.user_id ||
                        raw.uid ||
                        raw?.author?.userId ||
                        raw?.author?.user_id ||
                        raw?.author?.id ||
                        raw?.user?.userId ||
                        raw?.user?.user_id ||
                        raw?.user?.id ||
                        ''
                    ).trim();
                if (!authorId) return;

                const noteId = String(raw.noteId || raw.note_id || raw.id || '').trim();
                const rawAuthorName = toText(
                    raw.authorName ||
                    raw.nickname ||
                    raw?.author?.nickname ||
                    raw?.author?.name ||
                    raw?.user?.nickname ||
                    raw?.user?.name ||
                    ''
                );
                const { name: authorName, time: publishTime } = stripTimeTail(rawAuthorName);
                const title = toText(raw.title || raw.display_title || raw.desc || raw.noteTitle || '');
                const likes = String(
                    raw.likes ||
                    raw.liked_count ||
                    raw.likeCount ||
                    raw?.interact_info?.liked_count ||
                    ''
                );
                const authorUrl = normalizeUrl(raw.authorUrl || raw.profileUrl || buildAuthorUrl(authorId));
                const noteUrl = normalizeUrl(raw.noteUrl || buildNoteUrl(noteId));
                const thumbnail = raw.thumbnail || raw.cover || raw?.cover?.url || '';
                const key = `${authorId}::${noteId || title}`;
                if (!key.trim() || seen.has(key)) return;

                cards.push({
                    authorId,
                    authorName,
                    authorUrl,
                    title: title || '(无标题)',
                    likes,
                    thumbnail,
                    noteUrl,
                    publishTime: raw.publishTime || publishTime || '',
                    textPreview: toText(raw.textPreview || title).slice(0, 200),
                    source: raw.source || 'unknown',
                });
                seen.add(key);
            };

            const collectFromInitialState = () => {
                const cards = [];
                const seen = new Set();
                const state = window.__INITIAL_STATE__;
                if (!state || typeof state !== 'object') return cards;

                const isObj = (v) => !!v && typeof v === 'object';
                const visited = new WeakSet();
                const stack = [state];
                let guard = 0;
                while (stack.length > 0 && guard < 8000) {
                    guard += 1;
                    const node = stack.pop();
                    if (!isObj(node)) continue;
                    if (visited.has(node)) continue;
                    visited.add(node);

                    if (Array.isArray(node)) {
                        for (const item of node) {
                            if (isObj(item)) stack.push(item);
                        }
                        continue;
                    }

                    const keys = Object.keys(node);
                    const looksLikeNote =
                        keys.some((k) => /note|title|display_title|liked_count|interact/i.test(k)) &&
                        (
                            'user' in node ||
                            'author' in node ||
                            'userId' in node ||
                            'user_id' in node ||
                            'authorId' in node
                        );

                    if (looksLikeNote) {
                        pushCard(cards, seen, {
                            authorId:
                                node.authorId ||
                                node.userId ||
                                node.user_id ||
                                node?.user?.userId ||
                                node?.user?.user_id ||
                                node?.user?.id ||
                                node?.author?.userId ||
                                node?.author?.user_id ||
                                node?.author?.id,
                            authorName:
                                node.authorName ||
                                node.nickname ||
                                node?.user?.nickname ||
                                node?.author?.nickname ||
                                node?.author?.name ||
                                node?.user?.name,
                            authorUrl:
                                node.authorUrl ||
                                node.profileUrl ||
                                node?.author?.profileUrl ||
                                node?.user?.profileUrl,
                            title: node.title || node.display_title || node.desc || node?.note?.title,
                            likes:
                                node.likes ||
                                node.liked_count ||
                                node.likeCount ||
                                node?.interact_info?.liked_count,
                            noteId: node.noteId || node.note_id || node.id || node?.note?.id,
                            noteUrl: node.noteUrl || node.url || node.note_link,
                            publishTime: node.time || node.publish_time || node.publishTime || node.create_time || '',
                            thumbnail:
                                node.thumbnail ||
                                node?.cover?.url ||
                                node?.image?.url ||
                                node?.cover?.default,
                            source: '__INITIAL_STATE__',
                        });
                    }

                    for (const value of Object.values(node)) {
                        if (isObj(value)) stack.push(value);
                    }
                }
                return cards;
            };

            const findNoteRoot = (anchor) => {
                let node = anchor;
                let fallback = anchor.parentElement;
                for (let depth = 0; node && depth < 8; depth += 1) {
                    const text = toText(node.innerText || node.textContent || '');
                    const hasImage = !!node.querySelector('img');
                    const hasTitle = !!node.querySelector('.title, [class*="title"], h3, h4');
                    const hasNoteLink = !!node.querySelector('a[href*="/explore/"], a[href*="/discovery/"]');

                    if (text.length >= 10) {
                        fallback = node;
                    }
                    if ((hasImage && hasTitle) || (hasNoteLink && text.length >= 16)) {
                        return node;
                    }
                    node = node.parentElement;
                }
                return fallback || anchor;
            };

            const authorAnchors = Array.from(document.querySelectorAll('a[href*="/user/profile/"]'));
            const cards = [];
            const seen = new Set();

            for (const anchor of authorAnchors) {
                const authorUrl = normalizeUrl(anchor.getAttribute('href') || anchor.href);
                const authorId = extractUserId(authorUrl);
                if (!authorId) continue;

                const root = findNoteRoot(anchor);
                const rootText = toText(root?.innerText || root?.textContent || '');
                if (rootText.length <= 10) continue;

                const title =
                    toText(
                        root?.querySelector('.title, [class*="title"], h3, h4')?.textContent
                    ) || linesOf(rootText)[0] || '';
                const likesText =
                    toText(
                        root?.querySelector('[class*="like"], [class*="count"], [class*="interact"]')
                            ?.textContent
                    ) ||
                    (rootText.match(/([0-9.]+[千萬万亿wWkK+]?)\s*(?:赞|点赞|喜欢)/)?.[1] || '');
                const thumbnail = root?.querySelector('img')?.src || '';
                const noteLink = root?.querySelector('a[href*="/explore/"], a[href*="/discovery/"]');
                const noteUrl = normalizeUrl(noteLink?.getAttribute('href') || noteLink?.href || '');
                const authorName =
                    toText(
                        root?.querySelector('.author, [class*="author"], .name, [class*="user-name"]')
                            ?.textContent ||
                        anchor.textContent
                    ) || '';

                const key = `${authorId}::${noteUrl || title}`;
                if (seen.has(key)) continue;

                pushCard(cards, seen, {
                    authorId,
                    authorName,
                    authorUrl,
                    title,
                    likes: likesText,
                    thumbnail,
                    noteUrl,
                    textPreview: rootText.slice(0, 200),
                    source: 'dom_anchor',
                });
            }

            if (cards.length === 0) {
                const fallbackCards = collectFromInitialState();
                for (const card of fallbackCards) {
                    pushCard(cards, seen, card);
                }
            }

            return cards;
        });
    }

    aggregateAuthorsFromNotes(noteCards) {
        const authorMap = new Map();

        for (const note of noteCards) {
            if (!note.authorId) continue;

            const existing = authorMap.get(note.authorId);
            if (existing) {
                existing.noteCount += 1;
                existing.totalLikes += this.parseCount(note.likes);
                existing.posts.push({
                    title: note.title,
                    likes: note.likes,
                    noteUrl: note.noteUrl,
                    publishTime: note.publishTime || '',
                });
                // 优先用不含时间戳的更短干净名称；仅在现有为空时才更新
                if (!existing.nickname && note.authorName) {
                    existing.nickname = note.authorName;
                }
                if (!existing.profileUrl && note.authorUrl) {
                    existing.profileUrl = note.authorUrl;
                }
            } else {
                authorMap.set(note.authorId, {
                    userId: note.authorId,
                    nickname: note.authorName,
                    profileUrl: note.authorUrl,
                    noteCount: 1,
                    totalLikes: this.parseCount(note.likes),
                    posts: [
                        {
                            title: note.title,
                            likes: note.likes,
                            noteUrl: note.noteUrl,
                            publishTime: note.publishTime || '',
                        },
                    ],
                });
            }
        }

        const authors = [...authorMap.values()];
        authors.sort((a, b) => {
            const scoreA = a.noteCount * 3 + Math.log10(a.totalLikes + 1) * 2;
            const scoreB = b.noteCount * 3 + Math.log10(b.totalLikes + 1) * 2;
            return scoreB - scoreA;
        });

        return authors;
    }

    async detectSelfUserId(page) {
        try {
            return await page.evaluate(() => {
                // 小红书页面侧边栏/顶部导航通常有当前登录用户的个人资料链接
                // 限定在 header/sidebar/nav 区域查找，避免误匹配搜索结果
                const navSelectors = [
                    'header a[href*="/user/profile/"]',
                    'nav a[href*="/user/profile/"]',
                    '[class*="sidebar"] a[href*="/user/profile/"]',
                    '[class*="side-bar"] a[href*="/user/profile/"]',
                    '[class*="header"] a[href*="/user/profile/"]',
                    '[class*="channel"] a[href*="/user/profile/"]',
                    '.user a[href*="/user/profile/"]',
                    '[class*="user-info"] a[href*="/user/profile/"]',
                ];
                for (const sel of navSelectors) {
                    const el = document.querySelector(sel);
                    if (el) {
                        const match = (el.getAttribute('href') || el.href || '').match(
                            /\/user\/profile\/([a-zA-Z0-9]+)/
                        );
                        if (match) return match[1];
                    }
                }
                // 兜底：尝试从 __INITIAL_STATE__ 或 cookie 提取
                try {
                    const state = window.__INITIAL_STATE__;
                    if (state?.user?.userPageData?.basicInfo?.red_id) {
                        return state.user.userPageData.basicInfo.red_id;
                    }
                    if (state?.user?.userPageData?.basicInfo?.userId) {
                        return state.user.userPageData.basicInfo.userId;
                    }
                } catch { /* ignore */ }
                return '';
            });
        } catch {
            return '';
        }
    }

    async diagnoseZeroResult(page, keyword) {
        try {
            const info = await page.evaluate(() => {
                const text = document.body?.innerText || '';
                return {
                    hasCaptcha: /验证码|安全验证|请完成验证|验证后继续/i.test(text),
                    hasLogin: /扫码登录|手机号登录|立即登录|请先登录/i.test(text),
                    hasNoResult: /暂无|没有找到|无相关结果|空空如也/i.test(text),
                };
            });

            if (info.hasCaptcha) {
                return '触发平台验证/风控，请先在弹出的页面手动完成验证后重试';
            }
            if (info.hasLogin) {
                return '当前登录态无效，请先完成小红书登录后再搜索';
            }
            if (info.hasNoResult) {
                return `关键词“${keyword}”未检索到相关结果`;
            }
            return '未抓到结果，可能是页面结构变化或风控限制';
        } catch {
            return '未抓到结果，且无法诊断页面状态';
        }
    }

    async isLoggedIn() {
        if (this.usingMcp) {
            try {
                const status = await this.callMcp('status');
                return !!status.loggedIn;
            } catch {
                return false;
            }
        }

        const hasCookie = await this.hasAuthCookie();
        if (!hasCookie) return false;
        const probeOk = await this.validateSearchAccess();
        if (probeOk) return true;

        const metaFallback = this.hasRecentVerifiedMeta();
        if (metaFallback) {
            this.writeDebugLog('auth_probe_meta_fallback', { ok: true, reason: 'recent_verified_meta' });
            return true;
        }
        return false;
    }

    async login() {
        if (this.usingMcp) {
            try {
                const result = await this.callMcp('login');
                return {
                    success: !!result.success,
                    message: result.message || (result.success ? '登录成功' : '登录失败'),
                };
            } catch (err) {
                return { success: false, message: `MCP 登录失败: ${err.message}` };
            }
        }
        return runXiaohongshuLoginFlow();
    }

    async *searchByNotes(page, searchPageUrl, keyword, maxResults, options) {
        const searchKeywords = options.expandKeywords ? this.expandKeywords(keyword) : [keyword];
        const seenUsers = options.skipSeen ? this.loadSeenUsers() : new Set();
        const noteMap = new Map();
        const targetNotes = Math.max(maxResults * 4, 50);

        for (let keywordIndex = 0; keywordIndex < searchKeywords.length; keywordIndex += 1) {
            const searchKeyword = searchKeywords[keywordIndex];
            const keywordSearchUrl = `${this.searchUrl}?${new URLSearchParams({
                keyword: searchKeyword,
                target_search: 'notes',
                source: 'deeplink',
            }).toString()}`;

            page = await this.openSearchEntryPage(page, searchKeyword, keywordSearchUrl, 'notes');
            page = await this.ensureSearchResultsPage(page, keywordSearchUrl, searchKeyword, 'notes');
            await this.dismissLoginOverlay(page);
            await this.focusNoteTab(page);

            let scrollAttempts = 0;
            let lastCount = noteMap.size;

            while (noteMap.size < targetNotes && scrollAttempts < 10) {
                this.assertNotCancelled(options);
                page = await this.ensureSearchResultsPage(page, keywordSearchUrl, searchKeyword, 'notes');
                await this.dismissLoginOverlay(page);

                const cards = await this.collectNoteCards(page);
                for (const card of cards) {
                    const dedupeKey = `${card.authorId || ''}::${card.noteUrl || card.title || ''}`;
                    if (!card.authorId || !dedupeKey.trim()) continue;
                    if (!noteMap.has(dedupeKey)) {
                        noteMap.set(dedupeKey, card);
                    }
                }

                if (noteMap.size === lastCount) {
                    scrollAttempts += 1;
                } else {
                    scrollAttempts = 0;
                }
                lastCount = noteMap.size;

                this.writeDebugLog('notes_collected', {
                    keyword,
                    searchKeyword,
                    collected: noteMap.size,
                    scrollAttempts,
                });

                yield {
                    progress: 15 + Math.min(25, Math.round((noteMap.size / targetNotes) * 25)),
                    kocs: [],
                    message: `正在搜索关联词: ${searchKeyword} (${keywordIndex + 1}/${searchKeywords.length})，已找到 ${noteMap.size} 条笔记`,
                };

                await page.humanScroll(500);
            }
        }

        const allNoteCards = [...noteMap.values()];
        if (allNoteCards.length === 0) {
            const reason = await this.diagnoseZeroResult(page, keyword);
            await page.close().catch(() => { });
            yield { progress: 100, kocs: [], error: reason || '未找到相关笔记' };
            return;
        }

        const selfUserId = await this.detectSelfUserId(page);
        const authors = this.aggregateAuthorsFromNotes(allNoteCards).filter(
            (author) => !seenUsers.has(author.userId) && (!selfUserId || author.userId !== selfUserId)
        );

        this.writeDebugLog('authors_aggregated', {
            keyword,
            totalNotes: allNoteCards.length,
            uniqueAuthors: authors.length,
            skippedSeen: seenUsers.size,
            selfUserId: selfUserId || '(not detected)',
        });

        yield {
            progress: 45,
            kocs: [],
            message: `从 ${allNoteCards.length} 条笔记中发现 ${authors.length} 位创作者，正在分析...`,
        };

        const kocs = [];
        let consecutiveBlocks = 0;
        let profileFetchCount = 0;
        const candidateAuthors = authors.slice(0, Math.max(maxResults * 2, maxResults));

        for (let i = 0; i < candidateAuthors.length && kocs.length < maxResults; i += 1) {
            this.assertNotCancelled(options);
            const author = candidateAuthors[i];
            const progress = 45 + Math.round((i / Math.max(candidateAuthors.length, 1)) * 50);

            try {
                // 连续被拦截 3 次才彻底放弃 profile 获取
                const shouldFetchProfile = consecutiveBlocks < 3;

                const card = {
                    userId: author.userId,
                    nickname: author.nickname,
                    profileUrl: author.profileUrl,
                    fans: '',
                    description: author.posts.map((post) => post.title || '').join(' | ').slice(0, 240),
                    avatar: '',
                };

                this.writeDebugLog('profile_loop_entry', {
                    i,
                    userId: author.userId,
                    shouldFetchProfile,
                    consecutiveBlocks,
                    profileFetchCount,
                });

                const profileData = shouldFetchProfile
                    ? await this.getProfileData(page, card, options)
                    : this.buildCardOnlyProfile(card);

                if (shouldFetchProfile) profileFetchCount += 1;
                if (profileData.authLimited && !profileData.cardOnly) {
                    consecutiveBlocks += 1;
                    this.writeDebugLog('profile_blocked', {
                        userId: author.userId,
                        consecutiveBlocks,
                        action: consecutiveBlocks < 3 ? 'will_retry_after_cooldown' : 'giving_up',
                    });
                    // 被拦截后等待更久再重试
                    if (consecutiveBlocks < 3) {
                        const cooldown = consecutiveBlocks * 15000 + 10000;
                        yield {
                            progress,
                            kocs: [...kocs],
                            message: `触发风控，等待 ${Math.round(cooldown / 1000)}s 后重试...`,
                        };
                        await this.wait(cooldown);
                    }
                } else if (shouldFetchProfile) {
                    // 成功获取 profile，重置连续失败计数
                    consecutiveBlocks = 0;
                }

                const followers = this.parseCount(profileData.followers || '0');
                if (options.minFollowers && followers > 0 && followers < options.minFollowers) continue;
                if (options.maxFollowers && followers > 0 && followers > options.maxFollowers) continue;

                const kocData = await this.normalizeData({
                    userId: author.userId,
                    username: profileData.redId || author.userId,
                    nickname: profileData.nickname || author.nickname,
                    avatar: profileData.avatar || '',
                    profileUrl: author.profileUrl || `${this.homeUrl}/user/profile/${author.userId}`,
                    followers,
                    following: this.parseCount(profileData.following),
                    likes: this.parseCount(profileData.likes),
                    posts: this.parseCount(profileData.posts),
                    description: profileData.description || card.description,
                    category: this.inferCategory(profileData.description || card.description, keyword),
                    recentPosts: profileData.recentPosts || [],
                    engagementRate: profileData.engagementRate || 0,
                    relatedPosts: author.posts || [],
                    noteAppearances: author.noteCount || 0,
                    searchContextText: (author.posts || []).map((post) => post.title).join(' | '),
                    dataQuality: profileData.dataQuality || {
                        source: shouldFetchProfile ? 'profile_page' : 'note_discovery',
                        profileFetched: shouldFetchProfile && !profileData.authLimited,
                    },
                });

                kocs.push(kocData);
            } catch (err) {
                if (err.code === 'TASK_ABORTED') throw err;
                this.writeDebugLog('note_author_profile_failed', {
                    userId: author.userId,
                    message: err.message,
                });
            }

            yield {
                progress,
                kocs: [...kocs],
                message: `已分析 ${i + 1}/${candidateAuthors.length} 位创作者`,
            };

            if (consecutiveBlocks >= 3) {
                await page.randomDelay(800, 1500);
            } else {
                // 正常 profile 获取之间留足间隔，减少触发风控
                await page.randomDelay(8000, 13000);
            }
        }

        if (options.skipSeen && kocs.length > 0) {
            this.saveSeenUsers(kocs.map((koc) => koc.userId), seenUsers);
        }

        await page.close().catch(() => { });
        yield { progress: 100, kocs, message: `搜索完成，共找到 ${kocs.length} 个 KOC` };
    }

    async *search(keyword, options = {}) {
        const maxResults = options.maxResults || 20;
        const searchMode = options.searchMode || 'notes';
        let page = null;

        try {
            if (this.usingMcp) {
                yield* this.searchViaMcp(keyword, options);
                return;
            }

            const loggedIn = await this.isLoggedIn();
            if (!loggedIn) {
                yield {
                    progress: 100,
                    kocs: [],
                    error: '小红书登录态无效，请先点击右上角“平台登录”重新扫码登录',
                };
                return;
            }

            this.assertNotCancelled(options);
            page = await browserManager.newPage('xiaohongshu');

            yield { progress: 5, kocs: [], message: '正在打开小红书搜索...' };

            const targetSearch = searchMode === 'notes' ? 'notes' : 'users';
            const searchPageUrl = `${this.searchUrl}?${new URLSearchParams({
                keyword,
                target_search: targetSearch,
                source: 'deeplink',
            }).toString()}`;

            page = await this.openSearchEntryPage(page, keyword, searchPageUrl, searchMode);
            page = await this.ensureSearchResultsPage(page, searchPageUrl, keyword, searchMode);
            await this.dismissLoginOverlay(page);

            yield { progress: 15, kocs: [], message: '正在加载搜索结果...' };

            if (searchMode === 'notes') {
                yield* this.searchByNotes(page, searchPageUrl, keyword, maxResults, options);
                return;
            }

            const searchKeywords = options.expandKeywords ? this.expandKeywords(keyword) : [keyword];
            const seenUsers = options.skipSeen ? this.loadSeenUsers() : new Set();
            const userCardMap = new Map();

            for (let keywordIndex = 0; keywordIndex < searchKeywords.length; keywordIndex += 1) {
                const searchKeyword = searchKeywords[keywordIndex];
                const keywordSearchUrl = `${this.searchUrl}?${new URLSearchParams({
                    keyword: searchKeyword,
                    target_search: 'users',
                    source: 'deeplink',
                }).toString()}`;

                page = await this.openSearchEntryPage(page, searchKeyword, keywordSearchUrl, 'users');
                page = await this.ensureSearchResultsPage(page, keywordSearchUrl, searchKeyword, 'users');
                await this.dismissLoginOverlay(page);
                await this.focusUserTab(page);

                let scrollAttempts = 0;
                let lastCount = userCardMap.size;

                while (userCardMap.size < maxResults && scrollAttempts < 8) {
                    this.assertNotCancelled(options);
                    page = await this.ensureSearchResultsPage(page, keywordSearchUrl, searchKeyword, 'users');
                    await this.dismissLoginOverlay(page);

                    const cards = await this.collectUserCards(page);
                    for (const card of cards) {
                        if (!card.userId || seenUsers.has(card.userId)) continue;
                        const existing = userCardMap.get(card.userId);
                        userCardMap.set(card.userId, this.mergeUserCard(existing, card));
                    }

                    if (userCardMap.size === lastCount) {
                        scrollAttempts += 1;
                    } else {
                        scrollAttempts = 0;
                    }
                    lastCount = userCardMap.size;

                    this.writeDebugLog('search_cards_filtered', {
                        keyword,
                        searchKeyword,
                        filtered: userCardMap.size,
                        scrollAttempts,
                    });

                    yield {
                        progress: 15 + Math.min(30, Math.round((userCardMap.size / maxResults) * 30)),
                        kocs: [],
                        message: `正在搜索关联词: ${searchKeyword} (${keywordIndex + 1}/${searchKeywords.length})，已找到 ${userCardMap.size} 个用户`,
                    };

                    await page.humanScroll(500);
                }
            }

            const userCards = [...userCardMap.values()].sort(
                (a, b) => this.parseCount(b.fans) - this.parseCount(a.fans)
            );

            this.writeDebugLog('selected_user_cards', {
                keyword,
                count: userCards.length,
                cards: userCards.slice(0, maxResults).map((card) => ({
                    userId: card.userId,
                    nickname: card.nickname,
                    fans: card.fans || '',
                    followerText: card.followerText || '',
                    rootPreview: card.rootPreview || '',
                })),
            });

            if (userCards.length === 0) {
                const reason = await this.diagnoseZeroResult(page, keyword);
                await page.close().catch(() => { });
                yield { progress: 100, kocs: [], error: reason };
                return;
            }

            yield {
                progress: 45,
                kocs: [],
                message: `共找到 ${userCards.length} 个用户，正在获取详细信息...`,
            };

            const kocs = [];
            let profileAccessBlocked = false;
            let profileFetchCount = 0;

            for (let i = 0; i < Math.min(userCards.length, maxResults); i += 1) {
                this.assertNotCancelled(options);
                const card = userCards[i];
                const progress = 45 + Math.round((i / Math.min(userCards.length, maxResults)) * 50);

                try {
                    const cardFollowers = this.parseCount(card.fans);
                    if (options.minFollowers && cardFollowers > 0 && cardFollowers < options.minFollowers) {
                        continue;
                    }
                    if (options.maxFollowers && cardFollowers > 0 && cardFollowers > options.maxFollowers) {
                        continue;
                    }

                    const shouldFetchProfile =
                        !profileAccessBlocked &&
                        profileFetchCount < this.maxProfileFetchesPerRun;

                    const profileData = shouldFetchProfile
                        ? await this.getProfileData(page, card, options)
                        : this.buildCardOnlyProfile(card);

                    if (shouldFetchProfile) profileFetchCount += 1;
                    if (profileData.authLimited && !profileData.cardOnly) {
                        profileAccessBlocked = true;
                    }

                    const followers = this.parseCount(profileData.followers || card.fans);
                    if (options.minFollowers && followers > 0 && followers < options.minFollowers) continue;
                    if (options.maxFollowers && followers > 0 && followers > options.maxFollowers) continue;

                    const kocData = await this.normalizeData({
                        userId: card.userId,
                        username: profileData.redId || card.userId,
                        nickname: profileData.nickname || card.nickname,
                        avatar: profileData.avatar || card.avatar,
                        profileUrl: card.profileUrl || `${this.homeUrl}/user/profile/${card.userId}`,
                        followers,
                        following: this.parseCount(profileData.following),
                        likes: this.parseCount(profileData.likes),
                        posts: this.parseCount(profileData.posts),
                        description: profileData.description || card.description,
                        category: this.inferCategory(profileData.description || card.description, keyword),
                        recentPosts: profileData.recentPosts || [],
                        engagementRate: profileData.engagementRate || 0,
                        searchContextText: card.searchContextText || '',
                        dataQuality: profileData.dataQuality || {
                            source: shouldFetchProfile ? 'profile_page' : 'search_card',
                            profileFetched: shouldFetchProfile && !profileData.authLimited,
                        },
                    });

                    kocs.push(kocData);
                } catch (err) {
                    if (err.code === 'TASK_ABORTED') throw err;
                    console.warn(`[小红书] 获取用户 ${card.nickname} 详情失败:`, err.message);
                }

                yield {
                    progress,
                    kocs: [...kocs],
                    message: `已分析 ${i + 1}/${Math.min(userCards.length, maxResults)} 个用户`,
                };

                if (profileAccessBlocked) {
                    await page.randomDelay(800, 1500);
                } else if (profileFetchCount > 0) {
                    await page.randomDelay(6500, 9500);
                } else {
                    await page.randomDelay(800, 1500);
                }
            }

            if (options.skipSeen && kocs.length > 0) {
                this.saveSeenUsers(kocs.map((koc) => koc.userId), seenUsers);
            }

            await page.close().catch(() => { });
            yield { progress: 100, kocs, message: `搜索完成，共找到 ${kocs.length} 个 KOC` };
        } catch (err) {
            if (page) await page.close().catch(() => { });
            if (err.code === 'TASK_ABORTED') {
                yield { progress: 100, kocs: [], error: '任务已取消' };
                return;
            }
            yield { progress: 100, kocs: [], error: `小红书搜索失败: ${err.message}` };
        }
    }

    async getProfileData(page, card, options = {}) {
        const result = {
            nickname: card.nickname,
            description: card.description,
            avatar: card.avatar,
            followers: card.fans,
            following: '0',
            likes: '0',
            posts: '0',
            recentPosts: [],
            engagementRate: 0,
        };

        if (!card.userId) return result;

        // 复用传入的 page 导航到 profile（避免开新 tab 触发风控）
        const profileUrl = `${this.homeUrl}/user/profile/${card.userId}`;
        try {
            this.assertNotCancelled(options);
            this.writeDebugLog('profile_fetch_start', { userId: card.userId, nickname: card.nickname, mode: 'reuse_page' });
            await page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
            await page.randomDelay(2000, 3500);

            const pageUrl = page.url();
            if (this.isCaptchaOrLoginUrl(pageUrl)) {
                this.writeDebugLog('profile_fetch_auth_blocked', { userId: card.userId, redirectUrl: pageUrl });
                const resolved = await this.waitForCaptchaResolution(page, profileUrl, options);
                if (!resolved) {
                    return {
                        ...result,
                        authLimited: true,
                    };
                }
                await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => { });
                await page.randomDelay(1200, 2200);
            }

            const profileInfo = await page.evaluate(() => {
                const bodyText = document.body?.innerText || '';
                const authLimited = /扫码登录|手机号登录|立即登录|请先登录|登录后查看/i.test(bodyText);

                // ── 方法一：从 __INITIAL_STATE__ 提取（最可靠） ──
                try {
                    const state = window.__INITIAL_STATE__;
                    const pageData = state?.user?.userPageData;
                    if (pageData) {
                        const basicInfo = pageData.basicInfo || {};
                        const interactions = pageData.interactions || [];

                        let fans = '', follows = '', interaction = '';
                        for (const item of interactions) {
                            if (item.type === 'fans') fans = String(item.count || '');
                            else if (item.type === 'follows') follows = String(item.count || '');
                            else if (item.type === 'interaction') interaction = String(item.count || '');
                        }

                        // 笔记列表
                        const rawNotes = (state.user?.notes || [])[0] || [];
                        const notes = [];
                        for (const n of rawNotes.slice(0, 6)) {
                            notes.push({
                                title: n.display_title || n.title || '',
                                likes: String(n.liked_count || n.likes || '0'),
                                comments: '0',
                            });
                        }

                        const tags = (pageData.tags || []).map(t => t.name || '').filter(Boolean);

                        return {
                            source: '__INITIAL_STATE__',
                            redId: basicInfo.redId || '',
                            nickname: basicInfo.nickname || '',
                            description: basicInfo.desc || '',
                            avatar: basicInfo.imageb || basicInfo.images || '',
                            followers: fans,
                            following: follows,
                            likes: interaction,
                            posts: String(rawNotes.length || '0'),
                            recentNotes: notes,
                            tags,
                            authLimited,
                        };
                    }
                } catch (_e) { /* fallback to DOM parsing */ }

                // ── 方法二：DOM 文本解析（fallback） ──
                const getText = (selectors) => {
                    for (const sel of selectors) {
                        const el = document.querySelector(sel);
                        if (el?.textContent?.trim()) return el.textContent.trim();
                    }
                    return '';
                };
                const getTextLines = (text) =>
                    String(text || '')
                        .split('\n')
                        .map((line) => line.trim())
                        .filter(Boolean);
                const pickLine = (lines, patterns = []) => {
                    for (const line of lines) {
                        if (patterns.some((pattern) => pattern.test(line))) {
                            return line;
                        }
                    }
                    return '';
                };
                const extractMetricFromLine = (line, patterns = []) => {
                    for (const pattern of patterns) {
                        const match = String(line || '').match(pattern);
                        if (match?.[1]) return match[1].trim();
                    }
                    return '';
                };

                const bodyLines = getTextLines(bodyText);

                const nickname = getText(['.user-name', '.name', '[class*="nickname"]', 'h1']) || '';
                const description = getText([
                    '.user-desc',
                    '.desc',
                    '[class*="description"]',
                    '[class*="bio"]',
                ]) || '';
                const followerLine = pickLine(bodyLines, [
                    /(?:粉丝|关注者)\s*[：:・·• ]?\s*[0-9.]+[千萬万亿wWkK+]?/,
                    /[0-9.]+[千萬万亿wWkK+]?\s*(?:粉丝|关注者)/,
                ]);
                const followingLine = pickLine(bodyLines, [
                    /(?:关注)\s*[：:・·• ]?\s*[0-9.]+[千萬万亿wWkK+]?/,
                    /[0-9.]+[千萬万亿wWkK+]?\s*关注/,
                ]);
                const likeLine = pickLine(bodyLines, [
                    /(?:获赞|赞与收藏|赞藏)\s*[：:・·• ]?\s*[0-9.]+[千萬万亿wWkK+]?/,
                    /[0-9.]+[千萬万亿wWkK+]?\s*(?:获赞|赞与收藏|赞藏)/,
                ]);
                const noteCount = getText(['[class*="note-count"]', '.tab-count', '.note-num']);

                const noteEls = document.querySelectorAll('.note-item, [class*="note-card"], .cover-container');
                const notes = [];
                noteEls.forEach((el, idx) => {
                    if (idx >= 6) return;
                    const title = el.querySelector('.title, [class*="title"], .footer span')
                        ?.textContent?.trim();
                    const likeEl = el.querySelector('[class*="like"], .like-count, .engagement span');
                    const likeText = likeEl?.textContent?.trim() || '0';
                    notes.push({ title: title || '', likes: likeText, comments: '0' });
                });

                const avatarEl = document.querySelector(
                    '.avatar img, .user-avatar img, [class*="avatar"] img'
                );

                return {
                    source: 'dom_fallback',
                    nickname,
                    description,
                    avatar: avatarEl?.src || '',
                    followers: extractMetricFromLine(followerLine, [
                        /(?:粉丝|关注者)\s*[：:・·• ]?\s*([0-9.]+[千萬万亿wWkK+]?)/,
                        /([0-9.]+[千萬万亿wWkK+]?)(?=\s*(?:粉丝|关注者))/,
                    ]),
                    following: extractMetricFromLine(followingLine, [
                        /关注\s*[：:・·• ]?\s*([0-9.]+[千萬万亿wWkK+]?)/,
                        /([0-9.]+[千萬万亿wWkK+]?)(?=\s*关注)/,
                    ]),
                    likes: extractMetricFromLine(likeLine, [
                        /(?:获赞|赞与收藏|赞藏)\s*[：:・·• ]?\s*([0-9.]+[千萬万亿wWkK+]?)/,
                        /([0-9.]+[千萬万亿wWkK+]?)(?=\s*(?:获赞|赞与收藏|赞藏))/,
                    ]),
                    posts: noteCount || String(noteEls.length),
                    recentNotes: notes,
                    authLimited,
                };
            });

            this.writeDebugLog('profile_page_extracted', {
                userId: card.userId,
                redId: profileInfo.redId || '',
                source: profileInfo.source,
                nickname: profileInfo.nickname,
                followers: profileInfo.followers,
                following: profileInfo.following,
                likes: profileInfo.likes,
                authLimited: profileInfo.authLimited,
                recentNotesCount: (profileInfo.recentNotes || []).length,
            });

            if (profileInfo.authLimited) {
                return {
                    ...result,
                    authLimited: true,
                };
            }

            result.redId = profileInfo.redId || result.redId || '';
            result.nickname = profileInfo.nickname || result.nickname;
            result.description = profileInfo.description || result.description;
            result.avatar = profileInfo.avatar || result.avatar;
            result.followers = profileInfo.followers || result.followers;
            result.following = profileInfo.following || result.following;
            result.likes = profileInfo.likes || result.likes;
            result.posts = profileInfo.posts || result.posts;

            const followers = this.parseCount(result.followers);
            result.recentPosts = (profileInfo.recentNotes || []).map((note) => ({
                title: note.title,
                likes: this.parseCount(note.likes),
                comments: this.parseCount(note.comments),
                shares: 0,
            }));

            if (result.recentPosts.length > 0 && followers > 0) {
                const avgEngagement =
                    result.recentPosts.reduce((sum, post) => sum + post.likes + post.comments, 0) /
                    result.recentPosts.length;
                result.engagementRate = avgEngagement / followers;
            }
        } catch (err) {
            if (err.code === 'TASK_ABORTED') throw err;
            this.writeDebugLog('profile_fetch_error', { userId: card.userId, message: err.message });
        }

        return result;
    }

    inferCategory(desc, keyword) {
        const categories = {
            美妆: ['美妆', '化妆', '护肤', '彩妆', '口红', '面膜', '精华'],
            穿搭: ['穿搭', '时尚', '搭配', 'OOTD', '服装', '衣服'],
            美食: ['美食', '做饭', '食谱', '餐厅', '烘焙'],
            旅行: ['旅行', '旅游', '出行', '打卡', '景点', '攻略'],
            健身: ['健身', '运动', '减肥', '瑜伽', '跑步', '增肌'],
            母婴: ['母婴', '育儿', '宝宝', '孕期', '辅食', '亲子'],
            数码: ['数码', '手机', '电脑', '相机', '耳机', '科技'],
            家居: ['家居', '装修', '收纳', '好物', '家装'],
            宠物: ['宠物', '猫', '狗', '养猫', '养狗'],
            学习: ['学习', '考试', '考研', '四六级', '教程'],
            潮玩: ['潮玩', '盲盒', '手办', '潮流玩具', '开箱'],
        };

        const text = `${desc} ${keyword}`.toLowerCase();
        for (const [cat, keywords] of Object.entries(categories)) {
            if (keywords.some((item) => text.includes(item))) return cat;
        }
        return '综合';
    }
}
