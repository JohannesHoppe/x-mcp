import fs from "fs";
import path from "path";

export interface EngagedEntry {
  tweet_id: string;
  at: string; // ISO 8601: "2026-02-23T13:34:36.000Z"
}

export interface Workflow {
  id: string;                      // "fc:username" or auto-generated
  type: string;                    // "follow_cycle", "reply_track"
  current_step: string;            // where we are in the workflow
  target_user_id: string;
  target_username: string;
  created_at: string;              // ISO 8601
  check_after: string | null;      // ISO date — skip until this date
  context: Record<string, string>; // accumulated IDs: pinned_tweet_id, reply_tweet_id, etc.
  actions_done: string[];          // log: ["followed", "liked_pinned", "replied"]
  outcome: string | null;          // null = active, "followed_back", "cleaned_up", etc.
}

export interface QueueItem {
  id: string;                     // "q:<tweet_id>" for replies, "q:post-<timestamp>" for mention posts
  type: "cold_reply" | "mention_post";
  status: "pending" | "posted" | "skipped";
  created_at: string;             // ISO 8601
  target_tweet_id?: string;       // tweet being replied to (cold_reply only)
  target_author?: string;         // @username of tweet author
  target_text_snippet?: string;   // first ~100 chars for context
  text: string;                   // the reply/post text
  intent_url: string;             // pre-generated X intent URL
  source_tool: string;            // "reply_to_tweet" or "post_tweet"
  source_workflow_id?: string;    // if queued from a workflow
}

export interface StateFile {
  budget: {
    date: string; // ISO 8601 date: "2026-02-23"
    replies: number;
    originals: number;
    likes: number;
    retweets: number;
    follows: number;
    unfollows: number;
    deletes: number;
  };
  last_write_at: string | null; // ISO 8601: "2026-02-23T13:34:36.000Z"
  engaged: {
    replied_to: EngagedEntry[];
    liked: EngagedEntry[];
    retweeted: EngagedEntry[];
    quoted: EngagedEntry[];
    followed: EngagedEntry[]; // tweet_id holds user_id for follows
  };
  mentioned_by: string[]; // user_ids of authors who have @mentioned us (for reply eligibility)
  workflows: Workflow[];
  queue: QueueItem[];
}

// Entries older than 90 days are pruned on load
const DEDUP_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;

// Completed workflows older than 30 days are pruned on load
const WORKFLOW_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

// Pending queue items older than 7 days are pruned on load
const QUEUE_PENDING_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

// Completed/skipped queue items older than 1 day are pruned on load
const QUEUE_DONE_MAX_AGE_MS = 1 * 24 * 60 * 60 * 1000;

// Max active workflows (env-configurable)
export function getMaxWorkflows(): number {
  const v = process.env.X_MCP_MAX_WORKFLOWS;
  if (v === undefined || v === "") return 200;
  const n = parseInt(v, 10);
  return isNaN(n) ? 200 : n;
}

export function todayString(): string {
  return new Date().toISOString().slice(0, 10);
}

export function getDefaultState(): StateFile {
  return {
    budget: {
      date: todayString(),
      replies: 0,
      originals: 0,
      likes: 0,
      retweets: 0,
      follows: 0,
      unfollows: 0,
      deletes: 0,
    },
    last_write_at: null,
    engaged: {
      replied_to: [],
      liked: [],
      retweeted: [],
      quoted: [],
      followed: [],
    },
    mentioned_by: [],
    workflows: [],
    queue: [],
  };
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && !isNaN(value) ? value : fallback;
}

function asEngagedArray(value: unknown): EngagedEntry[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (e) => e && typeof e === "object" && typeof e.tweet_id === "string" && typeof e.at === "string",
  );
}

function pruneEngaged(entries: EngagedEntry[]): EngagedEntry[] {
  const cutoff = Date.now() - DEDUP_MAX_AGE_MS;
  return entries.filter((e) => new Date(e.at).getTime() > cutoff);
}

function isWorkflow(obj: unknown): obj is Workflow {
  if (!obj || typeof obj !== "object") return false;
  const w = obj as Record<string, unknown>;
  return (
    typeof w.id === "string" &&
    typeof w.type === "string" &&
    typeof w.current_step === "string" &&
    typeof w.target_user_id === "string" &&
    typeof w.target_username === "string" &&
    typeof w.created_at === "string"
  );
}

