/**
 * 平台适配器基类
 * 所有平台适配器都必须继承此类并实现所有方法
 */
export default class BasePlatform {
    constructor(name, icon) {
        this.name = name;
        this.icon = icon;
    }

    /**
     * 搜索 KOC
     * @param {string} keyword 搜索关键词
     * @param {object} options 搜索选项 { maxResults, minFollowers, maxFollowers }
     * @returns {AsyncGenerator<{progress: number, kocs: Array}>}
     */
    async *search(keyword, options = {}) {
        throw new Error(`${this.name}: search() not implemented`);
    }

    /**
     * 获取用户详细资料
     * @param {string} userId 用户ID
     * @returns {object} 标准化的用户数据
     */
    async getProfile(userId) {
        throw new Error(`${this.name}: getProfile() not implemented`);
    }

    /**
     * 检查是否已登录
     * @returns {boolean}
     */
    async isLoggedIn() {
        return false;
    }

    /**
     * 触发登录流程
     * @returns {{ success: boolean, message: string }}
     */
    async login() {
        throw new Error(`${this.name}: login() not implemented`);
    }

    /**
     * 已登录标志
     */
    get requiresLogin() {
        return true;
    }

    get mcpGatewayUrl() {
        return (process.env.MCP_GATEWAY_URL || '').trim().replace(/\/$/, '');
    }

    get usingMcp() {
        return !!this.mcpGatewayUrl;
    }

    /**
     * 标准化 KOC 数据格式
     */
    normalizeData(rawData) {
        return {
            platform: this.name,
            platformIcon: this.icon,
            userId: rawData.userId || '',
            username: rawData.username || '',
            nickname: rawData.nickname || '',
            avatar: rawData.avatar || '',
            profileUrl: rawData.profileUrl || '',
            followers: this.parseCount(rawData.followers),
            following: this.parseCount(rawData.following),
            likes: this.parseCount(rawData.likes),
            posts: this.parseCount(rawData.posts),
            totalViews: this.parseCount(rawData.totalViews),
            description: rawData.description || '',
            category: rawData.category || '未分类',
            contactInfo: this.extractContactInfo(rawData.description || ''),
            recentPosts: rawData.recentPosts || [],
            engagementRate: rawData.engagementRate || 0,
            dataQuality: rawData.dataQuality || null,
            rawData: rawData,
        };
    }

    /**
     * 从简介中提取联系方式
     */
    extractContactInfo(text) {
        const contacts = {};

        // 邮箱
        const emailMatch = text.match(/[\w.+-]+@[\w-]+\.[\w.]+/g);
        if (emailMatch) contacts.email = emailMatch[0];

        // 微信号
        const wxPatterns = [
            /(?:微信|wx|wechat|V信|v信|薇信|WX)[：:号]?\s*([a-zA-Z0-9_-]{5,20})/i,
            /(?:微信|wx|wechat)[：:]?\s*([a-zA-Z0-9_-]{5,20})/i,
        ];
        for (const p of wxPatterns) {
            const m = text.match(p);
            if (m) { contacts.wechat = m[1]; break; }
        }

        // 手机号
        const phoneMatch = text.match(/1[3-9]\d{9}/);
        if (phoneMatch) contacts.phone = phoneMatch[0];

        // QQ
        const qqMatch = text.match(/(?:QQ|qq)[：:号]?\s*(\d{5,12})/);
        if (qqMatch) contacts.qq = qqMatch[1];

        // Instagram
        const igMatch = text.match(/(?:ins|ig|instagram)[：:]?\s*@?([a-zA-Z0-9_.]+)/i);
        if (igMatch) contacts.instagram = igMatch[1];

        // Telegram
        const tgMatch = text.match(/(?:tg|telegram)[：:]?\s*@?([a-zA-Z0-9_]+)/i);
        if (tgMatch) contacts.telegram = tgMatch[1];

        return contacts;
    }

    /**
     * 解析中文数字缩写 (如 1.2万 → 12000, 3.5k → 3500)
     */
    parseCount(str) {
        if (typeof str === 'number') return str;
        if (!str) return 0;
        str = String(str).trim().replace(/,/g, '').replace(/\s+/g, '');

        const cnMap = { '万': 10000, '亿': 100000000 };
        for (const [unit, multiplier] of Object.entries(cnMap)) {
            if (str.includes(unit)) {
                return Math.round(parseFloat(str.replace(unit, '')) * multiplier);
            }
        }

        const enMap = {
            'k': 1000,
            'K': 1000,
            'm': 1000000,
            'M': 1000000,
            'b': 1000000000,
            'B': 1000000000,
            'w': 10000,
            'W': 10000,
        };
        for (const [unit, multiplier] of Object.entries(enMap)) {
            if (str.endsWith(unit)) {
                return Math.round(parseFloat(str.replace(unit, '')) * multiplier);
            }
        }

        return parseInt(str) || 0;
    }

    isCancelled(options = {}) {
        return !!options.signal?.aborted;
    }

    assertNotCancelled(options = {}) {
        if (this.isCancelled(options)) {
            const error = new Error('任务已取消');
            error.code = 'TASK_ABORTED';
            throw error;
        }
    }

    async callMcp(action, payload = {}) {
        if (!this.usingMcp) {
            throw new Error('MCP 网关未配置');
        }

        const endpoint = `${this.mcpGatewayUrl}/platform/${this.name}/${action}`;
        const headers = { 'Content-Type': 'application/json' };
        if (process.env.MCP_GATEWAY_TOKEN) {
            headers.Authorization = `Bearer ${process.env.MCP_GATEWAY_TOKEN}`;
        }

        const resp = await fetch(endpoint, {
            method: 'POST',
            headers,
            body: JSON.stringify(payload),
        });

        if (!resp.ok) {
            const body = await resp.text();
            throw new Error(`MCP 网关错误 ${resp.status}: ${body.slice(0, 200)}`);
        }

        return resp.json();
    }

    async *searchViaMcp(keyword, options = {}) {
        this.assertNotCancelled(options);
        yield { progress: 5, kocs: [], message: `正在通过 MCP 搜索 ${this.name}...` };

        const result = await this.callMcp('search', { keyword, options });
        this.assertNotCancelled(options);

        if (Array.isArray(result?.updates) && result.updates.length > 0) {
            for (const update of result.updates) {
                this.assertNotCancelled(options);
                const normalized = (update.kocs || []).map((koc) => this.normalizeData(koc));
                yield {
                    progress: update.progress ?? 0,
                    message: update.message || '',
                    error: update.error || null,
                    kocs: normalized,
                };
            }
            return;
        }

        const normalized = (result?.kocs || []).map((koc) => this.normalizeData(koc));
        yield {
            progress: 100,
            kocs: normalized,
            message: result?.message || `MCP 搜索完成，共 ${normalized.length} 条`,
        };
    }
}
