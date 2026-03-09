import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  loadBudgetConfig,
  formatBudgetString,
  checkBudget,
  checkDedup,
  recordAction,
  getParameterHint,
  isWriteTool,
  isProtectedAccount,
} from "./safety.js";
import type { BudgetConfig, ProtectedAccount } from "./safety.js";
import { getDefaultState } from "./state.js";
import type { StateFile } from "./state.js";

function makeConfig(overrides?: Partial<BudgetConfig>): BudgetConfig {
  return { maxReplies: 8, maxOriginals: 2, maxLikes: 20, maxRetweets: 5, maxFollows: 10, maxUnfollows: 10, maxDeletes: 5, ...overrides };
}

function makeState(overrides?: Partial<StateFile>): StateFile {
  return { ...getDefaultState(), ...overrides };
}

describe("loadBudgetConfig", () => {
  beforeEach(() => {
    delete process.env.X_MCP_MAX_REPLIES;
    delete process.env.X_MCP_MAX_ORIGINALS;
    delete process.env.X_MCP_MAX_LIKES;
    delete process.env.X_MCP_MAX_RETWEETS;
  });

  it("returns defaults when no env vars set", () => {
    const config = loadBudgetConfig();
    expect(config).toEqual({ maxReplies: 8, maxOriginals: 2, maxLikes: 20, maxRetweets: 5, maxFollows: 10, maxUnfollows: 10, maxDeletes: 5 });
  });

  it("reads custom values from env", () => {
    process.env.X_MCP_MAX_REPLIES = "3";
    process.env.X_MCP_MAX_ORIGINALS = "0";
    process.env.X_MCP_MAX_LIKES = "-1";
    process.env.X_MCP_MAX_RETWEETS = "10";

    const config = loadBudgetConfig();
    expect(config).toEqual({ maxReplies: 3, maxOriginals: 0, maxLikes: -1, maxRetweets: 10, maxFollows: 10, maxUnfollows: 10, maxDeletes: 5 });
  });

  it("falls back to defaults for non-numeric values", () => {
    process.env.X_MCP_MAX_REPLIES = "abc";
    const config = loadBudgetConfig();
    expect(config.maxReplies).toBe(8);
  });
});

describe("formatBudgetString", () => {
  it("formats normal counters", () => {
    const state = makeState({
      budget: { date: "2026-02-23", replies: 3, originals: 0, likes: 5, retweets: 1, follows: 2, unfollows: 0, deletes: 0 },
    });
    const result = formatBudgetString(state, makeConfig());
    expect(result).toBe("3/8 replies used, 0/2 originals used, 5/20 likes used, 1/5 retweets used, 2/10 follows used, 0/10 unfollows used, 0/5 deletes used");
  });

  it("shows LIMIT REACHED for exhausted counters", () => {
    const state = makeState({
      budget: { ...getDefaultState().budget, date: "2026-02-23", replies: 8, originals: 2, likes: 20, retweets: 5 },
    });
    const result = formatBudgetString(state, makeConfig());
    expect(result).toContain("8/8 replies used (LIMIT REACHED)");
    expect(result).toContain("2/2 originals used (LIMIT REACHED)");
  });

  it("shows unlimited for -1 limits", () => {
    const state = makeState({
      budget: { ...getDefaultState().budget, date: "2026-02-23", replies: 3, originals: 0, likes: 0, retweets: 0 },
    });
    const result = formatBudgetString(state, makeConfig({ maxReplies: -1 }));
    expect(result).toContain("3/unlimited replies used");
  });

  it("shows DISABLED for 0 limits", () => {
    const state = makeState({
      budget: { ...getDefaultState().budget, date: "2026-02-23", replies: 0, originals: 0, likes: 0, retweets: 0 },
    });
    const result = formatBudgetString(state, makeConfig({ maxLikes: 0 }));
    expect(result).toContain("0/0 likes used (DISABLED)");
  });

  it("includes relative time for last_write_at", () => {
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const state = makeState({ last_write_at: fiveMinAgo });
    const result = formatBudgetString(state, makeConfig());
    expect(result).toContain("| last action: 5m ago");
  });

  it("omits last action when last_write_at is null", () => {
    const state = makeState({ last_write_at: null });
    const result = formatBudgetString(state, makeConfig());
    expect(result).not.toContain("last action");
  });
});

