import browserManager from '../browser-manager.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const XHS_HOME_URL = 'https://www.xiaohongshu.com/explore';
const XHS_ENTRY_URLS = [
  'https://www.xiaohongshu.com/login?redirectPath=%2Fexplore',
  'https://www.xiaohongshu.com/explore',
  'https://www.xiaohongshu.com/',
  'https://www.xiaohongshu.com/search_result/?keyword=%E6%BD%AE%E7%8E%A9&type=1',
];
const XHS_COOKIE_NAMES = ['web_session'];
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const XHS_LOG_DIR = path.join(__dirname, '..', '..', 'data', 'logs');
const XHS_LOGIN_LOG = path.join(XHS_LOG_DIR, 'xhs-login.log');
const XHS_META_PATH = path.join(__dirname, '..', '..', 'data', 'cookies', 'xiaohongshu.meta.json');

function isLoginLikeUrl(url) {
  const text = String(url || '');
  return (
    /\/login(?:\?|$)/i.test(text) ||
    /\/website-login\//i.test(text) ||
    /agree\.xiaohongshu\.com/i.test(text)
  );
}

function writeLoginLog(message, payload = null) {
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
    fs.appendFileSync(XHS_LOGIN_LOG, `${line}\n`);
  } catch {
    // ignore
  }
}

function writeLoginMeta(meta) {
  try {
    const metaDir = path.dirname(XHS_META_PATH);
    if (!fs.existsSync(metaDir)) {
      fs.mkdirSync(metaDir, { recursive: true });
    }
    fs.writeFileSync(XHS_META_PATH, JSON.stringify(meta, null, 2));
  } catch {
    // ignore
  }
}

function hasValidAuthCookie(cookies) {
  const hasWebSession = cookies.some(
    (cookie) =>
      XHS_COOKIE_NAMES.includes(cookie.name) &&
      typeof cookie.value === 'string' &&
      cookie.value.trim().length > 10
  );
  // 仅 web_session 可能是游客态，至少再有一个强身份 cookie 才认为已登录
  const hasIdentityCookie = cookies.some(
    (cookie) => ['id_token', 'a1'].includes(cookie.name) && typeof cookie.value === 'string' && cookie.value.trim().length > 10
  );
  return hasWebSession && hasIdentityCookie;
}

function summarizeAuthCookies(cookies = []) {
  return cookies
    .filter((cookie) => ['web_session', 'a1', 'id_token'].includes(cookie.name))
    .map((cookie) => `${cookie.name}:${String(cookie.value || '').slice(0, 8)}...`);
}

function isSearchResultsUrl(url, keyword = '') {
  try {
    const parsed = new URL(url);
    const isSearchPath =
      parsed.pathname === '/search_result' || parsed.pathname === '/search_result/';
    if (!isSearchPath) return false;

    const keywordParam = decodeURIComponent(parsed.searchParams.get('keyword') || '').trim();
    return keyword ? keywordParam.includes(keyword) : !!keywordParam;
  } catch {
    return false;
  }
}

function inspectSearchHtml(url, bodyText) {
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
    hasLogin: /扫码登录|手机号登录|立即登录|请先登录|登录后查看/i.test(bodyText),
    hasCaptcha: /验证码|安全验证|请完成验证|验证后继续/i.test(bodyText),
    isHomeFeed: !isSearchPath && /发现|推荐|关注/.test((bodyText || '').slice(0, 200)),
  };
}

async function validateSearchAccess(context) {
  try {
    const probeUrl = 'https://www.xiaohongshu.com/search_result/?keyword=%E6%BD%AE%E7%8E%A9&type=1';
    const response = await context.request.get(probeUrl, { timeout: 20000 });
    const bodyText = await response.text();
    const info = inspectSearchHtml(response.url(), bodyText);
    return {
      ok:
        isSearchResultsUrl(info.url, '潮玩') &&
        !info.hasLogin &&
        !info.hasCaptcha &&
        !info.isHomeFeed,
      info,
    };
  } catch (err) {
    return {
      ok: false,
      info: {
        url: 'n/a',
        error: err.message,
      },
    };
  }
}

