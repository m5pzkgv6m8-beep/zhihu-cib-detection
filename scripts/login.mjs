#!/usr/bin/env node
// 导入知乎 cookie，让 MCP 具备登录态。这是 clone 之后唯一必须手动做的一步。
//
//   node scripts/login.mjs --status
//   node scripts/login.mjs --cookie "z_c0=...; __zse_ck=..."
//   node scripts/login.mjs --file cookies.json
//
// 获取 cookie：
//   1. 浏览器登录知乎
//   2. F12 → Network → 刷新页面 → 点任意一个请求
//   3. Request Headers → 复制整条 Cookie 的值
//   4. 至少要包含 z_c0 与 __zse_ck 两个字段
import { readFile } from "node:fs/promises";
import { connect, callRaw, parseArgs } from "./mcp-client.mjs";

const { opts } = parseArgs(process.argv.slice(2));
const client = await connect();
try {
  if (opts.status) {
    const s = await callRaw(client, "zhihu_session");
    console.log(s.text);
    process.exit(s.isError ? 1 : 0);
  }

  let cookie = "";
  if (typeof opts.cookie === "string") cookie = opts.cookie;
  else if (typeof opts.file === "string") cookie = await readFile(opts.file, "utf-8");

  if (!cookie.trim()) {
    console.error("用法：");
    console.error('  node scripts/login.mjs --cookie "z_c0=...; __zse_ck=..."');
    console.error("  node scripts/login.mjs --file cookies.json");
    console.error("  node scripts/login.mjs --status");
    console.error("");
    console.error("获取 cookie：浏览器登录知乎 → F12 → Network → 任一请求 →");
    console.error("Request Headers → 复制整条 Cookie 的值（需含 z_c0 与 __zse_ck）。");
    process.exit(1);
  }

  const set = await callRaw(client, "manage_cookies", {
    action: "set",
    site: "zhihu",
    cookies: cookie.trim(),
  });
  console.log(set.text);

  const s = await callRaw(client, "zhihu_session");
  console.log(s.text);
  process.exit(s.isError ? 1 : 0);
} finally {
  try {
    await client.close();
  } catch {}
}
