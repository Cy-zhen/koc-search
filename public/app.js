/**
 * KOC Discovery — Frontend Application
 */

// ============ State ============
const state = {
    keyword: '',
    searchMode: 'notes',
    skipSeen: true,
    expandKeywords: false,
    selectedPlatforms: ['xiaohongshu', 'youtube', 'douyin', 'tiktok'],
    kocs: [],
    taskId: null,
    searching: false,
    searchAbortController: null,
    currentFilter: 'all',
    currentSort: 'score',
};

// ============ DOM References ============
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const els = {
    keywordInput: $('#keywordInput'),
    searchBtn: $('#searchBtn'),
    platformChips: $('#platformChips'),

    progressSection: $('#progressSection'),
    progressTitle: $('#progressTitle'),
    progressPercent: $('#progressPercent'),
    progressFill: $('#progressFill'),
    progressPlatforms: $('#progressPlatforms'),
    progressMessage: $('#progressMessage'),

    resultsSection: $('#resultsSection'),
    totalKocs: $('#totalKocs'),
    avgScore: $('#avgScore'),
    topGrade: $('#topGrade'),
    withContact: $('#withContact'),
    kocGrid: $('#kocGrid'),
    resultsTabs: $('#resultsTabs'),
    sortSelect: $('#sortSelect'),
    exportBtn: $('#exportBtn'),

    modalOverlay: $('#modalOverlay'),
    detailModal: $('#detailModal'),
    modalContent: $('#modalContent'),
    modalClose: $('#modalClose'),

    authOverlay: $('#authOverlay'),
    authModal: $('#authModal'),
    authPlatforms: $('#authPlatforms'),
    authBtn: $('#authBtn'),
    authClose: $('#authClose'),
};

// ============ Event Listeners ============
function init() {
    // Search
    els.searchBtn.addEventListener('click', startSearch);
    els.keywordInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') startSearch();
    });

    // Platform chips
    els.platformChips.addEventListener('click', (e) => {
        const chip = e.target.closest('.platform-chip');
        if (!chip) return;
        chip.classList.toggle('active');
        state.selectedPlatforms = [...$$('.platform-chip.active')].map(
            (c) => c.dataset.platform
        );
    });

    const modeChips = $('#modeChips');
    if (modeChips) {
        modeChips.addEventListener('click', (e) => {
            const chip = e.target.closest('.mode-chip');
            if (!chip) return;
            $$('.mode-chip').forEach((c) => c.classList.remove('active'));
            chip.classList.add('active');
            state.searchMode = chip.dataset.mode || 'notes';
        });
    }

    const skipSeen = $('#skipSeen');
    if (skipSeen) {
        skipSeen.addEventListener('change', () => {
            state.skipSeen = !!skipSeen.checked;
        });
    }

    const expandKeywords = $('#expandKeywords');
    if (expandKeywords) {
        expandKeywords.addEventListener('change', () => {
            state.expandKeywords = !!expandKeywords.checked;
        });
    }

    // Tabs
    els.resultsTabs.addEventListener('click', (e) => {
        const tab = e.target.closest('.tab');
        if (!tab) return;
        $$('.tab').forEach((t) => t.classList.remove('active'));
        tab.classList.add('active');
        state.currentFilter = tab.dataset.filter;
        renderKocs();
    });

    // Sort
    els.sortSelect.addEventListener('change', () => {
        state.currentSort = els.sortSelect.value;
        renderKocs();
    });

    // Export
    els.exportBtn.addEventListener('click', exportCSV);

    // Modal
    els.modalClose.addEventListener('click', closeModal);
    els.modalOverlay.addEventListener('click', (e) => {
        if (e.target === els.modalOverlay) closeModal();
    });

    // Auth
    els.authBtn.addEventListener('click', openAuthModal);
    els.authClose.addEventListener('click', closeAuthModal);
    els.authOverlay.addEventListener('click', (e) => {
        if (e.target === els.authOverlay) closeAuthModal();
    });

    // Keyboard
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            closeModal();
            closeAuthModal();
        }
    });
}

