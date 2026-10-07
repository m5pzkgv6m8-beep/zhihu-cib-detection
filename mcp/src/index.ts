#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  getContext,
  detectSite,
  saveCookies,
  clearCookies,
  resetContext,
  closeBrowser,
  syncCookiesToDisk,
  parseCookieInput,
} from "./browser.js";
import { htmlToMarkdown } from "./extractor.js";
import {
  extractZhihu,
  getFollowees,
  getUserPosts,
  getQuestionAnswers,
  formatQuestionAnswersMarkdown,
} from "./sites/zhihu.js";
import {
  checkLogin,
  formatActivityMarkdown,
  formatCommentsMarkdown,
  formatProfileMarkdown,
  formatSearchMarkdown,
  getComments,
  getConnections,
  getMemberActivity,
  lookupMember,
  parseCommentTarget,
  searchZhihu,
  SESSION_EXPIRED_MSG,
  ZhihuActivityItem,
} from "./sites/zhihu-api.js";
import { writeFile, mkdir } from "fs/promises";
import { dirname } from "path";
import { extractZsxq } from "./sites/zsxq.js";
import { extractXueqiu } from "./sites/xueqiu.js";

const server = new McpServer({
  name: "anti-scrape-mcp",
  version: "1.0.0",
});

// Tool 1: fetch_page
server.tool(
  "fetch_page",
  "Fetch and extract content from anti-scraping websites (zhihu, zsxq, xueqiu) using a real browser. Returns markdown.",
  {
    url: z.string().url().describe("The URL to fetch"),
    wait_for: z
      .string()
      .optional()
      .describe("Optional CSS selector to wait for before extracting"),
  },
  async ({ url, wait_for }) => {
    const site = detectSite(url);
    const siteName = site ?? "zhihu"; // default context
    const ctx = await getContext(siteName);
    const page = await ctx.newPage();

    try {
      // zsxq 用 API 直接获取数据，不需要页面渲染
      if (site === "zsxq") {
        const content = await extractZsxq(ctx, url);
        return {
          content: [{ type: "text" as const, text: content }],
        };
      }

      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });

      if (wait_for) {
        await page.waitForSelector(wait_for, { timeout: 15000 });
      }

      // 等待网络空闲
      await page.waitForLoadState("networkidle").catch(() => {});

      let content: string;
      if (site === "zhihu") {
        content = await extractZhihu(page);
      } else if (site === "xueqiu") {
        content = await extractXueqiu(page);
      } else {
        // 通用提取
        const bodyHtml = await page
          .locator("article, main, .content, #content, body")
          .first()
          .innerHTML();
        content = htmlToMarkdown(bodyHtml);
      }

      return {
        content: [{ type: "text" as const, text: content }],
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text" as const, text: `Error fetching page: ${msg}` }],
        isError: true,
      };
    } finally {
      await page.close();
      // 把可能被刷新的反爬动态 cookie 写回磁盘，下次启动也是最新的。
      await syncCookiesToDisk(siteName).catch(() => {});
    }
  }
);

// Tool 2: screenshot_page
server.tool(
  "screenshot_page",
  "Take a screenshot of a webpage using a real browser. Returns base64 PNG image.",
  {
    url: z.string().url().describe("The URL to screenshot"),
    full_page: z
      .boolean()
      .default(false)
      .describe("Whether to capture the full scrollable page"),
  },
  async ({ url, full_page }) => {
    const site = detectSite(url);
    const siteName = site ?? "zhihu";
    const ctx = await getContext(siteName);
    const page = await ctx.newPage();

    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
      await page.waitForLoadState("networkidle").catch(() => {});

      const buffer = await page.screenshot({ fullPage: full_page });
      const base64 = buffer.toString("base64");

      return {
        content: [
          {
            type: "image" as const,
            data: base64,
            mimeType: "image/png" as const,
          },
        ],
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text" as const, text: `Error taking screenshot: ${msg}` }],
        isError: true,
      };
    } finally {
      await page.close();
      await syncCookiesToDisk(siteName).catch(() => {});
    }
  }
);

