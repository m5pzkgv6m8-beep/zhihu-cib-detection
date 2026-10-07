// 可复用的 MCP stdio 客户端：脚本与自定义分析都用它跟 anti-scrape-mcp 通信。
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(HERE, "..");
export const MCP_DIR = join(ROOT, "mcp");
const SERVER = join(MCP_DIR, "dist", "index.js");

const BUILD_HINT =
  "MCP server 尚未构建。请先运行：\n" +
  "  cd mcp && npm install && npx playwright install chromium && npm run build";

/** 启动本地 MCP server 并握手，返回已连接的 client。 */
export async function connect() {
  if (!existsSync(SERVER)) throw new Error(BUILD_HINT);
  // SDK 装在 mcp/node_modules 下，从 mcp/package.json 解析才能拿到正确的 exports 路径
  const req = createRequire(join(MCP_DIR, "package.json"));
  const clientUrl = pathToFileURL(
    req.resolve("@modelcontextprotocol/sdk/client/index.js")
  ).href;
  const stdioUrl = pathToFileURL(
    req.resolve("@modelcontextprotocol/sdk/client/stdio.js")
  ).href;
  const { Client } = await import(clientUrl);
  const { StdioClientTransport } = await import(stdioUrl);

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER],
  });
  const client = new Client(
    { name: "zhihu-cib-detection", version: "1.0.0" },
    { capabilities: {} }
  );
  await client.connect(transport);
  return client;
}

export function textOf(result) {
  return (result.content || [])
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

export async function callText(client, name, toolArgs = {}) {
  const r = await client.callTool({ name, arguments: toolArgs });
  const t = textOf(r);
  if (r.isError) {
    if (/Executable doesn't exist|playwright install/i.test(t)) {
      throw new Error(
        name +
          " 调用失败：Playwright 浏览器未安装。请运行：\n" +
          "  cd mcp && npx playwright install chromium\n\n原始错误：" +
          t.slice(0, 200)
      );
    }
    throw new Error(name + " 调用失败：" + t.slice(0, 300));
  }
  return t;
}

export async function callJson(client, name, toolArgs = {}) {
  return JSON.parse(await callText(client, name, toolArgs));
}

/** 不抛异常地调用，返回 { text, isError }，适合登录态自检这类允许失败的调用。 */
export async function callRaw(client, name, toolArgs = {}) {
  const r = await client.callTool({ name, arguments: toolArgs });
  return { text: textOf(r), isError: Boolean(r.isError) };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 简单参数解析：--key value / --flag，其余为位置参数。 */
export function parseArgs(argv) {
  const opts = {};
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const k = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        opts[k] = next;
        i++;
      } else {
        opts[k] = true;
      }
    } else {
      pos.push(a);
    }
  }
  return { opts, pos };
}
