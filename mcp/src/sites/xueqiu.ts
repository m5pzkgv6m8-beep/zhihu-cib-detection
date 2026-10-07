import { Page } from "playwright";
import { htmlToMarkdown } from "../extractor.js";

export async function extractXueqiu(page: Page): Promise<string> {
  const url = page.url();

  // 股票页面
  if (/\/S\/[A-Z]/.test(url)) {
    await page.waitForSelector(".quote-container, .stock-name", {
      timeout: 15000,
    });
    const name = await page
      .locator(".stock-name")
      .textContent()
      .catch(() => "");
    const price = await page
      .locator(".stock-current strong")
      .textContent()
      .catch(() => "");
    const change = await page
      .locator(".stock-change")
      .textContent()
      .catch(() => "");

    const quoteHtml = await page
      .locator(".quote-container")
      .innerHTML()
      .catch(() => "");
    const quoteMd = quoteHtml ? htmlToMarkdown(quoteHtml) : "";

    return `# ${(name || "").trim()}\n\n当前价格: ${(price || "").trim()} ${(change || "").trim()}\n\n${quoteMd}`;
  }

  // 帖子/文章页面
  await page.waitForSelector(
    ".article__bd__detail, .status-content, [class*='article']",
    { timeout: 15000 }
  );

  const selectors = [
    ".article__bd__detail",
    ".status-content",
    ".article__bd",
    "[class*='articleContent']",
  ];

  for (const sel of selectors) {
    const el = page.locator(sel).first();
    if ((await el.count()) > 0) {
      const html = await el.innerHTML();
      if (html.trim().length > 0) {
        const title = await page
          .locator(".article__bd__title, h1")
          .first()
          .textContent()
          .catch(() => null);
        const md = htmlToMarkdown(html);
        return title ? `# ${title.trim()}\n\n${md}` : md;
      }
    }
  }

  const bodyHtml = await page.locator("#app, body").first().innerHTML();
  return htmlToMarkdown(bodyHtml);
}
