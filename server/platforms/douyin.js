import BasePlatform from './base.js';
import browserManager from '../browser-manager.js';

/**
 * 抖音适配器 — Playwright 浏览器自动化
 */
export default class DouyinPlatform extends BasePlatform {
    constructor() {
        super('douyin', '🎵');
        this.homeUrl = 'https://www.douyin.com';
        this.searchUrl = 'https://www.douyin.com/search';
        this.authCookieNames = ['sessionid', 'sessionid_ss'];
    }

    async hasAuthCookie() {
        try {
            const context = await browserManager.getContext('douyin');
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
            const page = await browserManager.newPage('douyin');
            await page.goto(this.homeUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

            console.log('[抖音] 请在浏览器中扫码登录...');

            try {
                const timeoutMs = 120000;
                const pollEveryMs = 1500;
                const start = Date.now();

                while (Date.now() - start < timeoutMs) {
                    if (await this.hasAuthCookie()) {
                        await browserManager.saveCookies('douyin');
                        await page.close();
                        return { success: true, message: '抖音登录成功！' };
                    }
                    await page.waitForTimeout(pollEveryMs);
                }

                await page.close();
                return { success: false, message: '登录超时，请扫码后重试' };
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
            page = await browserManager.newPage('douyin');

            yield { progress: 5, kocs: [], message: '正在打开抖音搜索...' };

            // 搜索用户
            const url = `${this.searchUrl}/${encodeURIComponent(keyword)}?type=1`;
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
            await page.randomDelay(3000, 5000);

            yield { progress: 15, kocs: [], message: '正在加载搜索结果...' };

            // 切换到用户标签
            try {
                const userTab = await page.$(
                    'span:has-text("用户"), [data-tab="user"], li:has-text("用户")'
                );
                if (userTab) {
                    await userTab.click();
                    await page.randomDelay(2000, 3500);
                }
            } catch {
                // ignore
            }

            // 滚动收集用户卡片
            const userCards = [];
            let scrollAttempts = 0;
            let lastCount = 0;

            while (userCards.length < maxResults && scrollAttempts < 8) {
                this.assertNotCancelled(options);
                const cards = await page.$$eval(
                    '[class*="user-card"], [class*="user-list-item"], a[href*="/user/"], .search-result-card',
                    (elements) =>
                        elements.map((el) => {
                            const nameEl = el.querySelector(
                                '[class*="nickname"], [class*="name"], .title, h3, span.name'
                            );
                            const fansEl = el.querySelector(
                                '[class*="fans"], [class*="follower"], .desc'
                            );
                            const descEl = el.querySelector(
                                '[class*="signature"], [class*="desc"], [class*="bio"]'
                            );
                            const avatarEl = el.querySelector('img');
                            const linkEl = el.closest('a[href*="/user/"]') || el.querySelector('a[href*="/user/"]');
                            const idMatch = linkEl?.href?.match(
                                /\/user\/([a-zA-Z0-9_-]+)/
                            );

                            return {
                                nickname: nameEl?.textContent?.trim() || '',
                                fans: fansEl?.textContent?.trim() || '',
                                description: descEl?.textContent?.trim() || '',
                                avatar: avatarEl?.src || '',
                                userId: idMatch ? idMatch[1] : '',
                                profileUrl: linkEl?.href || '',
                            };
                        })
                );

                for (const card of cards) {
                    if (card.userId && !userCards.find((c) => c.userId === card.userId)) {
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
                    const followers = this.parseCount(profileData.followers || card.fans);

                    if (options.minFollowers && followers < options.minFollowers) continue;
                    if (options.maxFollowers && followers > options.maxFollowers) continue;

                    const kocData = this.normalizeData({
                        userId: card.userId,
                        username: card.userId,
                        nickname: profileData.nickname || card.nickname,
                        avatar: profileData.avatar || card.avatar,
                        profileUrl: card.profileUrl || `${this.homeUrl}/user/${card.userId}`,
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
                    console.warn(`[抖音] 获取用户 ${card.nickname} 详情失败:`, err.message);
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
            yield { progress: 100, kocs: [], error: `抖音搜索失败: ${err.message}` };
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
            profilePage = await browserManager.newPage('douyin');
            const profileUrl = `${this.homeUrl}/user/${card.userId}`;
            await profilePage.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
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
                    '[class*="nickname"]',
                    '[class*="name"]',
                    'h1',
                    'span.name',
                ]);
                const description = getText([
                    '[class*="signature"]',
                    '[class*="desc"]',
                    '[class*="bio"]',
                ]);

                // 统计数据
                const statEls = document.querySelectorAll(
                    '[class*="count"], [class*="stat"], .data-item'
                );
                const stats = {};

                statEls.forEach((el) => {
                    const text = el.textContent || '';
                    const numEl = el.querySelector(
                        'span, em, strong, [class*="num"]'
                    );
                    const num = numEl?.textContent?.trim() || '';

                    if (text.includes('关注')) stats.following = num;
                    else if (text.includes('粉丝')) stats.followers = num;
                    else if (text.includes('获赞')) stats.likes = num;
                });

                // 作品数
                const worksCount = getText([
                    '[class*="works-count"]',
                    '[class*="video-count"]',
                    '.tab-count',
                ]);

                // 近期视频
                const videoEls = document.querySelectorAll(
                    '[class*="video-card"], [class*="video-item"], .cover-container, li[class*="item"]'
                );
                const videos = [];
                videoEls.forEach((el, idx) => {
                    if (idx >= 6) return;
                    const title =
                        el.querySelector('[class*="title"], .desc')?.textContent?.trim() ||
                        '';
                    const likeEl = el.querySelector(
                        '[class*="like"], [class*="digg"]'
                    );
                    const likeText = likeEl?.textContent?.trim() || '0';
                    videos.push({
                        title,
                        likes: likeText,
                        comments: '0',
                    });
                });

                const avatarEl = document.querySelector(
                    'img[class*="avatar"], [class*="avatar"] img'
                );

                return {
                    nickname,
                    description,
                    avatar: avatarEl?.src || '',
                    followers: stats.followers || '',
                    following: stats.following || '',
                    likes: stats.likes || '',
                    posts: worksCount || String(videoEls.length),
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
                comments: this.parseCount(v.comments),
                shares: 0,
            }));

            if (result.recentPosts.length > 0 && followers > 0) {
                const avgEngagement =
                    result.recentPosts.reduce((s, p) => s + p.likes + p.comments, 0) /
                    result.recentPosts.length;
                result.engagementRate = avgEngagement / followers;
            }

        } catch (err) {
            if (err.code === 'TASK_ABORTED') throw err;
            console.warn(`[抖音] 获取资料页失败: ${err.message}`);
        } finally {
            if (profilePage) await profilePage.close().catch(() => {});
        }

        return result;
    }

    inferCategory(desc, keyword) {
        const categories = {
            美妆: ['美妆', '化妆', '护肤', '彩妆', '口红'],
            穿搭: ['穿搭', '时尚', '搭配', 'OOTD', '服装'],
            美食: ['美食', '做饭', '食谱', '餐厅', '烹饪'],
            旅行: ['旅行', '旅游', '出行', '打卡', '景点'],
            健身: ['健身', '运动', '减肥', '瑜伽', '跑步'],
            搞笑: ['搞笑', '段子', '幽默', '趣味', '整蛊'],
            知识: ['知识', '科普', '教育', '学习', '干货'],
            音乐: ['音乐', '唱歌', '翻唱', '原创音乐'],
            舞蹈: ['舞蹈', '跳舞', '编舞', '街舞'],
            游戏: ['游戏', '电竞', '王者', '吃鸡'],
        };

        const text = `${desc} ${keyword}`.toLowerCase();
        for (const [cat, keywords] of Object.entries(categories)) {
            if (keywords.some((k) => text.includes(k))) return cat;
        }
        return '综合';
    }
}
