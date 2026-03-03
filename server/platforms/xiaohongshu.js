import BasePlatform from './base.js';
import browserManager from '../browser-manager.js';

/**
 * 小红书适配器 — Playwright 浏览器自动化
 */
export default class XiaohongshuPlatform extends BasePlatform {
    constructor() {
        super('xiaohongshu', '📕');
        this.homeUrl = 'https://www.xiaohongshu.com';
        this.searchUrl = 'https://www.xiaohongshu.com/search_result';
        this.authCookieNames = ['web_session'];
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
                return `关键词“${keyword}”未检索到用户结果`;
            }
            return '未抓到用户结果，可能是页面结构变化或风控限制';
        } catch {
            return '未抓到用户结果，且无法诊断页面状态';
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
            const page = await browserManager.newPage('xiaohongshu');
            await page.goto(`${this.homeUrl}/explore`, { waitUntil: 'domcontentloaded', timeout: 30000 });

            // 等待用户手动扫码登录（最多 120 秒）
            console.log('[小红书] 请在浏览器中扫码登录...');

            try {
                const timeoutMs = 120000;
                const pollEveryMs = 1500;
                const start = Date.now();

                while (Date.now() - start < timeoutMs) {
                    if (await this.hasAuthCookie()) {
                        await browserManager.saveCookies('xiaohongshu');
                        await page.close();
                        return { success: true, message: '小红书登录成功！' };
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
            page = await browserManager.newPage('xiaohongshu');

            yield { progress: 5, kocs: [], message: '正在打开小红书搜索...' };

            // 搜索用户
            const searchPageUrl = `${this.searchUrl}?keyword=${encodeURIComponent(keyword)}&type=1`;
            await page.goto(searchPageUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
            await page.randomDelay(2000, 4000);

            yield { progress: 15, kocs: [], message: '正在加载搜索结果...' };

            // 切换到"用户"标签（如果有）
            try {
                const userTab = await page.$('span:has-text("用户"), div[data-type="user"]');
                if (userTab) {
                    await userTab.click();
                    await page.randomDelay(1500, 3000);
                }
            } catch {
                // 可能已经在用户标签
            }

            // 滚动加载更多结果
            const userCards = [];
            let lastCount = 0;
            let scrollAttempts = 0;

            while (userCards.length < maxResults && scrollAttempts < 8) {
                this.assertNotCancelled(options);
                const cards = await page.$$eval(
                    '.user-list-item, .user-card, [class*="user-item"], .search-user-item, a[href*="/user/profile/"]',
                    (elements) =>
                        elements.map((el) => {
                            const nameEl = el.querySelector(
                                '.user-name, .name, [class*="name"], h3, span.title'
                            );
                            const fansEl = el.querySelector(
                                '.user-fans, .fans, [class*="fans"], [class*="follower"]'
                            );
                            const descEl = el.querySelector(
                                '.user-desc, .desc, [class*="desc"], [class*="bio"]'
                            );
                            const avatarEl = el.querySelector('img, .avatar img');
                            const linkEl = el.closest('a') || el.querySelector('a');
                            const idMatch = linkEl?.href?.match(/\/user\/profile\/([a-zA-Z0-9]+)/);

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

                if (userCards.length === lastCount) {
                    scrollAttempts++;
                } else {
                    scrollAttempts = 0;
                }
                lastCount = userCards.length;

                await page.humanScroll(500);
                yield {
                    progress: 15 + Math.min(30, Math.round((userCards.length / maxResults) * 30)),
                    kocs: [],
                    message: `已找到 ${userCards.length} 个用户...`,
                };
            }

            if (userCards.length === 0) {
                const reason = await this.diagnoseZeroResult(page, keyword);
                await page.close();
                yield { progress: 100, kocs: [], error: reason };
                return;
            }

            yield {
                progress: 45,
                kocs: [],
                message: `共找到 ${userCards.length} 个用户，正在获取详细信息...`,
            };

            // 获取每个用户的详细信息
            const kocs = [];

            for (let i = 0; i < Math.min(userCards.length, maxResults); i++) {
                this.assertNotCancelled(options);
                const card = userCards[i];
                const progress = 45 + Math.round((i / Math.min(userCards.length, maxResults)) * 50);

                try {
                    const profileData = await this.getProfileData(page, card, options);

                    const followers = this.parseCount(profileData.followers || card.fans);

                    if (options.minFollowers && followers < options.minFollowers) continue;
                    if (options.maxFollowers && followers > options.maxFollowers) continue;

                    const kocData = this.normalizeData({
                        userId: card.userId,
                        username: card.userId,
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

                await page.randomDelay(1500, 3000);
            }

            await page.close();
            yield { progress: 100, kocs, message: `搜索完成，共找到 ${kocs.length} 个 KOC` };
        } catch (err) {
            if (page) await page.close();
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

        let profilePage = null;
        try {
            this.assertNotCancelled(options);
            profilePage = await browserManager.newPage('xiaohongshu');
            const profileUrl = `${this.homeUrl}/user/profile/${card.userId}`;
            await profilePage.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
            await profilePage.randomDelay(2000, 3500);

            // 提取用户信息
            const profileInfo = await profilePage.evaluate(() => {
                const getText = (selectors) => {
                    for (const sel of selectors) {
                        const el = document.querySelector(sel);
                        if (el?.textContent?.trim()) return el.textContent.trim();
                    }
                    return '';
                };

                // 尝试各种可能的选择器
                const nickname =
                    getText(['.user-name', '.name', '[class*="nickname"]', 'h1']) || '';
                const description =
                    getText([
                        '.user-desc',
                        '.desc',
                        '[class*="description"]',
                        '[class*="bio"]',
                    ]) || '';

                // 数据统计
                const statsEls = document.querySelectorAll(
                    '.data-item, .count-item, [class*="stat"], [class*="count"]'
                );
                const stats = {};
                statsEls.forEach((el) => {
                    const label = el.textContent || '';
                    const numEl = el.querySelector('span, em, strong');
                    const num = numEl?.textContent?.trim() || '';
                    if (label.includes('关注')) stats.following = num;
                    else if (label.includes('粉丝')) stats.followers = num;
                    else if (label.includes('赞') || label.includes('收藏'))
                        stats.likes = num;
                });

                // 笔记数
                const noteCount = getText([
                    '[class*="note-count"]',
                    '.tab-count',
                    '.note-num',
                ]);

                // 近期笔记
                const noteEls = document.querySelectorAll(
                    '.note-item, [class*="note-card"], .cover-container'
                );
                const notes = [];
                noteEls.forEach((el, idx) => {
                    if (idx >= 6) return;
                    const title = el.querySelector('.title, [class*="title"], .footer span')
                        ?.textContent?.trim();
                    const likeEl = el.querySelector(
                        '[class*="like"], .like-count, .engagement span'
                    );
                    const likeText = likeEl?.textContent?.trim() || '0';
                    notes.push({ title: title || '', likes: likeText, comments: '0' });
                });

                const avatarEl = document.querySelector(
                    '.avatar img, .user-avatar img, [class*="avatar"] img'
                );

                return {
                    nickname,
                    description,
                    avatar: avatarEl?.src || '',
                    followers: stats.followers || '',
                    following: stats.following || '',
                    likes: stats.likes || '',
                    posts: noteCount || String(noteEls.length),
                    recentNotes: notes,
                };
            });

            result.nickname = profileInfo.nickname || result.nickname;
            result.description = profileInfo.description || result.description;
            result.avatar = profileInfo.avatar || result.avatar;
            result.followers = profileInfo.followers || result.followers;
            result.following = profileInfo.following;
            result.likes = profileInfo.likes;
            result.posts = profileInfo.posts;

            // 处理近期笔记
            const followers = this.parseCount(result.followers);
            result.recentPosts = (profileInfo.recentNotes || []).map((n) => ({
                title: n.title,
                likes: this.parseCount(n.likes),
                comments: this.parseCount(n.comments),
                shares: 0,
            }));

            // 计算互动率
            if (result.recentPosts.length > 0 && followers > 0) {
                const avgEngagement =
                    result.recentPosts.reduce((s, p) => s + p.likes + p.comments, 0) /
                    result.recentPosts.length;
                result.engagementRate = avgEngagement / followers;
            }

        } catch (err) {
            if (err.code === 'TASK_ABORTED') throw err;
            console.warn(`[小红书] 获取资料页失败: ${err.message}`);
        } finally {
            if (profilePage) await profilePage.close().catch(() => {});
        }

        return result;
    }

    inferCategory(desc, keyword) {
        const categories = {
            美妆: ['美妆', '化妆', '护肤', '彩妆', '口红', '面膜', '精华'],
            穿搭: ['穿搭', '时尚', '搭配', 'OOTD', '服装', '衣服'],
            美食: ['美食', '美食', '做饭', '食谱', '餐厅', '烘焙'],
            旅行: ['旅行', '旅游', '出行', '打卡', '景点', '攻略'],
            健身: ['健身', '运动', '减肥', '瑜伽', '跑步', '增肌'],
            母婴: ['母婴', '育儿', '宝宝', '孕期', '辅食', '亲子'],
            数码: ['数码', '手机', '电脑', '相机', '耳机', '科技'],
            家居: ['家居', '装修', '收纳', '好物', '家装'],
            宠物: ['宠物', '猫', '狗', '养猫', '养狗'],
            学习: ['学习', '考试', '考研', '四六级', '教程'],
        };

        const text = `${desc} ${keyword}`.toLowerCase();
        for (const [cat, keywords] of Object.entries(categories)) {
            if (keywords.some((k) => text.includes(k))) return cat;
        }
        return '综合';
    }
}
