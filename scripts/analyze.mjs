#!/usr/bin/env node
// 从证据包计算协同行为信号并输出研判报告。
//
//   node scripts/analyze.mjs evidence.json
//   node scripts/analyze.mjs evidence.json --anonymize --out report.md
//
// --anonymize：账号名替换为角色代号、url_token 哈希化，用于对外发布。
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { parseArgs } from "./mcp-client.mjs";

const { opts, pos } = parseArgs(process.argv.slice(2));
const FILE = pos[0] || "evidence.json";
const ANON = Boolean(opts.anonymize);
const OUT = typeof opts.out === "string" ? opts.out : null;

const ev = JSON.parse(await readFile(FILE, "utf-8"));

// ---------- 匿名化 ----------
const nameMap = new Map();
const tokenMap = new Map();
const target = ev.target.profile;
nameMap.set(target.name, "目标账号");
(ev.promoters || []).forEach((p, i) => {
  nameMap.set(p.author, "推广号" + String.fromCharCode(65 + i));
});
let seq = 0;
function anonName(n) {
  if (!n) return "";
  if (!nameMap.has(n)) nameMap.set(n, "账号" + String(++seq).padStart(2, "0"));
  return nameMap.get(n);
}
function anonToken(t) {
  if (!t) return "";
  if (!tokenMap.has(t)) {
    tokenMap.set(t, createHash("sha256").update(t).digest("hex").slice(0, 10));
  }
  return tokenMap.get(t);
}
const N = (n) => (ANON ? anonName(n) : n);
const T = (t) => (ANON ? anonToken(t) : t);
const targetName = N(target.name);

// 把证据包里出现过的所有昵称都登记进映射表，这样评论正文里的第三方真名也能被替换掉
function collectNames() {
  const add = (n) => n && nameMap.set(n, nameMap.get(n) || null);
  for (const c of ev.comments || []) {
    add(c.post_author);
    for (const x of c.items || []) add(x.author);
  }
  for (const p of ev.promoters || []) {
    for (const f of p.followees || []) add(f.name);
  }
  for (const m of ev.mentions.items || []) add(m.author);
  for (const f of ev.target.followees || []) add(f.name);
  for (const [k, v] of nameMap) if (v === null) nameMap.delete(k);
}
collectNames();

/** 正文级脱敏：把正文里出现过的昵称也替换掉，避免 --anonymize 时从评论内容漏出真名。 */
const scrub = (s) => {
  let out = String(s ?? "");
  if (!ANON) return out;
  const keys = [...nameMap.keys()].sort((a, b) => b.length - a.length);
  for (const k of keys) {
    if (k && k.length >= 2) out = out.split(k).join(nameMap.get(k));
  }
  return out;
};

// ---------- 工具函数 ----------
const REC_RE = /关注|推荐|高手|大V|大神|水平|值得|技术|博主|排名|谁|评价|厉害|感谢/;
const CHEER_RE = /良心推荐|已关注|支持|感谢|学到了|老师|大神|受益匪浅|谢谢|膜拜|佩服/;
const norm = (s) => String(s || "").replace(/[？?！!。.\s]+$/g, "").trim();
const pct = (x) => (x * 100).toFixed(0) + "%";
const days = (a, b) =>
  Math.round((new Date(b).getTime() - new Date(a).getTime()) / 86400000);
const province = (ip) => (ip ? String(ip).replace(/^IP\s*属地\s*/, "").trim() : "");

// ---------- S1 内容半径 ----------
function radiusOf(activity) {
  const list = activity || [];
  if (!list.length) return { n: 0, hits: 0, radius: 0, recentRadius: 0, maxGapDays: null };
  const hits = list.filter((a) => REC_RE.test(a.title || "")).length;
  const dates = list.map((a) => a.date).filter(Boolean).sort();
  let maxGapDays = null;
  for (let i = 1; i < dates.length; i++) {
    const g = days(dates[i - 1], dates[i]);
    if (maxGapDays === null || g > maxGapDays) maxGapDays = g;
  }
  // 近 10 条单独算：老账号的历史回答会把全期比例拉低，掩盖近期转型
  const recent = list.slice(0, 10);
  const recentHits = recent.filter((a) => REC_RE.test(a.title || "")).length;
  return {
    n: list.length,
    hits,
    radius: hits / list.length,
    recentRadius: recent.length ? recentHits / recent.length : 0,
    maxGapDays,
  };
}

