import { chromium, Browser, BrowserContext, Cookie } from "playwright";
import { readFile, writeFile, mkdir, stat } from "fs/promises";
import { existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const COOKIES_DIR = join(__dirname, "..", "cookies");

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const STEALTH_SCRIPT = `
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
  Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en'] });
  window.chrome = { runtime: {} };
  const originalQuery = window.navigator.permissions.query;
  window.navigator.permissions.query = (parameters) =>
    parameters.name === 'notifications'
      ? Promise.resolve({ state: Notification.permission })
      : originalQuery(parameters);
`;

export type SiteName = "zhihu" | "zsxq" | "xueqiu";

const SITE_DOMAIN: Record<SiteName, string> = {
  zhihu: ".zhihu.com",
  zsxq: ".zsxq.com",
  xueqiu: ".xueqiu.com",
};

interface ContextEntry {
  ctx: BrowserContext;
  loadedAt: number;       // 上次从磁盘加载 cookie 时的 mtime
  syncing: Promise<void> | null;
}

let browser: Browser | null = null;
const contexts = new Map<SiteName, ContextEntry>();

export async function getBrowser(): Promise<Browser> {
  if (!browser || !browser.isConnected()) {
    // 知乎风控（/account/unhuman、40362）在无头环境下更容易触发。
    // 需要可见浏览器时设置环境变量 ASM_HEADLESS=0。
    const headless = process.env.ASM_HEADLESS !== "0";
    browser = await chromium.launch({
      headless,
      args: [
        "--disable-blink-features=AutomationControlled",
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-infobars",
        "--window-size=1920,1080",
      ],
    });
  }
  return browser;
}

function cookiePath(site: SiteName): string {
  return join(COOKIES_DIR, `${site}.json`);
}

async function getCookieFileMtime(site: SiteName): Promise<number> {
  const p = cookiePath(site);
  if (!existsSync(p)) return 0;
  try {
    const s = await stat(p);
    return s.mtimeMs;
  } catch {
    return 0;
  }
}

async function loadCookiesFromDisk(site: SiteName): Promise<Cookie[]> {
  const p = cookiePath(site);
  if (!existsSync(p)) return [];
  try {
    const raw = await readFile(p, "utf-8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed as Cookie[];
  } catch {
    return [];
  }
}

export async function saveCookies(
  site: SiteName,
  cookies: Cookie[]
): Promise<void> {
  if (!existsSync(COOKIES_DIR)) {
    await mkdir(COOKIES_DIR, { recursive: true });
  }
  await writeFile(cookiePath(site), JSON.stringify(cookies, null, 2), "utf-8");
}

export async function clearCookies(site: SiteName): Promise<void> {
  const p = cookiePath(site);
  if (existsSync(p)) {
    await writeFile(p, "[]", "utf-8");
  }
  const entry = contexts.get(site);
  if (entry) {
    await entry.ctx.clearCookies();
  }
}

export async function resetContext(site: SiteName): Promise<void> {
  const entry = contexts.get(site);
  if (entry) {
    await entry.ctx.close().catch(() => {});
    contexts.delete(site);
  }
}

/**
 * Persist current in-memory cookies for a site back to disk.
 * Called after each page operation so dynamic anti-bot tokens
 * (e.g. zhihu's __zse_ck) survive process restarts.
 *
 * Concurrent calls coalesce: only one sync per site runs at a time.
 */
export async function syncCookiesToDisk(site: SiteName): Promise<void> {
  const entry = contexts.get(site);
  if (!entry) return;

  if (entry.syncing) return entry.syncing;

  const task = (async () => {
    try {
      const cookies = await entry.ctx.cookies();
      if (!cookies.length) return;
      // Filter to site-relevant domains so we don't write unrelated junk.
      const targetDomain = SITE_DOMAIN[site];
      const filtered = cookies.filter(
        (c) =>
          c.domain === targetDomain ||
          c.domain === targetDomain.replace(/^\./, "") ||
          c.domain.endsWith(targetDomain)
      );
      const toWrite = filtered.length ? filtered : cookies;
      if (!existsSync(COOKIES_DIR)) {
        await mkdir(COOKIES_DIR, { recursive: true });
      }
      await writeFile(
        cookiePath(site),
        JSON.stringify(toWrite, null, 2),
        "utf-8"
      );
      // Bump our remembered mtime so the next getContext() call doesn't
      // think the file changed externally and rebuild the context.
      entry.loadedAt = await getCookieFileMtime(site);
    } catch {
      // Swallow — disk persistence is best-effort.
    } finally {
      entry.syncing = null;
    }
  })();

  entry.syncing = task;
  return task;
}

/**
 * Get (or build) a browser context for the site.
 * Hot-reloads cookies if cookies/<site>.json was modified externally
 * since we last loaded it — no MCP restart needed.
 */
export async function getContext(site: SiteName): Promise<BrowserContext> {
  const diskMtime = await getCookieFileMtime(site);
  const existing = contexts.get(site);

  if (existing) {
    if (diskMtime > existing.loadedAt) {
      // Cookie file changed under us. Rebuild.
      await existing.ctx.close().catch(() => {});
      contexts.delete(site);
    } else {
      return existing.ctx;
    }
  }

  const b = await getBrowser();
  const ctx = await b.newContext({
    userAgent: UA,
    viewport: { width: 1920, height: 1080 },
    locale: "zh-CN",
    extraHTTPHeaders: {
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    },
  });

  await ctx.addInitScript(STEALTH_SCRIPT);

  const cookies = await loadCookiesFromDisk(site);
  if (cookies.length > 0) {
    await ctx.addCookies(cookies);
  }

  contexts.set(site, {
    ctx,
    loadedAt: diskMtime,
    syncing: null,
  });
  return ctx;
}

export function detectSite(url: string): SiteName | null {
  if (/zhihu\.com/.test(url)) return "zhihu";
  if (/zsxq\.com/.test(url)) return "zsxq";
  if (/xueqiu\.com/.test(url)) return "xueqiu";
  return null;
}

/**
 * Parse cookies from either:
 *   - a JSON array of Playwright Cookie objects, or
 *   - a raw `Cookie:` header string ("a=b; c=d; ...")
 *
 * Returns Playwright-compatible Cookie objects defaulted to the given site's
 * domain when the input is a header string.
 */
export function parseCookieInput(input: string, site: SiteName): Cookie[] {
  const trimmed = input.trim();
  if (!trimmed) return [];

  // JSON path
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    const parsed = JSON.parse(trimmed);
    const arr: Cookie[] = Array.isArray(parsed) ? parsed : [parsed];
    return arr.map((c) => ({
      ...c,
      domain: c.domain || SITE_DOMAIN[site],
      path: c.path || "/",
      secure: c.secure ?? true,
      httpOnly: c.httpOnly ?? false,
      sameSite: c.sameSite ?? "Lax",
    }));
  }

  // Header path: "a=b; c=d"
  const out: Cookie[] = [];
  for (const part of trimmed.split(/;\s*/)) {
    if (!part) continue;
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (!name) continue;
    out.push({
      name,
      value,
      domain: SITE_DOMAIN[site],
      path: "/",
      expires: -1,
      httpOnly: false,
      secure: true,
      sameSite: "Lax",
    });
  }
  return out;
}

/**
 * Heuristic: does this URL look like a login redirect?
 * Used by site extractors to surface a clear "session expired" error
 * instead of returning the signin page's HTML as if it were content.
 */
export function isLoginRedirect(url: string): boolean {
  return /\/(signin|login)(\?|$|\/)/.test(url);
}

export async function closeBrowser(): Promise<void> {
  for (const [, entry] of contexts) {
    await entry.ctx.close().catch(() => {});
  }
  contexts.clear();
  if (browser) {
    await browser.close().catch(() => {});
    browser = null;
  }
}
