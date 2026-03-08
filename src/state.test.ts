import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { loadState, saveState, getDefaultState, todayString } from "./state.js";
import type { StateFile } from "./state.js";

function tmpFile(): string {
  return path.join(os.tmpdir(), `x-mcp-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
}

function cleanup(filePath: string): void {
  try { fs.unlinkSync(filePath); } catch {}
  try { fs.unlinkSync(filePath + ".tmp"); } catch {}
}

describe("todayString", () => {
  it("returns ISO date format YYYY-MM-DD", () => {
    const result = todayString();
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("getDefaultState", () => {
  it("returns fresh state with today's date", () => {
    const state = getDefaultState();
    expect(state.budget.date).toBe(todayString());
    expect(state.budget.replies).toBe(0);
    expect(state.budget.originals).toBe(0);
    expect(state.budget.likes).toBe(0);
    expect(state.budget.retweets).toBe(0);
    expect(state.last_write_at).toBeNull();
    expect(state.engaged.replied_to).toEqual([]);
    expect(state.engaged.liked).toEqual([]);
    expect(state.engaged.retweeted).toEqual([]);
    expect(state.engaged.quoted).toEqual([]);
  });

  it("includes new budget fields: follows, unfollows, deletes", () => {
    const state = getDefaultState();
    expect(state.budget.follows).toBe(0);
    expect(state.budget.unfollows).toBe(0);
    expect(state.budget.deletes).toBe(0);
  });

  it("includes followed dedup array", () => {
    const state = getDefaultState();
    expect(state.engaged.followed).toEqual([]);
  });

  it("includes empty workflows array", () => {
    const state = getDefaultState();
    expect(state.workflows).toEqual([]);
  });
});

describe("loadState", () => {
  let filePath: string;

  beforeEach(() => {
    filePath = tmpFile();
  });

  afterEach(() => {
    cleanup(filePath);
  });

  it("returns default state for non-existent file", () => {
    const state = loadState(filePath);
    expect(state.budget.date).toBe(todayString());
    expect(state.budget.replies).toBe(0);
    expect(state.engaged.replied_to).toEqual([]);
  });

  it("loads valid state file", () => {
    const existing = {
      budget: { date: todayString(), replies: 3, originals: 1, likes: 5, retweets: 2 },
      last_write_at: "2026-02-23T10:00:00.000Z",
      engaged: {
        replied_to: [{ tweet_id: "111", at: "2026-02-23T10:00:00.000Z" }],
        liked: [],
        retweeted: [],
        quoted: [],
      },
    };
    fs.writeFileSync(filePath, JSON.stringify(existing));

    const state = loadState(filePath);
    expect(state.budget.replies).toBe(3);
    expect(state.budget.originals).toBe(1);
    expect(state.last_write_at).toBe("2026-02-23T10:00:00.000Z");
    expect(state.engaged.replied_to).toHaveLength(1);
    expect(state.engaged.replied_to[0].tweet_id).toBe("111");
  });

  it("resets budget when date has changed but preserves engaged", () => {
    // Use yesterday's date for budget (triggers reset) but recent timestamps
    // for engaged entries (within 90-day pruning window)
    const recentTimestamp = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(); // yesterday
    const existing = {
      budget: { date: "2020-01-01", replies: 8, originals: 2, likes: 20, retweets: 5 },
      last_write_at: recentTimestamp,
      engaged: {
        replied_to: [{ tweet_id: "111", at: recentTimestamp }],
        liked: [{ tweet_id: "222", at: recentTimestamp }],
        retweeted: [],
        quoted: [],
      },
    };
    fs.writeFileSync(filePath, JSON.stringify(existing));

    const state = loadState(filePath);
    // Budget should be reset
    expect(state.budget.date).toBe(todayString());
    expect(state.budget.replies).toBe(0);
    expect(state.budget.originals).toBe(0);
    expect(state.budget.likes).toBe(0);
    expect(state.budget.retweets).toBe(0);
    // Engaged should be preserved (recent entries within pruning window)
    expect(state.engaged.replied_to).toHaveLength(1);
    expect(state.engaged.replied_to[0].tweet_id).toBe("111");
    expect(state.engaged.liked).toHaveLength(1);
    expect(state.engaged.liked[0].tweet_id).toBe("222");
    // last_write_at should be preserved
    expect(state.last_write_at).toBe(recentTimestamp);
  });

  it("preserves workflows across day boundary (budget reset)", () => {
    const recentDate = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(); // 2 days ago
    fs.writeFileSync(filePath, JSON.stringify({
      budget: { date: "2020-01-01", replies: 8, originals: 2, likes: 20, retweets: 5, follows: 5, unfollows: 3, deletes: 1 },
      last_write_at: null,
      engaged: { replied_to: [], liked: [], retweeted: [], quoted: [], followed: [] },
      workflows: [{
        id: "fc:alice",
        type: "follow_cycle",
        current_step: "waiting",
        target_user_id: "100",
        target_username: "alice",
        created_at: recentDate,
        check_after: "2026-03-01",
        context: { pinned_tweet_id: "456" },
        actions_done: ["followed", "liked_pinned"],
        outcome: null,
      }],
    }));

    const state = loadState(filePath);
    // Budget should be reset
    expect(state.budget.date).toBe(todayString());
    expect(state.budget.replies).toBe(0);
    expect(state.budget.follows).toBe(0);
    // Workflows should be preserved
    expect(state.workflows).toHaveLength(1);
    expect(state.workflows[0].id).toBe("fc:alice");
    expect(state.workflows[0].context.pinned_tweet_id).toBe("456");
  });

  it("returns default state for corrupt JSON", () => {
    fs.writeFileSync(filePath, "not valid json {{{");
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const state = loadState(filePath);
    expect(state.budget.date).toBe(todayString());
    expect(state.budget.replies).toBe(0);
    expect(consoleSpy).toHaveBeenCalled();

    consoleSpy.mockRestore();
  });
});

describe("saveState", () => {
  let filePath: string;

  beforeEach(() => {
    filePath = tmpFile();
  });

  afterEach(() => {
    cleanup(filePath);
  });

  it("round-trips state through save and load", () => {
    const now = new Date().toISOString();
    const state: StateFile = {
      budget: { date: todayString(), replies: 5, originals: 1, likes: 12, retweets: 3, follows: 0, unfollows: 0, deletes: 0 },
      last_write_at: now,
      engaged: {
        replied_to: [{ tweet_id: "aaa", at: now }],
        liked: [{ tweet_id: "bbb", at: now }],
        retweeted: [],
        quoted: [{ tweet_id: "ccc", at: now }],
        followed: [],
      },
      mentioned_by: [],
      workflows: [],
      queue: [],
    };

    saveState(filePath, state);
    const loaded = loadState(filePath);

    expect(loaded).toEqual(state);
  });

  it("cleans up temp file after atomic write", () => {
    const state = getDefaultState();
    saveState(filePath, state);

    expect(fs.existsSync(filePath)).toBe(true);
    expect(fs.existsSync(filePath + ".tmp")).toBe(false);
  });

  it("creates parent directories if needed", () => {
    const dirName = `x-mcp-nested-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const nestedDir = path.join(os.tmpdir(), dirName);
    const nested = path.join(nestedDir, "sub", "state.json");
    const state = getDefaultState();

    saveState(nested, state);
    expect(fs.existsSync(nested)).toBe(true);

    // Cleanup using the captured directory name
    fs.rmSync(nestedDir, { recursive: true, force: true });
  });
});