describe("checkBudget", () => {
  it("returns null for read-only tools", () => {
    expect(checkBudget("get_tweet", makeState(), makeConfig())).toBeNull();
    expect(checkBudget("search_tweets", makeState(), makeConfig())).toBeNull();
    expect(checkBudget("get_user", makeState(), makeConfig())).toBeNull();
  });

  it("returns null when under limit", () => {
    const state = makeState({
      budget: { ...getDefaultState().budget, date: "2026-02-23", replies: 3, originals: 0, likes: 0, retweets: 0 },
    });
    expect(checkBudget("reply_to_tweet", state, makeConfig())).toBeNull();
  });

  it("returns error when at limit", () => {
    const state = makeState({
      budget: { ...getDefaultState().budget, date: "2026-02-23", replies: 8, originals: 0, likes: 0, retweets: 0 },
    });
    const result = checkBudget("reply_to_tweet", state, makeConfig());
    expect(result).toContain("limit reached");
    expect(result).toContain("8/8");
    expect(result).toContain("Remaining today");
  });

  it("returns error when action is disabled (max=0)", () => {
    const state = makeState();
    const result = checkBudget("like_tweet", state, makeConfig({ maxLikes: 0 }));
    expect(result).toContain("disabled");
    expect(result).toContain("limit: 0");
  });

  it("returns null for unlimited action (max=-1)", () => {
    const state = makeState({
      budget: { ...getDefaultState().budget, date: "2026-02-23", replies: 999, originals: 0, likes: 0, retweets: 0 },
    });
    expect(checkBudget("reply_to_tweet", state, makeConfig({ maxReplies: -1 }))).toBeNull();
  });

  it("maps post_tweet to originals budget", () => {
    const state = makeState({
      budget: { ...getDefaultState().budget, date: "2026-02-23", replies: 0, originals: 2, likes: 0, retweets: 0 },
    });
    const result = checkBudget("post_tweet", state, makeConfig());
    expect(result).toContain("limit reached");
  });

  it("maps quote_tweet to originals budget", () => {
    const state = makeState({
      budget: { ...getDefaultState().budget, date: "2026-02-23", replies: 0, originals: 2, likes: 0, retweets: 0 },
    });
    const result = checkBudget("quote_tweet", state, makeConfig());
    expect(result).toContain("limit reached");
  });

  it("returns error for delete_tweet when at limit", () => {
    const state = makeState({
      budget: { ...getDefaultState().budget, date: "2026-02-23", deletes: 5 },
    });
    const result = checkBudget("delete_tweet", state, makeConfig());
    expect(result).toContain("limit reached");
  });

  it("returns null for delete_tweet under limit", () => {
    expect(checkBudget("delete_tweet", makeState(), makeConfig())).toBeNull();
  });

  it("maps follow_user to follows budget", () => {
    const state = makeState({
      budget: { ...getDefaultState().budget, date: "2026-02-23", follows: 10 },
    });
    const result = checkBudget("follow_user", state, makeConfig());
    expect(result).toContain("limit reached");
  });

  it("returns null for follow_user under limit", () => {
    const state = makeState({
      budget: { ...getDefaultState().budget, date: "2026-02-23", follows: 3 },
    });
    expect(checkBudget("follow_user", state, makeConfig())).toBeNull();
  });

  it("returns error for unfollow_user when at limit", () => {
    const state = makeState({
      budget: { ...getDefaultState().budget, date: "2026-02-23", unfollows: 10 },
    });
    const result = checkBudget("unfollow_user", state, makeConfig());
    expect(result).toContain("limit reached");
  });

  it("returns null for unfollow_user under limit", () => {
    expect(checkBudget("unfollow_user", makeState(), makeConfig())).toBeNull();
  });

  it("returns null for get_non_followers (read-only)", () => {
    expect(checkBudget("get_non_followers", makeState(), makeConfig())).toBeNull();
  });
});

