import type { StateFile, EngagedEntry } from "./state.js";

// --- Action type classification ---

type ActionType = "reply" | "original" | "like" | "retweet" | "follow" | "unfollow" | "delete" | null;
type DedupType = "replied_to" | "liked" | "retweeted" | "quoted" | "followed" | null;

const ACTION_MAP: Record<string, ActionType> = {
  post_tweet: "original",
  reply_to_tweet: "reply",
  quote_tweet: "original",
  like_tweet: "like",
  retweet: "retweet",
  follow_user: "follow",
  unfollow_user: "unfollow",
  delete_tweet: "delete",
  get_tweet: null,
  search_tweets: null,
  get_user: null,
  get_timeline: null,
  get_mentions: null,
  get_followers: null,
  get_following: null,
  get_non_followers: null,
  upload_media: null,
  get_metrics: null,
  unlike_tweet: null,
  unretweet: null,
  get_list_members: null,
  get_list_tweets: null,
  get_followed_lists: null,
  get_next_task: null,
  submit_task: null,
  start_workflow: null,
  get_workflow_status: null,
  cleanup_non_followers: null,
  get_queue: null,
  complete_queue_item: null,
  get_digest: null,
};

const DEDUP_MAP: Record<string, DedupType> = {
  reply_to_tweet: "replied_to",
  like_tweet: "liked",
  retweet: "retweeted",
  quote_tweet: "quoted",
  follow_user: "followed",
};

// --- Budget configuration ---

export interface BudgetConfig {
  maxReplies: number;
  maxOriginals: number;
  maxLikes: number;
  maxRetweets: number;
  maxFollows: number;
  maxUnfollows: number;
  maxDeletes: number;
}

export function loadBudgetConfig(): BudgetConfig {
  return {
    maxReplies: parseLimit(process.env.X_MCP_MAX_REPLIES, 8),
    maxOriginals: parseLimit(process.env.X_MCP_MAX_ORIGINALS, 2),
    maxLikes: parseLimit(process.env.X_MCP_MAX_LIKES, 20),
    maxRetweets: parseLimit(process.env.X_MCP_MAX_RETWEETS, 5),
    maxFollows: parseLimit(process.env.X_MCP_MAX_FOLLOWS, 10),
    maxUnfollows: parseLimit(process.env.X_MCP_MAX_UNFOLLOWS, 10),
    maxDeletes: parseLimit(process.env.X_MCP_MAX_DELETES, 5),
  };
}

function parseLimit(value: string | undefined, defaultValue: number): number {
  if (value === undefined || value === "") return defaultValue;
  const parsed = parseInt(value, 10);
  return isNaN(parsed) ? defaultValue : parsed;
}

// --- Budget formatting ---

export function formatBudgetString(state: StateFile, config: BudgetConfig): string {
  const parts: string[] = [];

  parts.push(formatCounter(state.budget.replies, config.maxReplies, "replies"));
  parts.push(formatCounter(state.budget.originals, config.maxOriginals, "originals"));
  parts.push(formatCounter(state.budget.likes, config.maxLikes, "likes"));
  parts.push(formatCounter(state.budget.retweets, config.maxRetweets, "retweets"));
  parts.push(formatCounter(state.budget.follows, config.maxFollows, "follows"));
  parts.push(formatCounter(state.budget.unfollows, config.maxUnfollows, "unfollows"));
  parts.push(formatCounter(state.budget.deletes, config.maxDeletes, "deletes"));

  let result = parts.join(", ");

  if (state.last_write_at) {
    const ago = relativeTime(state.last_write_at);
    result += ` | last action: ${ago}`;
  }

  return result;
}

function formatCounter(used: number, max: number, label: string): string {
  if (max === -1) return `${used}/unlimited ${label} used`;
  if (max === 0) return `${used}/${max} ${label} used (DISABLED)`;
  if (used >= max) return `${used}/${max} ${label} used (LIMIT REACHED)`;
  return `${used}/${max} ${label} used`;
}

