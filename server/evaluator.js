/**
 * KOC 质量评估引擎
 * 面向“可筛选、可比较”的场景输出评分 + 数据可信度
 */

const WEIGHTS = {
    engagementRate: 0.30,
    followerFit: 0.15,
    activityLevel: 0.20,
    contentRelevance: 0.20,
    growthTrend: 0.15,
};

const IDEAL_FOLLOWER_RANGES = [
    { min: 1000, max: 5000, score: 100 },
    { min: 5000, max: 10000, score: 95 },
    { min: 10000, max: 50000, score: 85 },
    { min: 50000, max: 100000, score: 65 },
    { min: 100000, max: 500000, score: 40 },
    { min: 500000, max: Infinity, score: 20 },
    { min: 0, max: 1000, score: 50 },
];

export function evaluateKOC(kocData, keyword = '') {
    const interactionSignals = summarizeInteractionSignals(kocData);
    const dataQuality = buildDataQuality(kocData, interactionSignals);

    const scores = {
        engagementRate: scoreEngagementRate(kocData, interactionSignals),
        followerFit: scoreFollowerFit(kocData.followers),
        activityLevel: scoreActivityLevel(kocData),
        contentRelevance: scoreContentRelevance(kocData, keyword),
        growthTrend: scoreGrowthTrend(kocData, interactionSignals),
    };

    // 笔记发现模式下数据不完整，动态调整权重
    const isNoteDiscovery = kocData.noteAppearances > 0 && kocData.followers <= 0;
    const weights = isNoteDiscovery
        ? {
            engagementRate: 0.10,   // 无法计算，降权
            followerFit: 0.05,      // 未知，降权
            activityLevel: 0.30,    // noteAppearances 可参考，升权
            contentRelevance: 0.40, // relatedPosts 有数据，核心依据
            growthTrend: 0.15,
        }
        : WEIGHTS;

    let totalScore = 0;
    for (const [dim, weight] of Object.entries(weights)) {
        totalScore += (scores[dim] || 0) * weight;
    }

    const grade = scoreToGrade(totalScore);
    const confidence = dataQuality.score;

    return {
        totalScore: Math.round(totalScore * 10) / 10,
        grade,
        confidence,
        scores,
        tags: generateTags(kocData, scores, dataQuality),
        recommendation: getRecommendation(grade, scores, dataQuality),
        dataQuality,
    };
}

function scoreToGrade(score) {
    if (score >= 85) return 'S';
    if (score >= 70) return 'A';
    if (score >= 55) return 'B';
    if (score >= 40) return 'C';
    return 'D';
}

function summarizeInteractionSignals(koc) {
    const posts = (koc.recentPosts || []).slice(0, 10);
    const followers = Number(koc.followers) || 0;

    let totalEngagement = 0;
    let totalViews = 0;
    let hasEngagementSignals = false;
    let hasViewSignals = false;

    for (const post of posts) {
        const likes = Number(post.likes) || 0;
        const comments = Number(post.comments) || 0;
        const shares = Number(post.shares) || 0;
        const views = Number(post.views) || 0;

        const engagement = likes + comments + shares;
        totalEngagement += engagement;
        totalViews += views;

        if (engagement > 0) hasEngagementSignals = true;
        if (views > 0) hasViewSignals = true;
    }

    if (koc.engagementRate && koc.engagementRate > 0) {
        return { mode: 'engagement', rate: Number(koc.engagementRate), followers };
    }

    if (followers > 0 && hasEngagementSignals && posts.length > 0) {
        return {
            mode: 'engagement',
            rate: totalEngagement / posts.length / followers,
            followers,
        };
    }

    if (followers > 0 && hasViewSignals && posts.length > 0) {
        return {
            mode: 'reach',
            rate: totalViews / posts.length / followers,
            followers,
        };
    }

    return { mode: 'none', rate: 0, followers };
}