// ---------- S3 同题共现 ----------
function cooccurrence(a, b) {
  const mapB = new Map();
  for (const x of b.activity || []) {
    const k = norm(x.title);
    if (!mapB.has(k)) mapB.set(k, x.date);
  }
  const shared = [];
  for (const x of a.activity || []) {
    const k = norm(x.title);
    if (mapB.has(k)) shared.push({ title: x.title, aDate: x.date, bDate: mapB.get(k) });
  }
  return shared;
}

// ---------- S6 时间爆发 ----------
function bursts(activity) {
  const byDay = new Map();
  for (const a of activity || []) {
    if (!a.date) continue;
    if (!REC_RE.test(a.title || "")) continue; // 只统计推荐类发帖，避免无关话题造成假爆发
    if (!byDay.has(a.date)) byDay.set(a.date, []);
    byDay.get(a.date).push(a.title);
  }
  return [...byDay.entries()]
    .filter(([, v]) => v.length >= 2)
    .sort((x, y) => y[1].length - x[1].length);
}

// ---------- 计算 ----------
const promoters = ev.promoters || [];
const pStats = promoters.map((p) => ({
  p,
  r: radiusOf(p.activity),
  followsTarget: (p.followees || []).some((f) => f.token === target.url_token),
  targetFollows: (ev.target.followees || []).some((f) => f.token === p.token),
  burst: bursts(p.activity),
  ip: province(p.profile && p.profile.ip_info),
}));

const byAuthor = ev.mentions.by_author || [];
const totalMentions = byAuthor.reduce((s, a) => s + a.count, 0);
const top3 = byAuthor.slice(0, 3).reduce((s, a) => s + a.count, 0);
const concentration = totalMentions ? top3 / totalMentions : 0;

const mentionItems = ev.mentions.items || [];
const recMentions = mentionItems.filter((m) => REC_RE.test(m.title || "")).length;
const templateCoverage = mentionItems.length ? recMentions / mentionItems.length : 0;

const allComments = [];
for (const c of ev.comments || []) for (const x of c.items || []) allComments.push(x);
const commenterCount = new Map();
for (const c of allComments) {
  const k = c.token || c.author;
  commenterCount.set(k, (commenterCount.get(k) || 0) + 1);
}
const repeatCommenters = [...commenterCount.entries()]
  .filter(([, n]) => n >= 2)
  .sort((a, b) => b[1] - a[1]);
const cheerHits = allComments.filter((c) => CHEER_RE.test(c.content || ""));
const targetInComments = allComments.filter((c) => c.author === target.name);
const postStats = (ev.comments || []).map((c) => {
  const items = c.items || [];
  const self = items.filter((x) => x.is_post_author).length;
  return {
    title: c.post_title,
    author: c.post_author,
    total: items.length,
    self,
    selfRatio: items.length ? self / items.length : 0,
  };
});

const followsTargetCount = pStats.filter((s) => s.followsTarget).length;
const mutualCount = pStats.filter((s) => s.followsTarget && s.targetFollows).length;

const ipTarget = province(target.ip_info);
const sameIpPromoters = pStats.filter((s) => s.ip && s.ip === ipTarget);

