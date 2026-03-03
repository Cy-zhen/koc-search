import express from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';
import { stringify } from 'csv-stringify/sync';
import dotenv from 'dotenv';

import { evaluateKOC } from './evaluator.js';
import browserManager from './browser-manager.js';
import YouTubePlatform from './platforms/youtube.js';
import XiaohongshuPlatform from './platforms/xiaohongshu.js';
import DouyinPlatform from './platforms/douyin.js';
import TikTokPlatform from './platforms/tiktok.js';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;
const TASK_TTL_MS = parseInt(process.env.TASK_TTL_MS || '21600000', 10); // 6h
const MAX_TASKS = parseInt(process.env.MAX_TASKS || '200', 10);

app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// 平台注册
const platforms = {
    youtube: new YouTubePlatform(),
    xiaohongshu: new XiaohongshuPlatform(),
    douyin: new DouyinPlatform(),
    tiktok: new TikTokPlatform(),
};

// 搜索任务存储
const tasks = new Map();

function toInt(value, fallback = 0) {
    const n = parseInt(value, 10);
    return Number.isFinite(n) ? n : fallback;
}

function pruneTasks() {
    const now = Date.now();
    for (const [id, task] of tasks.entries()) {
        const endedAt = task.endTime || task.startTime;
        if (now - endedAt > TASK_TTL_MS) {
            tasks.delete(id);
        }
    }

    if (tasks.size > MAX_TASKS) {
        const sorted = [...tasks.values()].sort((a, b) => (a.startTime || 0) - (b.startTime || 0));
        const over = tasks.size - MAX_TASKS;
        for (let i = 0; i < over; i++) {
            tasks.delete(sorted[i].id);
        }
    }
}

setInterval(pruneTasks, 10 * 60 * 1000).unref();