describe("state validation", () => {
  let filePath: string;

  beforeEach(() => {
    filePath = tmpFile();
  });

  afterEach(() => {
    cleanup(filePath);
  });

  it("fills in missing fields from partial state file", () => {
    // State file with budget but no engaged section
    fs.writeFileSync(filePath, JSON.stringify({
      budget: { date: todayString(), replies: 3, originals: 1 },
      last_write_at: "2026-02-23T10:00:00.000Z",
    }));

    const state = loadState(filePath);
    expect(state.budget.replies).toBe(3);
    expect(state.budget.originals).toBe(1);
    expect(state.budget.likes).toBe(0);
    expect(state.budget.retweets).toBe(0);
    expect(state.budget.follows).toBe(0);
    expect(state.budget.unfollows).toBe(0);
    expect(state.budget.deletes).toBe(0);
    expect(state.last_write_at).toBe("2026-02-23T10:00:00.000Z");
    expect(state.engaged.replied_to).toEqual([]);
    expect(state.engaged.liked).toEqual([]);
    expect(state.engaged.retweeted).toEqual([]);
    expect(state.engaged.quoted).toEqual([]);
    expect(state.engaged.followed).toEqual([]);
    expect(state.workflows).toEqual([]);
  });

  it("handles completely empty object", () => {
    fs.writeFileSync(filePath, "{}");
    const state = loadState(filePath);
    expect(state.budget.date).toBe(todayString());
    expect(state.budget.replies).toBe(0);
    expect(state.last_write_at).toBeNull();
    expect(state.engaged.replied_to).toEqual([]);
  });

  it("rejects non-number budget counters", () => {
    fs.writeFileSync(filePath, JSON.stringify({
      budget: { date: todayString(), replies: "not-a-number", originals: null },
    }));
    const state = loadState(filePath);
    expect(state.budget.replies).toBe(0);
    expect(state.budget.originals).toBe(0);
  });

  it("filters invalid engaged entries", () => {
    const now = new Date().toISOString();
    fs.writeFileSync(filePath, JSON.stringify({
      budget: { date: todayString(), replies: 0, originals: 0, likes: 0, retweets: 0 },
      engaged: {
        replied_to: [
          { tweet_id: "valid", at: now },
          { tweet_id: 123, at: now },           // invalid: numeric tweet_id
          { at: now },                           // invalid: missing tweet_id
          "not-an-object",                       // invalid: not an object
        ],
        liked: [],
        retweeted: [],
        quoted: [],
      },
    }));
    const state = loadState(filePath);
    expect(state.engaged.replied_to).toHaveLength(1);
    expect(state.engaged.replied_to[0].tweet_id).toBe("valid");
  });
});

