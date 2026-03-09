import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadDigestConfig, isDigestTime, resolveAutoCompletions, DigestConfig } from "./digest.js";
import type { QueueItem } from "./state.js";

describe("loadDigestConfig", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.X_MCP_DIGEST_TIMEZONE;
    delete process.env.X_MCP_DIGEST_HOURS;
    delete process.env.X_MCP_DIGEST_WINDOW_MINUTES;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns disabled config when no timezone set", () => {
    const config = loadDigestConfig();
    expect(config.enabled).toBe(false);
    expect(config.hours).toEqual([8, 13, 19]);
    expect(config.windowMinutes).toBe(60);
  });

  it("enables when timezone is set", () => {
    process.env.X_MCP_DIGEST_TIMEZONE = "Europe/Berlin";
    const config = loadDigestConfig();
    expect(config.enabled).toBe(true);
    expect(config.timezone).toBe("Europe/Berlin");
  });

  it("parses custom hours", () => {
    process.env.X_MCP_DIGEST_TIMEZONE = "Europe/Berlin";
    process.env.X_MCP_DIGEST_HOURS = "06,12,18";
    const config = loadDigestConfig();
    expect(config.hours).toEqual([6, 12, 18]);
  });

  it("filters invalid hours", () => {
    process.env.X_MCP_DIGEST_TIMEZONE = "Europe/Berlin";
    process.env.X_MCP_DIGEST_HOURS = "abc,25,-1,12";
    const config = loadDigestConfig();
    expect(config.hours).toEqual([12]);
  });

  it("falls back to defaults on all-invalid hours", () => {
    process.env.X_MCP_DIGEST_TIMEZONE = "Europe/Berlin";
    process.env.X_MCP_DIGEST_HOURS = "abc,xyz";
    const config = loadDigestConfig();
    expect(config.hours).toEqual([8, 13, 19]);
  });

  it("parses custom window minutes", () => {
    process.env.X_MCP_DIGEST_TIMEZONE = "Europe/Berlin";
    process.env.X_MCP_DIGEST_WINDOW_MINUTES = "30";
    const config = loadDigestConfig();
    expect(config.windowMinutes).toBe(30);
  });

  it("falls back on invalid window minutes", () => {
    process.env.X_MCP_DIGEST_TIMEZONE = "Europe/Berlin";
    process.env.X_MCP_DIGEST_WINDOW_MINUTES = "abc";
    const config = loadDigestConfig();
    expect(config.windowMinutes).toBe(60);
  });

  it("falls back on zero window minutes", () => {
    process.env.X_MCP_DIGEST_TIMEZONE = "Europe/Berlin";
    process.env.X_MCP_DIGEST_WINDOW_MINUTES = "0";
    const config = loadDigestConfig();
    expect(config.windowMinutes).toBe(60);
  });
});

