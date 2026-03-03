import BasePlatform from './base.js';

/**
 * YouTube 适配器 — 使用官方 Data API v3
 */
export default class YouTubePlatform extends BasePlatform {
    constructor() {
        super('youtube', '🎬');
        this.apiKey = process.env.YOUTUBE_API_KEY || '';
        this.baseUrl = 'https://www.googleapis.com/youtube/v3';
    }

    get requiresLogin() {
        return false; // YouTube API 不需要登录
    }

    async isLoggedIn() {
        return !!this.apiKey && this.apiKey !== 'your_youtube_api_key_here';
    }

    async login() {
        return {
            success: false,
            message: '请在 .env 文件中配置 YOUTUBE_API_KEY',
        };
    }

    async *search(keyword, options = {}) {
        const maxResults = options.maxResults || 20;

        if (!this.apiKey || this.apiKey === 'your_youtube_api_key_here') {
            yield {
                progress: 100,
                kocs: [],
                error: '未配置 YouTube API Key，请在 .env 中设置 YOUTUBE_API_KEY',
            };
            return;
        }

        try {
            this.assertNotCancelled(options);
            // Step 1: 搜索频道
            yield { progress: 10, kocs: [], message: '正在搜索 YouTube 频道...' };

            const searchUrl = new URL(`${this.baseUrl}/search`);
            searchUrl.searchParams.set('key', this.apiKey);
            searchUrl.searchParams.set('q', keyword);
            searchUrl.searchParams.set('type', 'channel');
            searchUrl.searchParams.set('part', 'snippet');
            searchUrl.searchParams.set('maxResults', String(Math.min(maxResults, 50)));
            searchUrl.searchParams.set('order', 'relevance');

            const searchResp = await fetch(searchUrl);
            if (!searchResp.ok) {
                const errBody = await searchResp.text();
                yield { progress: 100, kocs: [], error: `YouTube API 错误: ${searchResp.status} - ${errBody}` };
                return;
            }

            const searchData = await searchResp.json();
            const channels = searchData.items || [];

            if (channels.length === 0) {
                yield { progress: 100, kocs: [], message: '未找到相关频道' };
                return;
            }

            yield { progress: 30, kocs: [], message: `找到 ${channels.length} 个频道，正在获取详情...` };

            // Step 2: 批量获取频道详情
            const channelIds = channels.map((c) => c.snippet.channelId || c.id.channelId);
            const detailUrl = new URL(`${this.baseUrl}/channels`);
            detailUrl.searchParams.set('key', this.apiKey);
            detailUrl.searchParams.set('id', channelIds.join(','));
            detailUrl.searchParams.set('part', 'snippet,statistics,brandingSettings');

            const detailResp = await fetch(detailUrl);
            if (!detailResp.ok) {
                const errBody = await detailResp.text();
                yield { progress: 100, kocs: [], error: `YouTube API 错误: ${detailResp.status} - ${errBody}` };
                return;
            }
            const detailData = await detailResp.json();
            const channelDetails = detailData.items || [];

            yield { progress: 60, kocs: [], message: '正在分析频道数据...' };

            // Step 3: 获取每个频道的近期视频（取互动数据）
            const kocs = [];

            for (let i = 0; i < channelDetails.length; i++) {
                this.assertNotCancelled(options);
                const ch = channelDetails[i];
                const progress = 60 + Math.round((i / channelDetails.length) * 35);

                const recentPosts = await this.getRecentVideos(ch.id);

                const followers = parseInt(ch.statistics.subscriberCount) || 0;

                // 筛选粉丝数
                if (options.minFollowers && followers < options.minFollowers) continue;
                if (options.maxFollowers && followers > options.maxFollowers) continue;

                // 计算互动率
                let engagementRate = 0;
                if (recentPosts.length > 0 && followers > 0) {
                    const avgEngagement =
                        recentPosts.reduce((s, v) => s + v.likes + v.comments, 0) / recentPosts.length;
                    engagementRate = avgEngagement / followers;
                }

                const kocData = this.normalizeData({
                    userId: ch.id,
                    username: ch.snippet.customUrl || ch.id,
                    nickname: ch.snippet.title,
                    avatar: ch.snippet.thumbnails?.medium?.url || ch.snippet.thumbnails?.default?.url || '',
                    profileUrl: `https://www.youtube.com/channel/${ch.id}`,
                    followers,
                    following: 0,
                    likes: 0,
                    totalViews: parseInt(ch.statistics.viewCount) || 0,
                    posts: parseInt(ch.statistics.videoCount) || 0,
                    description: ch.snippet.description || '',
                    category:
                        ch.brandingSettings?.channel?.keywords || ch.snippet.description?.slice(0, 30) || '',
                    recentPosts,
                    engagementRate,
                });

                kocs.push(kocData);
                yield { progress, kocs: [...kocs], message: `已分析 ${kocs.length}/${channelDetails.length} 个频道` };
            }

            yield { progress: 100, kocs, message: `搜索完成，共找到 ${kocs.length} 个 KOC` };
        } catch (err) {
            if (err.code === 'TASK_ABORTED') {
                yield { progress: 100, kocs: [], error: '任务已取消' };
                return;
            }
            yield { progress: 100, kocs: [], error: `YouTube 搜索失败: ${err.message}` };
        }
    }

    async getRecentVideos(channelId) {
        try {
            // 搜索频道最近的视频
            const searchUrl = new URL(`${this.baseUrl}/search`);
            searchUrl.searchParams.set('key', this.apiKey);
            searchUrl.searchParams.set('channelId', channelId);
            searchUrl.searchParams.set('type', 'video');
            searchUrl.searchParams.set('part', 'snippet');
            searchUrl.searchParams.set('maxResults', '5');
            searchUrl.searchParams.set('order', 'date');

            const resp = await fetch(searchUrl);
            if (!resp.ok) return [];

            const data = await resp.json();
            const videoIds = (data.items || []).map((v) => v.id.videoId).filter(Boolean);

            if (videoIds.length === 0) return [];

            // 获取视频统计
            const statsUrl = new URL(`${this.baseUrl}/videos`);
            statsUrl.searchParams.set('key', this.apiKey);
            statsUrl.searchParams.set('id', videoIds.join(','));
            statsUrl.searchParams.set('part', 'statistics,snippet');

            const statsResp = await fetch(statsUrl);
            const statsData = await statsResp.json();

            return (statsData.items || []).map((v) => ({
                title: v.snippet.title,
                publishTime: v.snippet.publishedAt,
                likes: parseInt(v.statistics.likeCount) || 0,
                comments: parseInt(v.statistics.commentCount) || 0,
                views: parseInt(v.statistics.viewCount) || 0,
                shares: 0,
            }));
        } catch {
            return [];
        }
    }
}
