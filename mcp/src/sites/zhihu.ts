import { Page } from "playwright";
import { htmlToMarkdown } from "../extractor.js";
import { isLoginRedirect } from "../browser.js";
import {
  SESSION_EXPIRED_MSG,
  fetchMember,
  formatProfileMarkdown,
  getConnections,
  getMemberActivity,
} from "./zhihu-api.js";

function looksLikeLoginPage(text: string): boolean {
  if (!text) return false;
  const t = text.trim();
  // Login page boilerplate that consistently appears when redirected
  return (
    t.length < 600 &&
    /(打开知乎App|验证码登录|未注册手机|获取短信验证码)/.test(t)
  );
}

export interface ZhihuUser {
  name: string;
  url_token: string;
  bio: string;
  answer_count: number | null;
  article_count: number | null;
  follower_count: number | null;
}

export interface ZhihuPost {
  title: string;
  summary: string;
  url: string;
  /** v4 的 members/answers 接口不返回赞同数，未补全时为 null */
  vote_count: number | null;
}

async function closeModal(page: Page): Promise<void> {
  const closeBtn = page.locator('.Modal-closeButton, .signFlowModal .Button--plain, [aria-label="关闭"]');
  if ((await closeBtn.count()) > 0) {
    await closeBtn.first().click().catch(() => {});
    await page.waitForTimeout(500);
  }
}

async function tryExtract(
  page: Page,
  selectors: string[]
): Promise<string | null> {
  for (const sel of selectors) {
    const el = page.locator(sel).first();
    if ((await el.count()) > 0) {
      const html = await el.innerHTML().catch(() => "");
      if (html.trim().length > 50) {
        return htmlToMarkdown(html);
      }
    }
  }
  return null;
}

/**
 * 优先路径：直接从 SSR 注入的 js-initialData 里取数据。
 * 这个 JSON 在登录态下完整包含问题标题、回答正文、作者、点赞数，
 * 不依赖 React 渲染后的 DOM class，远比选择器稳。
 */
async function extractFromInitialData(page: Page): Promise<string | null> {
  const url = page.url();
  const data = await page.evaluate(() => {
    const node = document.getElementById("js-initialData");
    return node?.textContent || null;
  });
  if (!data) return null;

  let parsed: any;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }

  const entities = parsed?.initialState?.entities;
  if (!entities) return null;

  // /question/<qid>/answer/<aid>
  const answerMatch = url.match(/\/answer\/(\d+)/);
  if (answerMatch) {
    const aid = answerMatch[1];
    const a = entities.answers?.[aid];
    if (a?.content) {
      const qTitle =
        a.question?.title ||
        Object.values(entities.questions || {})[0] &&
          (Object.values(entities.questions || {})[0] as any).title ||
        "";
      const author = a.author?.name ? `\n\n— *${a.author.name}*` : "";
      const stats =
        a.voteupCount != null
          ? `\n\n（赞 ${a.voteupCount} · 评论 ${a.commentCount ?? 0}）`
          : "";
      const md = htmlToMarkdown(a.content);
      const head = qTitle ? `# ${qTitle}\n\n` : "";
      return `${head}${md}${author}${stats}`;
    }
  }

  // /p/<id> 专栏文章
  const articleMatch = url.match(/zhuanlan\.zhihu\.com\/p\/(\d+)|\/p\/(\d+)/);
  if (articleMatch) {
    const id = articleMatch[1] || articleMatch[2];
    const art = entities.articles?.[id];
    if (art?.content) {
      const md = htmlToMarkdown(art.content);
      const head = art.title ? `# ${art.title}\n\n` : "";
      return `${head}${md}`;
    }
  }

  return null;
}