// ============ Search ============
async function startSearch() {
    if (state.searching) {
        await cancelSearch(true);
        return;
    }

    const keyword = els.keywordInput.value.trim();
    if (!keyword) {
        els.keywordInput.focus();
        return;
    }

    if (state.selectedPlatforms.length === 0) {
        alert('请至少选择一个平台');
        return;
    }

    state.keyword = keyword;
    state.kocs = [];
    state.searching = true;
    state.taskId = null;
    state.searchAbortController = new AbortController();

    // UI state
    els.searchBtn.disabled = true;
    els.searchBtn.querySelector('span').textContent = '取消搜索';
    els.progressSection.classList.remove('hidden');
    els.resultsSection.classList.add('hidden');
    els.progressFill.style.width = '0%';
    els.progressPercent.textContent = '0%';
    els.progressPlatforms.innerHTML = '';
    els.progressMessage.textContent = '';
    const spinner = els.progressSection.querySelector('.spinner');
    if (spinner) spinner.style.display = 'block';

    const params = new URLSearchParams({
        keyword,
        platforms: state.selectedPlatforms.join(','),
        searchMode: state.searchMode,
        skipSeen: state.skipSeen ? 'true' : 'false',
        expandKeywords: state.expandKeywords ? 'true' : 'false',
        maxResults: $('#maxResults').value,
        minFollowers: $('#minFollowers').value || '0',
        maxFollowers: $('#maxFollowers').value || '0',
    });

    try {
        els.searchBtn.disabled = false;
        const response = await fetch(`/api/search?${params}`, {
            signal: state.searchAbortController.signal,
        });

        if (!response.ok) {
            throw new Error(`请求失败: ${response.status}`);
        }

        state.taskId = response.headers.get('X-Task-Id');

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });

            // Process complete SSE messages
            const lines = buffer.split('\n');
            buffer = lines.pop(); // Keep incomplete line

            for (const line of lines) {
                if (line.startsWith('data: ')) {
                    try {
                        const data = JSON.parse(line.slice(6));
                        handleSSEEvent(data);
                    } catch { /* ignore parse errors */ }
                }
            }
        }
    } catch (err) {
        if (err.name !== 'AbortError') {
            console.error('Search error:', err);
            els.progressMessage.textContent = `搜索出错: ${err.message}`;
        }
    } finally {
        state.searching = false;
        state.searchAbortController = null;
        els.searchBtn.disabled = false;
        els.searchBtn.querySelector('span').textContent = '开始搜索';
    }
}

async function cancelSearch(manual = false) {
    if (!state.searching) return;

    if (manual && state.taskId) {
        try {
            await fetch(`/api/tasks/${state.taskId}/cancel`, { method: 'POST' });
        } catch {
            // ignore
        }
    }

    if (state.searchAbortController) {
        state.searchAbortController.abort();
    }

    els.progressTitle.textContent = '正在取消任务...';
    els.progressMessage.textContent = '已发送取消请求，等待任务安全停止';
}

function handleSSEEvent(data) {
    switch (data.type) {
        case 'start':
            state.taskId = data.taskId;
            els.progressTitle.textContent = '正在搜索...';
            break;

        case 'platform_start':
            addProgressPlatform(data.platform, data.icon, data.name);
            els.progressTitle.textContent = `正在搜索 ${data.name}...`;
            break;

        case 'progress':
            updateProgress(data);
            break;

        case 'platform_done':
            markPlatformDone(data.platform);
            break;

        case 'platform_error':
            markPlatformError(data.platform, data.error);
            break;

        case 'done':
            handleSearchDone(data);
            break;

        case 'cancelled':
            handleSearchCancelled(data);
            break;
    }
}

function addProgressPlatform(id, icon, name) {
    const chip = document.createElement('div');
    chip.className = 'progress-platform-chip active';
    chip.id = `progress-${id}`;
    chip.innerHTML = `<span>${icon}</span> <span>${name}</span>`;
    els.progressPlatforms.appendChild(chip);
}

function markPlatformDone(id) {
    const chip = $(`#progress-${id}`);
    if (chip) {
        chip.classList.remove('active');
        chip.classList.add('done');
        chip.innerHTML += ' ✓';
    }
}

function markPlatformError(id, error) {
    const chip = $(`#progress-${id}`);
    if (chip) {
        chip.classList.remove('active');
        chip.classList.add('error');
        chip.innerHTML += ' ✗';
    }
    console.warn(`Platform ${id} error:`, error);
}