describe("checkDedup", () => {
  it("returns null for first engagement", () => {
    const state = makeState();
    expect(checkDedup("like_tweet", "123", state)).toBeNull();
  });

  it("returns error for duplicate engagement", () => {
    const state = makeState({
      engaged: {
        replied_to: [],
        liked: [{ tweet_id: "123", at: "2026-02-23T10:00:00.000Z" }],
        retweeted: [],
        quoted: [],
        followed: [],
      },
    });
    const result = checkDedup("like_tweet", "123", state);
    expect(result).toContain("Already liked tweet 123");
    expect(result).toContain("2026-02-23T10:00:00.000Z");
    expect(result).toContain("Duplicate blocked");
  });

  it("returns null for tools not in dedup map", () => {
    expect(checkDedup("post_tweet", "123", makeState())).toBeNull();
    expect(checkDedup("get_tweet", "123", makeState())).toBeNull();
  });

  it("checks correct dedup set per tool", () => {
    const state = makeState({
      engaged: {
        replied_to: [{ tweet_id: "111", at: "2026-02-23T10:00:00.000Z" }],
        liked: [{ tweet_id: "222", at: "2026-02-23T10:00:00.000Z" }],
        retweeted: [{ tweet_id: "333", at: "2026-02-23T10:00:00.000Z" }],
        quoted: [{ tweet_id: "444", at: "2026-02-23T10:00:00.000Z" }],
        followed: [],
      },
    });
    expect(checkDedup("reply_to_tweet", "111", state)).not.toBeNull();
    expect(checkDedup("reply_to_tweet", "222", state)).toBeNull(); // 222 is in liked, not replied_to
    expect(checkDedup("like_tweet", "222", state)).not.toBeNull();
    expect(checkDedup("retweet", "333", state)).not.toBeNull();
    expect(checkDedup("quote_tweet", "444", state)).not.toBeNull();
  });

  it("detects duplicate follow_user via followed dedup set", () => {
    const state = makeState({
      engaged: {
        replied_to: [],
        liked: [],
        retweeted: [],
        quoted: [],
        followed: [{ tweet_id: "user123", at: "2026-02-23T10:00:00.000Z" }],
      },
    });
    const result = checkDedup("follow_user", "user123", state);
    expect(result).toContain("Already followed user user123");
    expect(result).toContain("Duplicate blocked");
  });

  it("returns null for follow_user when not previously followed", () => {
    const state = makeState();
    expect(checkDedup("follow_user", "user456", state)).toBeNull();
  });
});