function dedupeKocs(kocs) {
    const seen = new Set();
    const result = [];

    for (const koc of kocs || []) {
        const stableId = koc.userId || koc.profileUrl || `${koc.nickname || ''}-${koc.username || ''}`;
        const key = `${koc.platform}::${stableId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        result.push(koc);
    }
    return result;
}

function buildSummary(kocs) {
    if (!kocs || kocs.length === 0) {
        return {
            total: 0,
            withContact: 0,
            avgScore: 0,
            avgConfidence: 0,
        };
    }

    const withContact = kocs.filter((k) => Object.keys(k.contactInfo || {}).length > 0).length;
    const avgScore = kocs.reduce((acc, k) => acc + (k.evaluation?.totalScore || 0), 0) / kocs.length;
    const avgConfidence = kocs.reduce((acc, k) => acc + (k.evaluation?.confidence || 0), 0) / kocs.length;

    return {
        total: kocs.length,
        withContact,
        avgScore: Number(avgScore.toFixed(1)),
        avgConfidence: Number(avgConfidence.toFixed(1)),
    };
}

function cancelTask(task, reason = '任务已取消') {
    if (!task || task.status !== 'running') return;
    task.cancelled = true;
    task.cancelReason = reason;
    task.status = 'cancelled';
    task.abortController?.abort();
}

function taskPublicView(task) {
    return {
        id: task.id,
        keyword: task.keyword,
        platforms: task.platforms,
        status: task.status,
        cancelled: !!task.cancelled,
        cancelReason: task.cancelReason || null,
        startTime: task.startTime,
        endTime: task.endTime || null,
        duration: task.endTime ? task.endTime - task.startTime : null,
        totalKocs: task.kocs?.length || 0,
        summary: task.summary || buildSummary(task.kocs || []),
    };
}

function normalizeKeywordTerm(term) {
    return String(term || '')
        .trim()
        .replace(/^["“”']+|["“”']+$/g, '')
        .trim();
}

function parseKeywordPlan(rawKeyword) {
    const raw = String(rawKeyword || '').trim();
    const result = { raw, mode: 'single', terms: [raw] };
    if (!raw) return result;

    const quotedTerms = [...raw.matchAll(/["“]([^"”]+)["”]/g)]
        .map((m) => normalizeKeywordTerm(m[1]))
        .filter(Boolean);
    const hasOr = /(?:\||\s+or\s+|或)/i.test(raw);
    const hasAnd = /(?:\+|&|\s+and\s+|且|并且)/i.test(raw);

    if (/包含/.test(raw) && quotedTerms.length >= 2) {
        if (hasOr) return { raw, mode: 'any', terms: [...new Set(quotedTerms)] };
        if (hasAnd) return { raw, mode: 'all', terms: [...new Set(quotedTerms)] };
    }

    if (hasOr) {
        const terms = raw
            .split(/\||\s+or\s+|或/gi)
            .map(normalizeKeywordTerm)
            .filter(Boolean);
        if (terms.length >= 2) return { raw, mode: 'any', terms: [...new Set(terms)] };
    }

    if (hasAnd) {
        const terms = raw
            .split(/\+|&|\s+and\s+|且|并且/gi)
            .map(normalizeKeywordTerm)
            .filter(Boolean);
        if (terms.length >= 2) return { raw, mode: 'all', terms: [...new Set(terms)] };
    }

    return { raw, mode: 'single', terms: [raw] };
}

function buildKeywordMatcher(keywordPlan) {
    const terms = (keywordPlan.terms || [])
        .map((t) => String(t || '').toLowerCase().trim())
        .filter(Boolean);

    if (keywordPlan.mode === 'single' || terms.length <= 1) {
        return () => true;
    }

    return (koc) => {
        const text = [
            koc.nickname,
            koc.username,
            koc.description,
            koc.category,
            ...(koc.recentPosts || []).map((p) => p.title || p.desc || ''),
        ]
            .filter(Boolean)
            .join(' ')
            .toLowerCase();

        if (keywordPlan.mode === 'all') {
            return terms.every((term) => text.includes(term));
        }
        return terms.some((term) => text.includes(term));
    };
}

// ============= API 路由 =============

/**
 * 获取平台列表及登录状态
 */
app.get('/api/platforms', async (req, res) => {
    const result = [];
    for (const [key, platform] of Object.entries(platforms)) {
        let loggedIn = false;
        try {
            loggedIn = await platform.isLoggedIn();
        } catch { /* ignore */ }

        result.push({
            id: key,
            name: platform.name,
            icon: platform.icon,
            requiresLogin: platform.requiresLogin,
            loggedIn,
            mode: platform.usingMcp ? 'mcp' : platform.requiresLogin ? 'browser' : 'api',
        });
    }
    res.json(result);
});

/**
 * 触发平台登录
 */
app.post('/api/auth/:platform/login', async (req, res) => {
    const platformKey = req.params.platform;
    const platform = platforms[platformKey];

    if (!platform) {
        return res.status(404).json({ error: '平台不存在' });
    }

    try {
        const result = await platform.login();
        res.json(result);
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

/**
 * 检查平台登录状态
 */
app.get('/api/auth/:platform/status', async (req, res) => {
    const platform = platforms[req.params.platform];
    if (!platform) return res.status(404).json({ error: '平台不存在' });

    try {
        const loggedIn = await platform.isLoggedIn();
        res.json({ loggedIn });
    } catch {
        res.json({ loggedIn: false });
    }
});

/**
 * 查询任务状态
 */
app.get('/api/tasks/:taskId', (req, res) => {
    const task = tasks.get(req.params.taskId);
    if (!task) {
        return res.status(404).json({ error: '任务不存在' });
    }
    res.json(taskPublicView(task));
});

/**
 * 取消任务
 */
app.post('/api/tasks/:taskId/cancel', (req, res) => {
    const task = tasks.get(req.params.taskId);
    if (!task) {
        return res.status(404).json({ error: '任务不存在' });
    }
    if (task.status !== 'running') {
        return res.json({ success: true, status: task.status });
    }

    cancelTask(task, '用户手动取消');
    res.json({ success: true, status: 'cancelled' });
});

/**
 * 启动搜索任务 (SSE 实时推送)
 */
app.get('/api/search', async (req, res) => {
    const { keyword, platforms: platformList, maxResults, minFollowers, maxFollowers } = req.query;

    if (!keyword) {
        return res.status(400).json({ error: '请提供搜索关键词' });
    }

    const selectedPlatforms = [...new Set(
        (platformList ? platformList.split(',') : Object.keys(platforms))
            .map((p) => p.trim())
            .filter(Boolean)
    )];

    if (selectedPlatforms.length === 0) {
        return res.status(400).json({ error: '请至少选择一个平台' });
    }

    const keywordPlan = parseKeywordPlan(keyword);
    const keywordMatcher = buildKeywordMatcher(keywordPlan);
    const searchTerms = keywordPlan.terms.length > 0 ? keywordPlan.terms : [keyword];
    const totalUnits = selectedPlatforms.length * searchTerms.length;

    pruneTasks();
    const taskId = uuidv4();
    let responseEnded = false;

    // SSE headers
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
        'X-Task-Id': taskId,
    });

    const sendEvent = (data) => {
        if (responseEnded || res.writableEnded) return;
        res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    const abortController = new AbortController();
    const options = {
        maxResults: toInt(maxResults, 20),
        minFollowers: toInt(minFollowers, 0),
        maxFollowers: toInt(maxFollowers, 0),
        signal: abortController.signal,
    };

    const allKocs = [];
    const taskData = {
        id: taskId,
        keyword,
        keywordPlan,
        platforms: selectedPlatforms,
        status: 'running',
        cancelled: false,
        cancelReason: null,
        kocs: allKocs,
        summary: null,
        startTime: Date.now(),
        endTime: null,
        abortController,
    };
    tasks.set(taskId, taskData);

    req.on('close', () => {
        if (taskData.status === 'running') {
            cancelTask(taskData, '客户端断开连接');
        }
    });

    sendEvent({
        type: 'start',
        taskId,
        totalPlatforms: selectedPlatforms.length,
        totalKeywordTerms: searchTerms.length,
        keywordMode: keywordPlan.mode,
        keywordTerms: searchTerms,
        message: '任务已启动，可随时取消',
    });

    // 依次搜索各平台
    for (let pi = 0; pi < selectedPlatforms.length; pi++) {
        if (taskData.cancelled) break;

        const platformKey = selectedPlatforms[pi];
        const platform = platforms[platformKey];

        if (!platform) {
            sendEvent({
                type: 'platform_error',
                platform: platformKey,
                code: 'UNKNOWN_PLATFORM',
                error: '未知平台',
            });
            continue;
        }

        if (platform.requiresLogin) {
            let loggedIn = false;
            try {
                loggedIn = await platform.isLoggedIn();
            } catch {
                loggedIn = false;
            }

            if (!loggedIn) {
                sendEvent({
                    type: 'platform_error',
                    platform: platformKey,
                    code: 'AUTH_REQUIRED',
                    error: `${platform.name} 未登录，请先在“平台登录”里完成登录`,
                });
                sendEvent({
                    type: 'platform_done',
                    platform: platformKey,
                    skipped: true,
                });
                continue;
            }
        }

        sendEvent({
            type: 'platform_start',
            platform: platformKey,
            icon: platform.icon,
            name: platform.name,
            index: pi + 1,
            total: selectedPlatforms.length,
            keywordTerms: searchTerms.length,
        });

        try {
            const platformKocs = [];

            for (let ti = 0; ti < searchTerms.length; ti++) {
                if (taskData.cancelled) break;

                const searchKeyword = searchTerms[ti];
                let latestKocsForTerm = [];

                try {
                    for await (const update of platform.search(searchKeyword, options)) {
                        if (taskData.cancelled) break;

                        const unitIndex = pi * searchTerms.length + ti;
                        const overallProgress = Math.round(
                            ((unitIndex + update.progress / 100) / totalUnits) * 100
                        );

                        const rawKocs = dedupeKocs(update.kocs || []);
                        const updateKocs = rawKocs.filter(keywordMatcher);

                        if (updateKocs.length > 0) {
                            for (const koc of updateKocs) {
                                if (!koc._evaluated) {
                                    koc.evaluation = evaluateKOC(koc, keyword);
                                    koc._evaluated = true;
                                }
                            }
                        }

                        sendEvent({
                            type: 'progress',
                            platform: platformKey,
                            keywordTerm: searchKeyword,
                            keywordMode: keywordPlan.mode,
                            platformProgress: update.progress,
                            overallProgress,
                            message: update.message || '',
                            error: update.error || null,
                            kocs: updateKocs,
                            kocCount: updateKocs.length,
                        });

                        if (updateKocs.length > 0) {
                            latestKocsForTerm = updateKocs;
                        }
                    }
                } catch (err) {
                    sendEvent({
                        type: 'platform_error',
                        platform: platformKey,
                        keywordTerm: searchKeyword,
                        code: err.code || 'SEARCH_FAILED',
                        error: err.message,
                    });
                }

                if (latestKocsForTerm.length > 0) {
                    platformKocs.push(...latestKocsForTerm);
                }
            }

            if (platformKocs.length > 0) {
                allKocs.push(...dedupeKocs(platformKocs));
            }
            if (taskData.cancelled) break;
        } catch (err) {
            sendEvent({
                type: 'platform_error',
                platform: platformKey,
                code: err.code || 'SEARCH_FAILED',
                error: err.message,
            });
        }

        sendEvent({
            type: 'platform_done',
            platform: platformKey,
        });
    }

    if (taskData.cancelled) {
        taskData.kocs = dedupeKocs(allKocs);
        taskData.status = 'cancelled';
        taskData.endTime = Date.now();
        taskData.summary = buildSummary(taskData.kocs);

        sendEvent({
            type: 'cancelled',
            taskId,
            reason: taskData.cancelReason || '任务已取消',
            totalKocs: taskData.kocs.length,
            kocs: taskData.kocs,
            duration: taskData.endTime - taskData.startTime,
            summary: taskData.summary,
        });

        responseEnded = true;
        res.end();
        return;
    }

    // 按质量评分排序
    taskData.kocs = dedupeKocs(allKocs).sort(
        (a, b) => (b.evaluation?.totalScore || 0) - (a.evaluation?.totalScore || 0)
    );
    taskData.status = 'done';
    taskData.endTime = Date.now();
    taskData.summary = buildSummary(taskData.kocs);

    sendEvent({
        type: 'done',
        taskId,
        totalKocs: taskData.kocs.length,
        kocs: taskData.kocs,
        duration: taskData.endTime - taskData.startTime,
        summary: taskData.summary,
    });

    responseEnded = true;
    res.end();
});

/**
 * 导出搜索结果为 CSV
 */
app.get('/api/export/:taskId', (req, res) => {
    const task = tasks.get(req.params.taskId);
    if (!task) {
        return res.status(404).json({ error: '任务不存在' });
    }

    const rows = task.kocs.map((koc) => ({
        平台: koc.platform,
        名称: koc.nickname,
        用户名: koc.username,
        粉丝数: koc.followers,
        总播放: koc.totalViews || 0,
        获赞数: koc.likes,
        作品数: koc.posts,
        互动率: koc.engagementRate ? `${(koc.engagementRate * 100).toFixed(2)}%` : '-',
        赛道: koc.category,
        质量评分: koc.evaluation?.totalScore || '-',
        质量等级: koc.evaluation?.grade || '-',
        数据可信度: koc.evaluation?.confidence || '-',
        标签: (koc.evaluation?.tags || []).join('、'),
        邮箱: koc.contactInfo?.email || '',
        微信: koc.contactInfo?.wechat || '',
        手机: koc.contactInfo?.phone || '',
        QQ: koc.contactInfo?.qq || '',
        简介: koc.description?.slice(0, 100) || '',
        主页链接: koc.profileUrl,
        建议: koc.evaluation?.recommendation || '',
    }));

    const csv = stringify(rows, {
        header: true,
        bom: true,
    });

    const exportDir = path.join(__dirname, '..', 'data', 'exports');
    if (!fs.existsSync(exportDir)) fs.mkdirSync(exportDir, { recursive: true });

    const filename = `KOC_${task.keyword}_${new Date().toISOString().slice(0, 10)}.csv`;
    const filepath = path.join(exportDir, filename);
    fs.writeFileSync(filepath, csv);

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
    res.send(csv);
});

/**
 * 导出客户端传来的结果为 CSV（无需 taskId）
 */
app.post('/api/export', (req, res) => {
    const { kocs, keyword } = req.body;

    if (!kocs || kocs.length === 0) {
        return res.status(400).json({ error: '没有可导出的数据' });
    }

    const rows = kocs.map((koc) => ({
        平台: koc.platform,
        名称: koc.nickname,
        用户名: koc.username,
        粉丝数: koc.followers,
        总播放: koc.totalViews || 0,
        获赞数: koc.likes,
        作品数: koc.posts,
        互动率: koc.engagementRate ? `${(koc.engagementRate * 100).toFixed(2)}%` : '-',
        赛道: koc.category,
        质量评分: koc.evaluation?.totalScore || '-',
        质量等级: koc.evaluation?.grade || '-',
        数据可信度: koc.evaluation?.confidence || '-',
        标签: (koc.evaluation?.tags || []).join('、'),
        邮箱: koc.contactInfo?.email || '',
        微信: koc.contactInfo?.wechat || '',
        手机: koc.contactInfo?.phone || '',
        QQ: koc.contactInfo?.qq || '',
        简介: koc.description?.slice(0, 100) || '',
        主页链接: koc.profileUrl,
        建议: koc.evaluation?.recommendation || '',
    }));

    const csv = stringify(rows, { header: true, bom: true });

    const filename = `KOC_${keyword || 'export'}_${new Date().toISOString().slice(0, 10)}.csv`;

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
    res.send(csv);
});

// 优雅关闭
process.on('SIGINT', async () => {
    console.log('\n正在关闭浏览器...');
    for (const task of tasks.values()) {
        cancelTask(task, '服务关闭');
    }
    await browserManager.closeAll();
    process.exit(0);
});

app.listen(PORT, () => {
    console.log(`\n🚀 KOC Discovery Tool 已启动`);
    console.log(`📡 访问地址: http://localhost:${PORT}`);
    console.log(`\n📋 支持平台:`);
    for (const [key, p] of Object.entries(platforms)) {
        console.log(`   ${p.icon} ${key}`);
    }
    console.log('');
});