function updateProgress(data) {
    els.progressFill.style.width = `${data.overallProgress || 0}%`;
    els.progressPercent.textContent = `${data.overallProgress || 0}%`;
    if (data.message) els.progressMessage.textContent = data.message;

    // Update kocs progressively
    if (data.kocs && data.kocs.length > 0) {
        for (const koc of data.kocs) {
            const existing = state.kocs.find(
                (k) => k.userId === koc.userId && k.platform === koc.platform
            );
            if (!existing) {
                state.kocs.push(koc);
            }
        }
    }
}

function handleSearchDone(data) {
    // Use final kocs from server
    if (data.kocs) {
        state.kocs = data.kocs;
    }

    els.progressTitle.textContent = '搜索完成！';
    els.progressFill.style.width = '100%';
    els.progressPercent.textContent = '100%';

    const duration = data.duration ? `${(data.duration / 1000).toFixed(1)}s` : '';
    const summaryText = data.summary
        ? `，平均分 ${data.summary.avgScore}，数据可信度 ${data.summary.avgConfidence}`
        : '';
    els.progressMessage.textContent =
        `共找到 ${state.kocs.length} 个 KOC${summaryText}${duration ? `，耗时 ${duration}` : ''}`;

    // Hide spinner
    const spinner = els.progressSection.querySelector('.spinner');
    if (spinner) spinner.style.display = 'none';

    // Show results
    setTimeout(() => {
        els.resultsSection.classList.remove('hidden');
        updateStats();
        renderKocs();
    }, 500);
}

function handleSearchCancelled(data) {
    if (data.kocs) {
        state.kocs = data.kocs;
    }

    els.progressTitle.textContent = '搜索已取消';
    els.progressMessage.textContent = data.reason || '任务已取消';
    const spinner = els.progressSection.querySelector('.spinner');
    if (spinner) spinner.style.display = 'none';

    if (state.kocs.length > 0) {
        els.resultsSection.classList.remove('hidden');
        updateStats();
        renderKocs();
    }
}

// ============ Rendering ============
function formatCount(num) {
    if (!num && num !== 0) return '-';
    num = parseInt(num) || 0;
    if (num >= 100000000) return `${(num / 100000000).toFixed(1)}亿`;
    if (num >= 10000) return `${(num / 10000).toFixed(1)}万`;
    if (num >= 1000) return `${(num / 1000).toFixed(1)}k`;
    return String(num);
}

function formatFollowers(koc) {
    if (koc.followers > 0) return formatCount(koc.followers);
    if (koc.dataQuality && koc.dataQuality.profileFetched === false) return '未获取';
    return formatCount(koc.followers);
}

function getScoreColor(score) {
    if (score >= 85) return 'var(--grade-s)';
    if (score >= 70) return 'var(--grade-a)';
    if (score >= 55) return 'var(--grade-b)';
    if (score >= 40) return 'var(--grade-c)';
    return 'var(--grade-d)';
}

function updateStats() {
    const kocs = state.kocs;
    els.totalKocs.textContent = kocs.length;

    if (kocs.length > 0) {
        const scores = kocs.map((k) => k.evaluation?.totalScore || 0);
        const avg = scores.reduce((s, v) => s + v, 0) / scores.length;
        els.avgScore.textContent = avg.toFixed(1);

        const grades = kocs.map((k) => k.evaluation?.grade || 'D');
        const gradeOrder = ['S', 'A', 'B', 'C', 'D'];
        const topGrade = gradeOrder.find((g) => grades.includes(g)) || 'D';
        els.topGrade.textContent = topGrade;

        const withContact = kocs.filter(
            (k) => Object.keys(k.contactInfo || {}).length > 0
        ).length;
        const avgConfidence = (
            kocs.reduce((s, k) => s + (k.evaluation?.confidence || 0), 0) / kocs.length
        ).toFixed(0);
        els.withContact.textContent = `${withContact} / ${avgConfidence}%`;
    } else {
        els.avgScore.textContent = '-';
        els.topGrade.textContent = '-';
        els.withContact.textContent = '0 / -';
    }
}

