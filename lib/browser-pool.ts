import puppeteer, { Browser } from "puppeteer-core";

let browserInstance: Browser | null = null;
let browserPromise: Promise<Browser> | null = null;
let lastUsed: number = Date.now();

const BROWSER_IDLE_TIMEOUT = 5 * 60 * 1000; // 5 minutes

async function getChromiumPath(): Promise<string> {
  if (process.env.CHROMIUM_PATH) {
    return process.env.CHROMIUM_PATH;
  }
  
  if (process.env.RENDER_EXTERNAL_URL) {
    const chromium = await import("@sparticuz/chromium");
    return await chromium.default.executablePath();
  }
  
  return "/usr/bin/chromium";
}

export async function getBrowser(): Promise<Browser> {
  lastUsed = Date.now();
  
  if (browserInstance && browserInstance.connected) {
    return browserInstance;
  }
  
  if (browserPromise) {
    return browserPromise;
  }
  
  browserPromise = (async () => {
    const executablePath = await getChromiumPath();
    console.log("[Browser Pool] Launching browser...");
    const browser = await puppeteer.launch({
      executablePath,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-gpu",
        "--disable-dev-shm-usage",
        "--single-process",
      ],
      headless: true,
    });
    
    browserInstance = browser;
    browserPromise = null;
    console.log("[Browser Pool] Browser launched and ready");
    
    startIdleChecker();
    
    return browser;
  })();
  
  return browserPromise;
}

let idleCheckerInterval: NodeJS.Timeout | null = null;

function startIdleChecker() {
  if (idleCheckerInterval) return;
  
  idleCheckerInterval = setInterval(async () => {
    if (Date.now() - lastUsed > BROWSER_IDLE_TIMEOUT && browserInstance) {
      console.log("[Browser Pool] Closing idle browser");
      await closeBrowser();
    }
  }, 60000);
}

export async function closeBrowser(): Promise<void> {
  if (browserInstance) {
    try {
      await browserInstance.close();
    } catch (e) {
      console.error("[Browser Pool] Error closing browser:", e);
    }
    browserInstance = null;
  }
  
  if (idleCheckerInterval) {
    clearInterval(idleCheckerInterval);
    idleCheckerInterval = null;
  }
}

export async function renderHtmlToImage(
  html: string,
  selector: string,
  width: number,
  height: number,
  deviceScaleFactor: number
): Promise<Buffer> {
  const browser = await getBrowser();
  const page = await browser.newPage();
  
  try {
    await page.setViewport({ width, height, deviceScaleFactor });
    await page.setContent(html, { waitUntil: "domcontentloaded" });
    
    const element = await page.$(selector);
    if (!element) {
      throw new Error(`Selector "${selector}" not found in HTML`);
    }
    
    const screenshot = await element.screenshot({ type: "png" });
    return Buffer.from(screenshot);
  } finally {
    await page.close();
  }
}
