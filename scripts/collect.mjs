#!/usr/bin/env node
// 采集证据包 evidence.json —— CIB 检测的 Phase 0。
//
//   node scripts/collect.mjs --session
//   node scripts/collect.mjs "<账号名或url_token>" [--out evidence.json]
//        [--mentions 40] [--promoters 6] [--posts-per-promoter 2]
//        [--comments-per-post 60] [--delay 1200]
//
// 只采集公开数据；请求间隔默认 1.2s，请勿调低（关注/粉丝列表最易触发风控）。
import { writeFile } from "node:fs/promises";
import { connect, callJson, callRaw, sleep, parseArgs } from "./mcp-client.mjs";

const { opts, pos } = parseArgs(process.argv.slice(2));
const num = (k, d) => (opts[k] === undefined ? d : Number(opts[k]));

const DELAY = num("delay", 1200);
const OUT = typeof opts.out === "string" ? opts.out : "evidence.json";
const MENTIONS = num("mentions", 40);
const TOP_PROMOTERS = num("promoters", 6);
const POSTS_PER_PROMOTER = num("posts-per-promoter", 2);
const COMMENTS_PER_POST = num("comments-per-post", 60);

const log = (m) => console.error("[collect] " + m);

const client = await connect();
try {
  if (opts.session) {
    const s = await callRaw(client, "zhihu_session");
    console.log(s.text);
    if (s.isError) {
      console.error("");
      console.error("未登录。请先导入 cookie —— 见 README 的「导入 cookie」一节。");
      process.exit(1);
    }
    process.exit(0);
  }

  const targetInput = pos[0];
  if (!targetInput) {
    console.error(
      "用法: node scripts/collect.mjs <账号名或url_token> [--out evidence.json]"
    );
    process.exit(1);
  }

  const notes = [];

  log("解析目标账号：" + targetInput);
  const prof = await callJson(client, "zhihu_profile", {
    user: targetInput,
    format: "json",
  });
  const target = prof.profile;
  if (prof.resolved_from === "name_search") {
    notes.push(
      "目标由中文名搜索解析而来，存在同名风险，候选数 " + prof.other_candidates.length
    );
  }
  log("  → " + target.name + " (" + target.url_token + ")");
  await sleep(DELAY);

  log("采集目标动态…");
  const act = await callJson(client, "zhihu_user_activity", {
    user: target.url_token,
    count: 60,
    format: "json",
  });
  await sleep(DELAY);

  log("采集目标关注列表…");
  const tfol = await callJson(client, "zhihu_network", {
    user: target.url_token,
    kind: "followees",
    max_count: 100,
    format: "json",
  });
  await sleep(DELAY);

  log("扫描全站提及（上限 " + MENTIONS + " 条，注意这是近似值）…");
  const ms = await callJson(client, "zhihu_search", {
    query: target.name,
    type: "general",
    max_count: MENTIONS,
    format: "json",
  });
  notes.push(
    "搜索接口单次查询上限 " + MENTIONS + " 条且按相关度排序，提及次数为近似值而非全量"
  );
  await sleep(DELAY);

  const mentionItems = ms.items
    .filter((i) => i.author && i.author_url_token)
    .map((i) => ({
      type: i.type,
      date: i.created_time
        ? new Date(i.created_time * 1000).toISOString().slice(0, 10)
        : null,
      created_time: i.created_time,
      author: i.author,
      author_token: i.author_url_token,
      title: i.title,
      url: i.url,
      votes: i.voteup_count,
      comments: i.comment_count,
    }));

  const byAuthorMap = new Map();
  for (const it of mentionItems) {
    const k = it.author_token;
    if (!byAuthorMap.has(k)) {
      byAuthorMap.set(k, {
        author: it.author,
        token: k,
        count: 0,
        votes: 0,
        dates: [],
        items: [],
      });
    }
    const e = byAuthorMap.get(k);
    e.count++;
    e.votes += it.votes || 0;
    if (it.date) e.dates.push(it.date);
    e.items.push(it);
  }
  const byAuthor = [...byAuthorMap.values()].sort((a, b) => b.count - a.count);
  log("  → 命中 " + mentionItems.length + " 条，涉及 " + byAuthor.length + " 个账号");

  // 排除目标自己
  const promoterSeeds = byAuthor
    .filter((a) => a.token !== target.url_token)
    .slice(0, TOP_PROMOTERS);

  const promoters = [];
  for (const seed of promoterSeeds) {
    log("采集提及者 " + seed.author + "（提及 " + seed.count + " 次）…");
    let p = null;
    try {
      p = (await callJson(client, "zhihu_profile", { user: seed.token, format: "json" }))
        .profile;
    } catch (e) {
      log("  画像失败：" + e.message);
    }
    await sleep(DELAY);

    let followees = [];
    try {
      followees = (
        await callJson(client, "zhihu_network", {
          user: seed.token,
          kind: "followees",
          max_count: 100,
          format: "json",
        })
      ).members.map((m) => ({ name: m.name, token: m.url_token }));
    } catch (e) {
      log("  关注列表失败：" + e.message);
    }
    await sleep(DELAY);

    let activity = [];
    try {
      activity = (
        await callJson(client, "zhihu_user_activity", {
          user: seed.token,
          count: 60,
          format: "json",
        })
      ).items.map((i) => ({
        title: i.title,
        date: i.created_time
          ? new Date(i.created_time * 1000).toISOString().slice(0, 10)
          : null,
        created_time: i.created_time,
        votes: i.voteup_count,
      }));
    } catch (e) {
      log("  动态失败：" + e.message);
    }
    await sleep(DELAY);

    promoters.push({
      author: seed.author,
      token: seed.token,
      mention_count: seed.count,
      mention_votes: seed.votes,
      profile: p,
      followees,
      activity,
      posts: seed.items
        .slice()
        .sort((a, b) => (b.votes || 0) - (a.votes || 0))
        .slice(0, POSTS_PER_PROMOTER),
    });
  }

  // 评论区
  const comments = [];
  for (const p of promoters) {
    for (const post of p.posts) {
      if (!post.url || !post.url.includes("/answer/")) continue;
      log("采集评论：" + p.author + " · " + post.title.slice(0, 24));
      try {
        const c = await callJson(client, "zhihu_answer_comments", {
          target: post.url,
          max_count: COMMENTS_PER_POST,
          format: "json",
        });
        comments.push({
          post_url: post.url,
          post_title: post.title,
          post_author: p.author,
          post_author_token: p.token,
          totals: c.totals,
          fetched: c.fetched,
          items: c.comments.map((x) => ({
            author: x.author,
            token: x.author_url_token,
            content: x.content,
            created: x.created_time
              ? new Date(x.created_time * 1000).toISOString().slice(0, 16).replace("T", " ")
              : null,
            votes: x.vote_count,
            is_post_author: x.is_post_author,
            reply_to: x.reply_to,
            ip: x.ip,
          })),
        });
      } catch (e) {
        log("  评论失败：" + e.message);
      }
      await sleep(DELAY);
    }
  }

  const evidence = {
    meta: {
      generated_at: new Date().toISOString(),
      tool: "zhihu-cib-detection / scripts/collect.mjs",
      target_input: targetInput,
      params: { MENTIONS, TOP_PROMOTERS, POSTS_PER_PROMOTER, COMMENTS_PER_POST, DELAY },
      notes,
    },
    target: {
      profile: target,
      activity: act.items.map((i) => ({
        title: i.title,
        kind: i.kind,
        date: i.created_time
          ? new Date(i.created_time * 1000).toISOString().slice(0, 10)
          : null,
        created_time: i.created_time,
        votes: i.voteup_count,
        url: i.url,
      })),
      activity_totals: act.totals,
      followees: tfol.members.map((m) => ({ name: m.name, token: m.url_token })),
      followees_totals: tfol.totals,
    },
    mentions: {
      query: target.name,
      fetched: mentionItems.length,
      items: mentionItems,
      by_author: byAuthor.map((a) => ({
        author: a.author,
        token: a.token,
        count: a.count,
        votes: a.votes,
      })),
    },
    promoters,
    comments,
  };

  await writeFile(OUT, JSON.stringify(evidence, null, 2), "utf-8");
  log("完成 → " + OUT);
  console.log(
    "证据包已写入 " +
      OUT +
      "\n目标：" +
      target.name +
      "\n提及条目：" +
      mentionItems.length +
      "（涉及 " +
      byAuthor.length +
      " 个账号）\n深度采集的提及者：" +
      promoters.length +
      "\n评论帖子：" +
      comments.length
  );
} finally {
  try {
    await client.close();
  } catch {}
}