function getFilteredSortedKocs() {
    let kocs = [...state.kocs];

    // Filter
    if (state.currentFilter !== 'all') {
        kocs = kocs.filter((k) => k.evaluation?.grade === state.currentFilter);
    }

    // Sort
    switch (state.currentSort) {
        case 'score':
            kocs.sort((a, b) => (b.evaluation?.totalScore || 0) - (a.evaluation?.totalScore || 0));
            break;
        case 'followers':
            kocs.sort((a, b) => (b.followers || 0) - (a.followers || 0));
            break;
        case 'engagement':
            kocs.sort((a, b) => (b.engagementRate || 0) - (a.engagementRate || 0));
            break;
    }

    return kocs;
}

function renderKocs() {
    const kocs = getFilteredSortedKocs();
    els.kocGrid.innerHTML = '';

    if (kocs.length === 0) {
        els.kocGrid.innerHTML = `
      <div style="grid-column: 1/-1; text-align: center; padding: 60px 20px; color: var(--text-muted);">
        <p style="font-size: 2rem; margin-bottom: 8px;">🔍</p>
        <p>暂无符合条件的 KOC</p>
      </div>
    `;
        return;
    }

    for (const koc of kocs) {
        const card = createKocCard(koc);
        els.kocGrid.appendChild(card);
    }

    // Animate cards
    requestAnimationFrame(() => {
        $$('.koc-card').forEach((card, i) => {
            card.style.opacity = '0';
            card.style.transform = 'translateY(20px)';
            setTimeout(() => {
                card.style.transition = 'all 0.4s cubic-bezier(0.4, 0, 0.2, 1)';
                card.style.opacity = '1';
                card.style.transform = 'translateY(0)';
            }, i * 50);
        });
    });
}

function createKocCard(koc) {
    const eval_ = koc.evaluation || {};
    const grade = eval_.grade || 'D';
    const score = eval_.totalScore || 0;
    const tags = eval_.tags || [];

    const card = document.createElement('div');
    card.className = 'koc-card';
    card.onclick = () => openDetailModal(koc);

    const contactTags = Object.keys(koc.contactInfo || {}).length > 0
        ? tags.filter((t) => t === '有联系方式')
            .map((t) => `<span class="koc-tag contact-tag">${t}</span>`)
            .join('')
        : '';

    const otherTags = tags
        .filter((t) => t !== '有联系方式')
        .slice(0, 3)
        .map((t) => `<span class="koc-tag">${t}</span>`)
        .join('');

    card.innerHTML = `
    <div class="koc-card-header">
      <img class="koc-avatar" src="${koc.avatar || ''}" alt="${koc.nickname}" 
        onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><rect fill=%22%231a2035%22 width=%22100%22 height=%22100%22/><text x=%2250%25%22 y=%2255%25%22 text-anchor=%22middle%22 fill=%22%2364748b%22 font-size=%2240%22>${koc.nickname?.[0] || '?'}</text></svg>'">
      <div class="koc-info">
        <div class="koc-name-row">
          <span class="koc-name">${escapeHtml(koc.nickname)}</span>
          <span class="koc-grade grade-${grade}">${grade}</span>
        </div>
        <div class="koc-username-row">@${escapeHtml(koc.username)}</div>
        <div class="koc-meta">
          <span class="koc-platform-badge">${koc.platformIcon || ''} ${koc.platform}</span>
          <span class="koc-category">${escapeHtml(koc.category)}</span>
        </div>
      </div>
    </div>

    <div class="koc-stats">
      <div class="koc-stat">
        <div class="koc-stat-value">${formatFollowers(koc)}</div>
        <div class="koc-stat-label">粉丝</div>
      </div>
      <div class="koc-stat">
        <div class="koc-stat-value">${formatCount(koc.likes)}</div>
        <div class="koc-stat-label">获赞</div>
      </div>
      <div class="koc-stat">
        <div class="koc-stat-value">${koc.engagementRate ? (koc.engagementRate * 100).toFixed(1) + '%' : '-'}</div>
        <div class="koc-stat-label">互动率</div>
      </div>
    </div>

    <div class="koc-score-bar">
      <div class="koc-score-track">
        <div class="koc-score-fill" style="width: ${score}%; background: ${getScoreColor(score)};"></div>
      </div>
      <span class="koc-score-value" style="color: ${getScoreColor(score)}">${score}</span>
    </div>

    <div class="koc-tags">
      ${otherTags}
      ${contactTags}
    </div>
  `;

    return card;
}