describe("workflow validation (isWorkflow / asWorkflowArray via loadState)", () => {
  let filePath: string;

  beforeEach(() => {
    filePath = tmpFile();
  });

  afterEach(() => {
    cleanup(filePath);
  });

  it("loads valid workflows from state file", () => {
    const now = new Date().toISOString();
    fs.writeFileSync(filePath, JSON.stringify({
      budget: { date: todayString(), replies: 0, originals: 0, likes: 0, retweets: 0, follows: 0, unfollows: 0, deletes: 0 },
      last_write_at: null,
      engaged: { replied_to: [], liked: [], retweeted: [], quoted: [], followed: [] },
      workflows: [{
        id: "fc:alice",
        type: "follow_cycle",
        current_step: "waiting",
        target_user_id: "123",
        target_username: "alice",
        created_at: now,
        check_after: "2026-03-01",
        context: { pinned_tweet_id: "456" },
        actions_done: ["followed", "liked_pinned"],
        outcome: null,
      }],
    }));

    const state = loadState(filePath);
    expect(state.workflows).toHaveLength(1);
    expect(state.workflows[0].id).toBe("fc:alice");
    expect(state.workflows[0].context.pinned_tweet_id).toBe("456");
    expect(state.workflows[0].actions_done).toEqual(["followed", "liked_pinned"]);
  });

  it("filters out invalid workflow entries", () => {
    fs.writeFileSync(filePath, JSON.stringify({
      budget: { date: todayString(), replies: 0, originals: 0, likes: 0, retweets: 0 },
      last_write_at: null,
      engaged: { replied_to: [], liked: [], retweeted: [], quoted: [], followed: [] },
      workflows: [
        {
          id: "fc:valid",
          type: "follow_cycle",
          current_step: "waiting",
          target_user_id: "100",
          target_username: "valid",
          created_at: new Date().toISOString(),
          check_after: null,
          context: {},
          actions_done: [],
          outcome: null,
        },
        { id: "missing-fields" },                // invalid: missing required fields
        "not-an-object",                          // invalid: not an object
        null,                                     // invalid: null
        { id: 123, type: "follow_cycle", current_step: "waiting", target_user_id: "1", target_username: "x", created_at: "2026-01-01" }, // invalid: numeric id
      ],
    }));

    const state = loadState(filePath);
    expect(state.workflows).toHaveLength(1);
    expect(state.workflows[0].id).toBe("fc:valid");
  });

  it("handles non-array workflows field", () => {
    fs.writeFileSync(filePath, JSON.stringify({
      budget: { date: todayString(), replies: 0, originals: 0, likes: 0, retweets: 0 },
      last_write_at: null,
      engaged: { replied_to: [], liked: [], retweeted: [], quoted: [], followed: [] },
      workflows: "not-an-array",
    }));

    const state = loadState(filePath);
    expect(state.workflows).toEqual([]);
  });

  it("normalizes missing optional workflow fields to defaults", () => {
    fs.writeFileSync(filePath, JSON.stringify({
      budget: { date: todayString(), replies: 0, originals: 0, likes: 0, retweets: 0 },
      last_write_at: null,
      engaged: { replied_to: [], liked: [], retweeted: [], quoted: [], followed: [] },
      workflows: [{
        id: "fc:bare",
        type: "follow_cycle",
        current_step: "execute_follow",
        target_user_id: "100",
        target_username: "bare",
        created_at: new Date().toISOString(),
        // Missing: check_after, context, actions_done, outcome
      }],
    }));

    const state = loadState(filePath);
    expect(state.workflows).toHaveLength(1);
    expect(state.workflows[0].check_after).toBeNull();
    expect(state.workflows[0].context).toEqual({});
    expect(state.workflows[0].actions_done).toEqual([]);
    expect(state.workflows[0].outcome).toBeNull();
  });
});