// Tool 3: manage_cookies
server.tool(
  "manage_cookies",
  "Manage browser cookies for anti-scraping sites. Accepts either a Playwright JSON cookie array OR a raw `Cookie:` header string (e.g. 'a=b; c=d'). Hot-reloads — no restart needed.",
  {
    action: z.enum(["set", "get", "clear"]).describe("Action to perform"),
    site: z
      .enum(["zhihu", "zsxq", "xueqiu"])
      .describe("Target website"),
    cookies: z
      .string()
      .optional()
      .describe(
        'For "set": either a JSON cookie array or a raw "name=value; name=value" header string.'
      ),
  },
  async ({ action, site, cookies }) => {
    try {
      if (action === "set") {
        if (!cookies) {
          return {
            content: [
              {
                type: "text" as const,
                text: 'Error: "cookies" parameter is required for "set" action',
              },
            ],
            isError: true,
          };
        }
        const parsed = parseCookieInput(cookies, site);
        if (parsed.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: "Error: parsed 0 cookies from input — check format.",
              },
            ],
            isError: true,
          };
        }
        await saveCookies(site, parsed);
        await resetContext(site);
        return {
          content: [
            {
              type: "text" as const,
              text: `Successfully set ${parsed.length} cookies for ${site}. Names: ${parsed.map((c) => c.name).join(", ")}`,
            },
          ],
        };
      }

      if (action === "get") {
        const ctx = await getContext(site);
        const current = await ctx.cookies();
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(current, null, 2),
            },
          ],
        };
      }

      // clear
      await clearCookies(site);
      return {
        content: [
          { type: "text" as const, text: `Cookies cleared for ${site}` },
        ],
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text" as const, text: `Error managing cookies: ${msg}` }],
        isError: true,
      };
    }
  }
);

// Graceful shutdown
process.on("SIGINT", async () => {
  await closeBrowser();
  process.exit(0);
});

// Tool 4: zhihu_followees
server.tool(
  "zhihu_followees",
  "Get the list of users that a Zhihu user follows. Returns structured JSON with name, url_token, bio, and stats.",
  {
    user_url_token: z
      .string()
      .describe("The url_token of the Zhihu user (from their profile URL, e.g. 'coder_yupi')"),
    max_count: z
      .number()
      .default(60)
      .describe("Maximum number of followees to return (default 60)"),
  },
  async ({ user_url_token, max_count }) => {
    const ctx = await getContext("zhihu");
    const page = await ctx.newPage();
    try {
      const users = await getFollowees(page, user_url_token, max_count);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(users, null, 2),
          },
        ],
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text" as const, text: `Error: ${msg}` }],
        isError: true,
      };
    } finally {
      await page.close();
      await syncCookiesToDisk("zhihu").catch(() => {});
    }
  }
);

