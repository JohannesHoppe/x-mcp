import { compactResponse } from "./compact.js";
import { encode } from "./toon.js";

/**
 * Extract tweet ID from a URL or raw numeric ID string.
 */
export function parseTweetId(input: string): string {
  const match = input.match(/(?:twitter\.com|x\.com)\/\w+\/status\/(\d+)/);
  if (match) return match[1];
  const stripped = input.trim();
  if (/^\d+$/.test(stripped)) return stripped;
  throw new Error(`Invalid tweet ID or URL: ${input}`);
}

/**
 * Detect the X API "Operation Kill the Bots" 403 error on cold replies.
 * Returns true if the error is a 403 specifically about not being mentioned.
 */
export function isColdReplyBlocked(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /HTTP 403/.test(error.message) && /not been mentioned/.test(error.message);
}

/**
 * Build an X intent URL for one-click manual posting.
 * Reply: https://x.com/intent/post?in_reply_to=TWEET_ID&text=...
 * Standalone: https://x.com/intent/post?text=...
 */
export function buildIntentUrl(params: { text: string; in_reply_to?: string }): string {
  const url = new URL("https://x.com/intent/post");
  url.searchParams.set("text", params.text);
  if (params.in_reply_to) {
    url.searchParams.set("in_reply_to", params.in_reply_to);
  }
  return url.toString();
}

/**
 * Safely extract a message string from an unknown error value.
 */
export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  return String(e);
}

/**
 * Format API result and rate limit info as a JSON string for MCP responses.
 *
 * In compact mode, compactResponse preserves the API's { data, meta } shape,
 * so we merge x_rate_limit/budget into that structure directly — no extra wrapper.
 * In non-compact mode, we wrap the raw API response in { data: ... } as an
 * MCP envelope.
 */
export function formatResult(
  data: unknown,
  rateLimit: string,
  budgetString?: string,
  compact?: boolean,
  toon?: boolean,
): string {
  let output: Record<string, unknown>;

  if (compact && data && typeof data === "object") {
    const compacted = compactResponse(data);
    if (compacted && typeof compacted === "object") {
      // compactResponse returns { data: compactTweet/User, meta?: ... } or passthrough
      // Merge budget/x_rate_limit alongside data/meta — no extra wrapping
      output = { ...(compacted as Record<string, unknown>) };
    } else {
      output = { data: compacted };
    }
  } else {
    output = { data };
  }

  if (rateLimit) output.x_rate_limit = rateLimit;
  if (budgetString) output.x_budget = budgetString;
  if (toon) return encode(output);
  return JSON.stringify(output);
}