describe("workflow pruning (pruneWorkflows via loadState)", () => {
  let filePath: string;

  beforeEach(() => {
    filePath = tmpFile();
  });

  afterEach(() => {
    cleanup(filePath);
  });

  it("prunes completed workflows older than 30 days", () => {
    const now = new Date();
    const recentDate = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000).toISOString(); // 10 days ago
    const oldDate = new Date(now.getTime() - 40 * 24 * 60 * 60 * 1000).toISOString();    // 40 days ago

    fs.writeFileSync(filePath, JSON.stringify({
      budget: { date: todayString(), replies: 0, originals: 0, likes: 0, retweets: 0, follows: 0, unfollows: 0, deletes: 0 },
      last_write_at: null,
      engaged: { replied_to: [], liked: [], retweeted: [], quoted: [], followed: [] },
      workflows: [
        {
          id: "fc:recent-done",
          type: "follow_cycle",
          current_step: "done",
          target_user_id: "1",
          target_username: "recent-done",
          created_at: recentDate,
          check_after: null,
          context: {},
          actions_done: [],
          outcome: "followed_back",
        },
        {
          id: "fc:old-done",
          type: "follow_cycle",
          current_step: "done",
          target_user_id: "2",
          target_username: "old-done",
          created_at: oldDate,
          check_after: null,
          context: {},
          actions_done: [],
          outcome: "cleaned_up",
        },
      ],
    }));

    const state = loadState(filePath);
    expect(state.workflows).toHaveLength(1);
    expect(state.workflows[0].id).toBe("fc:recent-done");
  });

  it("keeps active workflows regardless of age", () => {
    const oldDate = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString(); // 60 days ago

    fs.writeFileSync(filePath, JSON.stringify({
      budget: { date: todayString(), replies: 0, originals: 0, likes: 0, retweets: 0, follows: 0, unfollows: 0, deletes: 0 },
      last_write_at: null,
      engaged: { replied_to: [], liked: [], retweeted: [], quoted: [], followed: [] },
      workflows: [{
        id: "fc:old-active",
        type: "follow_cycle",
        current_step: "waiting",
        target_user_id: "1",
        target_username: "old-active",
        created_at: oldDate,
        check_after: "2026-04-01",
        context: {},
        actions_done: ["followed"],
        outcome: null,
      }],
    }));

    const state = loadState(filePath);
    expect(state.workflows).toHaveLength(1);
    expect(state.workflows[0].id).toBe("fc:old-active");
  });
});