export async function extractZhihu(page: Page): Promise<string> {
  const url = page.url();

  // 短路 1：被重定向到登录页 → 立即报错
  if (isLoginRedirect(url)) {
    throw new Error(SESSION_EXPIRED_MSG);
  }

  // 等待页面基本渲染
  await page.waitForTimeout(2000);

  // 短路 2：哪怕没重定向，但 URL 里塞了 next=... 这种登录回跳标记
  if (isLoginRedirect(page.url())) {
    throw new Error(SESSION_EXPIRED_MSG);
  }

  // 关闭可能的登录弹窗
  await closeModal(page);

  // 用户主页：DOM 结构不稳（js-initialData 里只有 stub），直接走 v4 API
  const peopleMatch = page.url().match(/zhihu\.com\/people\/([^/?#]+)/);
  if (peopleMatch) {
    const member = await fetchMember(page, decodeURIComponent(peopleMatch[1]));
    if (member) return formatProfileMarkdown(member);
  }

  // 优先：从 js-initialData 取，最稳
  const fromJson = await extractFromInitialData(page);
  if (fromJson && fromJson.trim().length > 50) return fromJson;

  // 专栏文章 DOM fallback
  if (url.includes("/p/") || url.includes("zhuanlan")) {
    const contentSelectors = [
      ".Post-RichTextContainer .RichText",
      ".Post-RichTextContainer",
      ".RichText.ztext.Post-RichText",
      ".RichText",
      "article",
    ];

    await page
      .waitForSelector(contentSelectors[0] + ", " + contentSelectors[2], {
        timeout: 10000,
      })
      .catch(() => {});

    const title = await page
      .locator(".Post-Title")
      .textContent()
      .catch(() => null);
    const md = await tryExtract(page, contentSelectors);
    if (md) return title ? `# ${title.trim()}\n\n${md}` : md;
  }

  // 回答页 DOM fallback
  const answerSelectors = [
    ".RichContent-inner .RichText",
    ".QuestionAnswer-content .RichText",
    ".RichContent-inner",
    ".RichText.ztext.CopyrightRichText-richText",
    ".RichText",
    ".AnswerItem .RichText",
  ];

  await page
    .waitForSelector(".RichContent-inner, .RichText, .QuestionAnswer-content", {
      timeout: 10000,
    })
    .catch(() => {});

  const expandBtn = page.locator(
    'button:has-text("展开阅读全文"), .ContentItem-expandButton'
  );
  if ((await expandBtn.count()) > 0) {
    await expandBtn.first().click().catch(() => {});
    await page.waitForTimeout(1000);
  }

  const questionTitle = await page
    .locator(".QuestionHeader-title")
    .textContent()
    .catch(() => null);

  const md = await tryExtract(page, answerSelectors);
  if (md) return questionTitle ? `# ${questionTitle.trim()}\n\n${md}` : md;

  // 最终 fallback：可见文本
  const bodyText = await page.evaluate(() => {
    const el =
      document.querySelector("#root") ||
      document.querySelector("#app") ||
      document.body;
    return el ? (el as HTMLElement).innerText : "";
  });

  // 关键：fallback 前先判断 fallback 出来的是不是登录页
  if (looksLikeLoginPage(bodyText)) {
    throw new Error(SESSION_EXPIRED_MSG);
  }

  if (bodyText.trim().length > 100) {
    return questionTitle
      ? `# ${questionTitle.trim()}\n\n${bodyText.trim()}`
      : bodyText.trim();
  }

  const pageTitle = await page.title();
  const bodyLen = await page.evaluate(() => document.body.innerHTML.length);
  throw new Error(
    `提取失败：标题=${pageTitle}, URL=${url}, body=${bodyLen}字节。${SESSION_EXPIRED_MSG}`
  );
}

function parseCount(text: string): number {
  const s = text.trim().replace(/,/g, "");
  if (s.includes("万")) return Math.round(parseFloat(s) * 10000);
  const n = parseInt(s, 10);
  return isNaN(n) ? 0 : n;
}

export async function getFollowees(
  page: Page,
  userToken: string,
  maxCount: number
): Promise<ZhihuUser[]> {
  // 走 v4 接口：比 DOM 抓取稳，且能拿到准确的 totals。
  // 注意：该接口默认不返回回答数/关注者数，故这几个字段为 null；
  // 需要精确统计时用 zhihu_profile 单独查该账号。
  const r = await getConnections(page, userToken, "followees", maxCount);
  return r.members.map((m) => ({
    name: m.name,
    url_token: m.url_token,
    bio: m.headline,
    answer_count: m.answer_count,
    article_count: m.articles_count,
    follower_count: m.follower_count,
  }));
}

export async function getUserPosts(
  page: Page,
  userToken: string,
  count: number
): Promise<ZhihuPost[]> {
  // 走 v4 接口，修掉旧实现的两处问题：
  //  1) 专栏链接被拼成 https://www.zhihu.com//zhuanlan.zhihu.com/p/<id>
  //  2) VoteButton 文本解析失败导致 vote_count 恒为 0
  const allPosts: ZhihuPost[] = [];
  const seen = new Set<string>();

  const push = (title: string, summary: string, url: string, vote: number | null) => {
    if (!title || seen.has(url)) return;
    seen.add(url);
    allPosts.push({ title, summary: summary.slice(0, 200), url, vote_count: vote });
  };

  const answers = await getMemberActivity(page, userToken, "answers", count, 1000, false);
  for (const it of answers.items) push(it.title, it.summary, it.url, it.voteup_count);

  if (allPosts.length < count) {
    const articles = await getMemberActivity(
      page,
      userToken,
      "articles",
      count - allPosts.length,
      1000,
      false
    );
    for (const it of articles.items) push(it.title, it.summary, it.url, it.voteup_count);
  }

  return allPosts.slice(0, count);
}

// ========== 问题下的全部回答（内部 v4 接口，需登录态） ==========

export interface ZhihuQuestionAnswer {
  id: string;
  author: string;
  author_url: string;
  url: string;
  voteup_count: number;
  comment_count: number;
  created_time: number | null;
  updated_time: number | null;
  content_md: string;
  content_length: number;
  content_truncated: boolean;
}

export interface ZhihuQuestionAnswersResult {
  question: { id: string; title: string; url: string; answer_count: number | null };
  answers: ZhihuQuestionAnswer[];
  fetched: number;
  is_end: boolean;
  totals: number | null;
  warnings: string[];
}

// 注意：知乎 v4 的 include 只接受"首个字段带 data[*]. 前缀、其后字段用裸名"的写法。
// 全字段都写成 data[*].xxx 会被服务端拒绝（403），裸名形式才同时返回正文与计数。
const ANSWERS_INCLUDE =
  "data[*].content,excerpt,voteup_count,comment_count,created_time,updated_time,author.name,author.url_token,question.title";

export function parseQuestionId(input: string): string | null {
  const s = input.trim();
  const m = s.match(/question\/(\d+)/) || s.match(/^(\d{5,})$/);
  return m ? m[1] : null;
}

interface RawPaging {
  is_end?: boolean;
  totals?: number;
  next?: string;
}

interface RawAnswer {
  id?: number | string;
  content?: string;
  excerpt?: string;
  voteup_count?: number;
  comment_count?: number;
  created_time?: number;
  updated_time?: number;
  author?: { name?: string; url_token?: string };
}

interface RawAnswersPage {
  data?: RawAnswer[];
  paging?: RawPaging;
  error?: { message?: string; code?: number; need_login?: boolean };
}

/**
 * 拉取一个问题下的全部回答正文。
 * 走 page 内的 fetch，因此天然带上浏览器指纹与 cookies/<site>.json 里的登录态。
 * 官方开放平台只给 Summary，这里给的是 content（正文 HTML → Markdown）。
 */
export async function getQuestionAnswers(
  page: Page,
  questionUrl: string,
  maxCount: number,
  delayMs = 1200
): Promise<ZhihuQuestionAnswersResult> {
  const qid = parseQuestionId(questionUrl);
  if (!qid) {
    throw new Error(
      `无法从输入解析问题 ID：${questionUrl}（需要 https://www.zhihu.com/question/<id> 或纯数字 id）`
    );
  }

  const pageUrl = `https://www.zhihu.com/question/${qid}`;
  await page.goto(pageUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(2500);
  await closeModal(page);

  if (isLoginRedirect(page.url())) throw new Error(SESSION_EXPIRED_MSG);

  const meta = await page.evaluate(() => {
    const raw = document.getElementById("js-initialData")?.textContent || null;
    if (!raw) return { title: document.title, answerCount: null as number | null };
    try {
      const p = JSON.parse(raw);
      const qs = p?.initialState?.entities?.questions || {};
      const first = Object.values(qs)[0] as { title?: string; answerCount?: number } | undefined;
      return { title: first?.title || document.title, answerCount: first?.answerCount ?? null };
    } catch {
      return { title: document.title, answerCount: null as number | null };
    }
  });

  const limit = 20;
  const cap = Math.max(1, Math.min(Math.floor(maxCount) || 20, 500));
  const answers: ZhihuQuestionAnswer[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();
  let offset = 0;
  let isEnd = false;
  let totals: number | null = null;

  if (/安全验证|异常/.test(meta.title) || page.url().includes("/account/unhuman")) {
    warnings.push(
      "问题页被知乎安全验证拦截（/account/unhuman），标题与页面内容不可信；请更换 cookie 或改用可见浏览器（ASM_HEADLESS=0）"
    );
  }

  while (answers.length < cap && !isEnd) {
    const res = await page.evaluate(
      async (args: { qid: string; include: string; limit: number; offset: number }) => {
        const url = `/api/v4/questions/${args.qid}/answers?include=${encodeURIComponent(
          args.include
        )}&limit=${args.limit}&offset=${args.offset}`;
        try {
          const r = await fetch(url, {
            headers: {
              accept: "application/json, text/plain, */*",
              "x-requested-with": "fetch",
            },
            credentials: "include",
          });
          const text = await r.text();
          let json: unknown = null;
          try {
            json = JSON.parse(text);
          } catch {
            json = null;
          }
          return { status: r.status, json, head: text.slice(0, 200) };
        } catch (e) {
          return { status: 0, json: null, head: String(e).slice(0, 200) };
        }
      },
      { qid, include: ANSWERS_INCLUDE, limit, offset }
    );

    const json = res.json as RawAnswersPage | null;
    if (!json) {
      warnings.push(`offset=${offset} 请求失败：HTTP ${res.status} ${res.head}`);
      break;
    }
    if (json.error) {
      const e = json.error;
      warnings.push(
        `offset=${offset} 接口报错 code=${e.code ?? "?"}${e.need_login ? "（need_login）" : ""}：${e.message ?? ""}`
      );
      if (e.need_login) warnings.push(SESSION_EXPIRED_MSG);
      break;
    }

    const data = json.data || [];
    const pageIsEnd = json.paging?.is_end ?? true;
    if (typeof json.paging?.totals === "number") totals = json.paging.totals;

    if (!data.length && !pageIsEnd) {
      warnings.push(`offset=${offset} 返回 0 条但 paging.is_end 为 false，停止以避免死循环`);
      break;
    }

    for (const a of data) {
      const id = a.id != null ? String(a.id) : "";
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const html = a.content || "";
      const md = html ? htmlToMarkdown(html) : (a.excerpt || "").trim();
      answers.push({
        id,
        author: a.author?.name || "",
        author_url: a.author?.url_token
          ? `https://www.zhihu.com/people/${a.author.url_token}`
          : "",
        url: `https://www.zhihu.com/question/${qid}/answer/${id}`,
        voteup_count: a.voteup_count ?? 0,
        comment_count: a.comment_count ?? 0,
        created_time: a.created_time ?? null,
        updated_time: a.updated_time ?? null,
        content_md: md,
        content_length: md.length,
        content_truncated: !html && !!a.excerpt,
      });
      if (answers.length >= cap) break;
    }

    isEnd = pageIsEnd;
    offset += limit;
    if (!isEnd && answers.length < cap) await page.waitForTimeout(Math.max(0, delayMs));
  }

  if (!isEnd && answers.length >= cap) {
    warnings.push(`已达到 max_count=${cap} 上限，未取完（totals=${totals ?? "未知"}）`);
  }

  return {
    question: { id: qid, title: meta.title, url: pageUrl, answer_count: meta.answerCount },
    answers,
    fetched: answers.length,
    is_end: isEnd,
    totals,
    warnings,
  };
}

export function formatQuestionAnswersMarkdown(r: ZhihuQuestionAnswersResult): string {
  const lines: string[] = [];
  lines.push(`# ${r.question.title}`);
  lines.push("");
  lines.push(`> 来源：${r.question.url}`);
  lines.push(
    `> 取到 ${r.fetched} 篇回答${r.totals != null ? `（问题下共 ${r.totals} 篇）` : ""}${
      r.is_end ? "，已到末尾" : "，未到末尾"
    }`
  );
  if (r.warnings.length) {
    lines.push("");
    for (const w of r.warnings) lines.push(`> ⚠️ ${w}`);
  }
  lines.push("");
  for (const [i, a] of r.answers.entries()) {
    lines.push("---");
    lines.push("");
    lines.push(`## ${i + 1}. ${a.author || "匿名用户"}`);
    lines.push("");
    lines.push(`- 链接：${a.url}`);
    lines.push(
      `- 赞同 ${a.voteup_count} · 评论 ${a.comment_count}${
        a.created_time ? ` · 发布于 ${new Date(a.created_time * 1000).toISOString().slice(0, 10)}` : ""
      }`
    );
    lines.push("");
    lines.push(a.content_md || "_（未返回正文，可能为付费内容或已被删除）_");
    lines.push("");
  }
  return lines.join("\n").trim();
}