// ============ Detail Modal ============
function openDetailModal(koc) {
    const eval_ = koc.evaluation || {};
    const grade = eval_.grade || 'D';
    const scores = eval_.scores || {};

    const contactEntries = Object.entries(koc.contactInfo || {});
    const contactHtml = contactEntries.length > 0
        ? `<div class="modal-contacts">
        <h4>📞 联系方式</h4>
        ${contactEntries.map(([k, v]) => `
          <div class="contact-row">
            <span class="contact-label">${getContactLabel(k)}</span>
            <span class="contact-value">${escapeHtml(v)}</span>
          </div>
        `).join('')}
      </div>`
        : '';

    const relatedPostsHtml = (koc.relatedPosts || []).length > 0
        ? `<div class="modal-related-posts">
        <h4>📝 相关帖子 (${koc.noteAppearances || koc.relatedPosts.length})</h4>
        ${(koc.relatedPosts || []).slice(0, 5).map((p) => `
          <div class="related-post-row">
            <span class="related-post-title">${escapeHtml(p.title || '')}</span>
            <span class="related-post-likes">${escapeHtml(p.likes || '-')} 赞</span>
          </div>
        `).join('')}
      </div>`
        : '';

    const dimLabels = {
        engagementRate: '互动率',
        followerFit: '粉丝适配',
        activityLevel: '活跃度',
        contentRelevance: '相关度',
        growthTrend: '增长趋势',
    };

    const radarHtml = Object.entries(scores)
        .map(([key, value]) => `
      <div class="radar-dim">
        <div class="radar-dim-value" style="color: ${getScoreColor(value)}">${Math.round(value)}</div>
        <div class="radar-bar-track">
          <div class="radar-bar-fill" style="width: ${value}%; background: ${getScoreColor(value)};"></div>
        </div>
        <div class="radar-dim-label">${dimLabels[key] || key}</div>
      </div>
    `)
        .join('');

    els.modalContent.innerHTML = `
    <div class="modal-profile">
      <img class="modal-avatar" src="${koc.avatar || ''}" alt="${koc.nickname}"
        onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><rect fill=%22%231a2035%22 width=%22100%22 height=%22100%22/><text x=%2250%25%22 y=%2255%25%22 text-anchor=%22middle%22 fill=%22%2364748b%22 font-size=%2240%22>${koc.nickname?.[0] || '?'}</text></svg>'">
      <div>
        <div class="koc-name-row" style="margin-bottom: 4px;">
          <span class="modal-name">${escapeHtml(koc.nickname)}</span>
          <span class="koc-grade grade-${grade}" style="margin-left: 10px;">${grade}</span>
        </div>
        <div class="modal-username">${koc.platformIcon} @${escapeHtml(koc.username)} · ${escapeHtml(koc.category)}</div>
      </div>
    </div>

    <div class="modal-stats-grid">
      <div class="modal-stat">
        <div class="modal-stat-value">${formatFollowers(koc)}</div>
        <div class="modal-stat-label">粉丝</div>
      </div>
      <div class="modal-stat">
        <div class="modal-stat-value">${formatCount(koc.following)}</div>
        <div class="modal-stat-label">关注</div>
      </div>
      <div class="modal-stat">
        <div class="modal-stat-value">${formatCount(koc.likes)}</div>
        <div class="modal-stat-label">获赞</div>
      </div>
      <div class="modal-stat">
        <div class="modal-stat-value">${formatCount(koc.posts)}</div>
        <div class="modal-stat-label">作品</div>
      </div>
    </div>

    <h4 style="font-size: 0.85rem; color: var(--text-secondary); margin-bottom: 10px;">📊 质量评估 · 综合 ${eval_.totalScore || 0} 分</h4>
    <div style="font-size: 0.78rem; color: var(--text-muted); margin-bottom: 10px;">
      数据可信度：${eval_.confidence || 0}%
    </div>
    <div class="modal-radar">
      <div class="radar-chart">${radarHtml}</div>
    </div>

    ${relatedPostsHtml}
    ${contactHtml}

    ${koc.description ? `<div class="modal-desc">${escapeHtml(koc.description)}</div>` : ''}

    <div class="modal-recommendation grade-${grade}">
      ${eval_.recommendation || ''}
    </div>

    ${koc.profileUrl ? `<a class="modal-link" href="${koc.profileUrl}" target="_blank" rel="noopener">
      🔗 查看主页
    </a>` : ''}
  `;

    els.modalOverlay.classList.remove('hidden');
}

