#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { z } from "zod";
import { XApiClient } from "./x-api.js";
import { parseTweetId, errorMessage, formatResult, isColdReplyBlocked, buildIntentUrl } from "./helpers.js";
import { encode } from "./toon.js";
import { loadState, saveState, type StateFile, type QueueItem } from "./state.js";
import {
  loadBudgetConfig,
  formatBudgetString,
  checkBudget,
  checkDedup,
  recordAction,
  getParameterHint,
  isWriteTool,
  loadProtectedAccounts,
  isProtectedAccount,
} from "./safety.js";
import {
  processWorkflows,
  submitTaskResponse,
  createWorkflow,
  getWorkflowStatus,
  cleanupNonFollowers,
} from "./workflow.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env") });

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}. See .env.example for required variables.`);
  }
  return value;
}

const client = new XApiClient({
  apiKey: requireEnv("X_API_KEY"),
  apiSecret: requireEnv("X_API_SECRET"),
  accessToken: requireEnv("X_ACCESS_TOKEN"),
  accessTokenSecret: requireEnv("X_ACCESS_TOKEN_SECRET"),
  bearerToken: requireEnv("X_BEARER_TOKEN"),
});

// --- Safety feature configuration ---

const statePath = process.env.X_MCP_STATE_FILE
  || path.resolve(process.cwd(), "x-mcp-state.json");
const budgetConfig = loadBudgetConfig();
const compactMode = process.env.X_MCP_COMPACT !== "false"; // default true
const dedupEnabled = process.env.X_MCP_DEDUP !== "false"; // default true
const toonEnabled = process.env.X_MCP_TOON !== "false"; // default true
const protectedAccounts = loadProtectedAccounts();

/** Format workflow tool output — uses TOON when enabled, otherwise JSON. */
function formatWorkflowOutput(data: Record<string, unknown>): string {
  return toonEnabled ? encode(data) : JSON.stringify(data, null, 2);
}

/**
 * Resolve protected account usernames to numeric IDs (one API call each).
 * After this, isProtectedAccount matches both usernames and numeric IDs.
 */
async function resolveProtectedAccountIds(): Promise<void> {
  for (const account of protectedAccounts) {
    try {
      const userId = await client.resolveUserId(account.username);
      if (userId && userId !== account.username) {
        account.userId = userId;
      }
    } catch {
      // If resolution fails, username-based check still works
    }
  }
}

// --- MCP server ---

const server = new McpServer({
  name: "x-autonomous-mcp",
  version: "0.1.0",
});

// --- Valid parameter keys per tool (for Levenshtein suggestions) ---

const VALID_KEYS: Record<string, string[]> = {
  post_tweet: ["text", "poll_options", "poll_duration_minutes", "media_ids"],
  reply_to_tweet: ["tweet_id", "text", "media_ids"],
  quote_tweet: ["tweet_id", "text", "media_ids"],
  delete_tweet: ["tweet_id"],
  get_tweet: ["tweet_id"],
  search_tweets: ["query", "max_results", "min_likes", "min_retweets", "sort_order", "since_id", "next_token"],
  get_user: ["username", "user_id"],
  get_timeline: ["user", "max_results", "next_token"],
  get_mentions: ["max_results", "since_id", "next_token"],
  get_followers: ["user", "max_results", "next_token"],
  get_following: ["user", "max_results", "next_token"],
  follow_user: ["user"],
  unfollow_user: ["user"],
  get_non_followers: ["max_pages"],
  like_tweet: ["tweet_id"],
  retweet: ["tweet_id"],
  unlike_tweet: ["tweet_id"],
  unretweet: ["tweet_id"],
  upload_media: ["media_data", "mime_type", "media_category"],
  get_metrics: ["tweet_id"],
  get_list_members: ["list_id", "max_results", "next_token"],
  get_list_tweets: ["list_id", "max_results", "next_token"],
  get_followed_lists: ["max_results", "next_token"],
  get_next_task: [],
  submit_task: ["workflow_id", "response"],
  start_workflow: ["type", "target", "reply_tweet_id"],
  get_workflow_status: ["type", "include_completed"],
  cleanup_non_followers: ["max_unfollow", "max_pages"],
  get_queue: ["status"],
  complete_queue_item: ["queue_id", "action"],
};

// --- Handler wrapper ---
// Centralizes: state loading, budget checks, dedup checks, action recording,
// response formatting (compact + budget string), and error handling.

interface WrapOptions {
  getTargetTweetId?: (args: Record<string, unknown>) => string | Promise<string>;
  postProcess?: (result: unknown, state: StateFile) => void;
}

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

function wrapHandler(
  toolName: string,
  handler: (args: Record<string, unknown>, resolvedTargetId: string | undefined, state: StateFile) => Promise<{ result: unknown; rateLimit: string }>,
  opts?: WrapOptions,
): (args: Record<string, unknown>) => Promise<ToolResult> {
  return async (args) => {
    try {
      // Unknown parameter check with Levenshtein suggestions
      const validKeys = VALID_KEYS[toolName];
      if (validKeys) {
        const unknownKeys = Object.keys(args).filter((k) => !validKeys.includes(k));
        if (unknownKeys.length > 0) {
          const hints = unknownKeys
            .map((k) => {
              const hint = getParameterHint(toolName, k, validKeys);
              return hint ? `Unknown parameter '${k}': ${hint}` : `Unknown parameter '${k}'.`;
            })
            .join("\n");
          const state = loadState(statePath);
          const budgetString = formatBudgetString(state, budgetConfig);
          return {
            content: [{ type: "text", text: `Error: ${hints}\n\nValid parameters for ${toolName}: ${validKeys.join(", ")}\n\nCurrent x_budget: ${budgetString}` }],
            isError: true,
          };
        }
      }

      const state = loadState(statePath);

      // Budget check (write tools only)
      const budgetError = checkBudget(toolName, state, budgetConfig);
      if (budgetError) {
        const budgetString = formatBudgetString(state, budgetConfig);
        return {
          content: [{ type: "text", text: `Error: ${budgetError}\n\nCurrent x_budget: ${budgetString}` }],
          isError: true,
        };
      }

      // Dedup check (engagement tools only) — also resolves tweet ID once
      const targetId = opts?.getTargetTweetId ? await opts.getTargetTweetId(args) : undefined;
      if (dedupEnabled && targetId) {
        const dedupError = checkDedup(toolName, targetId, state);
        if (dedupError) {
          const budgetString = formatBudgetString(state, budgetConfig);
          return {
            content: [{ type: "text", text: `Error: ${dedupError}\n\nCurrent x_budget: ${budgetString}` }],
            isError: true,
          };
        }
      }

      // Execute the actual API call, passing resolved ID and state
      const { result, rateLimit } = await handler(args, targetId, state);

      // Record action for write tools
      if (isWriteTool(toolName)) {
        recordAction(toolName, targetId ?? null, state);
      }

      // Post-process hook (e.g. get_mentions populating mentioned_by)
      if (opts?.postProcess) {
        opts.postProcess(result, state);
      }

      // Save state if anything mutated it
      if (isWriteTool(toolName) || opts?.postProcess) {
        saveState(statePath, state);
      }

      // Format response with budget string and compact mode
      const budgetString = formatBudgetString(state, budgetConfig);
      return {
        content: [{ type: "text", text: formatResult(result, rateLimit, budgetString, compactMode, toonEnabled) }],
      };
    } catch (e: unknown) {
      // Include budget in error responses when possible
      try {
        const state = loadState(statePath);
        const budgetString = formatBudgetString(state, budgetConfig);
        return {
          content: [{ type: "text", text: `Error: ${errorMessage(e)}\n\nCurrent x_budget: ${budgetString}` }],
          isError: true,
        };
      } catch {
        return {
          content: [{ type: "text", text: `Error: ${errorMessage(e)}` }],
          isError: true,
        };
      }
    }
  };
}

// ============================================================
// TWEET TOOLS
// ============================================================

server.registerTool(
  "post_tweet",
  {
    description: "Create a new post on X (Twitter). Supports text, polls, and media attachments. To REPLY to a tweet, use reply_to_tweet instead.",
    inputSchema: z.object({
      text: z.string().describe("The text content of the tweet"),
      poll_options: z.array(z.string()).min(2).max(4).optional().describe("Poll options (2-4 choices)"),
      poll_duration_minutes: z.number().int().min(1).max(10080).optional().describe("Poll duration in minutes (1-10080, default 1440 = 24h)"),
      media_ids: z.array(z.string()).optional().describe("Media IDs to attach (from upload_media)"),
    }).passthrough(),
  },
  wrapHandler("post_tweet", async (args, _resolvedId, state) => {
    const text = args.text as string;

    // Detect @mentions — X blocks these in standalone posts
    const mentionMatches = text.match(/@\w{1,15}/g);
    if (mentionMatches && mentionMatches.length > 0) {
      const intentUrl = buildIntentUrl({ text });
      const itemId = `q:post-${Date.now()}`;
      const item: QueueItem = {
        id: itemId, type: "mention_post", status: "pending",
        created_at: new Date().toISOString(),
        text, intent_url: intentUrl, source_tool: "post_tweet",
      };
      state.queue.push(item);
      return { result: { queued: true, queue_id: itemId, intent_url: intentUrl, message: `Post with mentions queued for manual posting. Mentions: ${mentionMatches.join(", ")}` }, rateLimit: "" };
    }

    return client.postTweet({
      text,
      poll_options: args.poll_options as string[] | undefined,
      poll_duration_minutes: args.poll_duration_minutes as number | undefined,
      media_ids: args.media_ids as string[] | undefined,
    });
  }),
);

server.registerTool(
  "reply_to_tweet",
  {
    description: "Reply to an existing post on X. Provide the tweet ID or URL to reply to.",
    inputSchema: z.object({
      tweet_id: z.string().describe("The tweet ID or URL to reply to"),
      text: z.string().describe("The reply text"),
      media_ids: z.array(z.string()).optional().describe("Media IDs to attach"),
    }).passthrough(),
  },
  wrapHandler("reply_to_tweet", async (args, resolvedId, state) => {
    const tweetId = resolvedId!;
    const text = args.text as string;
    const mediaIds = args.media_ids as string[] | undefined;

    // Resolve target tweet author to check mentioned_by cache
    let authorId: string | undefined;
    let authorUsername: string | undefined;
    let targetTextSnippet: string | undefined;
    try {
      const { result: tweetData } = await client.getTweet(tweetId);
      const data = tweetData as { data?: { author_id?: string; text?: string }; includes?: { users?: Array<{ id: string; username: string }> } };
      authorId = data?.data?.author_id;
      targetTextSnippet = data?.data?.text?.slice(0, 100);
      if (authorId && data?.includes?.users) {
        const user = data.includes.users.find((u) => u.id === authorId);
        if (user) authorUsername = `@${user.username}`;
      }
    } catch {
      // getTweet failure — fall through to queue path
    }

    const canReply = authorId ? state.mentioned_by.includes(authorId) : false;

    if (canReply) {
      // Author has mentioned us — try direct reply
      try {
        return await client.postTweet({ text, reply_to: tweetId, media_ids: mediaIds });
      } catch (err) {
        if (isColdReplyBlocked(err)) {
          // Stale cache — queue for manual posting
          const intentUrl = buildIntentUrl({ text, in_reply_to: tweetId });
          const item: QueueItem = {
            id: `q:${tweetId}`, type: "cold_reply", status: "pending",
            created_at: new Date().toISOString(),
            target_tweet_id: tweetId, target_author: authorUsername,
            target_text_snippet: targetTextSnippet,
            text, intent_url: intentUrl, source_tool: "reply_to_tweet",
          };
          if (!state.queue.some((q) => q.id === item.id && q.status === "pending")) {
            state.queue.push(item);
          }
          return { result: { queued: true, queue_id: item.id, intent_url: intentUrl, message: "Cold reply queued for manual posting." }, rateLimit: "" };
        }
        throw err;
      }
    } else {
      // Author hasn't mentioned us — queue for manual posting
      const intentUrl = buildIntentUrl({ text, in_reply_to: tweetId });
      const item: QueueItem = {
        id: `q:${tweetId}`, type: "cold_reply", status: "pending",
        created_at: new Date().toISOString(),
        target_tweet_id: tweetId, target_author: authorUsername,
        target_text_snippet: targetTextSnippet,
        text, intent_url: intentUrl, source_tool: "reply_to_tweet",
      };
      if (!state.queue.some((q) => q.id === item.id && q.status === "pending")) {
        state.queue.push(item);
      }
      return { result: { queued: true, queue_id: item.id, intent_url: intentUrl, message: "Cold reply queued for manual posting." }, rateLimit: "" };
    }
  }, { getTargetTweetId: (args) => parseTweetId(args.tweet_id as string) }),
);

server.registerTool(
  "quote_tweet",
  {
    description: "Quote retweet a post on X. Adds your commentary above the quoted post.",
    inputSchema: z.object({
      tweet_id: z.string().describe("The tweet ID or URL to quote"),
      text: z.string().describe("Your commentary text"),
      media_ids: z.array(z.string()).optional().describe("Media IDs to attach"),
    }).passthrough(),
  },
  wrapHandler("quote_tweet", async (args, resolvedId) => {
    return client.postTweet({
      text: args.text as string,
      quote_tweet_id: resolvedId!,
      media_ids: args.media_ids as string[] | undefined,
    });
  }, { getTargetTweetId: (args) => parseTweetId(args.tweet_id as string) }),
);

server.registerTool(
  "delete_tweet",
  {
    description: "Delete a post on X by its ID. Budget-limited (default 5/day). Set X_MCP_MAX_DELETES=0 to disable.",
    inputSchema: z.object({
      tweet_id: z.string().describe("The tweet ID or URL to delete"),
    }).passthrough(),
  },
  wrapHandler("delete_tweet", async (args) => {
    const id = parseTweetId(args.tweet_id as string);
    return client.deleteTweet(id);
  }),
);

server.registerTool(
  "get_tweet",
  {
    description: "Fetch a tweet and its metadata by ID or URL. Returns author info, metrics, and referenced tweets.",
    inputSchema: z.object({
      tweet_id: z.string().describe("The tweet ID or URL to fetch"),
    }).passthrough(),
  },
  wrapHandler("get_tweet", async (args) => {
    const id = parseTweetId(args.tweet_id as string);
    return client.getTweet(id);
  }),
);

// ============================================================
// SEARCH
// ============================================================

server.registerTool(
  "search_tweets",
  {
    description: "Search recent tweets by query. Supports keywords, hashtags, from:user, to:user, is:reply, has:media, etc. Uses the recent search endpoint (last 7 days). Use min_likes/min_retweets to filter for high-engagement tweets only. Use sort_order=relevancy to surface popular tweets first.",
    inputSchema: z.object({
      query: z.string().describe("Search query (e.g. 'from:elonmusk', '#ai', 'machine learning')"),
      max_results: z.number().optional().describe("Number of results to return (10-100, default 10)"),
      min_likes: z.number().optional().describe("Only return tweets with at least this many likes"),
      min_retweets: z.number().optional().describe("Only return tweets with at least this many retweets"),
      sort_order: z.enum(["recency", "relevancy"]).optional().describe("Sort order: 'recency' (default) or 'relevancy' (popular first)"),
      since_id: z.string().optional().describe("Only return tweets newer than this tweet ID (for incremental polling)"),
      next_token: z.string().optional().describe("Pagination token from previous response"),
    }).passthrough(),
  },
  wrapHandler("search_tweets", async (args) => {
    return client.searchTweets(
      args.query as string,
      args.max_results as number | undefined,
      args.next_token as string | undefined,
      {
        minLikes: args.min_likes as number | undefined,
        minRetweets: args.min_retweets as number | undefined,
        sortOrder: args.sort_order as string | undefined,
        sinceId: args.since_id as string | undefined,
      },
    );
  }),
);

// ============================================================
// USER TOOLS
// ============================================================

server.registerTool(
  "get_user",
  {
    description: "Look up a user profile by username or user ID. Returns bio, metrics, verification status, etc.",
    inputSchema: z.object({
      username: z.string().optional().describe("Username (without @)"),
      user_id: z.string().optional().describe("Numeric user ID"),
    }).passthrough(),
  },
  async (args) => {
    if (!args.username && !args.user_id) {
      const state = loadState(statePath);
      const budgetString = formatBudgetString(state, budgetConfig);
      return { content: [{ type: "text" as const, text: `Error: Provide either username or user_id\n\nCurrent x_budget: ${budgetString}` }], isError: true };
    }
    return wrapHandler("get_user", async (a) => {
      return client.getUser({
        username: a.username as string | undefined,
        userId: a.user_id as string | undefined,
      });
    })(args as Record<string, unknown>);
  },
);

server.registerTool(
  "get_timeline",
  {
    description: "Fetch a user's recent posts. Accepts a username or numeric user ID.",
    inputSchema: z.object({
      user: z.string().describe("Username (with or without @) or numeric user ID"),
      max_results: z.number().optional().describe("Number of results (5-100, default 10)"),
      next_token: z.string().optional().describe("Pagination token from previous response"),
    }).passthrough(),
  },
  wrapHandler("get_timeline", async (args) => {
    const userId = await client.resolveUserId(args.user as string);
    return client.getTimeline(
      userId,
      args.max_results as number | undefined,
      args.next_token as string | undefined,
    );
  }),
);

server.registerTool(
  "get_mentions",
  {
    description: "Fetch recent mentions of the authenticated user. Use since_id to only get new mentions since last check (saves tokens).",
    inputSchema: z.object({
      max_results: z.number().optional().describe("Number of results (5-100, default 10)"),
      since_id: z.string().optional().describe("Only return mentions newer than this tweet ID (for incremental polling)"),
      next_token: z.string().optional().describe("Pagination token from previous response"),
    }).passthrough(),
  },
  wrapHandler("get_mentions", async (args) => {
    return client.getMentions(
      args.max_results as number | undefined,
      args.next_token as string | undefined,
      args.since_id as string | undefined,
    );
  }, {
    postProcess: (result, state) => {
      // Extract author_ids from mentions and add to mentioned_by cache
      const data = result as { data?: Array<{ author_id?: string }> };
      if (data?.data && Array.isArray(data.data)) {
        for (const tweet of data.data) {
          if (tweet.author_id && !state.mentioned_by.includes(tweet.author_id)) {
            state.mentioned_by.push(tweet.author_id);
          }
        }
        // Cap at 10,000 entries (drop oldest)
        if (state.mentioned_by.length > 10_000) {
          state.mentioned_by = state.mentioned_by.slice(-10_000);
        }
      }
    },
  }),
);

server.registerTool(
  "get_followers",
  {
    description: "List followers of a user. Accepts a username or numeric user ID.",
    inputSchema: z.object({
      user: z.string().describe("Username (with or without @) or numeric user ID"),
      max_results: z.number().optional().describe("Number of results (1-1000, default 100)"),
      next_token: z.string().optional().describe("Pagination token from previous response"),
    }).passthrough(),
  },
  wrapHandler("get_followers", async (args) => {
    const userId = await client.resolveUserId(args.user as string);
    return client.getFollowers(
      userId,
      args.max_results as number | undefined,
      args.next_token as string | undefined,
    );
  }),
);

server.registerTool(
  "get_following",
  {
    description: "List who a user follows. Accepts a username or numeric user ID.",
    inputSchema: z.object({
      user: z.string().describe("Username (with or without @) or numeric user ID"),
      max_results: z.number().optional().describe("Number of results (1-1000, default 100)"),
      next_token: z.string().optional().describe("Pagination token from previous response"),
    }).passthrough(),
  },
  wrapHandler("get_following", async (args) => {
    const userId = await client.resolveUserId(args.user as string);
    return client.getFollowing(
      userId,
      args.max_results as number | undefined,
      args.next_token as string | undefined,
    );
  }),
);

// ============================================================
// ENGAGEMENT TOOLS
// ============================================================

server.registerTool(
  "like_tweet",
  {
    description: "Like a post on X.",
    inputSchema: z.object({
      tweet_id: z.string().describe("The tweet ID or URL to like"),
    }).passthrough(),
  },
  wrapHandler("like_tweet", async (_args, resolvedId) => {
    return client.likeTweet(resolvedId!);
  }, { getTargetTweetId: (args) => parseTweetId(args.tweet_id as string) }),
);

server.registerTool(
  "retweet",
  {
    description: "Retweet a post on X.",
    inputSchema: z.object({
      tweet_id: z.string().describe("The tweet ID or URL to retweet"),
    }).passthrough(),
  },
  wrapHandler("retweet", async (_args, resolvedId) => {
    return client.retweet(resolvedId!);
  }, { getTargetTweetId: (args) => parseTweetId(args.tweet_id as string) }),
);

// ============================================================
// FOLLOW / UNFOLLOW
// ============================================================

server.registerTool(
  "follow_user",
  {
    description: "Follow a user on X. Accepts a username or numeric user ID. Budget-limited. Dedup-tracked — won't follow the same user twice.",
    inputSchema: z.object({
      user: z.string().describe("Username (with or without @) or numeric user ID"),
    }).passthrough(),
  },
  wrapHandler("follow_user", async (_args, resolvedId) => {
    return client.followUser(resolvedId!);
  }, { getTargetTweetId: async (args) => {
    // Reuse dedup system — "tweet_id" slot holds user_id for follow dedup
    return client.resolveUserId(args.user as string);
  } }),
);

server.registerTool(
  "unfollow_user",
  {
    description: "Unfollow a user on X. Accepts a username or numeric user ID. Budget-limited (default 10/day). Protected accounts (X_MCP_PROTECTED_ACCOUNTS) are blocked. Set X_MCP_MAX_UNFOLLOWS=0 to disable.",
    inputSchema: z.object({
      user: z.string().describe("Username (with or without @) or numeric user ID"),
    }).passthrough(),
  },
  async (args) => {
    try {
      const userRef = args.user as string;
      // Protected accounts set contains both usernames and resolved numeric IDs
      // (resolved once at startup by resolveProtectedAccountIds)
      if (isProtectedAccount(userRef, protectedAccounts)) {
        const state = loadState(statePath);
        const budgetString = formatBudgetString(state, budgetConfig);
        return {
          content: [{ type: "text" as const, text: `Error: @${userRef.replace(/^@/, "")} is a protected account. Cannot unfollow.\n\nCurrent x_budget: ${budgetString}` }],
          isError: true,
        };
      }
      return wrapHandler("unfollow_user", async (a) => {
        const userId = await client.resolveUserId(a.user as string);
        return client.unfollowUser(userId);
      })(args as Record<string, unknown>);
    } catch (e: unknown) {
      return {
        content: [{ type: "text" as const, text: `Error: ${errorMessage(e)}` }],
        isError: true,
      };
    }
  },
);

server.registerTool(
  "get_non_followers",
  {
    description: "Find accounts you follow that don't follow you back. Returns a list sorted by follower count (lowest first = best unfollow candidates). Fetches up to 5 pages of following/followers — covers up to 5000 accounts.",
    inputSchema: z.object({
      max_pages: z.number().optional().describe("Max pages to fetch per list (default 5, each page = 1000 users)"),
    }).passthrough(),
  },
  wrapHandler("get_non_followers", async (args) => {
    return client.getNonFollowers(args.max_pages as number | undefined);
  }),
);

// ============================================================
// MEDIA
// ============================================================

server.registerTool(
  "upload_media",
  {
    description: "Upload an image or video to X. Returns a media_id that can be attached to posts. Provide the file as base64-encoded data.",
    inputSchema: z.object({
      media_data: z.string().describe("Base64-encoded media file data"),
      mime_type: z.string().describe("MIME type (e.g. 'image/png', 'image/jpeg', 'video/mp4')"),
      media_category: z.string().optional().describe("Category: 'tweet_image', 'tweet_gif', or 'tweet_video' (default: tweet_image)"),
    }).passthrough(),
  },
  wrapHandler("upload_media", async (args) => {
    const { mediaId, rateLimit } = await client.uploadMedia(
      args.media_data as string,
      args.mime_type as string,
      (args.media_category as string) || "tweet_image",
    );
    return {
      result: { media_id: mediaId, message: "Upload complete. Use this media_id in post_tweet." },
      rateLimit,
    };
  }),
);

// ============================================================
// METRICS
// ============================================================

server.registerTool(
  "get_metrics",
  {
    description: "Get engagement metrics for a specific post (impressions, likes, retweets, replies, quotes, bookmarks). Requires the tweet to be authored by the authenticated user for non-public metrics.",
    inputSchema: z.object({
      tweet_id: z.string().describe("The tweet ID or URL to get metrics for"),
    }).passthrough(),
  },
  wrapHandler("get_metrics", async (args) => {
    const id = parseTweetId(args.tweet_id as string);
    return client.getTweetMetrics(id);
  }),
);

// ============================================================
// UNDO TOOLS
// ============================================================

server.registerTool(
  "unlike_tweet",
  {
    description: "Unlike a previously liked post on X.",
    inputSchema: z.object({
      tweet_id: z.string().describe("The tweet ID or URL to unlike"),
    }).passthrough(),
  },
  wrapHandler("unlike_tweet", async (args) => {
    const id = parseTweetId(args.tweet_id as string);
    return client.unlikeTweet(id);
  }),
);

server.registerTool(
  "unretweet",
  {
    description: "Remove a retweet on X.",
    inputSchema: z.object({
      tweet_id: z.string().describe("The tweet ID or URL to unretweet"),
    }).passthrough(),
  },
  wrapHandler("unretweet", async (args) => {
    const id = parseTweetId(args.tweet_id as string);
    return client.unretweet(id);
  }),
);

// ============================================================
// LIST TOOLS
// ============================================================

server.registerTool(
  "get_list_members",
  {
    description: "Get members of a Twitter/X list. Returns user profiles with follower counts.",
    inputSchema: z.object({
      list_id: z.string().describe("The list ID"),
      max_results: z.number().optional().describe("Number of results (1-100, default 100)"),
      next_token: z.string().optional().describe("Pagination token from previous response"),
    }).passthrough(),
  },
  wrapHandler("get_list_members", async (args) => {
    return client.getListMembers(
      args.list_id as string,
      args.max_results as number | undefined,
      args.next_token as string | undefined,
    );
  }),
);

server.registerTool(
  "get_list_tweets",
  {
    description: "Get recent tweets from a Twitter/X list. Returns tweets with author info and metrics.",
    inputSchema: z.object({
      list_id: z.string().describe("The list ID"),
      max_results: z.number().optional().describe("Number of results (1-100, default 100)"),
      next_token: z.string().optional().describe("Pagination token from previous response"),
    }).passthrough(),
  },
  wrapHandler("get_list_tweets", async (args) => {
    return client.getListTweets(
      args.list_id as string,
      args.max_results as number | undefined,
      args.next_token as string | undefined,
    );
  }),
);

server.registerTool(
  "get_followed_lists",
  {
    description: "Get lists the authenticated user follows.",
    inputSchema: z.object({
      max_results: z.number().optional().describe("Number of results (1-100, default 100)"),
      next_token: z.string().optional().describe("Pagination token from previous response"),
    }).passthrough(),
  },
  wrapHandler("get_followed_lists", async (args) => {
    return client.getFollowedLists(
      args.max_results as number | undefined,
      args.next_token as string | undefined,
    );
  }),
);

// ============================================================
// WORKFLOW TOOLS
// ============================================================

server.registerTool(
  "get_next_task",
  {
    description: "MUST be called at the start of every session. The MCP auto-processes all pending workflow steps (follow-backs, cleanups, audits) and returns your next assignment. If nothing is pending, returns status summary.",
    inputSchema: z.object({}).passthrough(),
  },
  async () => {
    try {
      const state = loadState(statePath);
      const result = await processWorkflows(state, client, budgetConfig, protectedAccounts);
      saveState(statePath, state);

      const budgetString = formatBudgetString(state, budgetConfig);
      const output: Record<string, unknown> = {};

      if (result.auto_completed.length > 0) {
        output.auto_completed = result.auto_completed.join("\n");
      }
      if (result.next_task) {
        output.next_task = result.next_task;
      }
      output.status = result.status;
      output.x_budget = budgetString;

      return {
        content: [{ type: "text" as const, text: formatWorkflowOutput(output) }],
      };
    } catch (e: unknown) {
      return {
        content: [{ type: "text" as const, text: `Error: ${errorMessage(e)}` }],
        isError: true,
      };
    }
  },
);

server.registerTool(
  "submit_task",
  {
    description: "Submit your response to the MCP's workflow request. After submitting, call get_next_task for your next assignment.",
    inputSchema: z.object({
      workflow_id: z.string().describe("The workflow ID from the task assignment"),
      response: z.record(z.string()).describe("Your response (e.g. { reply_text: '...' })"),
    }).passthrough(),
  },
  async (args) => {
    try {
      const state = loadState(statePath);
      const { error } = submitTaskResponse(
        state,
        args.workflow_id as string,
        args.response as Record<string, string>,
      );

      if (error) {
        const budgetString = formatBudgetString(state, budgetConfig);
        return {
          content: [{ type: "text" as const, text: `Error: ${error}\n\nCurrent x_budget: ${budgetString}` }],
          isError: true,
        };
      }

      // Auto-advance after submit
      const result = await processWorkflows(state, client, budgetConfig, protectedAccounts);
      saveState(statePath, state);

      const budgetString = formatBudgetString(state, budgetConfig);
      const output: Record<string, unknown> = {
        result: `Task submitted for workflow ${args.workflow_id}.`,
      };
      if (result.auto_completed.length > 0) {
        output.auto_completed = result.auto_completed.join("\n");
      }
      if (result.next_task) {
        output.next_task = result.next_task;
      }
      output.status = result.status;
      output.x_budget = budgetString;

      return {
        content: [{ type: "text" as const, text: formatWorkflowOutput(output) }],
      };
    } catch (e: unknown) {
      return {
        content: [{ type: "text" as const, text: `Error: ${errorMessage(e)}` }],
        isError: true,
      };
    }
  },
);

server.registerTool(
  "start_workflow",
  {
    description: "Begin a new workflow. For follow_cycle: auto-follows, likes pinned, fetches timeline, then returns reply prompt. For reply_track: creates a tracking entry for a reply already posted (requires reply_tweet_id).",
    inputSchema: z.object({
      type: z.enum(["follow_cycle", "reply_track"]).describe("Workflow type"),
      target: z.string().describe("Target username (with or without @) or numeric user ID"),
      reply_tweet_id: z.string().optional().describe("Tweet ID of the reply being tracked (required for reply_track)"),
    }).passthrough(),
  },
  async (args) => {
    try {
      const state = loadState(statePath);
      const targetRef = args.target as string;
      const workflowType = args.type as string;

      // Validate required params before making API calls
      let initialContext: Record<string, string> | undefined;
      if (workflowType === "reply_track") {
        const replyTweetId = args.reply_tweet_id as string | undefined;
        if (!replyTweetId) {
          const budgetString = formatBudgetString(state, budgetConfig);
          return {
            content: [{ type: "text" as const, text: `Error: reply_track requires reply_tweet_id parameter.\n\nCurrent x_budget: ${budgetString}` }],
            isError: true,
          };
        }
        initialContext = { reply_tweet_id: replyTweetId };
      }

      const userId = await client.resolveUserId(targetRef);
      // Resolve actual username — don't store numeric ID as username
      let username: string;
      if (/^\d+$/.test(targetRef)) {
        const { result } = await client.getUser({ userId: targetRef });
        const data = result as { data?: { username?: string } };
        username = data.data?.username ?? targetRef;
      } else {
        username = targetRef.replace(/^@/, "");
      }

      const { error } = createWorkflow(state, workflowType, userId, username, initialContext);
      if (error) {
        const budgetString = formatBudgetString(state, budgetConfig);
        return {
          content: [{ type: "text" as const, text: `Error: ${error}\n\nCurrent x_budget: ${budgetString}` }],
          isError: true,
        };
      }

      // Auto-advance the new workflow
      const result = await processWorkflows(state, client, budgetConfig, protectedAccounts);
      saveState(statePath, state);

      const budgetString = formatBudgetString(state, budgetConfig);
      const output: Record<string, unknown> = {
        result: `Workflow ${workflowType} started for @${username}.`,
      };
      if (result.auto_completed.length > 0) {
        output.auto_completed = result.auto_completed.join("\n");
      }
      if (result.next_task) {
        output.next_task = result.next_task;
      }
      output.status = result.status;
      output.x_budget = budgetString;

      return {
        content: [{ type: "text" as const, text: formatWorkflowOutput(output) }],
      };
    } catch (e: unknown) {
      return {
        content: [{ type: "text" as const, text: `Error: ${errorMessage(e)}` }],
        isError: true,
      };
    }
  },
);

server.registerTool(
  "get_workflow_status",
  {
    description: "Show all active workflows with their current step, check-back dates, and outcomes.",
    inputSchema: z.object({
      type: z.string().optional().describe("Filter by workflow type (e.g. 'follow_cycle', 'reply_track')"),
      include_completed: z.boolean().optional().describe("Include completed workflows (default false)"),
    }).passthrough(),
  },
  async (args) => {
    try {
      const state = loadState(statePath);
      const workflows = getWorkflowStatus(
        state,
        args.type as string | undefined,
        (args.include_completed as boolean) ?? false,
      );

      const budgetString = formatBudgetString(state, budgetConfig);
      const summary = workflows.map((w) => ({
        id: w.id,
        type: w.type,
        target: `@${w.target_username}`,
        step: w.current_step,
        check_after: w.check_after,
        actions: w.actions_done,
        outcome: w.outcome,
      }));

      return {
        content: [{ type: "text" as const, text: formatWorkflowOutput({ workflows: summary, count: workflows.length, x_budget: budgetString }) }],
      };
    } catch (e: unknown) {
      return {
        content: [{ type: "text" as const, text: `Error: ${errorMessage(e)}` }],
        isError: true,
      };
    }
  },
);

server.registerTool(
  "cleanup_non_followers",
  {
    description: "Find non-followers and batch-unfollow them. Protected accounts (X_MCP_PROTECTED_ACCOUNTS) are skipped. Budget-limited.",
    inputSchema: z.object({
      max_unfollow: z.number().optional().describe("Maximum accounts to unfollow (default 10)"),
      max_pages: z.number().optional().describe("Max pages to fetch per list (default 5, each page = 1000 users)"),
    }).passthrough(),
  },
  async (args) => {
    try {
      const state = loadState(statePath);
      const result = await cleanupNonFollowers(
        client,
        state,
        budgetConfig,
        protectedAccounts,
        (args.max_unfollow as number) ?? 10,
        (args.max_pages as number) ?? 5,
      );
      saveState(statePath, state);

      const budgetString = formatBudgetString(state, budgetConfig);
      const output: Record<string, unknown> = {
        unfollowed: result.unfollowed,
        skipped: result.skipped,
        x_budget: budgetString,
      };
      if (result.error) output.error = result.error;

      return {
        content: [{ type: "text" as const, text: formatWorkflowOutput(output) }],
      };
    } catch (e: unknown) {
      return {
        content: [{ type: "text" as const, text: `Error: ${errorMessage(e)}` }],
        isError: true,
      };
    }
  },
);

// ============================================================
// QUEUE TOOLS (human-in-the-loop)
// ============================================================

server.registerTool(
  "get_queue",
  {
    description: "Get pending human-in-the-loop queue items. Returns items that need manual posting via X web/app, with pre-generated intent URLs.",
    inputSchema: z.object({
      status: z.enum(["pending", "posted", "skipped", "all"]).optional().describe("Filter by status (default: 'pending')"),
    }).passthrough(),
  },
  async (args) => {
    try {
      const state = loadState(statePath);
      const filterStatus = (args.status as string) ?? "pending";
      const items = filterStatus === "all"
        ? state.queue
        : state.queue.filter((q) => q.status === filterStatus);

      const budgetString = formatBudgetString(state, budgetConfig);
      return {
        content: [{ type: "text" as const, text: formatWorkflowOutput({ queue: items, count: items.length, x_budget: budgetString }) }],
      };
    } catch (e: unknown) {
      return {
        content: [{ type: "text" as const, text: `Error: ${errorMessage(e)}` }],
        isError: true,
      };
    }
  },
);

server.registerTool(
  "complete_queue_item",
  {
    description: "Mark a queued item as posted or skipped by the human. Removes it from the active queue after pruning.",
    inputSchema: z.object({
      queue_id: z.string().describe("The queue item ID to complete"),
      action: z.enum(["posted", "skipped"]).describe("What happened: 'posted' (human posted it) or 'skipped' (human decided not to)"),
    }).passthrough(),
  },
  async (args) => {
    try {
      const state = loadState(statePath);
      const queueId = args.queue_id as string;
      const action = args.action as "posted" | "skipped";

      const item = state.queue.find((q) => q.id === queueId);
      if (!item) {
        const budgetString = formatBudgetString(state, budgetConfig);
        return {
          content: [{ type: "text" as const, text: `Error: Queue item '${queueId}' not found.\n\nCurrent x_budget: ${budgetString}` }],
          isError: true,
        };
      }

      item.status = action;
      saveState(statePath, state);

      const budgetString = formatBudgetString(state, budgetConfig);
      return {
        content: [{ type: "text" as const, text: formatWorkflowOutput({ result: `Queue item ${queueId} marked as ${action}.`, x_budget: budgetString }) }],
      };
    } catch (e: unknown) {
      return {
        content: [{ type: "text" as const, text: `Error: ${errorMessage(e)}` }],
        isError: true,
      };
    }
  },
);

// ============================================================
// START SERVER
// ============================================================

async function main() {
  await resolveProtectedAccountIds();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