describe("isDigestTime", () => {
  const berlinConfig: DigestConfig = {
    timezone: "Europe/Berlin",
    hours: [8, 13, 19],
    windowMinutes: 60,
    enabled: true,
  };

  it("returns false when disabled", () => {
    const disabled: DigestConfig = { ...berlinConfig, enabled: false };
    expect(isDigestTime(disabled, new Date("2026-01-15T07:00:00Z"))).toBe(false);
  });

  // CET (winter): Berlin = UTC+1
  it("returns true at 08:00 Berlin in winter (07:00 UTC)", () => {
    expect(isDigestTime(berlinConfig, new Date("2026-01-15T07:00:00Z"))).toBe(true);
  });

  it("returns true at 08:30 Berlin in winter (07:30 UTC)", () => {
    expect(isDigestTime(berlinConfig, new Date("2026-01-15T07:30:00Z"))).toBe(true);
  });

  it("returns false at 07:59 Berlin in winter (06:59 UTC)", () => {
    expect(isDigestTime(berlinConfig, new Date("2026-01-15T06:59:00Z"))).toBe(false);
  });

  it("returns false at 09:00 Berlin in winter (08:00 UTC) — window closed", () => {
    expect(isDigestTime(berlinConfig, new Date("2026-01-15T08:00:00Z"))).toBe(false);
  });

  // CEST (summer): Berlin = UTC+2
  it("returns true at 08:00 Berlin in summer (06:00 UTC)", () => {
    expect(isDigestTime(berlinConfig, new Date("2026-07-15T06:00:00Z"))).toBe(true);
  });

  it("returns false at 07:59 Berlin in summer (05:59 UTC)", () => {
    expect(isDigestTime(berlinConfig, new Date("2026-07-15T05:59:00Z"))).toBe(false);
  });

  // Second window: 13:00
  it("returns true at 13:15 Berlin in winter (12:15 UTC)", () => {
    expect(isDigestTime(berlinConfig, new Date("2026-01-15T12:15:00Z"))).toBe(true);
  });

  // Third window: 19:00
  it("returns true at 19:45 Berlin in winter (18:45 UTC)", () => {
    expect(isDigestTime(berlinConfig, new Date("2026-01-15T18:45:00Z"))).toBe(true);
  });

  it("returns false between windows (10:00 Berlin = 09:00 UTC winter)", () => {
    expect(isDigestTime(berlinConfig, new Date("2026-01-15T09:00:00Z"))).toBe(false);
  });

  it("returns false between windows (15:00 Berlin = 14:00 UTC winter)", () => {
    expect(isDigestTime(berlinConfig, new Date("2026-01-15T14:00:00Z"))).toBe(false);
  });

  it("respects custom window width", () => {
    const shortWindow: DigestConfig = { ...berlinConfig, windowMinutes: 30 };
    // 08:29 Berlin = within 30-min window
    expect(isDigestTime(shortWindow, new Date("2026-01-15T07:29:00Z"))).toBe(true);
    // 08:30 Berlin = outside 30-min window
    expect(isDigestTime(shortWindow, new Date("2026-01-15T07:30:00Z"))).toBe(false);
  });

  it("works with single digest hour", () => {
    const singleHour: DigestConfig = { ...berlinConfig, hours: [12] };
    expect(isDigestTime(singleHour, new Date("2026-01-15T11:00:00Z"))).toBe(true); // 12:00 Berlin
    expect(isDigestTime(singleHour, new Date("2026-01-15T07:00:00Z"))).toBe(false); // 08:00 Berlin
  });
});

describe("resolveAutoCompletions", () => {
  function makeItem(overrides: Partial<QueueItem> = {}): QueueItem {
    return {
      id: "q:100", type: "cold_reply", status: "pending",
      created_at: "2026-03-09T10:00:00Z",
      target_tweet_id: "100", target_author: "@someone",
      text: "Nice take!", intent_url: "https://x.com/intent/post?text=Nice+take%21&in_reply_to=100",
      source_tool: "reply_to_tweet",
      ...overrides,
    };
  }

  it("returns empty when no pending items", () => {
    expect(resolveAutoCompletions([], new Set(["100"]))).toEqual([]);
  });

  it("returns empty when timeline has no matching replies", () => {
    const items = [makeItem()];
    expect(resolveAutoCompletions(items, new Set(["999"]))).toEqual([]);
  });

  it("matches cold_reply when target_tweet_id is in timeline", () => {
    const items = [makeItem({ id: "q:100", target_tweet_id: "100" })];
    expect(resolveAutoCompletions(items, new Set(["100"]))).toEqual(["q:100"]);
  });

  it("matches multiple items", () => {
    const items = [
      makeItem({ id: "q:100", target_tweet_id: "100" }),
      makeItem({ id: "q:200", target_tweet_id: "200" }),
      makeItem({ id: "q:300", target_tweet_id: "300" }),
    ];
    expect(resolveAutoCompletions(items, new Set(["100", "300"]))).toEqual(["q:100", "q:300"]);
  });

  it("ignores mention_post items", () => {
    const items = [makeItem({ id: "q:post-123", type: "mention_post", target_tweet_id: undefined })];
    expect(resolveAutoCompletions(items, new Set(["100"]))).toEqual([]);
  });

  it("ignores cold_reply items without target_tweet_id", () => {
    const items = [makeItem({ target_tweet_id: undefined })];
    expect(resolveAutoCompletions(items, new Set(["100"]))).toEqual([]);
  });

  it("returns empty when timeline set is empty", () => {
    const items = [makeItem()];
    expect(resolveAutoCompletions(items, new Set())).toEqual([]);
  });
});
