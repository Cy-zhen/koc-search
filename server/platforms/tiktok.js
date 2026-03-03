import BasePlatform from './base.js';
import browserManager from '../browser-manager.js';

/**
 * TikTok 适配器 — Playwright 浏览器自动化
 */
export default class TikTokPlatform extends BasePlatform {
    constructor() {
        super('tiktok', '🎶');
        this.homeUrl = 'https://www.tiktok.com';
        this.authCookieNames = ['sessionid', 'sessionid_ss', 'sid_tt'];
    }

    async hasAuthCookie() {
        try {
            const context = await browserManager.getContext('tiktok');
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

    async isLoggedIn() {
        if (this.usingMcp) {
            try {
                const status = await this.callMcp('status');
                return !!status.loggedIn;
            } catch {
                return false;
            }
        }

        return this.hasAuthCookie();
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

        try {
            const page = await browserManager.newPage('tiktok');
            await page.goto(`${this.homeUrl}/login`, {
                waitUntil: 'domcontentloaded',
                timeout: 30000,
            });

            console.log('[TikTok] 请在浏览器中登录...');

            try {
                const timeoutMs = 120000;
                const pollEveryMs = 1500;
                const start = Date.now();

                while (Date.now() - start < timeoutMs) {
                    if (await this.hasAuthCookie()) {
                        await browserManager.saveCookies('tiktok');
                        await page.close();
                        return { success: true, message: 'TikTok 登录成功！' };
                    }
                    await page.waitForTimeout(pollEveryMs);
                }

                await page.close();
                return { success: false, message: '登录超时，请登录后重试' };
            } catch (err) {
                await page.close();
                return { success: false, message: `登录超时或失败: ${err.message}` };
            }
        } catch (err) {
            return { success: false, message: `登录失败: ${err.message}` };
        }
    }

    async *search(keyword, options = {}) {
        const maxResults = options.maxResults || 20;
        let page = null;

        try {
            if (this.usingMcp) {
                yield* this.searchViaMcp(keyword, options);
                return;
            }

            this.assertNotCancelled(options);
            page = await browserManager.newPage('tiktok');

            yield { progress: 5, kocs: [], message: '正在打开 TikTok 搜索...' };

            const url = `${this.homeUrl}/search/user?q=${encodeURIComponent(keyword)}`;
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
            await page.randomDelay(3000, 5000);

            yield { progress: 15, kocs: [], message: '正在加载搜索结果...' };

            // 滚动收集用户卡片
            const userCards = [];
            let scrollAttempts = 0;
            let lastCount = 0;

            while (userCards.length < maxResults && scrollAttempts < 8) {
                this.assertNotCancelled(options);
                const cards = await page.$$eval(
                    '[data-e2e="search-user-container"] > div, [class*="UserListItem"], a[href*="/@"]',
                    (elements) =>
                        elements.map((el) => {
                            const nameEl = el.querySelector(
                                '[data-e2e="search-user-unique-id"], [class*="uniqueId"], [class*="username"], p[class*="title"]'
                            );
                            const nicknameEl = el.querySelector(
                                '[data-e2e="search-user-nickname"], [class*="nickname"], h3'
                            );
                            const fansEl = el.querySelector(
                                '[data-e2e="search-user-fans"], [class*="follower"], [class*="fans"]'
                            );
                            const descEl = el.querySelector(
                                '[data-e2e="search-user-desc"], [class*="desc"], [class*="bio"]'
                            );
                            const avatarEl = el.querySelector('img');
                            const linkEl =
                                el.closest('a[href*="/@"]') || el.querySelector('a[href*="/@"]');
                            const usernameMatch = linkEl?.href?.match(/\/@([^/?]+)/);

                            return {
                                username: nameEl?.textContent?.trim() || usernameMatch?.[1] || '',
                                nickname: nicknameEl?.textContent?.trim() || '',
                                fans: fansEl?.textContent?.trim() || '',
                                description: descEl?.textContent?.trim() || '',
                                avatar: avatarEl?.src || '',
                                userId: usernameMatch?.[1] || '',
                                profileUrl: linkEl?.href || '',
                            };
                        })
                );

                for (const card of cards) {
                    if (
                        card.userId &&
                        !userCards.find((c) => c.userId === card.userId)
                    ) {
                        userCards.push(card);
                    }
                }

                if (userCards.length === lastCount) scrollAttempts++;
                else scrollAttempts = 0;
                lastCount = userCards.length;

                await page.humanScroll(600);
                yield {
                    progress: 15 + Math.min(30, Math.round((userCards.length / maxResults) * 30)),
                    kocs: [],
                    message: `已找到 ${userCards.length} 个用户...`,
                };
            }

            yield {
                progress: 45,
                kocs: [],
                message: `共找到 ${userCards.length} 个用户，正在获取详细信息...`,
            };

            // 获取每个用户详情
            const kocs = [];

            for (let i = 0; i < Math.min(userCards.length, maxResults); i++) {
                this.assertNotCancelled(options);
                const card = userCards[i];
                const progress = 45 + Math.round((i / Math.min(userCards.length, maxResults)) * 50);

                try {
                    const profileData = await this.getProfileData(card, options);
                    const followers = this.parseCount(
                        profileData.followers || card.fans
                    );

                    if (options.minFollowers && followers < options.minFollowers) continue;
                    if (options.maxFollowers && followers > options.maxFollowers) continue;

                    const kocData = this.normalizeData({
                        userId: card.userId,
                        username: card.username || card.userId,
                        nickname: profileData.nickname || card.nickname,
                        avatar: profileData.avatar || card.avatar,
                        profileUrl:
                            card.profileUrl || `${this.homeUrl}/@${card.userId}`,
                        followers,
                        following: this.parseCount(profileData.following),
                        likes: this.parseCount(profileData.likes),
                        posts: this.parseCount(profileData.posts),
                        description: profileData.description || card.description,
                        category: this.inferCategory(
                            profileData.description || card.description,
                            keyword
                        ),
                        recentPosts: profileData.recentPosts || [],
                        engagementRate: profileData.engagementRate || 0,
                    });

                    kocs.push(kocData);
                } catch (err) {
                    if (err.code === 'TASK_ABORTED') throw err;
                    console.warn(
                        `[TikTok] 获取用户 ${card.nickname || card.username} 详情失败:`,
                        err.message
                    );
                }

                yield {
                    progress,
                    kocs: [...kocs],
                    message: `已分析 ${i + 1}/${Math.min(userCards.length, maxResults)} 个用户`,
                };

                await page.randomDelay(2000, 4000);
            }

            await page.close();
            yield { progress: 100, kocs, message: `搜索完成，共找到 ${kocs.length} 个 KOC` };
        } catch (err) {
            if (page) await page.close();
            if (err.code === 'TASK_ABORTED') {
                yield { progress: 100, kocs: [], error: '任务已取消' };
                return;
            }
            yield { progress: 100, kocs: [], error: `TikTok 搜索失败: ${err.message}` };
        }
    }

    async getProfileData(card, options = {}) {
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

        let profilePage = null;
        try {
            this.assertNotCancelled(options);
            profilePage = await browserManager.newPage('tiktok');
            const profileUrl = `${this.homeUrl}/@${card.userId}`;
            await profilePage.goto(profileUrl, {
                waitUntil: 'domcontentloaded',
                timeout: 15000,
            });
            await profilePage.randomDelay(2500, 4000);

            const profileInfo = await profilePage.evaluate(() => {
                const getText = (selectors) => {
                    for (const sel of selectors) {
                        const el = document.querySelector(sel);
                        if (el?.textContent?.trim()) return el.textContent.trim();
                    }
                    return '';
                };

                const nickname = getText([
                    '[data-e2e="user-subtitle"]',
                    'h1[data-e2e="user-title"]',
                    'h2[class*="ShareTitle"]',
                    '[class*="nickname"]',
                    'h1',
                ]);

                const description = getText([
                    '[data-e2e="user-bio"]',
                    'h2[data-e2e="user-bio"]',
                    '[class*="bio"]',
                    '[class*="desc"]',
                ]);

                const followers = getText([
                    '[data-e2e="followers-count"]',
                    '[class*="follower"] strong',
                    '[title="Followers"] strong',
                ]);

                const following = getText([
                    '[data-e2e="following-count"]',
                    '[class*="following"] strong',
                    '[title="Following"] strong',
                ]);

                const likes = getText([
                    '[data-e2e="likes-count"]',
                    '[class*="likes"] strong',
                    '[title="Likes"] strong',
                ]);

                // 视频
                const videoEls = document.querySelectorAll(
                    '[data-e2e="user-post-item"], [class*="DivItemContainer"], [class*="video-feed"] > div'
                );
                const videos = [];
                videoEls.forEach((el, idx) => {
                    if (idx >= 6) return;
                    const viewEl = el.querySelector(
                        '[data-e2e="video-views"], strong, [class*="count"]'
                    );
                    videos.push({
                        title: el.querySelector('[class*="title"]')?.textContent?.trim() || '',
                        views: viewEl?.textContent?.trim() || '0',
                        likes: '0',
                        comments: '0',
                    });
                });

                const avatarEl = document.querySelector(
                    '[data-e2e="user-avatar"] img, img[class*="ImgAvatar"]'
                );

                return {
                    nickname,
                    description,
                    avatar: avatarEl?.src || '',
                    followers,
                    following,
                    likes,
                    posts: String(videoEls.length),
                    recentVideos: videos,
                };
            });

            result.nickname = profileInfo.nickname || result.nickname;
            result.description = profileInfo.description || result.description;
            result.avatar = profileInfo.avatar || result.avatar;
            result.followers = profileInfo.followers || result.followers;
            result.following = profileInfo.following;
            result.likes = profileInfo.likes;
            result.posts = profileInfo.posts;

            const followers = this.parseCount(result.followers);
            result.recentPosts = (profileInfo.recentVideos || []).map((v) => ({
                title: v.title,
                likes: this.parseCount(v.likes),
                views: this.parseCount(v.views),
                comments: this.parseCount(v.comments),
                shares: 0,
            }));

            if (result.recentPosts.length > 0 && followers > 0) {
                const avgEngagement =
                    result.recentPosts.reduce(
                        (s, p) => s + p.likes + p.comments,
                        0
                    ) / result.recentPosts.length;
                result.engagementRate = avgEngagement / followers;
            }

        } catch (err) {
            if (err.code === 'TASK_ABORTED') throw err;
            console.warn(`[TikTok] 获取资料页失败: ${err.message}`);
        } finally {
            if (profilePage) await profilePage.close().catch(() => {});
        }

        return result;
    }

    inferCategory(desc, keyword) {
        const categories = {
            Beauty: ['beauty', 'makeup', 'skincare', 'cosmetics'],
            Fashion: ['fashion', 'outfit', 'style', 'clothing', 'OOTD'],
            Food: ['food', 'cooking', 'recipe', 'foodie', 'restaurant'],
            Travel: ['travel', 'tourism', 'adventure', 'explore'],
            Fitness: ['fitness', 'gym', 'workout', 'yoga', 'health'],
            Comedy: ['comedy', 'funny', 'humor', 'joke', 'skit'],
            Education: ['education', 'learn', 'tutorial', 'tips', 'howto'],
            Music: ['music', 'singing', 'song', 'cover', 'musician'],
            Dance: ['dance', 'dancing', 'choreography', 'dancer'],
            Gaming: ['gaming', 'game', 'gamer', 'esports', 'streamer'],
            Tech: ['tech', 'technology', 'gadget', 'phone', 'review'],
        };

        const text = `${desc} ${keyword}`.toLowerCase();
        for (const [cat, keywords] of Object.entries(categories)) {
            if (keywords.some((k) => text.includes(k))) return cat;
        }
        return 'General';
    }
}