// Tool 5: zhihu_user_posts
server.tool(
  "zhihu_user_posts",
  "Get recent answers and articles from a Zhihu user. Returns structured JSON with title, summary, url, and vote_count.",
  {
    user_url_token: z
      .string()
      .describe("The url_token of the Zhihu user (from their profile URL)"),
    count: z
      .number()
      .default(10)
      .describe("Number of posts to return (default 10)"),
  },
  async ({ user_url_token, count }) => {
    const ctx = await getContext("zhihu");
    const page = await ctx.newPage();
    try {
      const posts = await getUserPosts(page, user_url_token, count);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(posts, null, 2),
          },
        ],
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text" as const, text: `Error: ${msg}` }],
        isError: true,
      };
    } finally {
      await page.close();
      await syncCookiesToDisk("zhihu").catch(() => {});
    }
  }
);
// Tool 6: zhihu_question_answers
server.tool(
  "zhihu_question_answers",
  "Fetch ALL answers under a Zhihu question with FULL body text (converted to Markdown). Paginates Zhihu's internal v4 API with the logged-in browser session. Prefer save_to_file when the question has many or long answers.",
  {
    question_url: z
      .string()
      .describe("Zhihu question URL (https://www.zhihu.com/question/<id>) or a bare numeric question id"),
    max_count: z
      .number()
      .default(20)
      .describe("Maximum number of answers to fetch (default 20, hard cap 500)"),
    delay_ms: z
      .number()
      .default(1200)
      .describe("Delay between pages in ms (default 1200). Lower values raise the risk of Zhihu rate limiting."),
    format: z
      .enum(["markdown", "json"])
      .default("markdown")
      .describe("Output format. markdown = one section per answer."),
    save_to_file: z
      .string()
      .optional()
      .describe("Absolute file path. When set, the full result is written there and only a summary is returned."),
  },
  async ({ question_url, max_count, delay_ms, format, save_to_file }) => {
    const ctx = await getContext("zhihu");
    const page = await ctx.newPage();
    try {
      const result = await getQuestionAnswers(page, question_url, max_count, delay_ms);
      const payload =
        format === "json"
          ? JSON.stringify(result, null, 2)
          : formatQuestionAnswersMarkdown(result);

      if (save_to_file) {
        await mkdir(dirname(save_to_file), { recursive: true });
        await writeFile(save_to_file, payload, "utf-8");
        const lines = [
          `已写入 ${save_to_file}`,
          `问题：${result.question.title}`,
          `取到 ${result.fetched} 篇，is_end=${result.is_end}，totals=${result.totals ?? "未知"}`,
          `字符数：${payload.length}`,
        ];
        if (result.warnings.length) lines.push("警告：", ...result.warnings.map((w) => `- ${w}`));
        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      }

      return { content: [{ type: "text" as const, text: payload }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text" as const, text: `Error fetching question answers: ${msg}` }],
        isError: true,
      };
    } finally {
      await page.close();
      await syncCookiesToDisk("zhihu").catch(() => {});
    }
  }
);


// ========== Tool 7: zhihu_session ==========
server.tool(
  "zhihu_session",
  "Check whether the stored Zhihu cookies still produce a logged-in session (calls /api/v4/me). Run this first when other Zhihu tools start returning 401 / need_login.",
  {},
  async () => {
    const ctx = await getContext("zhihu");
    const page = await ctx.newPage();
    try {
      const s = await checkLogin(page);
      return {
        content: [
          {
            type: "text" as const,
            text: s.loggedIn
              ? "知乎登录态有效，当前账号：" + (s.name ?? "（未返回昵称）")
              : "知乎未登录或会话已失效。" + SESSION_EXPIRED_MSG,
          },
        ],
        isError: !s.loggedIn,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [{ type: "text" as const, text: "Error: " + msg }], isError: true };
    } finally {
      await page.close();
      await syncCookiesToDisk("zhihu").catch(() => {});
    }
  }
);

// ========== Tool 8: zhihu_profile ==========
server.tool(
  "zhihu_profile",
  "Get a Zhihu account profile: follower/following counts, answer/article counts, total upvotes, verification badges, headline, real-name status and IP location. Accepts a profile URL, url_token, @name, or the 32-hex internal id used inside @-mention links (Zhihu keeps two id spaces; this resolves both).",
  {
    user: z
      .string()
      .describe("Profile URL, url_token (e.g. 'coder_yupi'), @name, or 32-hex internal id"),
    format: z.enum(["json", "markdown"]).default("json").describe("Output format"),
  },
  async ({ user, format }) => {
    const ctx = await getContext("zhihu");
    const page = await ctx.newPage();
    try {
      const r = await lookupMember(page, user);
      const m = r.member;
      if (!m) {
        return {
          content: [{ type: "text" as const, text: "未找到账号：" + (r.error ?? user) }],
          isError: true,
        };
      }
      const text =
        format === "markdown"
          ? formatProfileMarkdown(m)
          : JSON.stringify(
              {
                resolved_from: r.resolvedFrom,
                profile: m,
                other_candidates: r.candidates
                  .filter((c) => c.url_token !== m.url_token)
                  .map((c) => ({ name: c.name, url_token: c.url_token, id: c.id })),
              },
              null,
              2
            );
      return { content: [{ type: "text" as const, text }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [{ type: "text" as const, text: "Error: " + msg }], isError: true };
    } finally {
      await page.close();
      await syncCookiesToDisk("zhihu").catch(() => {});
    }
  }
);

// ========== Tool 9: zhihu_user_activity ==========
server.tool(
  "zhihu_user_activity",
  "List a Zhihu user's answers and/or articles via the internal v4 API, with real upvote/comment counts, timestamps, and optional full body text as Markdown. Use it to profile an account's activity radius - e.g. whether it ever posts about anything other than one specific person.",
  {
    user: z.string().describe("Profile URL, url_token, @name, or 32-hex internal id"),
    count: z.number().default(10).describe("Max items to return (default 10, hard cap 1000)"),
    kind: z
      .enum(["all", "answers", "articles"])
      .default("all")
      .describe("Which activity to fetch (default all = answers first, then articles)"),
    include_content: z
      .boolean()
      .default(false)
      .describe("Include full body text converted to Markdown (slower, much larger output)"),
    include_stats: z
      .boolean()
      .default(false)
      .describe("Resolve accurate upvote counts per answer by loading each answer page (the list API does not expose them; ~1-2s per item)"),
    format: z.enum(["json", "markdown"]).default("markdown").describe("Output format"),
    save_to_file: z
      .string()
      .optional()
      .describe("Absolute file path. When set, the full result is written there and only a summary is returned."),
  },
  async ({ user, count, kind, include_content, include_stats, format, save_to_file }) => {
    const ctx = await getContext("zhihu");
    const page = await ctx.newPage();
    try {
      const cap = Math.max(1, Math.min(Math.floor(count) || 10, 1000));
      let items: ZhihuActivityItem[] = [];
      const warnings: string[] = [];
      let totals: number | null = null;
      let isEnd = true;

      if (kind === "all" || kind === "answers") {
        const a = await getMemberActivity(
          page,
          user,
          "answers",
          cap,
          1200,
          include_content,
          htmlToMarkdown,
          include_stats
        );
        items = items.concat(a.items);
        warnings.push(...a.warnings);
        if (a.totals != null) totals = a.totals;
        isEnd = a.is_end;
      }
      if ((kind === "all" || kind === "articles") && items.length < cap) {
        const b = await getMemberActivity(
          page,
          user,
          "articles",
          cap - items.length,
          1200,
          include_content,
          htmlToMarkdown,
          include_stats
        );
        items = items.concat(b.items);
        warnings.push(...b.warnings);
        isEnd = isEnd && b.is_end;
      }

      const result = { items, fetched: items.length, totals, is_end: isEnd, warnings };
      const payload =
        format === "json" ? JSON.stringify(result, null, 2) : formatActivityMarkdown(result);

      if (save_to_file) {
        await mkdir(dirname(save_to_file), { recursive: true });
        await writeFile(save_to_file, payload, "utf-8");
        return {
          content: [
            {
              type: "text" as const,
              text:
                "已写入 " +
                save_to_file +
                "\n条目：" +
                items.length +
                "\n字符数：" +
                payload.length +
                (warnings.length ? "\n警告：\n- " + warnings.join("\n- ") : ""),
            },
          ],
        };
      }

      return { content: [{ type: "text" as const, text: payload }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [{ type: "text" as const, text: "Error: " + msg }], isError: true };
    } finally {
      await page.close();
      await syncCookiesToDisk("zhihu").catch(() => {});
    }
  }
);

// ========== Tool 10: zhihu_network ==========
server.tool(
  "zhihu_network",
  "List who a Zhihu user follows (kind=followees) or who follows them (kind=followers) via the v4 API. This is the raw material for alt-account cluster detection: one-way follows, mutual follow rings, and shared follow sets.",
  {
    user: z.string().describe("Profile URL, url_token, @name, or 32-hex internal id"),
    kind: z.enum(["followees", "followers"]).default("followees").describe("Edge direction"),
    max_count: z.number().default(50).describe("Max members to return (default 50, hard cap 2000)"),
    delay_ms: z.number().default(1200).describe("Delay between pages in ms"),
    format: z.enum(["json", "markdown"]).default("json").describe("Output format"),
  },
  async ({ user, kind, max_count, delay_ms, format }) => {
    const ctx = await getContext("zhihu");
    const page = await ctx.newPage();
    try {
      const r = await getConnections(page, user, kind, max_count, delay_ms);
      const payload = {
        user,
        kind,
        fetched: r.fetched,
        totals: r.totals,
        is_end: r.is_end,
        warnings: r.warnings,
        members: r.members,
      };
      let text: string;
      if (format === "json") {
        text = JSON.stringify(payload, null, 2);
      } else {
        const L: string[] = [];
        L.push("# " + user + " 的" + (kind === "followees" ? "关注列表" : "粉丝列表"));
        L.push("");
        L.push(
          "> 取到 " +
            r.fetched +
            " 个" +
            (r.totals != null ? "（共 " + r.totals + " 个）" : "") +
            (r.is_end ? "，已到末尾" : "，未到末尾")
        );
        for (const w of r.warnings) L.push("> ⚠️ " + w);
        L.push("");
        for (const [i, m] of r.members.entries()) {
          L.push(
            i +
              1 +
              ". " +
              m.name +
              " (" +
              m.url_token +
              ")" +
              (m.headline ? " - " + m.headline : "")
          );
        }
        text = L.join("\n");
      }
      return { content: [{ type: "text" as const, text }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [{ type: "text" as const, text: "Error: " + msg }], isError: true };
    } finally {
      await page.close();
      await syncCookiesToDisk("zhihu").catch(() => {});
    }
  }
);

// ========== Tool 11: zhihu_answer_comments ==========
server.tool(
  "zhihu_answer_comments",
  "Fetch comments under a Zhihu answer or article via the v4 API: commenter url_token, headline, badges, IP location, timestamp, upvotes, reply target, whether each comment was written by the post author or by the current session account. This is the main evidence source for cheerleading alt accounts (e.g. repeated '良心推荐 已关注' from low-weight accounts).",
  {
    target: z
      .string()
      .describe("Answer URL (https://www.zhihu.com/question/<qid>/answer/<aid>), /answer/<id>, article URL, or a bare numeric id"),
    max_count: z.number().default(50).describe("Max comments (default 50, hard cap 2000)"),
    order: z
      .enum(["normal", "reverse"])
      .default("normal")
      .describe("normal = oldest first, reverse = newest first (use reverse to catch a recent burst)"),
    delay_ms: z.number().default(1200).describe("Delay between pages in ms"),
    format: z.enum(["markdown", "json"]).default("markdown").describe("Output format"),
    save_to_file: z
      .string()
      .optional()
      .describe("Absolute file path. When set, the full result is written there and only a summary is returned."),
  },
  async ({ target, max_count, order, delay_ms, format, save_to_file }) => {
    const parsed = parseCommentTarget(target);
    if (!parsed) {
      return {
        content: [
          {
            type: "text" as const,
            text:
              "无法解析目标：" +
              target +
              "（需要 https://www.zhihu.com/question/<qid>/answer/<aid>、/answer/<id>、专栏 /p/<id> 或纯数字 id）",
          },
        ],
        isError: true,
      };
    }
    const ctx = await getContext("zhihu");
    const page = await ctx.newPage();
    try {
      const r = await getComments(page, parsed, max_count, order, delay_ms);
      const payload = format === "json" ? JSON.stringify(r, null, 2) : formatCommentsMarkdown(r);

      if (save_to_file) {
        await mkdir(dirname(save_to_file), { recursive: true });
        await writeFile(save_to_file, payload, "utf-8");
        const lines = [
          "已写入 " + save_to_file,
          "目标：" + r.target.url,
          "标题：" + (r.target.title ?? "未知"),
          "取到 " + r.fetched + " 条评论，is_end=" + r.is_end + "，totals=" + (r.totals ?? "未知"),
          "字符数：" + payload.length,
        ];
        if (r.warnings.length) lines.push("警告：", ...r.warnings.map((w) => "- " + w));
        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      }

      return { content: [{ type: "text" as const, text: payload }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [{ type: "text" as const, text: "Error fetching comments: " + msg }], isError: true };
    } finally {
      await page.close();
      await syncCookiesToDisk("zhihu").catch(() => {});
    }
  }
);

// ========== Tool 12: zhihu_search ==========
server.tool(
  "zhihu_search",
  "Search Zhihu via the internal search_v3 API (t=general/content/people). Use it to discover question ids to crawl, and to resolve a display name into an account.",
  {
    query: z.string().describe("Search keywords"),
    type: z
      .enum(["general", "content", "people"])
      .default("general")
      .describe("general = mixed, content = answers/articles, people = accounts"),
    max_count: z.number().default(20).describe("Max results (default 20, hard cap 500)"),
    delay_ms: z.number().default(1200).describe("Delay between pages in ms"),
    format: z.enum(["markdown", "json"]).default("markdown").describe("Output format"),
  },
  async ({ query, type, max_count, delay_ms, format }) => {
    const ctx = await getContext("zhihu");
    const page = await ctx.newPage();
    try {
      const r = await searchZhihu(page, query, max_count, type, delay_ms);
      const text = format === "json" ? JSON.stringify(r, null, 2) : formatSearchMarkdown(r);
      return { content: [{ type: "text" as const, text }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [{ type: "text" as const, text: "Error searching: " + msg }], isError: true };
    } finally {
      await page.close();
      await syncCookiesToDisk("zhihu").catch(() => {});
    }
  }
);

process.on("SIGTERM", async () => {
  await closeBrowser();
  process.exit(0);
});
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
