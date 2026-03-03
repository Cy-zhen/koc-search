import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COOKIES_DIR = path.join(__dirname, '..', 'data', 'cookies');

class BrowserManager {
  constructor() {
    this.browser = null;
    this.contexts = {};
  }

  async isContextUsable(context) {
    if (!context) return false;
    try {
      const page = await context.newPage();
      await page.close().catch(() => {});
      return true;
    } catch {
      return false;
    }
  }

  async getBrowser() {
    if (!this.browser || !this.browser.isConnected()) {
      this.browser = await chromium.launch({
        headless: process.env.BROWSER_HEADLESS === 'true',
        slowMo: parseInt(process.env.BROWSER_SLOW_MO || '50'),
        args: [
          '--disable-blink-features=AutomationControlled',
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
        ],
      });
    }
    return this.browser;
  }

  getCookiePath(platform) {
    return path.join(COOKIES_DIR, `${platform}.json`);
  }

  getContextOptions(platform) {
    return {
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      viewport: { width: 1440, height: 900 },
      locale: platform === 'tiktok' ? 'en-US' : 'zh-CN',
      timezoneId: platform === 'tiktok' ? 'America/New_York' : 'Asia/Shanghai',
    };
  }

  async applyStealth(context) {
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
      Object.defineProperty(navigator, 'plugins', {
        get: () => [1, 2, 3, 4, 5],
      });
      Object.defineProperty(navigator, 'languages', {
        get: () => ['zh-CN', 'zh', 'en'],
      });
      window.chrome = { runtime: {} };
    });
  }

  async loadCookiesToContext(context, platform) {
    const cookiePath = this.getCookiePath(platform);
    if (!fs.existsSync(cookiePath)) return;

    try {
      const cookies = JSON.parse(fs.readFileSync(cookiePath, 'utf-8'));
      await context.addCookies(cookies);
      console.log(`[BrowserManager] 已加载 ${platform} Cookie (${cookies.length} 条)`);
    } catch (e) {
      console.warn(`[BrowserManager] 加载 ${platform} Cookie 失败:`, e.message);
    }
  }

  async createIsolatedContext(platform, options = {}) {
    const browser = await this.getBrowser();
    const context = await browser.newContext(this.getContextOptions(platform));
    await this.applyStealth(context);

    if (options.loadCookies !== false) {
      await this.loadCookiesToContext(context, platform);
    }

    return context;
  }

  async getContext(platform) {
    if (this.contexts[platform]) {
      const usable = await this.isContextUsable(this.contexts[platform]);
      if (usable) {
        return this.contexts[platform];
      }
      await this.contexts[platform].close().catch(() => {});
      delete this.contexts[platform];
    }

    const context = await this.createIsolatedContext(platform);

    this.contexts[platform] = context;
    return context;
  }

  async saveContextCookies(context, platform) {
    if (!context) return;

    try {
      const cookies = await context.cookies();
      const cookiePath = this.getCookiePath(platform);

      if (!fs.existsSync(COOKIES_DIR)) {
        fs.mkdirSync(COOKIES_DIR, { recursive: true });
      }

      fs.writeFileSync(cookiePath, JSON.stringify(cookies, null, 2));
      console.log(`[BrowserManager] 已保存 ${platform} Cookie (${cookies.length} 条)`);
    } catch (e) {
      console.warn(`[BrowserManager] 保存 ${platform} Cookie 失败:`, e.message);
    }
  }

  async saveCookies(platform) {
    const context = this.contexts[platform];
    if (!context) return;
    await this.saveContextCookies(context, platform);
  }

  async newPage(platform) {
    const context = await this.getContext(platform);
    let page;
    try {
      page = await context.newPage();
    } catch (e) {
      await this.closeContext(platform);
      const retryContext = await this.getContext(platform);
      page = await retryContext.newPage();
    }

    // 随机延迟辅助
    page.randomDelay = async (min = 800, max = 2500) => {
      const delay = Math.floor(Math.random() * (max - min + 1)) + min;
      await page.waitForTimeout(delay);
    };

    // 模拟人类滚动
    page.humanScroll = async (distance = 300) => {
      await page.mouse.wheel(0, distance);
      await page.randomDelay(500, 1500);
    };

    return page;
  }

  async closeContext(platform) {
    if (this.contexts[platform]) {
      await this.saveCookies(platform);
      await this.contexts[platform].close().catch(() => {});
      delete this.contexts[platform];
    }
  }

  async closeAll() {
    for (const platform of Object.keys(this.contexts)) {
      await this.closeContext(platform);
    }
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }
}

// 单例模式
const browserManager = new BrowserManager();
export default browserManager;