function asWorkflowArray(value: unknown): Workflow[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isWorkflow).map((w) => ({
    id: w.id,
    type: w.type,
    current_step: w.current_step,
    target_user_id: w.target_user_id,
    target_username: w.target_username,
    created_at: w.created_at,
    check_after: typeof w.check_after === "string" ? w.check_after : null,
    context: (w.context && typeof w.context === "object" && !Array.isArray(w.context))
      ? Object.fromEntries(Object.entries(w.context).filter(([, v]) => typeof v === "string")) as Record<string, string>
      : {},
    actions_done: Array.isArray(w.actions_done) ? w.actions_done.filter((s: unknown) => typeof s === "string") : [],
    outcome: typeof w.outcome === "string" ? w.outcome : null,
  }));
}

function pruneWorkflows(workflows: Workflow[]): Workflow[] {
  const cutoff = Date.now() - WORKFLOW_MAX_AGE_MS;
  return workflows.filter((w) => {
    // Keep all active workflows (no outcome)
    if (!w.outcome) return true;
    // Prune completed workflows older than 30 days
    return new Date(w.created_at).getTime() > cutoff;
  });
}

function isQueueItem(obj: unknown): obj is QueueItem {
  if (!obj || typeof obj !== "object") return false;
  const q = obj as Record<string, unknown>;
  return (
    typeof q.id === "string" &&
    typeof q.type === "string" &&
    typeof q.status === "string" &&
    typeof q.created_at === "string" &&
    typeof q.text === "string" &&
    typeof q.intent_url === "string" &&
    typeof q.source_tool === "string"
  );
}

function asQueueArray(value: unknown): QueueItem[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isQueueItem);
}

function pruneQueue(items: QueueItem[]): QueueItem[] {
  const now = Date.now();
  return items.filter((q) => {
    const age = now - new Date(q.created_at).getTime();
    if (q.status === "pending") return age < QUEUE_PENDING_MAX_AGE_MS;
    return age < QUEUE_DONE_MAX_AGE_MS;
  });
}

/**
 * Validate and normalize a parsed JSON object into a safe StateFile.
 * Missing or invalid fields fall back to defaults.
 */
function validateState(raw: unknown): StateFile {
  if (!raw || typeof raw !== "object") return getDefaultState();

  const obj = raw as Record<string, unknown>;
  const budget = (obj.budget && typeof obj.budget === "object")
    ? obj.budget as Record<string, unknown>
    : {};
  const engaged = (obj.engaged && typeof obj.engaged === "object")
    ? obj.engaged as Record<string, unknown>
    : {};

  const today = todayString();
  const budgetDate = typeof budget.date === "string" ? budget.date : today;

  // Reset counters if date changed
  const dateChanged = budgetDate !== today;

  const workflows = pruneWorkflows(asWorkflowArray(obj.workflows));

  // mentioned_by: deduplicated string[] of user IDs, capped at 10,000
  const rawMentioned = Array.isArray(obj.mentioned_by)
    ? obj.mentioned_by.filter((v: unknown): v is string => typeof v === "string")
    : [];
  const mentionedBy = [...new Set(rawMentioned)].slice(-10_000);

  return {
    budget: {
      date: today,
      replies: dateChanged ? 0 : asNumber(budget.replies, 0),
      originals: dateChanged ? 0 : asNumber(budget.originals, 0),
      likes: dateChanged ? 0 : asNumber(budget.likes, 0),
      retweets: dateChanged ? 0 : asNumber(budget.retweets, 0),
      follows: dateChanged ? 0 : asNumber(budget.follows, 0),
      unfollows: dateChanged ? 0 : asNumber(budget.unfollows, 0),
      deletes: dateChanged ? 0 : asNumber(budget.deletes, 0),
    },
    last_write_at: typeof obj.last_write_at === "string" ? obj.last_write_at : null,
    engaged: {
      replied_to: pruneEngaged(asEngagedArray(engaged.replied_to)),
      liked: pruneEngaged(asEngagedArray(engaged.liked)),
      retweeted: pruneEngaged(asEngagedArray(engaged.retweeted)),
      quoted: pruneEngaged(asEngagedArray(engaged.quoted)),
      followed: pruneEngaged(asEngagedArray(engaged.followed)),
    },
    mentioned_by: mentionedBy,
    workflows,
    queue: pruneQueue(asQueueArray(obj.queue)),
  };
}

export function loadState(filePath: string): StateFile {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    return validateState(parsed);
  } catch (e: unknown) {
    if (e instanceof Error && "code" in e && (e as NodeJS.ErrnoException).code === "ENOENT") {
      return getDefaultState();
    }
    // Corrupt file — log warning, return fresh state
    console.error(`Warning: could not parse state file ${filePath}, starting fresh:`, e);
    return getDefaultState();
  }
}

export function saveState(filePath: string, state: StateFile): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const tmp = filePath + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), "utf-8");
  fs.renameSync(tmp, filePath);
}