function relativeTime(isoTimestamp: string): string {
  const diff = Date.now() - new Date(isoTimestamp).getTime();
  if (diff < 0) return "just now";
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

// --- Budget checks ---

export function checkBudget(
  toolName: string,
  state: StateFile,
  config: BudgetConfig,
): string | null {
  const action = ACTION_MAP[toolName] ?? null;
  if (!action) return null; // Read-only tool, no budget needed

  const { used, max, label } = getBudgetInfo(action, state, config);

  if (max === 0) {
    return `Daily ${label} are disabled (limit: 0). Remaining today: ${remainingSummary(state, config)}.`;
  }

  if (max !== -1 && used >= max) {
    return `Daily ${label} limit reached (${used}/${max}). Try again tomorrow. Remaining today: ${remainingSummary(state, config)}.`;
  }

  return null;
}

function getBudgetInfo(
  action: ActionType,
  state: StateFile,
  config: BudgetConfig,
): { used: number; max: number; label: string } {
  switch (action) {
    case "reply":
      return { used: state.budget.replies, max: config.maxReplies, label: "reply" };
    case "original":
      return { used: state.budget.originals, max: config.maxOriginals, label: "original" };
    case "like":
      return { used: state.budget.likes, max: config.maxLikes, label: "like" };
    case "retweet":
      return { used: state.budget.retweets, max: config.maxRetweets, label: "retweet" };
    case "follow":
      return { used: state.budget.follows, max: config.maxFollows, label: "follow" };
    case "unfollow":
      return { used: state.budget.unfollows, max: config.maxUnfollows, label: "unfollow" };
    case "delete":
      return { used: state.budget.deletes, max: config.maxDeletes, label: "delete" };
    default:
      return { used: 0, max: -1, label: "unknown" };
  }
}

function remainingSummary(state: StateFile, config: BudgetConfig): string {
  const parts: string[] = [];
  parts.push(remainingPart(state.budget.replies, config.maxReplies, "replies"));
  parts.push(remainingPart(state.budget.originals, config.maxOriginals, "originals"));
  parts.push(remainingPart(state.budget.likes, config.maxLikes, "likes"));
  parts.push(remainingPart(state.budget.retweets, config.maxRetweets, "retweets"));
  parts.push(remainingPart(state.budget.follows, config.maxFollows, "follows"));
  parts.push(remainingPart(state.budget.unfollows, config.maxUnfollows, "unfollows"));
  parts.push(remainingPart(state.budget.deletes, config.maxDeletes, "deletes"));
  return parts.join(", ");
}

function remainingPart(used: number, max: number, label: string): string {
  if (max === -1) return `unlimited ${label}`;
  if (max === 0) return `0 ${label}`;
  return `${Math.max(0, max - used)} ${label}`;
}

// --- Dedup checks ---

export function checkDedup(
  toolName: string,
  targetTweetId: string,
  state: StateFile,
): string | null {
  const dedupType = DEDUP_MAP[toolName] ?? null;
  if (!dedupType) return null;

  const entries: EngagedEntry[] = state.engaged[dedupType];
  const existing = entries.find((e) => e.tweet_id === targetTweetId);
  if (existing) {
    const noun = dedupType === "followed" ? "user" : "tweet";
    return `Already ${dedupType.replace("_", " ")} ${noun} ${targetTweetId} at ${existing.at}. Duplicate blocked.`;
  }

  return null;
}

// --- Write tool check ---

export function isWriteTool(toolName: string): boolean {
  return (ACTION_MAP[toolName] ?? null) !== null;
}

// --- Record action (mutates state in-place) ---

export function recordAction(
  toolName: string,
  targetTweetId: string | null,
  state: StateFile,
  options?: { skipBudget?: boolean },
): void {
  const action = ACTION_MAP[toolName] ?? null;
  const now = new Date().toISOString();

  if (!options?.skipBudget) {
    // Increment budget counter
    if (action === "reply") state.budget.replies++;
    else if (action === "original") state.budget.originals++;
    else if (action === "like") state.budget.likes++;
    else if (action === "retweet") state.budget.retweets++;
    else if (action === "follow") state.budget.follows++;
    else if (action === "unfollow") state.budget.unfollows++;
    else if (action === "delete") state.budget.deletes++;

    // Update last_write_at for any write action
    if (action) {
      state.last_write_at = now;
    }
  }

  // Add to dedup set (always — even for queued items)
  const dedupType = DEDUP_MAP[toolName] ?? null;
  if (dedupType && targetTweetId) {
    state.engaged[dedupType].push({ tweet_id: targetTweetId, at: now });
  }
}

// --- Self-describing error hints ---

const PARAMETER_HINTS: Record<string, Record<string, string>> = {
  post_tweet: {
    reply_to_tweet_id: "Use the 'reply_to_tweet' tool instead.",
    in_reply_to: "Use the 'reply_to_tweet' tool instead.",
    in_reply_to_tweet_id: "Use the 'reply_to_tweet' tool instead.",
    in_reply_to_status_id: "Use the 'reply_to_tweet' tool instead.",
    quote_tweet_id: "Use the 'quote_tweet' tool instead.",
    quoted_tweet_id: "Use the 'quote_tweet' tool instead.",
  },
};

function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

function closestMatch(input: string, candidates: string[], maxDistance = 3): string | null {
  let best: string | null = null;
  let bestDist = maxDistance + 1;
  for (const candidate of candidates) {
    const dist = levenshtein(input.toLowerCase(), candidate.toLowerCase());
    if (dist < bestDist) {
      bestDist = dist;
      best = candidate;
    }
  }
  return best;
}

// --- Protected accounts ---

export interface ProtectedAccount {
  username: string;
  userId: string | null; // populated at startup via resolveProtectedAccountIds
}

export function loadProtectedAccounts(): ProtectedAccount[] {
  return (process.env.X_MCP_PROTECTED_ACCOUNTS || "")
    .split(",")
    .map((s) => s.trim().replace(/^@/, "").toLowerCase())
    .filter(Boolean)
    .map((username) => ({ username, userId: null }));
}

export function isProtectedAccount(input: string, protectedAccounts: ProtectedAccount[]): boolean {
  const normalized = input.replace(/^@/, "").toLowerCase();
  return protectedAccounts.some((a) => a.username === normalized || a.userId === normalized);
}

export function getParameterHint(toolName: string, unknownKey: string, validKeys?: string[]): string | null {
  // Check hardcoded hints first (e.g., "use reply_to_tweet tool instead")
  const hint = PARAMETER_HINTS[toolName]?.[unknownKey];
  if (hint) return hint;

  // Fall back to Levenshtein distance suggestion
  if (validKeys && validKeys.length > 0) {
    const suggestion = closestMatch(unknownKey, validKeys);
    if (suggestion) return `Did you mean '${suggestion}'?`;
  }

  return null;
}