function scoreEngagementRate(koc, interactionSignals) {
    // 笔记模式：无粉丝数时用 relatedPosts 的点赞数估算互动水平
    if (!koc.followers || koc.followers <= 0) {
        const relatedPosts = koc.relatedPosts || [];
        if (relatedPosts.length > 0) {
            const totalLikes = relatedPosts.reduce((sum, p) => sum + (Number(p.likes) || 0), 0);
            const avgLikes = totalLikes / relatedPosts.length;
            if (avgLikes >= 1000) return 85;
            if (avgLikes >= 500) return 75;
            if (avgLikes >= 100) return 65;
            if (avgLikes >= 30) return 55;
            return 45;
        }
        return 50; // 无数据给中性分，而非低分
    }

    if (interactionSignals.mode === 'engagement') {
        const rate = interactionSignals.rate;
        if (rate >= 0.10) return 100;
        if (rate >= 0.06) return 85;
        if (rate >= 0.03) return 70;
        if (rate >= 0.01) return 55;
        return 35;
    }

    // TikTok 等场景常见：近期抓到浏览量但抓不到点赞/评论
    if (interactionSignals.mode === 'reach') {
        const reachRate = interactionSignals.rate;
        if (reachRate >= 1.5) return 85;
        if (reachRate >= 1.0) return 75;
        if (reachRate >= 0.6) return 65;
        if (reachRate >= 0.3) return 55;
        return 45;
    }

    return 45;
}

function scoreFollowerFit(followers) {
    // 粉丝数未知时给中性分，不惩罚
    if (!followers || followers <= 0) return 55;
    for (const range of IDEAL_FOLLOWER_RANGES) {
        if (followers >= range.min && followers < range.max) return range.score;
    }
    return 50;
}

function scoreActivityLevel(koc) {
    const posts = koc.recentPosts || [];
    let score = 35;

    if (posts.length === 0) {
        if (koc.posts >= 100) score = 70;
        else if (koc.posts >= 50) score = 60;
        else if (koc.posts >= 20) score = 50;
        else score = 35;
    } else {
        const dates = posts
            .map((p) => new Date(p.publishTime || p.date))
            .filter((d) => !isNaN(d))
            .sort((a, b) => b - a);

        if (dates.length >= 2) {
            const spanDays = (dates[0] - dates[dates.length - 1]) / (1000 * 60 * 60 * 24);
            const avgInterval = spanDays / (dates.length - 1);

            if (avgInterval <= 1) score = 100;
            else if (avgInterval <= 3) score = 85;
            else if (avgInterval <= 7) score = 70;
            else if (avgInterval <= 14) score = 55;
            else score = 35;
        } else if (posts.length >= 8) {
            score = 80;
        } else if (posts.length >= 5) {
            score = 70;
        } else if (posts.length >= 3) {
            score = 60;
        } else {
            score = 50;
        }
    }

    if (koc.noteAppearances && koc.noteAppearances >= 2) {
        score = Math.min(100, score + koc.noteAppearances * 5);
    }

    return score;
}

function scoreContentRelevance(koc, keyword) {
    if (!keyword) return 60;

    const terms = keyword
        .toLowerCase()
        .split(/[\s,，;；|]+/)
        .map((t) => t.trim())
        .filter(Boolean);

    if (terms.length === 0) return 60;

    let matchCount = 0;
    let totalChecks = 0;

    const desc = (koc.description || '').toLowerCase();
    const category = (koc.category || '').toLowerCase();
    const relatedPostTitles = (koc.relatedPosts || [])
        .map((p) => p.title || '')
        .join(' ')
        .toLowerCase();
    const posts = koc.recentPosts || [];

    for (const term of terms) {
        totalChecks += 3;
        if (desc.includes(term)) matchCount += 1;
        if (category.includes(term)) matchCount += 1;
        if (relatedPostTitles.includes(term)) matchCount += 1;
    }

    for (const post of posts.slice(0, 5)) {
        const text = `${post.title || ''} ${post.desc || ''}`.toLowerCase();
        for (const term of terms) {
            totalChecks += 1;
            if (text.includes(term)) matchCount += 1;
        }
    }

    if (totalChecks === 0) return 50;
    const ratio = matchCount / totalChecks;
    let score = 25;
    if (ratio >= 0.5) score = 100;
    else if (ratio >= 0.3) score = 80;
    else if (ratio >= 0.15) score = 60;
    else if (ratio > 0) score = 40;

    if (koc.noteAppearances >= 2) {
        score = Math.min(100, score + 15);
    }
    return score;
}

