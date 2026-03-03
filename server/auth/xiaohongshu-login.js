import browserManager from '../browser-manager.js';

const XHS_HOME_URL = 'https://www.xiaohongshu.com/explore';
const XHS_COOKIE_NAMES = ['web_session'];

function hasValidAuthCookie(cookies) {
  return cookies.some(
    (cookie) =>
      XHS_COOKIE_NAMES.includes(cookie.name) &&
      typeof cookie.value === 'string' &&
      cookie.value.trim().length > 10
  );
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

export async function runXiaohongshuLoginFlow(options = {}) {
  const timeoutMs = options.timeoutMs || 180000;
  const pollEveryMs = options.pollEveryMs || 1500;

  await browserManager.closeContext('xiaohongshu').catch(() => {});

  const context = await browserManager.createIsolatedContext('xiaohongshu', {
    loadCookies: false,
  });

  const pages = new Set();
  const attachPage = (page) => {
    pages.add(page);
    page.on('close', () => pages.delete(page));
  };

  context.on('page', attachPage);

  let page = await context.newPage();
  attachPage(page);

  try {
    await page.goto(XHS_HOME_URL, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });

    await page.waitForTimeout(1500);
    await tryClickLoginEntry(page);

    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const cookies = await context.cookies('https://www.xiaohongshu.com');
      if (hasValidAuthCookie(cookies)) {
        await browserManager.saveContextCookies(context, 'xiaohongshu');
        await context.close().catch(() => {});
        return { success: true, message: '小红书登录成功，Cookie 已保存' };
      }

      const currentPages = [...pages].filter((p) => !p.isClosed());
      if (currentPages.length > 0) {
        const latest = currentPages[currentPages.length - 1];
        try {
          await latest.bringToFront();
        } catch {
          // ignore
        }
      }

      await page.waitForTimeout(pollEveryMs);
    }

    const urls = [...pages]
      .filter((p) => !p.isClosed())
      .map((p) => p.url())
      .filter(Boolean)
      .slice(0, 5);

    await context.close().catch(() => {});
    return {
      success: false,
      message: `登录超时，请在弹出的页面完成扫码/协议确认后重试。当前页面: ${urls.join(' | ') || 'n/a'}`,
    };
  } catch (err) {
    await context.close().catch(() => {});
    return { success: false, message: `登录失败: ${err.message}` };
  }
}

export default { runXiaohongshuLoginFlow };
