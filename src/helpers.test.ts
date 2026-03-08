import { describe, it, expect } from "vitest";
import { parseTweetId, errorMessage, formatResult, isColdReplyBlocked, buildIntentUrl } from "./helpers.js";

describe("parseTweetId", () => {
  it("parses raw numeric ID", () => {
    expect(parseTweetId("1234567890")).toBe("1234567890");
  });

  it("parses x.com URL", () => {
    expect(parseTweetId("https://x.com/user/status/1234567890")).toBe("1234567890");
  });

  it("parses twitter.com URL", () => {
    expect(parseTweetId("https://twitter.com/user/status/1234567890")).toBe("1234567890");
  });

  it("parses URL with query parameters", () => {
    expect(parseTweetId("https://x.com/user/status/1234567890?s=20")).toBe("1234567890");
  });

  it("trims whitespace from raw ID", () => {
    expect(parseTweetId("  1234567890  ")).toBe("1234567890");
  });

  it("throws on invalid input", () => {
    expect(() => parseTweetId("not-a-valid-id")).toThrow("Invalid tweet ID or URL");
  });

  it("throws on empty string", () => {
    expect(() => parseTweetId("")).toThrow("Invalid tweet ID or URL");
  });
});

describe("errorMessage", () => {
  it("extracts message from Error", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom");
  });

  it("returns string errors as-is", () => {
    expect(errorMessage("something broke")).toBe("something broke");
  });

  it("stringifies non-Error non-string values", () => {
    expect(errorMessage(42)).toBe("42");
    expect(errorMessage(null)).toBe("null");
    expect(errorMessage(undefined)).toBe("undefined");
  });
});

describe("formatResult", () => {
  it("wraps data in { data } envelope", () => {
    const result = JSON.parse(formatResult({ id: "1" }, ""));
    expect(result).toEqual({ data: { id: "1" } });
  });

  it("includes x_rate_limit when non-empty", () => {
    const result = JSON.parse(formatResult({ id: "1" }, "5/15 remaining"));
    expect(result.x_rate_limit).toBe("5/15 remaining");
  });

  it("omits x_rate_limit when empty string", () => {
    const result = JSON.parse(formatResult({}, ""));
    expect(result).not.toHaveProperty("x_rate_limit");
  });

  it("includes x_budget string when provided", () => {
    const result = JSON.parse(formatResult({ id: "1" }, "", "3/8 replies used, 0/2 originals used"));
    expect(result.x_budget).toBe("3/8 replies used, 0/2 originals used");
  });

  it("omits x_budget when undefined", () => {
    const result = JSON.parse(formatResult({ id: "1" }, ""));
    expect(result).not.toHaveProperty("x_budget");
  });

  it("compacts tweet response when compact=true (no double data wrapping)", () => {
    const apiResponse = {
      data: {
        id: "123",
        text: "Hello",
        author_id: "456",
        public_metrics: { like_count: 5, retweet_count: 1, reply_count: 0 },
        entities: { urls: [] },
        created_at: "2026-02-23T13:00:00.000Z",
      },
      includes: {
        users: [{ id: "456", username: "author", name: "Author" }],
      },
    };
    const result = JSON.parse(formatResult(apiResponse, "", undefined, true));
    // compactResponse merges directly — { data: compactTweet, budget: ... }
    expect(result.data.author).toBe("@author");
    expect(result.data.likes).toBe(5);
    expect(result.data).not.toHaveProperty("entities");
    expect(result).not.toHaveProperty("includes");
  });

  it("does not compact when compact=false", () => {
    const apiResponse = {
      data: {
        id: "123",
        text: "Hello",
        author_id: "456",
        entities: { urls: [] },
      },
    };
    const result = JSON.parse(formatResult(apiResponse, "", undefined, false));
    // Non-compact: wraps raw API response in MCP envelope { data: <raw> }
    expect(result.data.data.entities).toBeDefined();
  });

  it("preserves meta in compact mode", () => {
    const apiResponse = {
      data: [
        { id: "1", text: "First", author_id: "10", public_metrics: { like_count: 1, retweet_count: 0, reply_count: 0 }, created_at: "2026-02-23T13:00:00.000Z" },
      ],
      includes: { users: [{ id: "10", username: "u", name: "U" }] },
      meta: { result_count: 1, next_token: "abc" },
    };
    const result = JSON.parse(formatResult(apiResponse, "", "3/8 replies used", true));
    expect(result.meta).toEqual({ result_count: 1, next_token: "abc" });
    expect(result.x_budget).toBe("3/8 replies used");
    expect(result.data).toHaveLength(1);
    expect(result.data[0].author).toBe("@u");
  });

  it("returns TOON string when toon=true", () => {
    const result = formatResult({ id: "1", text: "hi" }, "5/15", undefined, false, true);
    // TOON output is not JSON — should not parse as JSON
    expect(() => JSON.parse(result)).toThrow();
    // Should contain TOON key-value format
    expect(result).toContain("data:");
    expect(result).toContain("id: ");
    expect(result).toContain("x_rate_limit: 5/15");
  });

  it("returns TOON with compact+toon combination", () => {
    const apiResponse = {
      data: {
        id: "123",
        text: "Hello",
        author_id: "456",
        public_metrics: { like_count: 5, retweet_count: 1, reply_count: 0 },
        created_at: "2026-02-23T13:00:00.000Z",
      },
      includes: {
        users: [{ id: "456", username: "author", name: "Author" }],
      },
    };
    const result = formatResult(apiResponse, "5/15", "3/8 replies used", true, true);
    // Should be TOON, not JSON
    expect(() => JSON.parse(result)).toThrow();
    // Compact fields should appear
    expect(result).toContain("@author");
    expect(result).toContain("x_budget:");
    expect(result).toContain("x_rate_limit:");
  });

  it("returns JSON (not TOON) when toon=false", () => {
    const result = formatResult({ id: "1" }, "5/15", undefined, false, false);
    const parsed = JSON.parse(result);
    expect(parsed.data.id).toBe("1");
    expect(parsed.x_rate_limit).toBe("5/15");
  });
});