// ---------- 信号族 ----------
const families = [
  {
    key: "S1",
    name: "内容半径塌缩",
    weight: "high",
    hit: pStats.some(
      (s) => s.r.n >= 5 && (s.r.radius >= 0.6 || s.r.recentRadius >= 0.8)
    ),
    detail: pStats
      .filter((s) => s.r.n >= 3)
      .map(
        (s) =>
          N(s.p.author) +
          " 全期 " +
          pct(s.r.radius) +
          "／近 10 条 " +
          pct(s.r.recentRadius) +
          "（" +
          s.r.hits +
          "/" +
          s.r.n +
          "）"
      )
      .join("，"),
  },
  {
    key: "S2",
    name: "提及高度集中",
    weight: "high",
    hit: concentration >= 0.5 && totalMentions >= 5,
    detail: "Top3 占 " + pct(concentration) + "（" + top3 + "/" + totalMentions + "）",
  },
  { key: "S3", name: "同题共现", weight: "high", hit: false, detail: "" },
  {
    key: "S4",
    name: "评论区闭环",
    weight: "high",
    hit:
      targetInComments.length > 0 ||
      (repeatCommenters.length >= 1 && cheerHits.length >= 2),
    detail:
      "目标本人出现 " +
      targetInComments.length +
      " 次；重复评论者 " +
      repeatCommenters.length +
      " 个；模板捧场语 " +
      cheerHits.length +
      " 条",
  },
  {
    key: "S5",
    name: "关注成团",
    weight: "mid",
    hit: followsTargetCount >= 1,
    detail:
      followsTargetCount + "/" + promoters.length + " 个提及者关注目标，回关 " + mutualCount + " 个",
  },
  {
    key: "S6",
    name: "时间爆发",
    weight: "mid",
    hit: pStats.some((s) => s.burst.some(([, v]) => v.length >= 3)),
    detail:
      pStats
        .flatMap((s) => s.burst.map(([d, v]) => N(s.p.author) + " " + d + " 发 " + v.length + " 条"))
        .join("；") || "无",
  },
  {
    key: "S7",
    name: "话术模板覆盖",
    weight: "mid",
    hit: templateCoverage >= 0.7 && mentionItems.length >= 5,
    detail: pct(templateCoverage) + "（" + recMentions + "/" + mentionItems.length + "）",
  },
  {
    key: "S8",
    name: "IP 同地",
    weight: "low",
    hit: sameIpPromoters.length >= 1,
    detail: sameIpPromoters.length
      ? sameIpPromoters.map((s) => N(s.p.author)).join("，") + " 与目标同为 " + ipTarget
      : "无",
  },
];

const pairs = [];
for (let i = 0; i < pStats.length; i++) {
  for (let j = i + 1; j < pStats.length; j++) {
    const shared = cooccurrence(pStats[i].p, pStats[j].p);
    if (shared.length) pairs.push({ a: pStats[i].p.author, b: pStats[j].p.author, shared });
  }
}
pairs.sort((x, y) => y.shared.length - x.shared.length);
const s3 = families.find((f) => f.key === "S3");
s3.hit = pairs.some((p) => p.shared.length >= 3);
s3.detail = pairs.length
  ? "最强共现 " +
    N(pairs[0].a) +
    " × " +
    N(pairs[0].b) +
    " 共同回答 " +
    pairs[0].shared.length +
    " 个问题"
  : "无共现";

// ---------- 置信度 ----------
const high = families.filter((f) => f.weight === "high" && f.hit).length;
const mid = families.filter((f) => f.weight === "mid" && f.hit).length;
const low = families.filter((f) => f.weight === "low" && f.hit).length;
let confidence = "低";
if (high >= 3 && mid >= 1) confidence = "高";
else if (high >= 2 || (high >= 1 && mid >= 2)) confidence = "中";

