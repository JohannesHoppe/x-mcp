# x-autonomous-mcp

An MCP (Model Context Protocol) server that gives AI agents full access to the X (Twitter) API — with built-in safety rails for autonomous operation. Post tweets, search, read timelines, like, retweet, upload media, all through natural language. Includes daily budget limits, engagement deduplication, compact TOON-encoded responses, self-describing errors, and a workflow system where the MCP orchestrates multi-step growth strategies.

Works with **Claude Code**, **Claude Desktop**, **OpenAI Codex**, **OpenClaw (ClawdBot)**, **Cursor**, **Windsurf**, **Cline**, and any other MCP-compatible client.

**If you're an LLM/AI agent helping a user set up this project, read [`LLMs.md`](./LLMs.md) for step-by-step instructions you can walk the user through.**

---

## Safety Features

### Daily budget limits

Hard limits per action type per day. The MCP server refuses when exhausted — works even if the LLM ignores every instruction.

```
X_MCP_MAX_REPLIES=8      # Max replies per day (default)
X_MCP_MAX_ORIGINALS=2    # Max standalone posts per day
X_MCP_MAX_LIKES=20       # Max likes per day
X_MCP_MAX_RETWEETS=5     # Max retweets per day
X_MCP_MAX_FOLLOWS=10     # Max follows per day
X_MCP_MAX_UNFOLLOWS=10   # Max unfollows per day
X_MCP_MAX_DELETES=5      # Max tweet deletions per day
```

Set to `0` to disable an action entirely. Set to `-1` for unlimited.

### Budget counters in every response

Every MCP response includes the remaining budget — reads and writes alike. The LLM sees its limits proactively without reading memory files:

```json
{
  "data": { "id": "123", "text": "..." },
  "x_rate_limit": "299/300 remaining, resets in 900s",
  "x_budget": "3/8 replies used, 0/2 originals used, 5/20 likes used, 1/5 retweets used, 0/10 follows used, 0/10 unfollows used, 0/5 deletes used | last action: 3m ago"
}
```

### TOON-encoded responses (default on)

