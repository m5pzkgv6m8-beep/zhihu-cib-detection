import { Page } from "playwright";
import { htmlToMarkdown } from "../extractor.js";

export const SESSION_EXPIRED_MSG =
  "知乎会话已失效或未登录。请通过 manage_cookies action=set site=zhihu 重新导入浏览器 cookie（含 z_c0 / __zse_ck）。";

const API_HEADERS: Record<string, string> = {
  accept: "application/json, text/plain, */*",
  "x-requested-with": "fetch",
};

const PAGE_SIZE = 20;
const sleep = (page: Page, ms: number) => page.waitForTimeout(Math.max(0, ms));

export interface ApiResponse<T> {
  status: number;
  json: T | null;
  raw: string;
}

/**
 * 在页面上下文里发请求：天然带上浏览器指纹、Referer 与 cookies/zhihu.json 的登录态。
 * 知乎 v4 接口对 Node 直连有风控，必须走页面内 fetch。
 */
export async function apiGet<T = unknown>(
  page: Page,
  path: string
): Promise<ApiResponse<T>> {
  const r = await page.evaluate(
    async (args: { path: string; headers: Record<string, string> }) => {
      try {
        const res = await fetch(args.path, {
          headers: args.headers,
          credentials: "include",
        });
        const text = await res.text();
        let json: unknown = null;
        try {
          json = JSON.parse(text);
        } catch {
          json = null;
        }
        return { status: res.status, json, raw: text.slice(0, 300) };
      } catch (e) {
        return { status: 0, json: null, raw: String(e).slice(0, 300) };
      }
    },
    { path, headers: API_HEADERS }
  );
  return { status: r.status, json: (r.json as T | null) ?? null, raw: r.raw };
}