// ---------- 报告 ----------
const L = [];
L.push("# 知乎协同行为（CIB）研判报告");
L.push("");
L.push("> 证据包：" + FILE + "　生成时间：" + ev.meta.generated_at);
L.push("> 采集参数：" + JSON.stringify(ev.meta.params));
if (ANON) L.push("> **本报告已匿名化**（账号名替换为角色代号，token 已哈希）");
L.push("");
L.push("## 一、结论");
L.push("");
L.push(
  "**置信度：" +
    confidence +
    "**（高权重信号命中 " +
    high +
    " 个，中权重 " +
    mid +
    " 个，弱信号 " +
    low +
    " 个）"
);
L.push("");
L.push(
  "**" +
    targetName +
    "**（" +
    T(target.url_token) +
    "，" +
    (target.follower_count ?? "?") +
    " 粉丝 / " +
    (target.answer_count ?? "?") +
    " 回答）被 " +
    promoters.length +
    " 个账号集中提及，共命中 " +
    mentionItems.length +
    " 条提及内容。"
);
L.push("");
L.push("**这只能证明协同行为，不能证明动机。** 详见第六节。");
L.push("");
L.push("## 二、信号命中表");
L.push("");
L.push("| 信号 | 权重 | 命中 | 说明 |");
L.push("| --- | --- | --- | --- |");
for (const f of families) {
  L.push(
    "| " + f.key + " " + f.name + " | " + f.weight + " | " + (f.hit ? "✅" : "—") + " | " + f.detail + " |"
  );
}
L.push("");
L.push("## 三、数据摘要");
L.push("");
L.push("### 目标画像");
L.push("");
L.push("| 字段 | 值 |");
L.push("| --- | --- |");
L.push("| 账号 | " + targetName + " |");
L.push("| url_token | " + T(target.url_token) + " |");
L.push("| 简介 | " + scrub(target.headline || "（空）") + " |");
L.push(
  "| 粉丝 / 关注 | " +
    (target.follower_count ?? "?") +
    " / " +
    (target.following_count ?? "?") +
    " |"
);
L.push("| 回答 / 文章 | " + (target.answer_count ?? "?") + " / " + (target.articles_count ?? "?") + " |");
L.push("| 总赞同 | " + (target.voteup_count ?? "?") + " |");
L.push("| 认证 | " + ((target.badges || []).join("；") || "无") + " |");
L.push("| IP 属地 | " + (target.ip_info || "?") + " |");
L.push("");
L.push("### 提及者（按提及次数）");
L.push("");
L.push("| 账号 | 提及次数 | 累计赞 | 粉丝 | 回答数 | 内容半径 | 关注目标 |");
L.push("| --- | --- | --- | --- | --- | --- | --- |");
for (const s of pStats) {
  const pr = s.p.profile || {};
  L.push(
    "| " +
      N(s.p.author) +
      " | " +
      s.p.mention_count +
      " | " +
      s.p.mention_votes +
      " | " +
      (pr.follower_count ?? "?") +
      " | " +
      (pr.answer_count ?? "?") +
      " | " +
      pct(s.r.radius) +
      " | " +
      (s.followsTarget ? "是" : "否") +
      " |"
  );
}
L.push("");
L.push("## 四、关键证据");
L.push("");
L.push("### S1 内容半径塌缩");
L.push("");
L.push("账号近期动态里「推荐类」内容的占比。越高越说明该账号是专职推荐号。");
L.push("");
for (const s of pStats) {
  L.push(
    "- **" +
      N(s.p.author) +
      "**：全期 " +
      pct(s.r.radius) +
      "，近 10 条 " +
      pct(s.r.recentRadius) +
      "（" +
      s.r.hits +
      "/" +
      s.r.n +
      "）" +
      (s.r.maxGapDays !== null ? "，动态间最大空档 " + s.r.maxGapDays + " 天" : "")
  );
}
L.push("");
L.push("### S3 同题共现");
L.push("");
if (pairs.length) {
  for (const pr of pairs.slice(0, 5)) {
    L.push("**" + N(pr.a) + " × " + N(pr.b) + "** —— 共同回答 " + pr.shared.length + " 个问题：");
    L.push("");
    L.push("| 问题 | " + N(pr.a) + " | " + N(pr.b) + " |");
    L.push("| --- | --- | --- |");
    for (const sh of pr.shared.slice(0, 8)) {
      L.push("| " + scrub(sh.title) + " | " + (sh.aDate || "?") + " | " + (sh.bDate || "?") + " |");
    }
    L.push("");
  }
} else {
  L.push("未发现共现。");
  L.push("");
}
L.push("### S4 评论区");
L.push("");
L.push("共采集 " + (ev.comments || []).length + " 个帖子的 " + allComments.length + " 条评论。");
L.push("");
if (targetInComments.length) {
  L.push("**目标账号本人出现在推荐自己的帖子评论区 " + targetInComments.length + " 次：**");
  L.push("");
  for (const c of targetInComments.slice(0, 5)) {
    L.push(
      "- " +
        (c.created || "?") +
        " 赞" +
        c.votes +
        "：" +
        scrub(c.content).replace(/\s+/g, " ").slice(0, 90)
    );
  }
  L.push("");
}
if (repeatCommenters.length) {
  L.push("**重复出现的评论者：**");
  L.push("");
  for (const [k, n] of repeatCommenters.slice(0, 8)) {
    const nm = allComments.find((c) => (c.token || c.author) === k);
    L.push("- " + N(nm ? nm.author : k) + "：" + n + " 条");
  }
  L.push("");
}
if (cheerHits.length) {
  L.push("**模板化捧场语命中 " + cheerHits.length + " 条，示例：**");
  L.push("");
  for (const c of cheerHits.slice(0, 6)) {
    L.push("- " + N(c.author) + "：" + scrub(c.content).replace(/\s+/g, " ").slice(0, 60));
  }
  L.push("");
}
L.push("**帖子作者自我回复占比（维持评论区活跃）：**");
L.push("");
L.push("| 帖子 | 作者 | 评论数 | 作者自回 | 占比 |");
L.push("| --- | --- | --- | --- | --- |");
for (const s of postStats) {
  L.push(
    "| " +
      scrub(s.title) +
      " | " +
      N(s.author) +
      " | " +
      s.total +
      " | " +
      s.self +
      " | " +
      pct(s.selfRatio) +
      " |"
  );
}
L.push("");
L.push("### S6 时间爆发");
L.push("");
if (pStats.some((s) => s.burst.length)) {
  for (const s of pStats) {
    for (const [d, v] of s.burst) {
      L.push(
        "- **" +
          N(s.p.author) +
          "** " +
          d +
          " 单日发 " +
          v.length +
          " 条：" +
          v.map((t) => scrub(t).slice(0, 30)).join("；")
      );
    }
  }
} else {
  L.push("无单日多帖。");
}
L.push("");
L.push("## 五、误报排除");
L.push("");
L.push("逐条核对以下常见误报，确认不成立才可升级结论：");
L.push("");
L.push("- [ ] 热点涌入（大 V 爆款引来自然发帖潮）");
L.push("- [ ] 正常互推（同领域 KOL 互相推荐）");
L.push("- [ ] 粉丝自发安利");
L.push("- [ ] 合法机构矩阵（用 is_org / 认证字段区分）");
L.push("- [ ] 搜索偏差（提及次数为近似值）");
L.push("- [ ] 同名不同人（用 zhihu_profile 候选列表核对）");
L.push("");
L.push("## 六、无法判定的部分");
L.push("");
L.push("本节是报告的必要组成部分，**不可删除**：");
L.push("");
L.push("- **动机**：没有私信、资金流等证据，无法判定是否存在付费推广");
L.push("- **同一人操作**：无法判定多个账号是否由同一人控制");
L.push("- **点赞行为**：平台不公开点赞者身份，无法验证是否存在刷赞");
L.push("- **提及次数是近似值**：搜索接口单次查询有上限且按相关度排序，非全量统计");
L.push("- **IP 同地是弱信号**：省份人口越多，巧合概率越高，单独不构成证据");
L.push("");
L.push("## 七、采集局限");
L.push("");
for (const n of ev.meta.notes || []) L.push("- " + n);
L.push(
  "- 深度采集的提及者仅前 " +
    (ev.meta.params.TOP_PROMOTERS ?? "?") +
    " 个，可能遗漏长尾协同账号"
);
L.push(
  "- 评论采集上限 " +
    (ev.meta.params.COMMENTS_PER_POST ?? "?") +
    " 条/帖，高评论量帖子可能未取完"
);
L.push("");

const report = L.join("\n");
if (OUT) {
  await writeFile(OUT, report, "utf-8");
  console.log(
    "报告已写入 " + OUT + "\n置信度：" + confidence + "（高权重 " + high + " / 中 " + mid + " / 弱 " + low + "）"
  );
} else {
  console.log(report);
}