function scoreGrowthTrend(koc, interactionSignals) {
    if (koc.growthRate || koc.growthRate === 0) {
        const rate = Number(koc.growthRate) || 0;
        if (rate >= 0.10) return 100;
        if (rate >= 0.05) return 80;
        if (rate >= 0.02) return 65;
        if (rate >= 0) return 50;
        return 30;
    }

    if (interactionSignals.mode === 'engagement') {
        const rate = interactionSignals.rate;
        if (rate >= 0.08) return 85;
        if (rate >= 0.04) return 70;
        if (rate >= 0.02) return 55;
        return 40;
    }

    if (interactionSignals.mode === 'reach') {
        const reachRate = interactionSignals.rate;
        if (reachRate >= 1.2) return 80;
        if (reachRate >= 0.8) return 65;
        if (reachRate >= 0.4) return 55;
        return 45;
    }

    if (koc.followers > 0 && koc.totalViews > 0) {
        const viewsPerFollower = koc.totalViews / koc.followers;
        if (viewsPerFollower >= 10) return 75;
        if (viewsPerFollower >= 5) return 65;
        if (viewsPerFollower >= 2) return 55;
    }

    // 笔记模式：多次出现 + 帖子点赞多说明有增长潜力
    if (koc.noteAppearances >= 2) {
        const relatedPosts = koc.relatedPosts || [];
        const totalLikes = relatedPosts.reduce((sum, p) => sum + (Number(p.likes) || 0), 0);
        if (totalLikes >= 500 && koc.noteAppearances >= 3) return 75;
        if (totalLikes >= 200) return 65;
        if (totalLikes >= 50) return 55;
    }

    return 50;
}

function buildDataQuality(koc, interactionSignals) {
    const relatedPosts = koc.relatedPosts || [];
    const hasRelatedPosts = relatedPosts.length > 0;
    const checks = {
        followers: koc.followers > 0 ? 1 : 0,
        profileText: (koc.description || '').trim().length >= 10 ? 1 : 0,
        category: !!koc.category && !['未分类', '综合', 'General'].includes(koc.category) ? 1 : 0,
        postsCount: koc.posts > 0 ? 1 : (hasRelatedPosts ? 0.5 : 0),
        recentPosts: (koc.recentPosts || []).length >= 3 ? 1 : (koc.recentPosts || []).length > 0 ? 0.5 : (hasRelatedPosts ? 0.5 : 0),
        interactionSignals: interactionSignals.mode === 'none' ? (hasRelatedPosts ? 0.5 : 0) : 1,
        contactInfo: Object.keys(koc.contactInfo || {}).length > 0 ? 1 : 0,
    };

    const sum = Object.values(checks).reduce((acc, x) => acc + x, 0);
    const max = Object.keys(checks).length;
    const score = Math.round((sum / max) * 100);

    let level = 'low';
    if (score >= 75) level = 'high';
    else if (score >= 50) level = 'medium';

    return { score, level, checks };
}

function generateTags(koc, scores, dataQuality) {
    const tags = [];
    if (koc.followers >= 1000 && koc.followers <= 50000) tags.push('优质KOC');
    if (koc.followers > 50000) tags.push('KOL');
    if (scores.engagementRate >= 85) tags.push('高互动');
    if (scores.activityLevel >= 80) tags.push('高活跃');
    if (scores.contentRelevance >= 80) tags.push('强相关');
    if (scores.followerFit >= 90) tags.push('粉丝适配');
    if (scores.growthTrend >= 80) tags.push('增长快');
    if (Object.keys(koc.contactInfo || {}).length > 0) tags.push('有联系方式');
    // 笔记发现模式下的特有标签
    if (koc.noteAppearances >= 3) tags.push('高频创作');
    if (koc.noteAppearances >= 2 && scores.contentRelevance >= 70) tags.push('深耕赛道');
    if (dataQuality.level === 'low' && koc.noteAppearances <= 0) tags.push('数据待核验');
    else if (dataQuality.level === 'low') tags.push('仅笔记数据');
    return tags;
}

function getRecommendation(grade, scores, dataQuality) {
    const tips = [];

    if (grade === 'S') tips.push('优先联系，适合作为核心合作对象');
    else if (grade === 'A') tips.push('推荐合作，可优先进入沟通名单');
    else if (grade === 'B') tips.push('可作为补充池，建议人工复核后投放');
    else if (grade === 'C') tips.push('谨慎合作，建议先小预算测试');
    else tips.push('暂不推荐，优先筛选其他账号');

    if (scores.engagementRate < 50) tips.push('互动信号偏弱');
    if (scores.activityLevel < 50) tips.push('近期活跃度偏低');
    if (scores.contentRelevance < 50) tips.push('赛道相关度不高');
    if (dataQuality.level === 'low') tips.push('当前数据完整度低，需二次核验');

    return tips.join('；');
}

export default { evaluateKOC };
