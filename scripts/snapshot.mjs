#!/usr/bin/env node
// 证据保全：把页面「当时长什么样」截图落盘，并生成带 SHA-256 的清单，供日后核验。
//
//   node scripts/snapshot.mjs --url <url> [--url <url> ...] [--out evidence/batch]
//   node scripts/snapshot.mjs --from evidence.json [--out evidence/batch]
//   node scripts/snapshot.mjs --verify evidence/batch
//
// 边界：截图只证明「某一时刻页面渲染成这样」，不能证明内容真实（页面可被编辑、删除）。
// 证据力来自 截图 + 原始 JSON + 采集时间戳 + SHA-256 的组合，四者缺一不可。
import { writeFile, mkdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { connect, sleep } from "./mcp-client.mjs";

// ---- 参数（--url 可重复）----
const opts = { url: [] };
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (!a.startsWith("--")) continue;
  const k = a.slice(2);
  const next = argv[i + 1];
  const val = next !== undefined && !next.startsWith("--") ? (i++, next) : true;
  if (k === "url") opts.url.push(val);
  else opts[k] = val;
}

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const pngSize = (buf) => {
  try {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  } catch {
    return { width: null, height: null };
  }
};
const slug = (url) => {
  const m = url.match(/answer\/(\d+)/);
  if (m) return "answer-" + m[1];
  const p = url.match(/(?:zhuanlan\.zhihu\.com\/p\/|\/p\/)(\d+)/);
  if (p) return "article-" + p[1];
  const q = url.match(/question\/(\d+)/);
  if (q) return "question-" + q[1];
  const people = url.match(/people\/([^/?#]+)/);
  if (people) return "people-" + people[1];
  return "page-" + sha256(Buffer.from(url)).slice(0, 8);
};
const kindOf = (url) => slug(url).split("-")[0];

// ---- --verify 模式：重算哈希，检查文件是否被改动 ----
if (opts.verify) {
  const dir = String(opts.verify);
  const manifest = JSON.parse(await readFile(join(dir, "manifest.json"), "utf-8"));
  let bad = 0;
  console.log("批次：" + manifest.batch);
  console.log("采集时间：" + manifest.created_at_local);
  console.log("");
  for (const it of manifest.items) {
    const buf = await readFile(join(dir, it.screenshot));
    const h = sha256(buf);
    const ok = h === it.sha256;
    if (!ok) bad++;
    console.log((ok ? "✓ " : "✗ 已被改动 ") + it.screenshot + "  " + h.slice(0, 12));
  }
  console.log("");
  console.log(bad ? "✗ " + bad + " 个文件校验失败" : "✓ 全部 " + manifest.items.length + " 个文件校验通过");
  process.exit(bad ? 1 : 0);
}

// ---- 组装待截图 URL ----
const urls = [...opts.url];
if (opts.from) {
  const ev = JSON.parse(await readFile(String(opts.from), "utf-8"));
  const t = ev.target && ev.target.profile;
  if (t && t.url) urls.push(t.url);
  for (const p of ev.promoters || []) {
    for (const post of p.posts || []) if (post.url) urls.push(post.url);
  }
  console.log("从 " + opts.from + " 提取 " + urls.length + " 个 URL");
}

if (!urls.length) {
  console.error("用法：");
  console.error("  node scripts/snapshot.mjs --url <url> [--url <url> ...] [--out evidence/batch]");
  console.error("  node scripts/snapshot.mjs --from evidence.json [--out evidence/batch]");
  console.error("  node scripts/snapshot.mjs --verify evidence/batch");
  process.exit(1);
}

const stamp = new Date();
const pad = (n) => String(n).padStart(2, "0");
const localStamp =
  stamp.getFullYear() +
  pad(stamp.getMonth() + 1) +
  pad(stamp.getDate()) +
  "-" +
  pad(stamp.getHours()) +
  pad(stamp.getMinutes());
const OUT = String(opts.out || join("evidence", "batch-" + localStamp));
const SHOTS = join(OUT, "shots");
await mkdir(SHOTS, { recursive: true });

const full = opts.full !== false; // 默认全页
const delay = Number(opts.delay || 1200);
const client = await connect();
const items = [];

try {
  let n = 0;
  for (const url of urls) {
    n++;
    const name = String(n).padStart(3, "0") + "-" + slug(url) + ".png";
    const rel = "shots/" + name;
    process.stderr.write("[snapshot] " + n + "/" + urls.length + " " + url + "\n");
    const capturedAt = new Date();
    try {
      const r = await client.callTool({
        name: "screenshot_page",
        arguments: { url, full_page: full },
      });
      const img = (r.content || []).find((c) => c.type === "image");
      if (!img) throw new Error("未返回图片内容");
      const buf = Buffer.from(img.data, "base64");
      await writeFile(join(OUT, rel), buf);
      const size = pngSize(buf);
      items.push({
        url,
        kind: kindOf(url),
        captured_at: capturedAt.toISOString(),
        captured_at_local: capturedAt.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" }),
        screenshot: rel,
        width: size.width,
        height: size.height,
        bytes: buf.length,
        sha256: sha256(buf),
      });
    } catch (e) {
      items.push({
        url,
        kind: kindOf(url),
        captured_at: capturedAt.toISOString(),
        captured_at_local: capturedAt.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" }),
        screenshot: null,
        error: String(e).slice(0, 300),
      });
    }
    if (n < urls.length) await sleep(delay);
  }
} finally {
  try {
    await client.close();
  } catch {}
}

const okCount = items.filter((i) => i.sha256).length;
const manifest = {
  batch: OUT.replace(/\\/g, "/"),
  created_at: stamp.toISOString(),
  created_at_local: stamp.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" }),
  tool: "zhihu-cib-detection / scripts/snapshot.mjs",
  note: "截图证明某一时刻页面渲染状态，不能证明内容真实。核验：node scripts/snapshot.mjs --verify <批次目录>",
  params: { full_page: full, delay_ms: delay, total: urls.length, succeeded: okCount },
  items,
};
await writeFile(join(OUT, "manifest.json"), JSON.stringify(manifest, null, 2), "utf-8");

console.log("批次目录：" + OUT);
console.log("截图成功：" + okCount + "/" + urls.length);
console.log("清单文件：" + join(OUT, "manifest.json"));
console.log("核验命令：node scripts/snapshot.mjs --verify " + OUT);
