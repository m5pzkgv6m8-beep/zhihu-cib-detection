import { BrowserContext } from "playwright";
import { htmlToMarkdown } from "../extractor.js";

function extractGroupId(url: string): string | null {
  const m = url.match(/group\/(\d+)/);
  return m ? m[1] : null;
}

function extractTopicId(url: string): string | null {
  const m = url.match(/topic\/(\d+)/);
  return m ? m[1] : null;
}

interface ZsxqOwner {
  user_id?: number;
  name?: string;
  alias?: string;
  location?: string;
}

interface ZsxqTopic {
  topic_id?: number;
  create_time?: string;
  type?: string;
  talk?: { owner?: ZsxqOwner; text?: string; images?: { large?: { url?: string } }[] };
  question?: { owner?: ZsxqOwner; text?: string };
  answer?: { owner?: ZsxqOwner; text?: string };
  owner?: ZsxqOwner;
  likes_count?: number;
  comments_count?: number;
}

function getAuthor(t: ZsxqTopic): string {
  const o = t.talk?.owner ?? t.question?.owner ?? t.owner;
  return o?.alias ?? o?.name ?? "未知";
}

function formatTopic(t: ZsxqTopic): string {
  const parts: string[] = [];
  const author = getAuthor(t);
  const time = t.create_time?.replace("T", " ").replace(/\+.*/, "") ?? "";
  parts.push(`### ${author}  ${time}`);

  if (t.talk?.text) parts.push(t.talk.text);
  if (t.question?.text) parts.push(`**提问：** ${t.question.text}`);
  if (t.answer?.text) {
    const answerer = t.answer.owner?.alias ?? t.answer.owner?.name ?? "";
    parts.push(`**${answerer} 回答：** ${t.answer.text}`);
  }
  if (t.talk?.images?.length) {
    for (const img of t.talk.images) {
      if (img.large?.url) parts.push(`![image](${img.large.url})`);
    }
  }

  const meta: string[] = [];
  if (t.likes_count) meta.push(`${t.likes_count} 赞`);
  if (t.comments_count) meta.push(`${t.comments_count} 评论`);
  if (meta.length) parts.push(meta.join(" | "));
  return parts.join("\n\n");
}

export async function extractZsxq(
  ctx: BrowserContext,
  url: string
): Promise<string> {
  const groupId = extractGroupId(url);
  const topicId = extractTopicId(url);

  const headers: Record<string, string> = {
    accept: "application/json, text/plain, */*",
    origin: "https://wx.zsxq.com",
    referer: "https://wx.zsxq.com/",
    "x-version": "2.91.0",
  };

  // 单个主题
  if (topicId) {
    try {
      const resp = await ctx.request.get(
        `https://api.zsxq.com/v2/topics/${topicId}`,
        { headers }
      );
      if (resp.ok()) {
        const data = await resp.json();
        if (data.resp_data?.topic) {
          return formatTopic(data.resp_data.topic);
        }
      }
      return `[API 错误] status: ${resp.status()}, body: ${(await resp.text()).slice(0, 500)}`;
    } catch (e) {
      return `[请求失败] ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  // 星球主题列表
  if (groupId) {
    for (const scope of ["all", "by_owner"]) {
      try {
        const resp = await ctx.request.get(
          `https://api.zsxq.com/v2/groups/${groupId}/topics?scope=${scope}&count=20`,
          { headers }
        );
        if (resp.ok()) {
          const data = await resp.json();
          if (data.resp_data?.topics?.length) {
            return data.resp_data.topics.map(formatTopic).join("\n\n---\n\n");
          }
        }
      } catch {
        continue;
      }
    }

    // 返回错误详情
    try {
      const resp = await ctx.request.get(
        `https://api.zsxq.com/v2/groups/${groupId}/topics?scope=all&count=20`,
        { headers }
      );
      return `[API 错误] status: ${resp.status()}, body: ${(await resp.text()).slice(0, 500)}`;
    } catch (e) {
      return `[请求失败] ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  return `[无法解析] URL: ${url}，未识别到 group_id 或 topic_id。`;
}
