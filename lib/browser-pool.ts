import "server-only";
import puppeteer, { Browser, Page } from "puppeteer";

const MAX_POOL_SIZE = 3;
const PAGE_TIMEOUT = 30000;
const BROWSER_ARGS = [
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-gpu",
  "--disable-dev-shm-usage",
  "--disable-accelerated-2d-canvas",
  "--no-first-run",
  "--no-zygote",
  "--single-process",
  "--disable-background-networking",
  "--disable-default-apps",
  "--disable-extensions",
  "--disable-sync",
  "--disable-translate",
  "--hide-scrollbars",
  "--metrics-recording-only",
  "--mute-audio",
  "--no-default-browser-check",
  "--safebrowsing-disable-auto-update",
];

interface PooledBrowser {
  browser: Browser;
  inUse: boolean;
  createdAt: number;
  useCount: number;
}

class BrowserPool {
  private pool: PooledBrowser[] = [];
  private initPromise: Promise<void> | null = null;
  private maxUseCount = 50;
  private maxAge = 5 * 60 * 1000;

  private async createBrowser(): Promise<Browser> {
    return puppeteer.launch({
      headless: true,
      executablePath: process.env.CHROMIUM_PATH || undefined,
      args: BROWSER_ARGS,
    });
  }

  async acquire(): Promise<Browser> {
    for (const pooled of this.pool) {
      if (!pooled.inUse) {
        const age = Date.now() - pooled.createdAt;
        if (age > this.maxAge || pooled.useCount >= this.maxUseCount) {
          await this.removeBrowser(pooled);
          continue;
        }
        pooled.inUse = true;
        pooled.useCount++;
        return pooled.browser;
      }
    }

    if (this.pool.length < MAX_POOL_SIZE) {
      const browser = await this.createBrowser();
      const pooled: PooledBrowser = {
        browser,
        inUse: true,
        createdAt: Date.now(),
        useCount: 1,
      };
      this.pool.push(pooled);
      return browser;
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
    return this.acquire();
  }

  release(browser: Browser): void {
    const pooled = this.pool.find((p) => p.browser === browser);
    if (pooled) {
      pooled.inUse = false;
    }
  }

  private async removeBrowser(pooled: PooledBrowser): Promise<void> {
    const index = this.pool.indexOf(pooled);
    if (index !== -1) {
      this.pool.splice(index, 1);
      try {
        await pooled.browser.close();
      } catch (e) {
        console.error("[BrowserPool] Error closing browser:", e);
      }
    }
  }

  async shutdown(): Promise<void> {
    for (const pooled of this.pool) {
      try {
        await pooled.browser.close();
      } catch (e) {
        console.error("[BrowserPool] Error closing browser:", e);
      }
    }
    this.pool = [];
  }

  getStats(): { total: number; inUse: number; available: number } {
    const inUse = this.pool.filter((p) => p.inUse).length;
    return {
      total: this.pool.length,
      inUse,
      available: this.pool.length - inUse,
    };
  }
}

export const browserPool = new BrowserPool();

export async function renderHtmlToImage(
  html: string,
  options: {
    width: number;
    height: number;
    selector?: string;
    outputWidth?: number;
    outputHeight?: number;
  }
): Promise<Buffer> {
  const browser = await browserPool.acquire();
  let page: Page | null = null;

  try {
    page = await browser.newPage();
    await page.setViewport({
      width: options.width,
      height: options.height,
      deviceScaleFactor: 1,
    });

    await page.setContent(html, { waitUntil: "networkidle0", timeout: PAGE_TIMEOUT });

    if (options.selector) {
      const element = await page.$(options.selector);
      if (element) {
        const screenshot = await element.screenshot({ type: "png" });
        return Buffer.from(screenshot);
      }
    }

    const screenshot = await page.screenshot({
      type: "png",
      clip: { x: 0, y: 0, width: options.width, height: options.height },
    });

    return Buffer.from(screenshot);
  } finally {
    if (page) {
      try {
        await page.close();
      } catch (e) {
        console.error("[BrowserPool] Error closing page:", e);
      }
    }
    browserPool.release(browser);
  }
}