describe("recordAction", () => {
  it("increments reply counter", () => {
    const state = makeState();
    recordAction("reply_to_tweet", "123", state);
    expect(state.budget.replies).toBe(1);
    expect(state.budget.originals).toBe(0);
  });

  it("increments original counter for post_tweet", () => {
    const state = makeState();
    recordAction("post_tweet", null, state);
    expect(state.budget.originals).toBe(1);
  });

  it("increments original counter for quote_tweet", () => {
    const state = makeState();
    recordAction("quote_tweet", "123", state);
    expect(state.budget.originals).toBe(1);
  });

  it("increments like counter", () => {
    const state = makeState();
    recordAction("like_tweet", "123", state);
    expect(state.budget.likes).toBe(1);
  });

  it("increments retweet counter", () => {
    const state = makeState();
    recordAction("retweet", "123", state);
    expect(state.budget.retweets).toBe(1);
  });

  it("updates last_write_at for write actions", () => {
    const state = makeState();
    expect(state.last_write_at).toBeNull();
    recordAction("reply_to_tweet", "123", state);
    expect(state.last_write_at).not.toBeNull();
    expect(state.last_write_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("does not update anything for read-only tools", () => {
    const state = makeState();
    recordAction("get_tweet", null, state);
    expect(state.budget.replies).toBe(0);
    expect(state.budget.originals).toBe(0);
    expect(state.last_write_at).toBeNull();
  });

  it("adds to dedup set for engagement tools", () => {
    const state = makeState();
    recordAction("like_tweet", "123", state);
    expect(state.engaged.liked).toHaveLength(1);
    expect(state.engaged.liked[0].tweet_id).toBe("123");
    expect(state.engaged.liked[0].at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("adds to replied_to dedup set", () => {
    const state = makeState();
    recordAction("reply_to_tweet", "456", state);
    expect(state.engaged.replied_to).toHaveLength(1);
    expect(state.engaged.replied_to[0].tweet_id).toBe("456");
  });

  it("adds to quoted dedup set", () => {
    const state = makeState();
    recordAction("quote_tweet", "789", state);
    expect(state.engaged.quoted).toHaveLength(1);
    expect(state.engaged.quoted[0].tweet_id).toBe("789");
  });

  it("increments follow counter", () => {
    const state = makeState();
    recordAction("follow_user", null, state);
    expect(state.budget.follows).toBe(1);
    expect(state.last_write_at).not.toBeNull();
  });

  it("does not add dedup entry for follow_user when no target ID", () => {
    const state = makeState();
    recordAction("follow_user", null, state);
    expect(state.engaged.replied_to).toHaveLength(0);
    expect(state.engaged.liked).toHaveLength(0);
    expect(state.engaged.retweeted).toHaveLength(0);
    expect(state.engaged.quoted).toHaveLength(0);
    expect(state.engaged.followed).toHaveLength(0);
  });

  it("adds to followed dedup set when target ID is provided", () => {
    const state = makeState();
    recordAction("follow_user", "user789", state);
    expect(state.engaged.followed).toHaveLength(1);
    expect(state.engaged.followed[0].tweet_id).toBe("user789");
  });

  it("accumulates counters across multiple calls", () => {
    const state = makeState();
    recordAction("reply_to_tweet", "a", state);
    recordAction("reply_to_tweet", "b", state);
    recordAction("like_tweet", "c", state);
    expect(state.budget.replies).toBe(2);
    expect(state.budget.likes).toBe(1);
    expect(state.engaged.replied_to).toHaveLength(2);
    expect(state.engaged.liked).toHaveLength(1);
  });

  it("records dedup but skips budget when skipBudget is true", () => {
    const state = makeState();
    recordAction("reply_to_tweet", "queued123", state, { skipBudget: true });
    expect(state.budget.replies).toBe(0);
    expect(state.last_write_at).toBeNull();
    expect(state.engaged.replied_to).toHaveLength(1);
    expect(state.engaged.replied_to[0].tweet_id).toBe("queued123");
  });

  it("skipBudget does not affect dedup for like_tweet", () => {
    const state = makeState();
    recordAction("like_tweet", "liked456", state, { skipBudget: true });
    expect(state.budget.likes).toBe(0);
    expect(state.engaged.liked).toHaveLength(1);
    expect(state.engaged.liked[0].tweet_id).toBe("liked456");
  });

  it("normal call still increments budget when skipBudget is not set", () => {
    const state = makeState();
    recordAction("reply_to_tweet", "normal789", state);
    expect(state.budget.replies).toBe(1);
    expect(state.last_write_at).not.toBeNull();
    expect(state.engaged.replied_to).toHaveLength(1);
  });
});

describe("getParameterHint", () => {
  it("returns hint for reply_to_tweet_id on post_tweet", () => {
    const hint = getParameterHint("post_tweet", "reply_to_tweet_id");
    expect(hint).toBe("Use the 'reply_to_tweet' tool instead.");
  });

  it("returns hint for in_reply_to on post_tweet", () => {
    expect(getParameterHint("post_tweet", "in_reply_to")).toBe("Use the 'reply_to_tweet' tool instead.");
  });

  it("returns hint for in_reply_to_status_id on post_tweet", () => {
    expect(getParameterHint("post_tweet", "in_reply_to_status_id")).toBe("Use the 'reply_to_tweet' tool instead.");
  });

  it("returns hint for quote_tweet_id on post_tweet", () => {
    expect(getParameterHint("post_tweet", "quote_tweet_id")).toBe("Use the 'quote_tweet' tool instead.");
  });

  it("returns null for unknown params on post_tweet without valid keys", () => {
    expect(getParameterHint("post_tweet", "random_param")).toBeNull();
  });

  it("returns null for tools not in hint map", () => {
    expect(getParameterHint("get_tweet", "reply_to_tweet_id")).toBeNull();
    expect(getParameterHint("like_tweet", "reply_to_tweet_id")).toBeNull();
  });

  // Levenshtein distance suggestions
  const VALID_KEYS = ["text", "poll_options", "poll_duration_minutes", "media_ids"];

  it("suggests closest valid parameter for typos", () => {
    expect(getParameterHint("post_tweet", "poll_option", VALID_KEYS)).toBe("Did you mean 'poll_options'?");
    expect(getParameterHint("post_tweet", "media_id", VALID_KEYS)).toBe("Did you mean 'media_ids'?");
    expect(getParameterHint("post_tweet", "texts", VALID_KEYS)).toBe("Did you mean 'text'?");
  });

  it("prefers hardcoded hint over Levenshtein suggestion", () => {
    // "in_reply_to" has a hardcoded hint, should not get a Levenshtein suggestion
    expect(getParameterHint("post_tweet", "in_reply_to", VALID_KEYS)).toBe("Use the 'reply_to_tweet' tool instead.");
  });

  it("returns null for completely unrelated parameter names", () => {
    expect(getParameterHint("post_tweet", "completely_unrelated_garbage_param", VALID_KEYS)).toBeNull();
  });

  it("returns null when validKeys is empty array", () => {
    expect(getParameterHint("post_tweet", "text", [])).toBeNull();
  });

  it("returns null when validKeys is not provided and no hardcoded hint", () => {
    expect(getParameterHint("post_tweet", "random_param")).toBeNull();
  });
});

describe("isWriteTool", () => {
  it("returns true for write tools", () => {
    expect(isWriteTool("post_tweet")).toBe(true);
    expect(isWriteTool("reply_to_tweet")).toBe(true);
    expect(isWriteTool("quote_tweet")).toBe(true);
    expect(isWriteTool("like_tweet")).toBe(true);
    expect(isWriteTool("retweet")).toBe(true);
    expect(isWriteTool("follow_user")).toBe(true);
  });

  it("returns false for read-only tools", () => {
    expect(isWriteTool("get_tweet")).toBe(false);
    expect(isWriteTool("search_tweets")).toBe(false);
    expect(isWriteTool("get_user")).toBe(false);
    expect(isWriteTool("get_timeline")).toBe(false);
    expect(isWriteTool("get_mentions")).toBe(false);
    expect(isWriteTool("get_followers")).toBe(false);
    expect(isWriteTool("get_following")).toBe(false);
    expect(isWriteTool("upload_media")).toBe(false);
    expect(isWriteTool("get_metrics")).toBe(false);
  });

  it("returns true for delete_tweet (budget-limited)", () => {
    expect(isWriteTool("delete_tweet")).toBe(true);
  });

  it("returns true for unfollow_user (budget-limited)", () => {
    expect(isWriteTool("unfollow_user")).toBe(true);
  });

  it("returns false for get_non_followers (read-only)", () => {
    expect(isWriteTool("get_non_followers")).toBe(false);
  });

  it("returns false for get_digest (read-only)", () => {
    expect(isWriteTool("get_digest")).toBe(false);
  });

  it("returns false for unknown tools", () => {
    expect(isWriteTool("nonexistent_tool")).toBe(false);
  });
});

describe("isProtectedAccount", () => {
  const accounts: ProtectedAccount[] = [
    { username: "friend1", userId: "111" },
    { username: "mentor", userId: "222" },
    { username: "unresolved", userId: null },
  ];

  it("matches by username", () => {
    expect(isProtectedAccount("friend1", accounts)).toBe(true);
  });

  it("matches by username with @ prefix", () => {
    expect(isProtectedAccount("@friend1", accounts)).toBe(true);
  });

  it("matches case-insensitively", () => {
    expect(isProtectedAccount("Friend1", accounts)).toBe(true);
    expect(isProtectedAccount("MENTOR", accounts)).toBe(true);
  });

  it("matches by numeric userId", () => {
    expect(isProtectedAccount("111", accounts)).toBe(true);
    expect(isProtectedAccount("222", accounts)).toBe(true);
  });

  it("returns false for unresolved userId (null)", () => {
    // "unresolved" matches by username, not userId
    expect(isProtectedAccount("unresolved", accounts)).toBe(true);
    // Some random ID that doesn't match any userId
    expect(isProtectedAccount("999", accounts)).toBe(false);
  });

  it("returns false for non-protected accounts", () => {
    expect(isProtectedAccount("stranger", accounts)).toBe(false);
    expect(isProtectedAccount("333", accounts)).toBe(false);
  });
});