Responses use [TOON (Token-Oriented Object Notation)](https://github.com/toon-format/toon) instead of JSON. For array-heavy responses (timelines, search results, followers), TOON declares field names once in a header and uses CSV-style rows — significantly fewer tokens than JSON:

```
data[2]{id,text,author,author_followers,author_follower_ratio,likes,retweets,replies,replied_to_id,created_at}:
  "123",Hello world,@foo,5200,2.1,9,2,0,null,"2026-02-23T17:00:01.000Z"
  "456",Another tweet,@foo,5200,2.1,3,0,1,null,"2026-02-23T16:00:00.000Z"
meta:
  result_count: 2
  next_token: abc
x_rate_limit: 299/300 (900s)
x_budget: "3/8 replies used, 0/2 originals used, 5/20 likes used, 1/5 retweets used, 0/10 follows used, 0/10 unfollows used, 0/5 deletes used"
```

Set `X_MCP_TOON=false` to get non-pretty JSON instead.

### Compact responses (default on)

Strips fields the LLM doesn't need. Dropped: `entities`, `edit_history_tweet_ids`, `conversation_id`, `lang`, `annotations`, URL expansions, image metadata. Flattens `public_metrics` and resolves `author_id` to `@username`. Long tweets (premium, >280 chars) are transparently merged — the `text` field always contains the full text regardless of tweet length.

### Engagement deduplication (default on)

Never reply to, like, or retweet the same tweet twice. Permanently tracked — prevents spam reports from re-engaging the same tweet days later.

### Self-describing errors with typo suggestions

Every tool validates parameters and returns actionable hints. Hardcoded redirects catch common mistakes, and fuzzy matching suggests the closest valid parameter for typos:

```
Unknown parameter 'reply_to_tweet_id': Use the 'reply_to_tweet' tool instead.
Unknown parameter 'poll_option': Did you mean 'poll_options'?

Valid parameters for post_tweet: text, poll_options, poll_duration_minutes, media_ids
```

### Cold reply auto-fallback (broken by X — see warning above)

X's API (since Feb 2026) blocks programmatic replies unless the target author has @mentioned your account. `reply_to_tweet` handles this automatically: it checks a `mentioned_by` cache (populated by `get_mentions`) and posts a quote tweet instead when a direct reply would be blocked. The response includes `_fallback: "quote_tweet"` when this happens. Budget counts against the reply limit regardless.

**Update (2026-03-01):** The quote-tweet fallback is also blocked by X. Cold quote tweets return the same 403 as cold replies. The code is correct — X just blocks everything. See the warning at the top of this README.

### Budget-gated destructive tools

`delete_tweet` and `unfollow_user` are budget-limited. Set to `0` to block them entirely:

```
X_MCP_MAX_UNFOLLOWS=10   # Default 10/day. Set to 0 to block all unfollows.
X_MCP_MAX_DELETES=5      # Default 5/day. Set to 0 to block all deletions.
```

### Protected accounts

Comma-separated usernames that **cannot** be unfollowed — checked by `unfollow_user`, `cleanup_non_followers`, and workflow cleanup:

```
X_MCP_PROTECTED_ACCOUNTS=friend1,friend2,@mentor
```

### Unknown parameter detection

Unknown parameters are caught by the MCP server (not silently ignored). Unknown keys trigger fuzzy-matched suggestions or hardcoded redirect hints — the LLM learns from its mistake instead of getting an opaque validation error.

---

## Features

### Engagement filtering on `search_tweets`

The X API v2 has no `min_faves` operator. x-autonomous-mcp adds **client-side engagement filtering** so low-engagement tweets never reach the LLM:

```
search_tweets query="AI safety -is:retweet" max_results=10 min_likes=20 min_retweets=5
```

When filters are set, the server fetches 100 results internally, filters by `public_metrics`, and returns up to `max_results`. The `includes.users` array is pruned to match.

### Relevancy sorting on `search_tweets`

```
search_tweets query="AI hallucination" sort_order="relevancy"
```

Default is `recency` (newest first). `relevancy` surfaces popular tweets first, which naturally pairs with `min_likes` filtering.

### Incremental polling via `since_id`

Both `search_tweets` and `get_mentions` accept `since_id` — only returns results newer than the given tweet ID. For agents that poll periodically, this avoids re-processing old results and saves tokens.

```
get_mentions since_id="2025881827982876805"
search_tweets query="@mybot" since_id="2025881827982876805"
```

### Username or ID — everywhere

All user-related tools (`get_timeline`, `get_followers`, `get_following`, `follow_user`, `unfollow_user`, `get_non_followers`) accept either a `@username`, a plain username, or a numeric user ID. No more two-step "look up user first, then get timeline" dance. The server resolves it automatically.

```
get_timeline user="@JohannesHoppe"
get_timeline user="JohannesHoppe"
get_timeline user="43859239"
```

### Lean responses

- Omits `profile_image_url` and media expansions from API requests (useless for LLMs, wastes tokens)
- Includes `public_metrics` in user expansions for search results (so agents can see follower counts when evaluating reply targets)

---

## What Can It Do?

| Category | Tools | What You Can Say |
|----------|-------|------------------|
| **Post** | `post_tweet`, `reply_to_tweet`, `quote_tweet` | "Post 'hello world' on X" / "Reply to this tweet saying thanks" |
| **Read** | `get_tweet`, `search_tweets`, `get_timeline`, `get_mentions` | "Show me @JohannesHoppe's latest posts" / "Search for tweets about MCP" |
| **Users** | `get_user`, `get_followers`, `get_following`, `get_non_followers` | "Look up @openai" / "Who doesn't follow me back?" |
| **Engage** | `like_tweet`, `retweet`, `follow_user` | "Like that tweet" / "Follow @openai" |
| **Undo** | `unlike_tweet`, `unretweet`, `unfollow_user`, `delete_tweet` | "Unlike that tweet" / "Unfollow @spambot" |
| **Lists** | `get_list_members`, `get_list_tweets`, `get_followed_lists` | "Show me members of this list" / "What lists do I follow?" |
| **Media** | `upload_media` | "Upload this image and post it with the caption..." |
| **Analytics** | `get_metrics` | "How many impressions did my last post get?" |
| **Workflows** | `get_next_task`, `submit_task`, `start_workflow`, `get_workflow_status`, `cleanup_non_followers` | "What's my next task?" / "Start a follow cycle for @interesting_user" |

Accepts tweet URLs or IDs interchangeably -- paste `https://x.com/user/status/123` or just `123`.
Accepts usernames with or without `@`, or numeric user IDs -- `@JohannesHoppe`, `JohannesHoppe`, or `43859239`.

Search results and timeline tweets include **`author_followers`** (raw count) and **`author_follower_ratio`** (followers/following ratio, precomputed) so you can evaluate engagement quality without burning tokens on arithmetic.

---

## Example Responses (TOON format)

Every response includes `x_rate_limit` and `x_budget` fields. Array endpoints use TOON's tabular format (field names once in header, CSV-style rows). Set `X_MCP_TOON=false` for JSON instead.

### get_timeline / search_tweets / get_mentions

```
data[3]{id,text,author,author_followers,author_follower_ratio,likes,retweets,replies,replied_to_id,created_at}:
  "1893660912",Build agents not wrappers,@karpathy,3940281,118.6,4521,312,89,null,"2026-02-23T17:00:01.000Z"
  "1893660913",Hot take: MCP is underrated,@swyx,98200,3.2,210,45,12,null,"2026-02-23T16:30:00.000Z"
  "1893660914",Agreed!,@johndoe,1500,0.8,3,0,0,"1893660913","2026-02-23T16:45:00.000Z"
meta:
  result_count: 3
  next_token: abc123
x_rate_limit: 299/300 (900s)
x_budget: "3/8 replies used, 0/2 originals used, 5/20 likes used, 1/5 retweets used, 0/10 follows used, 0/10 unfollows used, 0/5 deletes used | last action: 3m ago"
```

Compact tweets include `author_followers` (raw count) and `author_follower_ratio` (followers/following ratio, precomputed). `replied_to_id` is the tweet ID this is replying to, or `null` for standalone tweets.

### get_tweet

```
data:
  id: "1893660912"
  text: Build agents not wrappers
  author: "@karpathy"
  author_followers: 3940281
  author_follower_ratio: 118.6
  likes: 4521
  retweets: 312
  replies: 89
  replied_to_id: null
  created_at: "2026-02-23T17:00:01.000Z"
x_rate_limit: 299/300 (900s)
x_budget: "3/8 replies used, 0/2 originals used, 5/20 likes used, 1/5 retweets used, 0/10 follows used, 0/10 unfollows used, 0/5 deletes used"
```

### get_user

```
data:
  id: "43859239"
  username: JohannesHoppe
  name: Johannes Hoppe
  followers: 1234
  following: 567
  tweets: 890
  bio: Building things with TypeScript and AI
  pinned_tweet_id: "1893650001"
x_rate_limit: 299/300 (900s)
x_budget: "0/8 replies used, 0/2 originals used, 0/20 likes used, 0/5 retweets used, 0/10 follows used, 0/10 unfollows used, 0/5 deletes used"
```

### get_followers / get_following

```
data[2]{id,username,name,followers,following,tweets,bio,pinned_tweet_id}:
  "123456",alice_dev,Alice,8900,450,1200,Full-stack engineer,"1893650100"
  "789012",bob_ai,Bob,340,120,890,ML researcher,null
meta:
  result_count: 2
  next_token: def456
x_rate_limit: 14/15 (900s)
x_budget: "0/8 replies used, 0/2 originals used, 0/20 likes used, 0/5 retweets used, 0/10 follows used, 0/10 unfollows used, 0/5 deletes used"
```

### get_non_followers

```
data[2]{id,username,name,followers,following,tweets,bio,pinned_tweet_id}:
  "111222",inactive_acc,Some Account,12,5000,3,,null
  "333444",spam_bot,Spammy,0,10000,50000,Follow me!,null
meta:
  total_following: 567
  total_followers: 1234
  non_followers_count: 2
x_rate_limit: 14/15 (900s)
x_budget: "0/8 replies used, 0/2 originals used, 0/20 likes used, 0/5 retweets used, 0/10 follows used, 0/10 unfollows used, 0/5 deletes used"
```

Sorted by follower count ascending (lowest quality first = best unfollow candidates). Summary fields (`total_following`, `total_followers`, `non_followers_count`) are in `meta`.

### post_tweet / reply_to_tweet / quote_tweet

```
data:
  id: "1893661000"
  text: Hello world!
x_rate_limit: 199/200 (900s)
x_budget: "0/8 replies used, 1/2 originals used, 0/20 likes used, 0/5 retweets used, 0/10 follows used, 0/10 unfollows used, 0/5 deletes used | last action: 0s ago"
```

### like_tweet / retweet / follow_user

```
data:
  liked: true
x_rate_limit: 199/200 (900s)
x_budget: "0/8 replies used, 0/2 originals used, 1/20 likes used, 0/5 retweets used, 0/10 follows used, 0/10 unfollows used, 0/5 deletes used | last action: 0s ago"
```

### get_metrics

```
data:
  id: "1893660912"
  text: Build agents not wrappers
  public_metrics:
    like_count: 4521
    retweet_count: 312
    reply_count: 89
    quote_count: 23
    bookmark_count: 156
    impression_count: 892340
x_rate_limit: 299/300 (900s)
x_budget: "0/8 replies used, 0/2 originals used, 0/20 likes used, 0/5 retweets used, 0/10 follows used, 0/10 unfollows used, 0/5 deletes used"
```

### upload_media

```
media_id: "1893670001"
message: Upload complete. Use this media_id in post_tweet.
x_rate_limit: 299/300 (900s)
x_budget: "0/8 replies used, 0/2 originals used, 0/20 likes used, 0/5 retweets used, 0/10 follows used, 0/10 unfollows used, 0/5 deletes used"
```

### Error responses

Budget exhausted:
```
Error: Daily reply limit reached (8/8). Try again tomorrow. Remaining today: 0 replies, 2 originals, 15 likes, 5 retweets, 10 follows, 10 unfollows, 5 deletes.

Current x_budget: 8/8 replies used (LIMIT REACHED), 0/2 originals used, 5/20 likes used, 0/5 retweets used, 0/10 follows used, 0/10 unfollows used, 0/5 deletes used
```

Duplicate engagement:
```
Error: Already liked tweet 1893660912 at 2026-02-23T10:00:00.000Z. Duplicate blocked.

Current x_budget: 3/8 replies used, 0/2 originals used, 5/20 likes used, 1/5 retweets used, 0/10 follows used, 0/10 unfollows used, 0/5 deletes used
```

Unknown parameter:
```
Error: Unknown parameter 'poll_option': Did you mean 'poll_options'?

Valid parameters for post_tweet: text, poll_options, poll_duration_minutes, media_ids

Current x_budget: 0/8 replies used, 0/2 originals used, 0/20 likes used, 0/5 retweets used, 0/10 follows used, 0/10 unfollows used, 0/5 deletes used
```

---

## Workflow System

The MCP includes a hardcoded workflow engine that orchestrates multi-step growth strategies. The MCP is the authority — it auto-executes all mechanical steps and only asks the LLM when it needs creative input. Workflows are persistent: if the LLM disconnects, the next `get_next_task` call resumes exactly where things left off. Users targeted by active workflows are automatically protected from `cleanup_non_followers` — you won't accidentally unfollow someone you're in the middle of engaging with.

| Workflow | Summary | Docs |
|----------|---------|------|
| **follow_cycle** | Follow, like pinned, reply, wait 7d, check follow-back, cleanup | [Full spec](docs/WORKFLOW-FOLLOW-CYCLE.md) |
| **reply_track** | Track a reply for 48h, auto-delete if zero engagement | [Full spec](docs/WORKFLOW-REPLY-TRACK.md) |
| **cleanup_non_followers** | One-shot batch unfollow of non-followers | [Full spec](docs/WORKFLOW-CLEANUP-NON-FOLLOWERS.md) |

### Workflow Tools

| Tool | Description |
|------|-------------|
| `get_next_task` | Auto-processes all pending work, returns next LLM assignment |
| `submit_task` | Submit LLM response (e.g. reply text), auto-continues workflow |
| `start_workflow` | Begin a new follow_cycle or reply_track (`reply_tweet_id` required for reply_track) |
| `get_workflow_status` | Show all workflows with steps, dates, outcomes |
| `cleanup_non_followers` | Batch-unfollow non-followers (respects budget + protected accounts) |

---

## Setup

### 1. Clone and build

```bash
git clone https://github.com/JohannesHoppe/x-autonomous-mcp.git
cd x-autonomous-mcp
npm install
npm run build
```

### 2. Get your X API credentials

You need 5 credentials from the [X Developer Portal](https://developer.x.com/en/portal/dashboard). Here's exactly how to get them:

#### a) Create an app

1. Go to the [X Developer Portal](https://developer.x.com/en/portal/dashboard)
2. Sign in with your X account
3. Go to **Apps** in the left sidebar
4. Click **Create App** (you may need to sign up for a developer account first)
5. Give it a name (e.g., `my-x-mcp`)
6. You'll immediately see your **Consumer Key** (API Key), **Secret Key** (API Secret), and **Bearer Token**
7. **Save all three now** -- the secret won't be shown again

#### b) Enable write permissions

By default, new apps only have Read permissions. You need Read and Write to post tweets, like, retweet, etc.

1. In your app's page, scroll down to **User authentication settings**
2. Click **Set up**
3. Set **App permissions** to **Read and write**
4. Set **Type of App** to **Web App, Automated App or Bot**
5. Set **Callback URI / Redirect URL** to `https://localhost` (required but won't be used)
6. Set **Website URL** to any valid URL (e.g., `https://x.com`)
7. Click **Save**

#### c) Generate access tokens (with write permissions)

After enabling write permissions, you need to generate (or regenerate) your Access Token and Secret so they carry the new permissions:

1. Go back to your app's **Keys and Tokens** page
2. Under **Access Token and Secret**, click **Regenerate**
3. Save both the **Access Token** and **Access Token Secret**

If you skip step (b) before generating tokens, your tokens will be Read-only and posting will fail with a 403 error.

### 3. Configure credentials

Copy the example env file and fill in your 5 credentials:

```bash
cp .env.example .env
```

Edit `.env`:

```
X_API_KEY=your_consumer_key
X_API_SECRET=your_secret_key
X_BEARER_TOKEN=your_bearer_token
X_ACCESS_TOKEN=your_access_token
X_ACCESS_TOKEN_SECRET=your_access_token_secret
```

### 4. Configure safety features (optional)

See `.env.example` for all available options:

```bash
# Daily budget limits (defaults shown)
X_MCP_MAX_REPLIES=8
X_MCP_MAX_ORIGINALS=2
X_MCP_MAX_LIKES=20
X_MCP_MAX_RETWEETS=5
X_MCP_MAX_FOLLOWS=10
X_MCP_MAX_UNFOLLOWS=10
X_MCP_MAX_DELETES=5

# TOON encoding (default: true) — set to "false" for JSON
X_MCP_TOON=true

# Compact responses (default: true)
X_MCP_COMPACT=true

# Engagement deduplication (default: true)
X_MCP_DEDUP=true

# Protected accounts (cannot be unfollowed)
# X_MCP_PROTECTED_ACCOUNTS=friend1,friend2,@mentor

# Max active workflows (default: 200)
# X_MCP_MAX_WORKFLOWS=200
```

---

## Connect to Your Client

See **[Client Setup](docs/CLIENT-SETUP.md)** for configuration instructions for Claude Code, Claude Desktop, Cursor, OpenAI Codex, Windsurf, Cline, and other MCP clients.

---

## Troubleshooting

### 403 "oauth1-permissions" error when posting
Your Access Token was generated before you enabled write permissions. Go to the X Developer Portal, ensure App permissions are set to "Read and write", then **Regenerate** your Access Token and Secret.

### 401 Unauthorized
Double-check that all 5 credentials in your `.env` are correct and that there are no extra spaces or line breaks.

### 429 Rate Limited
The error message includes exactly when the rate limit resets. Wait until then, or reduce request frequency.

### Server shows "Connected" but tools aren't used
Make sure you added the server with the correct scope (user/global, not project-scoped if you want it everywhere), then restart your client.

---

## Rate Limiting

Every response includes rate limit info: remaining requests, total limit, and reset time. When a limit is hit, you get a clear error with the exact reset timestamp.

## Pagination

List endpoints return a `next_token` in the response. Pass it back to get the next page of results. Works on: `search_tweets`, `get_timeline`, `get_mentions`, `get_followers`, `get_following`, `get_list_members`, `get_list_tweets`, `get_followed_lists`.

## Search Query Syntax

The `search_tweets` tool supports X's full query language:

- `from:username` -- posts by a specific user
- `to:username` -- replies to a specific user
- `#hashtag` -- posts containing a hashtag
- `"exact phrase"` -- exact text match
- `has:media` / `has:links` / `has:images` -- filter by content type
- `is:reply` / `-is:retweet` -- filter by post type
- `lang:en` -- filter by language
- Combine with spaces (AND) or `OR`

---

## Credits

Based on [Infatoshi/x-mcp](https://github.com/Infatoshi/x-mcp) (MIT, [@Infatoshi](https://github.com/Infatoshi)).

TOON encoder vendored from [@toon-format/toon](https://github.com/toon-format/toon) (MIT, [Johann Schopplich](https://github.com/johannschopplich)).

## License

MIT