/** 页面不在 zhihu.com 域下时，相对路径的 fetch 会跨域失败，先落到首页。 */
export async function ensureZhihuOrigin(page: Page): Promise<void> {
  if (!/zhihu\.com/.test(page.url())) {
    await page.goto("https://www.zhihu.com/", {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
    await page.waitForTimeout(1200);
  }
}

/** /api/v4/me 是判定登录态最干净的方式：登录返回 member，未登录返回 401。 */
export async function checkLogin(
  page: Page
): Promise<{ loggedIn: boolean; name: string | null; urlToken: string | null }> {
  // 关键：必须先落到 zhihu.com 域，否则相对路径 fetch 在 about:blank 上直接失败
  await ensureZhihuOrigin(page);
  const r = await apiGet<{ id?: string; name?: string; url_token?: string }>(
    page,
    "/api/v4/me"
  );
  if (r.status === 200 && r.json && r.json.id) {
    return {
      loggedIn: true,
      name: r.json.name ?? null,
      urlToken: r.json.url_token ?? null,
    };
  }
  return { loggedIn: false, name: null, urlToken: null };
}

export function stripEm(s: unknown): string {
  return String(s ?? "").replace(/<\/?em>/g, "").trim();
}

function pickBadges(raw: any): string[] {
  const out: string[] = [];
  const v2 = raw?.badge_v2;
  if (v2) {
    for (const b of v2.merged_badges || []) {
      const t = b?.description || b?.title;
      if (t && !out.includes(t)) out.push(t);
    }
    if (!out.length && v2.title) out.push(String(v2.title));
  }
  if (!out.length && Array.isArray(raw?.badge)) {
    for (const b of raw.badge) {
      const t = b?.description || b?.title;
      if (t && !out.includes(t)) out.push(t);
    }
  }
  return out;
}

// ========== 账号 ==========

export interface ZhihuMember {
  id: string;
  url_token: string;
  name: string;
  headline: string;
  description: string;
  gender: number | null;
  ip_info: string | null;
  is_org: boolean;
  is_realname: boolean | null;
  avatar_url: string;
  answer_count: number | null;
  articles_count: number | null;
  follower_count: number | null;
  following_count: number | null;
  voteup_count: number | null;
  thanked_count: number | null;
  favorited_count: number | null;
  badges: string[];
  url: string;
}

export function toMember(raw: any): ZhihuMember {
  return {
    id: String(raw?.id ?? ""),
    url_token: raw?.url_token ?? "",
    name: stripEm(raw?.name),
    headline: stripEm(raw?.headline ?? raw?.headline_render),
    description: raw?.description ?? "",
    gender: raw?.gender ?? null,
    ip_info: raw?.ip_info ?? null,
    is_org: Boolean(raw?.is_org) || raw?.type === "org",
    is_realname: raw?.is_realname ?? null,
    avatar_url: raw?.avatar_url ?? "",
    answer_count: raw?.answer_count ?? null,
    articles_count: raw?.articles_count ?? null,
    follower_count: raw?.follower_count ?? null,
    following_count: raw?.following_count ?? null,
    voteup_count: raw?.voteup_count ?? null,
    thanked_count: raw?.thanked_count ?? null,
    favorited_count: raw?.favorited_count ?? null,
    badges: pickBadges(raw),
    url: raw?.url_token ? "https://www.zhihu.com/people/" + raw.url_token : "",
  };
}

const MEMBER_INCLUDE =
  "answer_count,articles_count,follower_count,following_count,voteup_count," +
  "thanked_count,favorited_count,description,badge[*].detail,gender,ip_info,is_realname,is_org";

/**
 * 把各种写法的账号输入统一成 API 可用的标识。
 * 支持：主页 URL、/people/<x>、@名字、纯 token、32 位内部 hash。
 */
export function parseMemberInput(input: string): string {
  const s = String(input ?? "").trim();
  const m =
    s.match(/zhihu\.com\/people\/([^/?#\s]+)/) ||
    s.match(/zhihu\.com\/api\/v4\/people\/([^/?#\s]+)/);
  if (m) return decodeURIComponent(m[1]);
  return s.replace(/^@/, "").trim();
}

export interface MemberLookup {
  member: ZhihuMember | null;
  resolvedFrom: "direct" | "name_search" | null;
  candidates: ZhihuMember[];
  error: string | null;
}

export async function fetchMember(
  page: Page,
  ident: string
): Promise<ZhihuMember | null> {
  const r = await apiGet<any>(
    page,
    "/api/v4/members/" +
      encodeURIComponent(ident) +
      "?include=" +
      encodeURIComponent(MEMBER_INCLUDE)
  );
  if (r.status === 200 && r.json && !r.json.error && r.json.id) {
    return toMember(r.json);
  }
  return null;
}

/**
 * 按标识查账号；标识是中文名等非 token 写法时，回退到 people 搜索取首个精确命中。
 * 注意：知乎有两套 ID —— 正文 @ 链接里是 32 位内部 hash，API/关注列表里是自定义 url_token。
 * 两者都能直接喂给 /api/v4/members/<x>，返回对象同时含 id 与 url_token，可用来做映射。
 */
export async function lookupMember(page: Page, input: string): Promise<MemberLookup> {
  await ensureZhihuOrigin(page);
  const ident = parseMemberInput(input);
  if (!ident) {
    return { member: null, resolvedFrom: null, candidates: [], error: "账号标识为空" };
  }

  const direct = await fetchMember(page, ident);
  if (direct) {
    return { member: direct, resolvedFrom: "direct", candidates: [direct], error: null };
  }

  if (/[^\x00-\x7F]/.test(ident)) {
    const found = await searchZhihu(page, ident, 5, "people", 0);
    const candidates: ZhihuMember[] = [];
    for (const it of found.items) {
      if (it.type !== "people" || !it.url_token) continue;
      const m = await fetchMember(page, it.url_token);
      if (m) candidates.push(m);
    }
    const exact = candidates.find((c) => c.name === ident) || candidates[0] || null;
    if (exact) {
      return { member: exact, resolvedFrom: "name_search", candidates, error: null };
    }
    return {
      member: null,
      resolvedFrom: null,
      candidates,
      error:
        "未找到账号「" + ident + "」，people 搜索命中 " + candidates.length + " 个候选",
    };
  }

  return {
    member: null,
    resolvedFrom: null,
    candidates: [],
    error:
      "无法解析账号标识「" + ident + "」（需要主页 URL、url_token 或 32 位 hash）",
  };
}

// ========== 关注 / 粉丝 ==========

export interface ZhihuConnectionResult {
  members: ZhihuMember[];
  fetched: number;
  totals: number | null;
  is_end: boolean;
  warnings: string[];
}

export async function getConnections(
  page: Page,
  userToken: string,
  kind: "followees" | "followers",
  maxCount: number,
  delayMs = 1200
): Promise<ZhihuConnectionResult> {
  await ensureZhihuOrigin(page);
  const token = parseMemberInput(userToken);
  const cap = Math.max(1, Math.min(Math.floor(maxCount) || 20, 2000));
  const members: ZhihuMember[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();
  let offset = 0;
  let isEnd = false;
  let totals: number | null = null;

  while (members.length < cap && !isEnd) {
    const r = await apiGet<{ data?: any[]; paging?: any; error?: any }>(
      page,
      "/api/v4/members/" +
        encodeURIComponent(token) +
        "/" +
        kind +
        "?limit=" +
        PAGE_SIZE +
        "&offset=" +
        offset
    );

    if (r.status !== 200 || !r.json) {
      warnings.push(
        "offset=" + offset + " 请求失败：HTTP " + r.status + " " + r.raw.slice(0, 150)
      );
      break;
    }
    if (r.json.error) {
      const e: any = r.json.error;
      warnings.push(
        "offset=" +
          offset +
          " 接口报错 code=" +
          (e.code ?? "?") +
          (e.need_login ? "（need_login）" : "") +
          "：" +
          (e.message ?? "")
      );
      if (e.need_login) warnings.push(SESSION_EXPIRED_MSG);
      break;
    }

    const data = r.json.data || [];
    if (typeof r.json.paging?.totals === "number") totals = r.json.paging.totals;
    const pageIsEnd = r.json.paging?.is_end ?? true;

    if (!data.length && !pageIsEnd) {
      warnings.push(
        "offset=" + offset + " 返回 0 条但 paging.is_end 为 false，停止以避免死循环"
      );
      break;
    }

    for (const rawItem of data) {
      const m = toMember(rawItem);
      if (!m.url_token || seen.has(m.url_token)) continue;
      seen.add(m.url_token);
      members.push(m);
      if (members.length >= cap) break;
    }

    isEnd = pageIsEnd;
    offset += PAGE_SIZE;
    if (!isEnd && members.length < cap) await sleep(page, delayMs);
  }

  if (!isEnd && members.length >= cap) {
    warnings.push(
      "已达到 max_count=" + cap + " 上限，未取完（totals=" + (totals ?? "未知") + "）"
    );
  }

  return { members, fetched: members.length, totals, is_end: isEnd, warnings };
}

// ========== 用户动态（回答 / 文章） ==========

export interface ZhihuActivityItem {
  kind: "answer" | "article";
  id: string;
  title: string;
  summary: string;
  url: string;
  voteup_count: number | null;
  comment_count: number | null;
  created_time: number | null;
  updated_time: number | null;
  content_md: string | null;
  content_length: number;
  question_id: string | null;
}

export interface ZhihuActivityResult {
  items: ZhihuActivityItem[];
  fetched: number;
  totals: number | null;
  is_end: boolean;
  warnings: string[];
}

const ACTIVITY_INCLUDE_ANSWERS =
  "data[*].content,excerpt,voteup_count,comment_count,created_time,updated_time,question.title,question.id";
const ACTIVITY_INCLUDE_ARTICLES =
  "data[*].content,excerpt,voteup_count,comment_count,created_time,updated_time,title";

export async function getMemberActivity(
  page: Page,
  userToken: string,
  kind: "answers" | "articles",
  maxCount: number,
  delayMs = 1200,
  withContent = false,
  toMarkdown: (html: string) => string = htmlToMarkdown,
  withStats = false
): Promise<ZhihuActivityResult> {
  await ensureZhihuOrigin(page);
  const token = parseMemberInput(userToken);
  const cap = Math.max(1, Math.min(Math.floor(maxCount) || 10, 1000));
  const include =
    kind === "answers" ? ACTIVITY_INCLUDE_ANSWERS : ACTIVITY_INCLUDE_ARTICLES;
  const items: ZhihuActivityItem[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();
  let offset = 0;
  let isEnd = false;
  let totals: number | null = null;

  while (items.length < cap && !isEnd) {
    const r = await apiGet<{ data?: any[]; paging?: any; error?: any }>(
      page,
      "/api/v4/members/" +
        encodeURIComponent(token) +
        "/" +
        kind +
        "?include=" +
        encodeURIComponent(include) +
        "&limit=" +
        PAGE_SIZE +
        "&offset=" +
        offset
    );

    if (r.status !== 200 || !r.json) {
      warnings.push(
        "offset=" + offset + " 请求失败：HTTP " + r.status + " " + r.raw.slice(0, 150)
      );
      break;
    }
    if (r.json.error) {
      const e: any = r.json.error;
      warnings.push(
        "offset=" +
          offset +
          " 接口报错 code=" +
          (e.code ?? "?") +
          (e.need_login ? "（need_login）" : "") +
          "：" +
          (e.message ?? "")
      );
      if (e.need_login) warnings.push(SESSION_EXPIRED_MSG);
      break;
    }

    const data = r.json.data || [];
    if (typeof r.json.paging?.totals === "number") totals = r.json.paging.totals;
    const pageIsEnd = r.json.paging?.is_end ?? true;

    if (!data.length && !pageIsEnd) {
      warnings.push(
        "offset=" + offset + " 返回 0 条但 paging.is_end 为 false，停止以避免死循环"
      );
      break;
    }

    for (const rawItem of data) {
      const id = rawItem?.id != null ? String(rawItem.id) : "";
      if (!id || seen.has(id)) continue;
      seen.add(id);

      const html = rawItem?.content || "";
      const md = withContent && html ? toMarkdown(html) : null;
      const title =
        kind === "answers"
          ? stripEm(rawItem?.question?.title ?? "")
          : stripEm(rawItem?.title ?? "");
      const summary = String(rawItem?.excerpt ?? "").trim();

      items.push({
        kind: kind === "answers" ? "answer" : "article",
        id,
        title,
        summary,
        url:
          kind === "answers"
            ? "https://www.zhihu.com/answer/" + id
            : "https://zhuanlan.zhihu.com/p/" + id,
        voteup_count: rawItem?.voteup_count ?? null,
        comment_count: rawItem?.comment_count ?? null,
        created_time: rawItem?.created_time ?? null,
        updated_time: rawItem?.updated_time ?? null,
        content_md: md,
        content_length: md ? md.length : summary.length,
        question_id:
          rawItem?.question?.id != null ? String(rawItem.question.id) : null,
      });
      if (items.length >= cap) break;
    }

    isEnd = pageIsEnd;
    offset += PAGE_SIZE;
    if (!isEnd && items.length < cap) await sleep(page, delayMs);
  }

  if (!isEnd && items.length >= cap) {
    warnings.push(
      "已达到 max_count=" + cap + " 上限，未取完（totals=" + (totals ?? "未知") + "）"
    );
  }

  // /api/v4/members/<t>/answers 不返回 voteup_count（只有 reaction.statistics，
  // 而 reaction.statistics.like_count 并非赞同数，实测 365 赞的回答显示 8）。
  // 需要准确赞数时，逐条打开回答页读 js-initialData.entities.answers[id].voteupCount。
  if (withStats && kind === "answers" && items.length) {
    const stats = await enrichAnswerStats(
      page,
      items.map((it) => it.id),
      delayMs
    );
    for (const it of items) {
      const s = stats.get(it.id);
      if (s) {
        it.voteup_count = s.voteup;
        if (s.comment != null) it.comment_count = s.comment;
      }
    }
    if (stats.size < items.length) {
      warnings.push(
        "有 " +
          (items.length - stats.size) +
          " 条回答未能取到赞数（页面未返回 js-initialData）"
      );
    }
  }

  return { items, fetched: items.length, totals, is_end: isEnd, warnings };
}

/** 逐条打开回答页，从 SSR 注入的 js-initialData 取准确的赞同/评论数。 */
export async function enrichAnswerStats(
  page: Page,
  ids: string[],
  delayMs = 800
): Promise<Map<string, { voteup: number | null; comment: number | null }>> {
  const out = new Map<string, { voteup: number | null; comment: number | null }>();
  for (const id of ids) {
    try {
      await page.goto("https://www.zhihu.com/answer/" + id, {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      });
      await page.waitForTimeout(1200);
      const r = await page.evaluate((aid: string) => {
        const raw = document.getElementById("js-initialData")?.textContent || null;
        if (!raw) return null;
        try {
          const j = JSON.parse(raw);
          const a = j?.initialState?.entities?.answers?.[aid];
          if (!a) return null;
          return {
            voteup: a.voteupCount ?? null,
            comment: a.commentCount ?? null,
          };
        } catch {
          return null;
        }
      }, id);
      if (r) out.set(id, r);
    } catch {
      // 单条失败不影响其余
    }
    await sleep(page, delayMs);
  }
  return out;
}

// ========== 评论 ==========

export interface ZhihuComment {
  id: string;
  content: string;
  created_time: number | null;
  vote_count: number;
  author: string;
  author_url_token: string;
  author_id: string;
  author_headline: string;
  author_badges: string[];
  /** 该评论是否由当前登录账号（cookies 所属账号）所发 */
  is_self: boolean;
  /** 该评论是否由被评论内容的作者所发 */
  is_post_author: boolean;
  reply_to: string;
  child_count: number;
  ip: string;
}

export interface CommentTarget {
  kind: "answer" | "article";
  id: string;
  url: string;
}

export function parseCommentTarget(input: string): CommentTarget | null {
  const s = String(input ?? "").trim();
  const a = s.match(/answer\/(\d+)/);
  if (a) {
    return { kind: "answer", id: a[1], url: "https://www.zhihu.com/answer/" + a[1] };
  }
  const p = s.match(/(?:zhuanlan\.zhihu\.com\/p\/|\/p\/)(\d+)/);
  if (p) {
    return { kind: "article", id: p[1], url: "https://zhuanlan.zhihu.com/p/" + p[1] };
  }
  if (/^\d{6,}$/.test(s)) {
    return { kind: "answer", id: s, url: "https://www.zhihu.com/answer/" + s };
  }
  return null;
}

export interface ZhihuCommentsResult {
  target: {
    kind: "answer" | "article";
    id: string;
    url: string;
    title: string | null;
    author: string | null;
    author_url_token: string | null;
    voteup_count: number | null;
    comment_count: number | null;
  };
  comments: ZhihuComment[];
  fetched: number;
  totals: number | null;
  is_end: boolean;
  warnings: string[];
}

export async function getComments(
  page: Page,
  target: CommentTarget,
  maxCount: number,
  order: "normal" | "reverse" = "normal",
  delayMs = 1200
): Promise<ZhihuCommentsResult> {
  await ensureZhihuOrigin(page);
  const cap = Math.max(1, Math.min(Math.floor(maxCount) || 20, 2000));
  const comments: ZhihuComment[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();
  let offset = 0;
  let isEnd = false;
  let totals: number | null = null;

  let title: string | null = null;
  let author: string | null = null;
  let authorToken: string | null = null;
  let voteup: number | null = null;
  let commentCount: number | null = null;

  if (target.kind === "answer") {
    const meta = await apiGet<any>(
      page,
      "/api/v4/answers/" +
        target.id +
        "?include=" +
        encodeURIComponent(
          "question.title,author.name,author.url_token,voteup_count,comment_count"
        )
    );
    if (meta.status === 200 && meta.json && !meta.json.error) {
      title = stripEm(meta.json.question?.title) || null;
      author = stripEm(meta.json.author?.name) || null;
      authorToken = meta.json.author?.url_token ?? null;
      voteup = meta.json.voteup_count ?? null;
      commentCount = meta.json.comment_count ?? null;
    } else if (meta.json?.error?.need_login) {
      warnings.push(SESSION_EXPIRED_MSG);
    }
  } else {
    const meta = await apiGet<any>(
      page,
      "/api/v4/articles/" +
        target.id +
        "?include=" +
        encodeURIComponent(
          "title,author.name,author.url_token,voteup_count,comment_count"
        )
    );
    if (meta.status === 200 && meta.json && !meta.json.error) {
      title = stripEm(meta.json.title) || null;
      author = stripEm(meta.json.author?.name) || null;
      authorToken = meta.json.author?.url_token ?? null;
      voteup = meta.json.voteup_count ?? null;
      commentCount = meta.json.comment_count ?? null;
    } else if (meta.json?.error?.need_login) {
      warnings.push(SESSION_EXPIRED_MSG);
    }
  }

  const resource = target.kind === "answer" ? "answers" : "articles";

  while (comments.length < cap && !isEnd) {
    const r = await apiGet<{ data?: any[]; paging?: any; error?: any }>(
      page,
      "/api/v4/" +
        resource +
        "/" +
        target.id +
        "/comments?limit=" +
        PAGE_SIZE +
        "&offset=" +
        offset +
        "&order=" +
        order
    );

    if (r.status !== 200 || !r.json) {
      warnings.push(
        "offset=" + offset + " 请求失败：HTTP " + r.status + " " + r.raw.slice(0, 150)
      );
      break;
    }
    if (r.json.error) {
      const e: any = r.json.error;
      warnings.push(
        "offset=" +
          offset +
          " 接口报错 code=" +
          (e.code ?? "?") +
          (e.need_login ? "（need_login）" : "") +
          "：" +
          (e.message ?? "")
      );
      if (e.need_login) warnings.push(SESSION_EXPIRED_MSG);
      break;
    }

    const data = r.json.data || [];
    if (typeof r.json.paging?.totals === "number") totals = r.json.paging.totals;
    const pageIsEnd = r.json.paging?.is_end ?? true;

    if (!data.length && !pageIsEnd) {
      warnings.push(
        "offset=" + offset + " 返回 0 条但 paging.is_end 为 false，停止以避免死循环"
      );
      break;
    }

    for (const rawItem of data) {
      const id = rawItem?.id != null ? String(rawItem.id) : "";
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const m = rawItem?.author?.member || {};
      comments.push({
        id,
        content: htmlToMarkdown(String(rawItem?.content ?? "")).trim(),
        created_time: rawItem?.created_time ?? null,
        vote_count: rawItem?.vote_count ?? 0,
        author: stripEm(m.name),
        author_url_token: m.url_token ?? "",
        author_id: m.id ?? "",
        author_headline: stripEm(m.headline),
        author_badges: pickBadges(m),
        is_self: Boolean(rawItem?.is_author),
        is_post_author: Boolean(
          authorToken && m.url_token && authorToken === m.url_token
        ),
        reply_to: stripEm(rawItem?.reply_to_author?.member?.name),
        child_count: rawItem?.child_comment_count ?? 0,
        ip: rawItem?.address_text ?? "",
      });
      if (comments.length >= cap) break;
    }

    isEnd = pageIsEnd;
    offset += PAGE_SIZE;
    if (!isEnd && comments.length < cap) await sleep(page, delayMs);
  }

  if (!isEnd && comments.length >= cap) {
    warnings.push(
      "已达到 max_count=" + cap + " 上限，未取完（totals=" + (totals ?? "未知") + "）"
    );
  }

  return {
    target: {
      kind: target.kind,
      id: target.id,
      url: target.url,
      title,
      author,
      author_url_token: authorToken,
      voteup_count: voteup,
      comment_count: commentCount,
    },
    comments,
    fetched: comments.length,
    totals,
    is_end: isEnd,
    warnings,
  };
}

// ========== 搜索 ==========

export interface ZhihuSearchItem {
  type: string;
  id: string;
  title: string;
  excerpt: string;
  url: string;
  url_token: string | null;
  author: string | null;
  author_url_token: string | null;
  voteup_count: number | null;
  comment_count: number | null;
  answer_count: number | null;
  follower_count: number | null;
  created_time: number | null;
  headline: string | null;
  badges: string[];
}

export interface ZhihuSearchResult {
  query: string;
  type: string;
  items: ZhihuSearchItem[];
  fetched: number;
  is_end: boolean;
  warnings: string[];
}

function buildSearchUrl(o: any): string {
  switch (o?.type) {
    case "answer":
      return "https://www.zhihu.com/answer/" + o.id;
    case "article":
      return "https://zhuanlan.zhihu.com/p/" + o.id;
    case "question":
      return "https://www.zhihu.com/question/" + o.id;
    case "people":
      return "https://www.zhihu.com/people/" + (o.url_token || o.id);
    default:
      return String(o?.url ?? "").replace("api.zhihu.com", "www.zhihu.com");
  }
}

export async function searchZhihu(
  page: Page,
  query: string,
  maxCount: number,
  type: "general" | "content" | "people" = "general",
  delayMs = 1200
): Promise<ZhihuSearchResult> {
  await ensureZhihuOrigin(page);
  const cap = Math.max(1, Math.min(Math.floor(maxCount) || 20, 500));
  const items: ZhihuSearchItem[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();
  let offset = 0;
  let isEnd = false;

  while (items.length < cap && !isEnd) {
    const r = await apiGet<{ data?: any[]; paging?: any; error?: any }>(
      page,
      "/api/v4/search_v3?t=" +
        type +
        "&q=" +
        encodeURIComponent(query) +
        "&correction=1&limit=" +
        PAGE_SIZE +
        "&offset=" +
        offset
    );

    if (r.status !== 200 || !r.json) {
      warnings.push(
        "offset=" + offset + " 请求失败：HTTP " + r.status + " " + r.raw.slice(0, 150)
      );
      break;
    }
    if (r.json.error) {
      const e: any = r.json.error;
      warnings.push(
        "offset=" +
          offset +
          " 接口报错 code=" +
          (e.code ?? "?") +
          (e.need_login ? "（need_login）" : "") +
          "：" +
          (e.message ?? "")
      );
      if (e.need_login) warnings.push(SESSION_EXPIRED_MSG);
      break;
    }

    const data = r.json.data || [];
    const pageIsEnd = r.json.paging?.is_end ?? true;

    let addedThisPage = 0;
    for (const it of data) {
      if (it?.type !== "search_result" || !it.object) continue;
      const o = it.object;
      const kind = String(o.type ?? "");
      const id = o.id != null ? String(o.id) : "";
      if (!id || seen.has(id + ":" + kind)) continue;
      seen.add(id + ":" + kind);

      items.push({
        type: kind,
        id,
        title: stripEm(o.title || o.question?.title || o.name || ""),
        excerpt: stripEm(o.excerpt || ""),
        url: buildSearchUrl(o),
        url_token: o.url_token ?? null,
        author: o.author?.name ? stripEm(o.author.name) : null,
        author_url_token: o.author?.url_token ?? null,
        voteup_count: o.voteup_count ?? null,
        comment_count: o.comment_count ?? null,
        answer_count: o.answer_count ?? null,
        follower_count: o.follower_count ?? null,
        created_time: o.created_time ?? null,
        headline: o.headline ? stripEm(o.headline) : null,
        badges: pickBadges(o),
      });
      addedThisPage++;
      if (items.length >= cap) break;
    }

    // 搜索接口在无结果时 is_end 不可靠，用「本页没有新条目」兜底
    isEnd = pageIsEnd || addedThisPage === 0;
    offset += PAGE_SIZE;
    if (!isEnd && items.length < cap) await sleep(page, delayMs);
  }

  if (!isEnd && items.length >= cap) {
    warnings.push("已达到 max_count=" + cap + " 上限，未取完");
  }

  return { query, type, items, fetched: items.length, is_end: isEnd, warnings };
}

// ========== Markdown 输出 ==========

const dateStr = (t: number | null | undefined) =>
  t ? new Date(t * 1000).toISOString().slice(0, 16).replace("T", " ") : "未知";

export function formatProfileMarkdown(m: ZhihuMember): string {
  const L: string[] = [];
  L.push("# " + m.name);
  L.push("");
  L.push("> " + m.url);
  if (m.headline) L.push("> " + m.headline);
  L.push("");
  L.push("| 字段 | 值 |");
  L.push("| --- | --- |");
  L.push("| url_token | " + m.url_token + " |");
  L.push("| 内部 id (hash) | " + m.id + " |");
  L.push("| 回答数 | " + (m.answer_count ?? "未知") + " |");
  L.push("| 文章数 | " + (m.articles_count ?? "未知") + " |");
  L.push("| 关注者 | " + (m.follower_count ?? "未知") + " |");
  L.push("| 关注了 | " + (m.following_count ?? "未知") + " |");
  L.push("| 获得赞同 | " + (m.voteup_count ?? "未知") + " |");
  L.push("| 认证/成就 | " + (m.badges.length ? m.badges.join("；") : "无") + " |");
  L.push(
    "| 实名 | " +
      (m.is_realname === null ? "未知" : m.is_realname ? "是" : "否") +
      " |"
  );
  L.push("| 机构号 | " + (m.is_org ? "是" : "否") + " |");
  L.push("| IP 属地 | " + (m.ip_info ?? "未知") + " |");
  if (m.description) {
    L.push("");
    L.push("**简介**：" + m.description);
  }
  return L.join("\n").trim();
}

export function formatCommentsMarkdown(r: ZhihuCommentsResult): string {
  const L: string[] = [];
  L.push("# 评论：" + (r.target.title || r.target.id));
  L.push("");
  L.push("> 来源：" + r.target.url);
  if (r.target.author) L.push("> 作者：" + r.target.author);
  L.push(
    "> 取到 " +
      r.fetched +
      " 条评论" +
      (r.totals != null ? "（共 " + r.totals + " 条）" : "") +
      (r.is_end ? "，已到末尾" : "，未到末尾")
  );
  if (r.warnings.length) {
    L.push("");
    for (const w of r.warnings) L.push("> ⚠️ " + w);
  }
  L.push("");
  for (const [i, c] of r.comments.entries()) {
    L.push("---");
    L.push("");
    L.push(
      "### " +
        (i + 1) +
        ". " +
        (c.author || "匿名用户") +
        (c.is_post_author ? "（**本文作者**）" : c.is_self ? "（当前登录账号）" : "")
    );
    L.push("");
    const bits = ["赞 " + c.vote_count, dateStr(c.created_time)];
    if (c.reply_to) bits.push("回复 @" + c.reply_to);
    if (c.ip) bits.push("IP " + c.ip);
    L.push("- " + bits.join(" · "));
    L.push(
      "- 主页：https://www.zhihu.com/people/" + (c.author_url_token || c.author_id)
    );
    if (c.author_headline) L.push("- 简介：" + c.author_headline);
    if (c.author_badges.length) L.push("- 认证：" + c.author_badges.join("；"));
    L.push("");
    L.push(c.content || "_（空）_");
    L.push("");
  }
  return L.join("\n").trim();
}

export function formatSearchMarkdown(r: ZhihuSearchResult): string {
  const L: string[] = [];
  L.push("# 搜索：" + r.query + "（" + r.type + "）");
  L.push("");
  L.push("> 取到 " + r.fetched + " 条" + (r.is_end ? "，已到末尾" : "，未到末尾"));
  if (r.warnings.length) {
    L.push("");
    for (const w of r.warnings) L.push("> ⚠️ " + w);
  }
  L.push("");
  for (const [i, it] of r.items.entries()) {
    L.push((i + 1) + ". **" + (it.title || it.headline || it.id) + "**（" + it.type + "）");
    L.push("   - " + it.url);
    const bits: string[] = [];
    if (it.author) bits.push("作者 " + it.author);
    if (it.voteup_count != null) bits.push("赞 " + it.voteup_count);
    if (it.comment_count != null) bits.push("评论 " + it.comment_count);
    if (it.answer_count != null) bits.push("回答数 " + it.answer_count);
    if (it.follower_count != null) bits.push("关注者 " + it.follower_count);
    if (it.created_time) bits.push(dateStr(it.created_time));
    if (bits.length) L.push("   - " + bits.join(" · "));
    if (it.excerpt) L.push("   - " + it.excerpt.slice(0, 160));
  }
  return L.join("\n").trim();
}

export function formatActivityMarkdown(r: ZhihuActivityResult): string {
  const L: string[] = [];
  L.push("# 用户动态");
  L.push("");
  L.push(
    "> 取到 " +
      r.fetched +
      " 条" +
      (r.totals != null ? "（共 " + r.totals + " 条）" : "") +
      (r.is_end ? "，已到末尾" : "，未到末尾")
  );
  if (r.warnings.length) {
    L.push("");
    for (const w of r.warnings) L.push("> ⚠️ " + w);
  }
  L.push("");
  for (const [i, it] of r.items.entries()) {
    L.push("---");
    L.push("");
    L.push("## " + (i + 1) + ". " + (it.title || "（无标题）"));
    L.push("");
    L.push("- 类型：" + (it.kind === "answer" ? "回答" : "文章"));
    L.push("- 链接：" + it.url);
    L.push(
      "- 赞 " +
        (it.voteup_count ?? "未知") +
        " · 评论 " +
        (it.comment_count ?? "未知") +
        " · 发布于 " +
        dateStr(it.created_time)
    );
    if (it.content_md) {
      L.push("");
      L.push(it.content_md);
    } else if (it.summary) {
      L.push("");
      L.push("> " + it.summary);
    }
    L.push("");
  }
  return L.join("\n").trim();
}
