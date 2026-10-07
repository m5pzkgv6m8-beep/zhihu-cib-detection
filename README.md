# zhihu-cib-detection

用本地 MCP 采集知乎**公开**数据，识别「小号抬大号」式的**协同非真实行为（CIB, Coordinated Inauthentic Behavior）**。

一个 [Agent Skill](https://docs.claude.com/en/docs/claude-code/skills)：装上之后，AI 助手就知道怎么用这套工具链做知乎账号协同行为研判。

## 它能回答什么问题

- 某个知乎账号是不是在**被小号引流**？
- 一批「推荐某某博主」的回答，是读者自发还是**协同推广**？
- 某账号是不是**养号/买号**转成的推荐号？
- 评论区里的「良心推荐 已关注」是不是**水军话术**？
- 目标账号与推荐者之间是**什么关系**（互关？单向？熟人？）

## 它明确做不到什么

这一点比「能做什么」更重要：

- **点赞者身份拿不到**。平台不公开，所以无法直接证明「谁点的赞」，也无法证明刷赞（只能靠时间序列间接推断）
- **无法证明动机**。没有私信、没有资金流，所以「同一人操作」和「收钱办事」都**无法判定**
- **搜索接口有上限**，提及次数是近似值，不是全量统计

因此本工具输出的永远是 **疑似度 + 证据链**，不是定论。报告里必须写明「无法判定的部分」。

## 快速开始

**前置要求**：Node.js ≥ 18。

```bash
git clone <this-repo> && cd naoshi

# 1. 安装依赖并构建本地 MCP server
cd mcp
npm ci                          # 仓库带 package-lock.json，用 ci 保证依赖版本一致
npx playwright install chromium # 首次必须执行，下载无头浏览器（约 150MB）
npm run build
cd ..

# 2. 导入知乎登录态（唯一需要手动准备的一步）
node scripts/login.mjs --cookie "z_c0=...; __zse_ck=..."
#   或从文件导入： node scripts/login.mjs --file cookies.json
#   自检登录态：   node scripts/login.mjs --status

# 3. 采集证据包
node scripts/collect.mjs "某账号名或url_token" --out evidence.json

# 4. 出研判报告（对外发布务必加 --anonymize）
node scripts/analyze.mjs evidence.json --anonymize --out report.md
```

### 获取知乎 cookie

`login.mjs` 需要一条完整的 `Cookie` 请求头：

1. 浏览器登录知乎
2. F12 → Network → 刷新页面 → 点任意一个请求
3. Request Headers → 复制整条 `Cookie` 的值
4. 至少要包含 `z_c0` 与 `__zse_ck` 两个字段

导入后登录态存在 `mcp/cookies/zhihu.json`，**已被 .gitignore 忽略，不会提交**。
cookie 会随每次请求自动回写（动态反爬 token 得以保留），外部修改文件后无需重启即会热加载。

### 安装成 Agent Skill

把整个仓库放到 agent 的 skills 目录即可，例如 Claude Code：

```bash
cp -r naoshi ~/.claude/skills/zhihu-cib-detection
```

之后当你说「查一下这个知乎账号是不是被小号引流」时 skill 会自动触发。
脚本按自身位置解析 MCP 路径，所以仓库放在哪都能跑。

### 让 Agent 直接调用 MCP

`scripts/` 下的脚本会自己拉起 MCP，**不需要额外配置**。
但如果你希望 agent 直接调用 `mcp__anti-scrape__*` 工具（`SKILL.md` 里的工作流就是这么写的），
需要把这个 MCP server 注册给它：

```bash
# Claude Code
claude mcp add anti-scrape -- node /绝对路径/naoshi/mcp/dist/index.js
```

或写进 MCP 配置文件：

```json
{
  "mcpServers": {
    "anti-scrape": {
      "command": "node",
      "args": ["/绝对路径/naoshi/mcp/dist/index.js"]
    }
  }
}
```

脚本与 agent 共用同一份登录态（`mcp/cookies/zhihu.json`），导入一次即可。

### 常见问题

| 现象 | 原因 / 解决 |
| --- | --- |
| `MCP server 尚未构建` | 没执行第 1 步的 `npm run build` |
| `Playwright 浏览器未安装` | 没执行 `npx playwright install chromium` |
| `知乎未登录或会话已失效` | cookie 未导入或已过期，重跑 `login.mjs` |
| 触发安全验证 / 错误码 40362 | 请求过密，调大 `--delay`；或设 `ASM_HEADLESS=0` 走可见浏览器 |

## 仓库结构

```
.
├── SKILL.md                  # Skill 入口：何时触发、完整工作流、判定规则
├── references/
│   ├── tools.md              # 12 个 MCP 工具的参数/返回，以及三个必须知道的坑
│   ├── methodology.md        # 信号计算方式与判定逻辑
│   ├── evidence.md           # 证据链格式、置信度分级、合规边界
│   └── case-study.md         # 完整匿名化案例
├── scripts/
│   ├── collect.mjs           # 采集证据包
│   ├── analyze.mjs           # 计算信号、出报告
│   └── mcp-client.mjs        # 可复用的 MCP stdio 客户端
└── mcp/                      # anti-scrape-mcp（Playwright + 知乎 v4 API 封装）
    └── src/sites/zhihu-api.ts
```

## 方法论一句话版

**不要靠单一信号下结论。** 时间聚集、IP 同省、互相关注，单独看全都会大量误报。
真正有说服力的是**多个信号族同时命中**：

内容半径塌缩（账号只推一个人）+ 提及高度集中（少数账号贡献大部分推荐）
+ 同题共现（多账号错峰覆盖同一批问题）+ 评论区闭环（目标本人下场与推荐者熟人互动）

详见 `references/methodology.md`。

## 合规与伦理

本工具用于**平台治理、舆情研判、尽调、学术研究**等正当用途。

- 只采集公开页面，请求间隔 ≥1.2s
- **不得用于骚扰、人肉、公开点名指控**
- 基于间接证据公开点名真实账号，在多数法域下存在名誉权风险 —— 对外发布前请使用 `--anonymize`
- 涉及个人信息处理时遵守当地法律（如《个人信息保护法》）；自动化结论必须保留人工复核环节
- 使用者需自行遵守目标平台的用户协议

## 许可证

MIT