describe("dedup pruning", () => {
  let filePath: string;

  beforeEach(() => {
    filePath = tmpFile();
  });

  afterEach(() => {
    cleanup(filePath);
  });

  it("prunes entries older than 90 days", () => {
    const now = new Date();
    const recent = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString(); // 30 days ago
    const old = new Date(now.getTime() - 100 * 24 * 60 * 60 * 1000).toISOString();   // 100 days ago

    fs.writeFileSync(filePath, JSON.stringify({
      budget: { date: todayString(), replies: 0, originals: 0, likes: 0, retweets: 0 },
      last_write_at: null,
      engaged: {
        replied_to: [
          { tweet_id: "recent", at: recent },
          { tweet_id: "old", at: old },
        ],
        liked: [{ tweet_id: "also-old", at: old }],
        retweeted: [],
        quoted: [{ tweet_id: "also-recent", at: recent }],
      },
    }));

    const state = loadState(filePath);
    expect(state.engaged.replied_to).toHaveLength(1);
    expect(state.engaged.replied_to[0].tweet_id).toBe("recent");
    expect(state.engaged.liked).toHaveLength(0);
    expect(state.engaged.quoted).toHaveLength(1);
    expect(state.engaged.quoted[0].tweet_id).toBe("also-recent");
  });

  it("keeps all entries younger than 90 days", () => {
    const now = new Date().toISOString();
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    fs.writeFileSync(filePath, JSON.stringify({
      budget: { date: todayString(), replies: 0, originals: 0, likes: 0, retweets: 0 },
      last_write_at: null,
      engaged: {
        replied_to: [
          { tweet_id: "a", at: now },
          { tweet_id: "b", at: yesterday },
        ],
        liked: [],
        retweeted: [],
        quoted: [],
      },
    }));

    const state = loadState(filePath);
    expect(state.engaged.replied_to).toHaveLength(2);
  });
});

describe("mentioned_by", () => {
  let filePath: string;
  beforeEach(() => { filePath = tmpFile(); });
  afterEach(() => { cleanup(filePath); });

  it("default state has empty mentioned_by", () => {
    const state = getDefaultState();
    expect(state.mentioned_by).toEqual([]);
  });

  it("round-trips through save/load", () => {
    const state = getDefaultState();
    state.mentioned_by = ["111", "222", "333"];
    saveState(filePath, state);

    const loaded = loadState(filePath);
    expect(loaded.mentioned_by).toEqual(["111", "222", "333"]);
  });

  it("filters non-string values", () => {
    fs.writeFileSync(filePath, JSON.stringify({
      ...getDefaultState(),
      mentioned_by: ["valid", 42, null, "also_valid", undefined, { id: "bad" }],
    }));

    const loaded = loadState(filePath);
    expect(loaded.mentioned_by).toEqual(["valid", "also_valid"]);
  });

  it("deduplicates entries", () => {
    fs.writeFileSync(filePath, JSON.stringify({
      ...getDefaultState(),
      mentioned_by: ["111", "222", "111", "333", "222"],
    }));

    const loaded = loadState(filePath);
    expect(loaded.mentioned_by).toEqual(["111", "222", "333"]);
  });

  it("caps at 10,000 entries (keeps newest)", () => {
    const ids = Array.from({ length: 12_000 }, (_, i) => `user_${i}`);
    fs.writeFileSync(filePath, JSON.stringify({
      ...getDefaultState(),
      mentioned_by: ids,
    }));

    const loaded = loadState(filePath);
    expect(loaded.mentioned_by).toHaveLength(10_000);
    expect(loaded.mentioned_by[0]).toBe("user_2000");
    expect(loaded.mentioned_by[9999]).toBe("user_11999");
  });

  it("falls back to empty array when missing", () => {
    const raw = getDefaultState() as Record<string, unknown>;
    delete raw.mentioned_by;
    fs.writeFileSync(filePath, JSON.stringify(raw));

    const loaded = loadState(filePath);
    expect(loaded.mentioned_by).toEqual([]);
  });

  it("falls back to empty array when not an array", () => {
    fs.writeFileSync(filePath, JSON.stringify({
      ...getDefaultState(),
      mentioned_by: "not-an-array",
    }));

    const loaded = loadState(filePath);
    expect(loaded.mentioned_by).toEqual([]);
  });
});