async function inspectPageAuthState(page) {
  try {
    const url = page.url();
    const state = await page.evaluate(() => {
      const bodyText = document.body?.innerText || '';
      return {
        hasLogin: /扫码登录|手机号登录|立即登录|请先登录|登录后查看|注册登录/i.test(bodyText),
        hasCaptcha: /验证码|安全验证|请完成验证|验证后继续/i.test(bodyText),
      };
    });
    return { url, ...state };
  } catch {
    return {
      url: page?.url?.() || '',
      hasLogin: true,
      hasCaptcha: false,
    };
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createPageTracker(context) {
  const pages = new Set();
  const onClose = (page) => pages.delete(page);
  const onPage = (page) => {
    pages.add(page);
    page.on('close', () => onClose(page));
  };

  for (const page of context.pages()) {
    onPage(page);
  }
  context.on('page', onPage);

  return {
    pages,
    dispose: () => context.off('page', onPage),
  };
}

function getLatestPage(tracker, preferredPage = null) {
  if (preferredPage && !preferredPage.isClosed()) {
    return preferredPage;
  }

  const candidates = [...tracker.pages].filter((page) => !page.isClosed());
  return candidates.length > 0 ? candidates[candidates.length - 1] : null;
}

async function tryClickLoginEntry(page) {
  const candidates = [
    page.locator('text=登录').first(),
    page.locator('text=立即登录').first(),
    page.locator('text=手机号登录').first(),
  ];

  for (const candidate of candidates) {
    try {
      if (await candidate.isVisible({ timeout: 1000 })) {
        await candidate.click({ timeout: 2000 });
        return true;
      }
    } catch {
      // ignore
    }
  }

  return false;
}

async function acceptTermsIfNeeded(page) {
  if (!/agree\.xiaohongshu\.com/i.test(page.url())) {
    return false;
  }

  const candidates = [
    page.locator('button:has-text("同意")').first(),
    page.locator('button:has-text("同意并继续")').first(),
    page.locator('button:has-text("我已阅读并同意")').first(),
    page.locator('text=同意并继续').first(),
    page.locator('text=我已阅读并同意').first(),
  ];

  for (const candidate of candidates) {
    try {
      if (await candidate.isVisible({ timeout: 1000 })) {
        await candidate.click({ timeout: 2500 });
        return true;
      }
    } catch {
      // ignore
    }
  }

  return false;
}

async function openLoginEntryPage(page) {
  let lastError = null;

  for (const url of XHS_ENTRY_URLS) {
    try {
      await page.goto(url, {
        waitUntil: 'commit',
        timeout: 15000,
      });
      await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
      await page.waitForSelector('body', { timeout: 5000 }).catch(() => {});
      writeLoginLog('login_page_opened', { url: page.url(), requestedUrl: url });
      return;
    } catch (err) {
      lastError = err;
      writeLoginLog('login_page_open_failed', {
        requestedUrl: url,
        message: err.message,
      });
    }
  }

  throw lastError || new Error('无法打开小红书登录入口页');
}

export async function runXiaohongshuLoginFlow(options = {}) {
  const timeoutMs = options.timeoutMs || 180000;
  const pollEveryMs = options.pollEveryMs || 1500;
  const validationEveryMs = options.validationEveryMs || 6000;

  console.log('请在弹出的浏览器中完成小红书扫码登录。程序会自动检测登录是否成功，无需手动关闭窗口。');
  await browserManager.closeContext('xiaohongshu').catch(() => {});
  writeLoginMeta({ verified: false, updatedAt: new Date().toISOString(), reason: 'login_started' });

  const context = await browserManager.createIsolatedContext('xiaohongshu', {
    loadCookies: false,
  });

  const tracker = createPageTracker(context);

  let page = await context.newPage();

  try {
    await openLoginEntryPage(page);

    await page.waitForTimeout(1500);
    await tryClickLoginEntry(page);

    const start = Date.now();
    let lastValidationAt = 0;
    let stableAuthPassCount = 0;
    while (Date.now() - start < timeoutMs) {
      page = getLatestPage(tracker, page);
      if (!page) {
        writeLoginLog('login_window_closed', { elapsedMs: Date.now() - start });
        const validation = await validateSearchAccess(context);
        const cookies = await context.cookies('https://www.xiaohongshu.com');
        const hasAuthCookie = hasValidAuthCookie(cookies);
        writeLoginLog('login_final_validation', {
          ...validation,
          hasAuthCookie,
          authCookies: summarizeAuthCookies(cookies),
        });
        if (validation.ok && hasAuthCookie) {
          await browserManager.saveContextCookies(context, 'xiaohongshu');
          writeLoginMeta({
            verified: true,
            verifiedAt: new Date().toISOString(),
            via: 'manual_window_close',
          });
          tracker.dispose();
          await context.close().catch(() => {});
          return { success: true, message: '小红书登录成功，Cookie 已保存' };
        }

        throw new Error('登录窗口已关闭，但最终搜索页校验未通过');
      }

      const acceptedTerms = await acceptTermsIfNeeded(page);
      if (acceptedTerms) {
        writeLoginLog('terms_accepted', { url: page.url() });
      }

      const cookies = await context.cookies('https://www.xiaohongshu.com');
      const hasAuthCookie = hasValidAuthCookie(cookies);
      if (hasAuthCookie) {
        writeLoginLog('login_cookie_detected', {
          url: page.url(),
          cookieCount: cookies.length,
          authCookies: summarizeAuthCookies(cookies),
        });
      }

      if (Date.now() - lastValidationAt >= validationEveryMs) {
        lastValidationAt = Date.now();
        const pageState = await inspectPageAuthState(page);
        const activeUrl = pageState.url || page.url();
        const onLoginPage = isLoginLikeUrl(activeUrl);
        const validation = await validateSearchAccess(context);
        const strictReady =
          validation.ok &&
          hasAuthCookie &&
          !onLoginPage &&
          !pageState.hasLogin &&
          !pageState.hasCaptcha;

        stableAuthPassCount = strictReady ? stableAuthPassCount + 1 : 0;

        writeLoginLog('login_probe_validation', {
          ...validation,
          pageState,
          onLoginPage,
          hasAuthCookie,
          strictReady,
          stableAuthPassCount,
          activeUrl,
        });
        if (strictReady && stableAuthPassCount >= 2) {
          await browserManager.saveContextCookies(context, 'xiaohongshu');
          writeLoginMeta({
            verified: true,
            verifiedAt: new Date().toISOString(),
            via: 'auto_validation',
          });
          tracker.dispose();
          await context.close().catch(() => {});
          return { success: true, message: '小红书登录成功，已验证可访问搜索页' };
        }
      }

      try {
        await page.bringToFront();
      } catch {
        // ignore
      }

      await tryClickLoginEntry(page);
      writeLoginLog('login_polling', {
        url: page.url(),
        elapsedMs: Date.now() - start,
      });
      await sleep(pollEveryMs);
    }

    const urls = [...tracker.pages]
      .filter((p) => !p.isClosed())
      .map((p) => p.url())
      .filter(Boolean)
      .slice(0, 5);

    tracker.dispose();
    writeLoginLog('login_timeout', { urls });
    writeLoginMeta({ verified: false, updatedAt: new Date().toISOString(), reason: 'login_timeout' });
    await context.close().catch(() => {});
    return {
      success: false,
      message: `登录超时，请在弹出的页面完成扫码/协议确认，并在完成后手动关闭浏览器窗口。当前页面: ${urls.join(' | ') || 'n/a'}`,
    };
  } catch (err) {
    tracker.dispose();
    writeLoginLog('login_failed', { message: err.message });
    writeLoginMeta({ verified: false, updatedAt: new Date().toISOString(), reason: err.message });
    await context.close().catch(() => {});
    return { success: false, message: `登录失败: ${err.message}` };
  }
}

export default { runXiaohongshuLoginFlow };
