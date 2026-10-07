# MCP 工具参考

`anti-scrape-mcp` 暴露 12 个工具。在 AI 助手里以 `mcp__anti-scrape__<tool>` 形式调用；
在脚本里通过 `scripts/mcp-client.mjs` 走 stdio 调用，参数名与下表一致。

所有知乎工具共用一份登录态（`mcp/cookies/zhihu.json`），每次请求后自动回写。

---

## 通用

### `fetch_page`

抓单页正文为 Markdown。

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `url` | string | 目标 URL |
| `wait_for` | string? | 可选，等待的 CSS 选择器 |

知乎分支支持回答页 / 专栏 / 问题页 / **用户主页**（主页走 v4 API 输出完整画像）。
被重定向到登录页会直接抛「会话已失效」，而不是把登录页当成内容返回。

### `screenshot_page`

页面截图，返回 base64 PNG。参数：`url`、`full_page`。

### `manage_cookies`

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `action` | `set` \| `get` \| `clear` | 操作 |
| `site` | `zhihu` \| `zsxq` \| `xueqiu` | 目标站点 |
| `cookies` | string? | set 时必填，Playwright JSON 数组或 `a=b; c=d` 头字符串 |

热加载：外部修改 cookie 文件后按 mtime 自动重建 context，无需重启。

---

## 知乎

### `zhihu_session`

无参数。调用 `/api/v4/me` 判断登录态，返回当前账号名。
**其它工具报 need_login 时先跑这个。**

### `zhihu_profile`

账号画像。

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `user` | string | 主页 URL / url_token / `@名字` / 32 位内部 hash |
| `format` | `json` \| `markdown` | 默认 json |

返回：`id`（内部 hash）、`url_token`、`name`、`headline`、`description`、
`follower_count`、`following_count`、`answer_count`、`articles_count`、
`voteup_count`、`thanked_count`、`favorited_count`、`badges`（认证）、
`is_realname`、`is_org`、`ip_info`。

输入中文名时会自动走 people 搜索并返回候选列表。

### `zhihu_user_activity`

用户动态（回答 + 文章）。

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `user` | string | 同上 |
| `count` | number | 默认 10，上限 200 |
| `kind` | `all` \| `answers` \| `articles` | 默认 all |
| `include_content` | boolean | 是否带正文 Markdown，默认 false |
| `include_stats` | boolean | 是否逐条补全准确赞数，默认 false（每条约 1–2s） |
| `format` | `json` \| `markdown` | 默认 markdown |
| `save_to_file` | string? | 落盘路径 |

**这是判断「内容半径」的主工具**：拿最近 N 条动态的标题 + 日期。

### `zhihu_network`

关注列表 / 粉丝列表。

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `user` | string | 同上 |
| `kind` | `followees` \| `followers` | 默认 followees |
| `max_count` | number | 默认 50，上限 2000 |
| `delay_ms` | number | 默认 1200 |
| `format` | `json` \| `markdown` | 默认 json |

返回 `totals`（准确总数）与成员列表。
注意：该接口**不返回成员的粉丝数/回答数**，需要精确统计时对具体账号再调 `zhihu_profile`。

### `zhihu_answer_comments`

回答 / 文章的评论。

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `target` | string | 回答 URL、`/answer/<id>`、专栏 URL 或纯数字 id |
| `max_count` | number | 默认 50，上限 2000 |
| `order` | `normal` \| `reverse` | normal=最早在前，reverse=最新在前（抓近期爆发用 reverse） |
| `delay_ms` | number | 默认 1200 |
| `format` | `markdown` \| `json` | 默认 markdown |
| `save_to_file` | string? | 落盘路径 |

每条评论返回：`content`、`created_time`、`vote_count`、`author`、
`author_url_token`、`author_headline`、`author_badges`、
`is_self`、`is_post_author`、`reply_to`、`ip`。

### `zhihu_search`

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `query` | string | 关键词 |
| `type` | `general` \| `content` \| `people` | 默认 general |
| `max_count` | number | 默认 20，上限 500 |
| `delay_ms` | number | 默认 1200 |
| `format` | `markdown` \| `json` | 默认 markdown |

`type=content` 实测常返回空，**用 `general`**。返回项含 `type`（answer/article/question/people）、
`title`、`author`、`author_url_token`、`voteup_count`、`created_time`、`url`。

**这是 Phase 2「提及面扫描」的核心工具。**

### `zhihu_question_answers`

一个问题下的**全部回答正文**。

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `question_url` | string | 问题 URL 或纯数字 id |
| `max_count` | number | 默认 20，上限 500 |
| `delay_ms` | number | 默认 1200 |
| `format` | `markdown` \| `json` | 默认 markdown |
| `save_to_file` | string? | 落盘路径 |

每条回答含 `content_md`、`voteup_count`、`comment_count`、`created_time`、
`author`、`author_url`。**该接口的赞数是可靠的**（与页面一致）。

### `zhihu_followees` / `zhihu_user_posts`

兼容封装，分别等价于 `zhihu_network(kind=followees)` 和 `zhihu_user_activity`。
新代码建议直接用后者。`zhihu_user_posts` 的 `vote_count` 恒为 `null`
（底层接口不返回赞数），需要赞数请用 `zhihu_user_activity` 的 `include_stats`。

---

## 三个必须知道的坑

### 1. 知乎有两套用户 ID

| 来源 | 黄彦臻的标识 |
| --- | --- |
| 回答正文里的 `@` 链接 | `57fcf79614feeea015b395a3022bd10f`（32 位内部 hash） |
| v4 API 的 `author.url_token` / 关注列表 | `huang-wei-yan-30`（自定义 token） |

正文 @ 提及用的是 hash，关注图用的是 token，**两者无法直接 join**。
`/api/v4/members/<hash>` 与 `/api/v4/members/<token>` 都能解析，返回对象同时含
`id` 与 `url_token`，用 `zhihu_profile` 即可完成映射。

### 2. 赞同数不是所有接口都给

| 接口 | 赞数 |
| --- | --- |
| `/api/v4/questions/<qid>/answers?include=...voteup_count...` | ✅ |
| `/api/v4/search_v3` | ✅ |
| `/api/v4/members/<token>/answers` | ❌ **不返回**（四种 include 变体均无效） |
| `/api/v4/answers/<id>` | ❌ 不返回 |

该接口只给 `reaction.statistics`，但 `like_count` **不是赞同数**
（实测 365 赞的回答显示 `like_count=8`）。**不要拿它当赞数用。**

需要准确赞数：用 `zhihu_user_activity` 的 `include_stats: true`，
逐条打开回答页读 `js-initialData.entities.answers[id].voteupCount`。

### 3. `is_author` 不是「本文作者」

`/api/v4/answers/<id>/comments` 返回的 `is_author` 表示
**该评论由当前登录账号所发**，不是「评论者是本文作者」。工具已拆成：

- `is_self` —— 当前登录账号所发（原 `is_author`）
- `is_post_author` —— 与本文作者 token 比对得出

另外 `paging.totals` 是接口自报值，与实际返回条目数可能不一致
（扁平评论接口会同时返回根评论和回复，实测 `totals=21` 但实际 23 条）。报告中要注明。