describe("isColdReplyBlocked", () => {
  it("detects the X API cold reply 403 error", () => {
    const err = new Error(
      'postTweet failed (HTTP 403): Reply to this conversation is not allowed because you have not been mentioned or otherwise engaged by the author. Rate limit: 299/300 remaining.',
    );
    expect(isColdReplyBlocked(err)).toBe(true);
  });

  it("rejects non-Error values", () => {
    expect(isColdReplyBlocked("some string")).toBe(false);
    expect(isColdReplyBlocked(null)).toBe(false);
    expect(isColdReplyBlocked(undefined)).toBe(false);
    expect(isColdReplyBlocked(403)).toBe(false);
  });

  it("rejects other 403 errors", () => {
    const err = new Error("postTweet failed (HTTP 403): Forbidden.");
    expect(isColdReplyBlocked(err)).toBe(false);
  });

  it("rejects non-403 errors with similar text", () => {
    const err = new Error("not been mentioned");
    expect(isColdReplyBlocked(err)).toBe(false);
  });

  it("rejects unrelated errors", () => {
    const err = new Error("postTweet failed (HTTP 429): Rate limited.");
    expect(isColdReplyBlocked(err)).toBe(false);
  });
});

describe("buildIntentUrl", () => {
  it("generates standalone post URL", () => {
    const url = buildIntentUrl({ text: "Hello world" });
    expect(url).toBe("https://x.com/intent/post?text=Hello+world");
  });

  it("generates reply URL with in_reply_to", () => {
    const url = buildIntentUrl({ text: "Great take!", in_reply_to: "123456789" });
    expect(url).toContain("text=Great+take%21");
    expect(url).toContain("in_reply_to=123456789");
    expect(url.startsWith("https://x.com/intent/post?")).toBe(true);
  });

  it("URL-encodes special characters", () => {
    const url = buildIntentUrl({ text: "Hello @user & friends 🚀\nnew line" });
    expect(url).toContain("text=");
    // Should not contain raw special chars
    expect(url).not.toContain(" ");
    expect(url).not.toContain("\n");
    // Decode to verify roundtrip
    const parsed = new URL(url);
    expect(parsed.searchParams.get("text")).toBe("Hello @user & friends 🚀\nnew line");
  });
});