function closeModal() {
    els.modalOverlay.classList.add('hidden');
}

function getContactLabel(key) {
    const map = {
        email: '邮箱',
        wechat: '微信',
        phone: '手机',
        qq: 'QQ',
        instagram: 'Ins',
        telegram: 'TG',
    };
    return map[key] || key;
}

// ============ Auth Modal ============
async function openAuthModal() {
    els.authOverlay.classList.remove('hidden');

    try {
        const resp = await fetch('/api/platforms');
        const platforms = await resp.json();

        els.authPlatforms.innerHTML = platforms
            .map(
                (p) => `
      <div class="auth-platform-item">
        <div class="auth-platform-info">
          <span class="auth-platform-icon">${p.icon}</span>
            <div>
            <div class="auth-platform-name">${p.id}</div>
            <div class="auth-platform-status ${p.loggedIn ? 'logged-in' : 'not-logged'}">
              ${p.loggedIn ? '✅ 已登录' : p.requiresLogin ? '⚠️ 需要登录' : '🔑 需配置 API Key'}
            </div>
            <div class="auth-platform-status" style="margin-top: 4px; opacity: 0.75;">
              模式：${p.mode || 'unknown'}
            </div>
          </div>
        </div>
        <button class="auth-login-btn ${p.loggedIn ? 'logged' : ''}" 
          data-platform="${p.id}" 
          ${p.loggedIn ? 'disabled' : ''}>
          ${p.loggedIn ? '已连接' : p.requiresLogin ? '去登录' : '查看配置'}
        </button>
      </div>
    `
            )
            .join('');

        // Bind login buttons
        $$('.auth-login-btn:not(.logged)').forEach((btn) => {
            btn.addEventListener('click', async () => {
                const platform = btn.dataset.platform;
                btn.textContent = '登录中...';
                btn.disabled = true;

                try {
                    const resp = await fetch(`/api/auth/${platform}/login`, {
                        method: 'POST',
                    });
                    const result = await resp.json();

                    if (result.success) {
                        btn.textContent = '已连接';
                        btn.classList.add('logged');
                        const statusEl = btn.closest('.auth-platform-item').querySelector('.auth-platform-status');
                        statusEl.textContent = '✅ 已登录';
                        statusEl.className = 'auth-platform-status logged-in';
                    } else {
                        btn.textContent = '重试';
                        btn.disabled = false;
                        alert(result.message);
                    }
                } catch (err) {
                    btn.textContent = '重试';
                    btn.disabled = false;
                    alert('登录请求失败: ' + err.message);
                }
            });
        });
    } catch (err) {
        els.authPlatforms.innerHTML =
            '<p style="color: var(--text-muted);">加载失败，请确认服务已启动</p>';
    }
}

function closeAuthModal() {
    els.authOverlay.classList.add('hidden');
}

// ============ Export ============
async function exportCSV() {
    if (state.kocs.length === 0) {
        alert('暂无数据可导出');
        return;
    }

    try {
        const exportKocs = state.kocs.map(koc => {
            const { rawData, ...rest } = koc;
            return rest;
        });
        const resp = await fetch('/api/export', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                kocs: exportKocs,
                keyword: state.keyword,
            }),
        });

        const blob = await resp.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download =
            resp.headers.get('Content-Disposition')?.match(/filename="(.+)"/)?.[1] ||
            `KOC_${state.keyword}.csv`;
        a.click();
        URL.revokeObjectURL(url);
    } catch (err) {
        alert('导出失败: ' + err.message);
    }
}

// ============ Utilities ============
function escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

// ============ Init ============
init();