describe("queue", () => {
  let filePath: string;

  beforeEach(() => {
    filePath = path.join(os.tmpdir(), `x-mcp-test-queue-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  });

  afterEach(() => {
    try { fs.unlinkSync(filePath); } catch {}
  });

  it("default state has empty queue", () => {
    expect(getDefaultState().queue).toEqual([]);
  });

  it("round-trips queue items through save/load", () => {
    const state = getDefaultState();
    const item = {
      id: "q:123", type: "cold_reply" as const, status: "pending" as const,
      created_at: new Date().toISOString(),
      target_tweet_id: "123", target_author: "@someone",
      target_text_snippet: "Hello world",
      text: "Great take!", intent_url: "https://x.com/intent/post?text=Great+take%21&in_reply_to=123",
      source_tool: "reply_to_tweet",
    };
    state.queue.push(item);
    saveState(filePath, state);
    const loaded = loadState(filePath);
    expect(loaded.queue).toHaveLength(1);
    expect(loaded.queue[0]).toEqual(item);
  });

  it("prunes pending items older than 7 days", () => {
    const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    const fresh = new Date().toISOString();
    const state = getDefaultState();
    state.queue = [
      { id: "q:old", type: "cold_reply", status: "pending", created_at: old, text: "old", intent_url: "u", source_tool: "reply_to_tweet" },
      { id: "q:new", type: "cold_reply", status: "pending", created_at: fresh, text: "new", intent_url: "u", source_tool: "reply_to_tweet" },
    ];
    saveState(filePath, state);
    const loaded = loadState(filePath);
    expect(loaded.queue).toHaveLength(1);
    expect(loaded.queue[0].id).toBe("q:new");
  });

  it("prunes completed items older than 1 day", () => {
    const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    const state = getDefaultState();
    state.queue = [
      { id: "q:done", type: "cold_reply", status: "posted", created_at: old, text: "done", intent_url: "u", source_tool: "reply_to_tweet" },
    ];
    saveState(filePath, state);
    const loaded = loadState(filePath);
    expect(loaded.queue).toHaveLength(0);
  });

  it("keeps fresh completed items", () => {
    const fresh = new Date().toISOString();
    const state = getDefaultState();
    state.queue = [
      { id: "q:done", type: "cold_reply", status: "posted", created_at: fresh, text: "done", intent_url: "u", source_tool: "reply_to_tweet" },
    ];
    saveState(filePath, state);
    const loaded = loadState(filePath);
    expect(loaded.queue).toHaveLength(1);
  });

  it("filters invalid queue entries", () => {
    fs.writeFileSync(filePath, JSON.stringify({
      ...getDefaultState(),
      queue: [
        { id: "q:valid", type: "cold_reply", status: "pending", created_at: new Date().toISOString(), text: "hi", intent_url: "u", source_tool: "reply_to_tweet" },
        { id: "q:invalid" },  // missing required fields
        "not-an-object",
        null,
      ],
    }));
    const loaded = loadState(filePath);
    expect(loaded.queue).toHaveLength(1);
    expect(loaded.queue[0].id).toBe("q:valid");
  });

  it("handles missing queue field", () => {
    fs.writeFileSync(filePath, JSON.stringify({
      budget: { date: todayString(), replies: 0, originals: 0, likes: 0, retweets: 0, follows: 0, unfollows: 0, deletes: 0 },
      last_write_at: null,
      engaged: { replied_to: [], liked: [], retweeted: [], quoted: [], followed: [] },
      mentioned_by: [],
      workflows: [],
    }));
    const loaded = loadState(filePath);
    expect(loaded.queue).toEqual([]);
  });

  it("handles non-array queue field", () => {
    fs.writeFileSync(filePath, JSON.stringify({
      ...getDefaultState(),
      queue: "not-an-array",
    }));
    const loaded = loadState(filePath);
    expect(loaded.queue).toEqual([]);
  });
});
