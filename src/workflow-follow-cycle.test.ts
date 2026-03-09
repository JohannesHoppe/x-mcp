import { describe, it, expect, vi } from "vitest";
import { processWorkflows } from "./workflow.js";
import { getDefaultState } from "./state.js";
import type { StateFile, Workflow } from "./state.js";
import type { BudgetConfig } from "./safety.js";
import type { XApiClient } from "./x-api.js";

function makeConfig(overrides?: Partial<BudgetConfig>): BudgetConfig {
  return {
    maxReplies: 8,
    maxOriginals: 2,
    maxLikes: 20,
    maxRetweets: 5,
    maxFollows: 10,
    maxUnfollows: 10,
    maxDeletes: 5,
    ...overrides,
  };
}

function makeState(overrides?: Partial<StateFile>): StateFile {
  return { ...getDefaultState(), ...overrides };
}

function makeWorkflow(overrides?: Partial<Workflow>): Workflow {
  return {
    id: "fc:testuser",
    type: "follow_cycle",
    current_step: "execute_follow",
    target_user_id: "12345",
    target_username: "testuser",
    created_at: new Date().toISOString(),
    check_after: null,
    context: {},
    actions_done: [],
    outcome: null,
    ...overrides,
  };
}

function makeMockClient(overrides?: Partial<Record<string, unknown>>): XApiClient {
  return {
    followUser: vi.fn().mockResolvedValue({ result: { data: { following: true } }, rateLimit: "" }),
    getUser: vi.fn().mockResolvedValue({ result: { data: { id: "12345", pinned_tweet_id: "pin123", public_metrics: { followers_count: 5000 } } }, rateLimit: "" }),
    likeTweet: vi.fn().mockResolvedValue({ result: { data: { liked: true } }, rateLimit: "" }),
    unlikeTweet: vi.fn().mockResolvedValue({ result: { data: { liked: false } }, rateLimit: "" }),
    getTimeline: vi.fn().mockResolvedValue({
      result: {
        data: [
          { id: "tweet1", text: "Original post about AI", author_id: "12345" },
          { id: "tweet2", text: "Reply to someone", author_id: "12345", referenced_tweets: [{ type: "replied_to", id: "other" }] },
        ],
      },
      rateLimit: "",
    }),
    getTweet: vi.fn().mockResolvedValue({ result: { data: { id: "tweet1", author_id: "12345" } }, rateLimit: "" }),
    postTweet: vi.fn().mockResolvedValue({ result: { data: { id: "reply789" } }, rateLimit: "" }),
    deleteTweet: vi.fn().mockResolvedValue({ result: { data: { deleted: true } }, rateLimit: "" }),
    unfollowUser: vi.fn().mockResolvedValue({ result: { data: { following: false } }, rateLimit: "" }),
    getAuthenticatedUserId: vi.fn().mockResolvedValue("myid"),
    getFollowers: vi.fn().mockResolvedValue({ result: { data: [] }, rateLimit: "" }),
    getFollowing: vi.fn().mockResolvedValue({ result: { data: [], meta: {} }, rateLimit: "" }),
    getTweetMetrics: vi.fn().mockResolvedValue({
      result: { data: { public_metrics: { like_count: 5, reply_count: 2, impression_count: 100 } } },
      rateLimit: "",
    }),
    resolveUserId: vi.fn().mockResolvedValue("12345"),
    getNonFollowers: vi.fn().mockResolvedValue({ result: { data: [], meta: { total_following: 0, total_followers: 0, non_followers_count: 0 } }, rateLimit: "" }),
    ...overrides,
  } as unknown as XApiClient;
}

describe("processWorkflows — follow_cycle", () => {
  it("auto-executes follow + like pinned + get timeline, returns at need_reply_text", async () => {
    const workflow = makeWorkflow({ current_step: "execute_follow" });
    const state = makeState({ workflows: [workflow] });
    const client = makeMockClient();
    const config = makeConfig();

    const result = await processWorkflows(state, client, config, []);

    expect(client.followUser).toHaveBeenCalledWith("12345");
    expect(client.getUser).toHaveBeenCalled();
    expect(client.likeTweet).toHaveBeenCalledWith("pin123");
    expect(client.getTimeline).toHaveBeenCalled();

    expect(workflow.current_step).toBe("need_reply_text");
    expect(workflow.actions_done).toContain("followed");
    expect(workflow.actions_done).toContain("liked_pinned");
    expect(workflow.context.target_tweet_id).toBe("tweet1"); // picks non-reply
    expect(workflow.context.pinned_tweet_id).toBe("pin123");
    expect(workflow.context.author_followers).toBe("5000");

    expect(result.next_task).not.toBeNull();
    expect(result.next_task!.workflow_id).toBe("fc:testuser");
    expect(result.next_task!.instruction).toContain("reply");
    expect(result.next_task!.context.author_followers).toBe("5000");

    // Verify budget counters were incremented
    expect(state.budget.follows).toBe(1);
    expect(state.budget.likes).toBe(1);
  });

  it("skips duplicate follow", async () => {
    const workflow = makeWorkflow({ current_step: "execute_follow" });
    const state = makeState({
      workflows: [workflow],
      engaged: { ...getDefaultState().engaged, followed: [{ tweet_id: "12345", at: new Date().toISOString() }] },
    });
    const client = makeMockClient();

    await processWorkflows(state, client, makeConfig(), []);

    expect(client.followUser).not.toHaveBeenCalled();
    expect(workflow.outcome).toBe("skipped_duplicate");
    expect(workflow.current_step).toBe("done");
  });

  it("respects follow budget exhaustion", async () => {
    const workflow = makeWorkflow({ current_step: "execute_follow" });
    const state = makeState({
      workflows: [workflow],
      budget: { ...getDefaultState().budget, follows: 10 },
    });
    const client = makeMockClient();

    const result = await processWorkflows(state, client, makeConfig(), []);

    expect(client.followUser).not.toHaveBeenCalled();
    expect(result.auto_completed[0]).toContain("budget exhausted");
  });

  it("queues reply when author not in mentioned_by (no budget consumed)", async () => {
    const workflow = makeWorkflow({
      current_step: "post_reply",
      context: { reply_text: "Great insight!", target_tweet_id: "tweet1", target_tweet_text: "This is the original tweet text that should appear as a snippet" },
    });
    const state = makeState({ workflows: [workflow] });
    const client = makeMockClient();

    await processWorkflows(state, client, makeConfig(), []);

    // Author "12345" is NOT in mentioned_by → queued for manual posting
    expect(client.getTweet).toHaveBeenCalledWith("tweet1");
    expect(client.postTweet).not.toHaveBeenCalled();
    expect(workflow.current_step).toBe("waiting");
    expect(workflow.check_after).not.toBeNull();
    expect(workflow.actions_done).toContain("reply_queued");

    // Budget consumed (bot thinks it replied)
    expect(state.budget.replies).toBe(1);
    // Dedup recorded
    expect(state.engaged.replied_to).toHaveLength(1);
    expect(state.engaged.replied_to[0].tweet_id).toBe("tweet1");

    // Queue item added with context
    expect(state.queue.length).toBe(1);
    expect(state.queue[0].id).toBe("q:tweet1");
    expect(state.queue[0].type).toBe("cold_reply");
    expect(state.queue[0].status).toBe("pending");
    expect(state.queue[0].text).toBe("Great insight!");
    expect(state.queue[0].target_text_snippet).toBe("This is the original tweet text that should appear as a snippet");
    expect(state.queue[0].intent_url).toContain("x.com/intent/post");
    expect(state.queue[0].intent_url).toContain("in_reply_to=tweet1");
  });

  it("posts direct reply when author is in mentioned_by (budget consumed)", async () => {
    const workflow = makeWorkflow({
      current_step: "post_reply",
      context: { reply_text: "Great insight!", target_tweet_id: "tweet1" },
    });
    // Author "12345" IS in mentioned_by
    const state = makeState({ workflows: [workflow], mentioned_by: ["12345"] });
    const client = makeMockClient();

    await processWorkflows(state, client, makeConfig(), []);

    expect(client.postTweet).toHaveBeenCalledWith({
      text: "Great insight!",
      reply_to: "tweet1",
    });
    expect(workflow.current_step).toBe("waiting");
    expect(workflow.context.reply_tweet_id).toBe("reply789");
    expect(workflow.actions_done).toContain("replied");
    // Budget IS consumed for direct replies
    expect(state.budget.replies).toBe(1);
    // No queue items
    expect(state.queue.length).toBe(0);
  });

  it("queues reply when getTweet fails (no budget consumed)", async () => {
    const workflow = makeWorkflow({
      current_step: "post_reply",
      context: { reply_text: "Great insight!", target_tweet_id: "tweet1" },
    });
    const state = makeState({ workflows: [workflow] });
    const client = makeMockClient({
      getTweet: vi.fn().mockRejectedValue(new Error("getTweet API error")),
    });

    await processWorkflows(state, client, makeConfig(), []);

    // getTweet failed → authorId undefined → canReply false → queued
    expect(client.postTweet).not.toHaveBeenCalled();
    expect(workflow.actions_done).toContain("reply_queued");
    expect(state.budget.replies).toBe(1);
    expect(state.engaged.replied_to).toHaveLength(1);
    expect(state.queue.length).toBe(1);
    expect(state.queue[0].type).toBe("cold_reply");
  });

  it("queues reply when getTweet returns no author_id (no budget consumed)", async () => {
    const workflow = makeWorkflow({
      current_step: "post_reply",
      context: { reply_text: "Great insight!", target_tweet_id: "tweet1" },
    });
    const state = makeState({ workflows: [workflow] });
    const client = makeMockClient({
      getTweet: vi.fn().mockResolvedValue({ result: { data: { id: "tweet1" } }, rateLimit: "" }),
    });

    await processWorkflows(state, client, makeConfig(), []);

    // author_id missing → canReply false → queued
    expect(client.postTweet).not.toHaveBeenCalled();
    expect(workflow.actions_done).toContain("reply_queued");
    expect(state.budget.replies).toBe(1);
    expect(state.engaged.replied_to).toHaveLength(1);
    expect(state.queue.length).toBe(1);
  });

  it("queues reply on 403 even when author is in mentioned_by (stale cache, no budget consumed)", async () => {
    const workflow = makeWorkflow({
      current_step: "post_reply",
      context: { reply_text: "Great insight!", target_tweet_id: "tweet1" },
    });
    const state = makeState({ workflows: [workflow], mentioned_by: ["12345"] });
    const client = makeMockClient({
      postTweet: vi.fn()
        .mockRejectedValueOnce(new Error('postTweet failed (HTTP 403): Reply to this conversation is not allowed because you have not been mentioned or otherwise engaged by the author.')),
    });

    await processWorkflows(state, client, makeConfig(), []);

    // First call: reply attempt → 403 (stale cache) → queued
    expect(client.postTweet).toHaveBeenCalledTimes(1);
    expect(client.postTweet).toHaveBeenCalledWith({ text: "Great insight!", reply_to: "tweet1" });
    expect(workflow.actions_done).toContain("reply_queued");
    // Budget consumed (bot thinks it replied)
    expect(state.budget.replies).toBe(1);
    expect(state.engaged.replied_to).toHaveLength(1);
    expect(state.queue.length).toBe(1);
    expect(state.queue[0].intent_url).toContain("in_reply_to=tweet1");
  });

  it("skips waiting workflows that haven't reached check_after", async () => {
    const futureDate = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const workflow = makeWorkflow({
      current_step: "waiting",
      check_after: futureDate,
    });
    const state = makeState({ workflows: [workflow] });
    const client = makeMockClient();

    const result = await processWorkflows(state, client, makeConfig(), []);

    expect(workflow.current_step).toBe("waiting"); // unchanged
    expect(result.next_task).toBeNull();
    expect(result.status).toContain("waiting");
  });

  it("advances to check_followback when check_after has passed", async () => {
    const pastDate = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const workflow = makeWorkflow({
      current_step: "waiting",
      check_after: pastDate,
    });
    const state = makeState({ workflows: [workflow] });
    // Mock: target's following list does NOT include our ID → not followed back
    const client = makeMockClient();

    await processWorkflows(state, client, makeConfig(), []);

    expect(client.getFollowing).toHaveBeenCalled();
    // Since mock getFollowing returns empty array → not followed back → cleanup
    expect(workflow.outcome).toBe("cleaned_up");
    expect(workflow.current_step).toBe("done");
  });

  it("detects followback by checking target's following list", async () => {
    const pastDate = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const workflow = makeWorkflow({
      current_step: "waiting",
      check_after: pastDate,
    });
    const state = makeState({ workflows: [workflow] });
    // Mock: target follows us (our ID "myid" is in their following list)
    const client = makeMockClient({
      getFollowing: vi.fn().mockResolvedValue({
        result: { data: [{ id: "myid" }, { id: "other" }], meta: {} },
        rateLimit: "",
      }),
    });

    await processWorkflows(state, client, makeConfig(), []);

    expect(workflow.outcome).toBe("followed_back");
    expect(workflow.current_step).toBe("done");
  });

  it("paginates through target's following list to find followback", async () => {
    const pastDate = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const workflow = makeWorkflow({
      current_step: "waiting",
      check_after: pastDate,
    });
    const state = makeState({ workflows: [workflow] });
    // Mock: our ID is on page 2 of target's following list
    const client = makeMockClient({
      getFollowing: vi.fn()
        .mockResolvedValueOnce({
          result: { data: [{ id: "other1" }, { id: "other2" }], meta: { next_token: "page2" } },
          rateLimit: "",
        })
        .mockResolvedValueOnce({
          result: { data: [{ id: "myid" }], meta: {} },
          rateLimit: "",
        }),
    });

    await processWorkflows(state, client, makeConfig(), []);

    expect(client.getFollowing).toHaveBeenCalledTimes(2);
    expect(workflow.outcome).toBe("followed_back");
  });

  it("protects accounts from cleanup by username", async () => {
    const workflow = makeWorkflow({
      current_step: "cleanup",
      context: { pinned_tweet_id: "pin123", reply_tweet_id: "reply789" },
    });
    const state = makeState({ workflows: [workflow] });
    const client = makeMockClient();

    await processWorkflows(state, client, makeConfig(), [{ username: "testuser", userId: "12345" }]);

    expect(client.unfollowUser).not.toHaveBeenCalled();
    expect(workflow.outcome).toBe("protected_kept");
  });

  it("protects accounts from cleanup by userId", async () => {
    const workflow = makeWorkflow({
      current_step: "cleanup",
      context: { pinned_tweet_id: "pin123", reply_tweet_id: "reply789" },
    });
    const state = makeState({ workflows: [workflow] });
    const client = makeMockClient();

    // Username doesn't match, but userId does
    await processWorkflows(state, client, makeConfig(), [{ username: "different_name", userId: "12345" }]);

    expect(client.unfollowUser).not.toHaveBeenCalled();
    expect(workflow.outcome).toBe("protected_kept");
  });

  it("performs cleanup — unlike, delete, unfollow", async () => {
    const workflow = makeWorkflow({
      current_step: "cleanup",
      context: { pinned_tweet_id: "pin123", reply_tweet_id: "reply789" },
    });
    const state = makeState({ workflows: [workflow] });
    const client = makeMockClient();

    await processWorkflows(state, client, makeConfig(), []);

    expect(client.unlikeTweet).toHaveBeenCalledWith("pin123");
    expect(client.deleteTweet).toHaveBeenCalledWith("reply789");
    expect(client.unfollowUser).toHaveBeenCalledWith("12345");
    expect(workflow.outcome).toBe("cleaned_up");
    expect(workflow.actions_done).toContain("unliked_pinned");
    expect(workflow.actions_done).toContain("deleted_reply");
    expect(workflow.actions_done).toContain("unfollowed");

    // Verify budget counters incremented
    expect(state.budget.deletes).toBe(1);
    expect(state.budget.unfollows).toBe(1);
  });

  it("skips reply when no target tweet found in timeline", async () => {
    const workflow = makeWorkflow({ current_step: "execute_follow" });
    const state = makeState({ workflows: [workflow] });
    // Mock: empty timeline
    const client = makeMockClient({
      getTimeline: vi.fn().mockResolvedValue({ result: { data: [] }, rateLimit: "" }),
    });

    const result = await processWorkflows(state, client, makeConfig(), []);

    expect(workflow.current_step).toBe("waiting");
    expect(workflow.check_after).not.toBeNull();
    expect(result.next_task).toBeNull(); // no LLM task since reply was skipped
    expect(result.auto_completed.some((s: string) => s.includes("No suitable tweet"))).toBe(true);
  });

  it("continues when follow succeeds but getUser fails", async () => {
    const workflow = makeWorkflow({ current_step: "execute_follow" });
    const state = makeState({ workflows: [workflow] });
    const client = makeMockClient({
      getUser: vi.fn().mockRejectedValue(new Error("getUser API error")),
    });

    await processWorkflows(state, client, makeConfig(), []);

    expect(client.followUser).toHaveBeenCalled();
    expect(workflow.actions_done).toContain("followed");
    // Should still advance past execute_follow even though getUser failed
    expect(workflow.current_step).not.toBe("execute_follow");
  });

  it("continues when like fails", async () => {
    const workflow = makeWorkflow({ current_step: "execute_follow" });
    const state = makeState({ workflows: [workflow] });
    const client = makeMockClient({
      likeTweet: vi.fn().mockRejectedValue(new Error("like API error")),
    });

    await processWorkflows(state, client, makeConfig(), []);

    expect(workflow.actions_done).toContain("followed");
    expect(workflow.actions_done).not.toContain("liked_pinned");
    // Should still advance to need_reply_text
    expect(workflow.current_step).toBe("need_reply_text");
  });

  it("aborts workflow when follow fails", async () => {
    const workflow = makeWorkflow({ current_step: "execute_follow" });
    const state = makeState({ workflows: [workflow] });
    const client = makeMockClient({
      followUser: vi.fn().mockRejectedValue(new Error("follow API error")),
    });

    await processWorkflows(state, client, makeConfig(), []);

    expect(workflow.outcome).toBe("follow_failed");
    expect(workflow.current_step).toBe("done");
  });

  it("continues cleanup when unlike fails", async () => {
    const workflow = makeWorkflow({
      current_step: "cleanup",
      context: { pinned_tweet_id: "pin123", reply_tweet_id: "reply789" },
    });
    const state = makeState({ workflows: [workflow] });
    const client = makeMockClient({
      unlikeTweet: vi.fn().mockRejectedValue(new Error("unlike failed")),
    });

    await processWorkflows(state, client, makeConfig(), []);

    expect(workflow.outcome).toBe("cleaned_up");
    expect(workflow.actions_done).not.toContain("unliked_pinned");
    expect(workflow.actions_done).toContain("deleted_reply");
    expect(workflow.actions_done).toContain("unfollowed");
  });

  it("sets partially_cleaned_up when unfollow budget exhausted", async () => {
    const workflow = makeWorkflow({
      current_step: "cleanup",
      context: { pinned_tweet_id: "pin123", reply_tweet_id: "reply789" },
    });
    const state = makeState({
      workflows: [workflow],
      budget: { ...getDefaultState().budget, unfollows: 10 },
    });
    const client = makeMockClient();

    await processWorkflows(state, client, makeConfig(), []);

    expect(client.unlikeTweet).toHaveBeenCalledWith("pin123");
    expect(client.deleteTweet).toHaveBeenCalledWith("reply789");
    expect(client.unfollowUser).not.toHaveBeenCalled();
    expect(workflow.outcome).toBe("partially_cleaned_up");
    expect(workflow.actions_done).toContain("unliked_pinned");
    expect(workflow.actions_done).toContain("deleted_reply");
    expect(workflow.actions_done).not.toContain("unfollowed");
  });

  it("skips reply when reply budget is exhausted", async () => {
    const workflow = makeWorkflow({
      current_step: "post_reply",
      context: { reply_text: "Great insight!", target_tweet_id: "tweet1" },
    });
    const state = makeState({
      workflows: [workflow],
      budget: { ...getDefaultState().budget, replies: 8 },
    });
    const client = makeMockClient();

    await processWorkflows(state, client, makeConfig(), []);

    expect(client.postTweet).not.toHaveBeenCalled();
    expect(workflow.current_step).toBe("waiting");
    expect(workflow.check_after).not.toBeNull();
  });

  it("continues to waiting even when reply posting fails (non-403 error)", async () => {
    const workflow = makeWorkflow({
      current_step: "post_reply",
      context: { reply_text: "Great insight!", target_tweet_id: "tweet1" },
    });
    // Author IS in mentioned_by so reply is attempted via API
    const state = makeState({ workflows: [workflow], mentioned_by: ["12345"] });
    const client = makeMockClient({
      postTweet: vi.fn().mockRejectedValue(new Error("post failed")),
    });

    await processWorkflows(state, client, makeConfig(), []);

    expect(workflow.current_step).toBe("waiting");
    expect(workflow.actions_done).toContain("reply_failed");
  });

  it("skips like when like budget is exhausted", async () => {
    const workflow = makeWorkflow({ current_step: "execute_follow" });
    const state = makeState({
      workflows: [workflow],
      budget: { ...getDefaultState().budget, likes: 20 },
    });
    const client = makeMockClient();

    await processWorkflows(state, client, makeConfig(), []);

    expect(client.followUser).toHaveBeenCalled();
    expect(client.likeTweet).not.toHaveBeenCalled();
    expect(workflow.actions_done).toContain("followed");
    expect(workflow.actions_done).not.toContain("liked_pinned");
    expect(workflow.current_step).toBe("need_reply_text");
  });

  it("skips like when pinned tweet was already liked (dedup)", async () => {
    const workflow = makeWorkflow({ current_step: "execute_follow" });
    const state = makeState({
      workflows: [workflow],
      engaged: { ...getDefaultState().engaged, liked: [{ tweet_id: "pin123", at: new Date().toISOString() }] },
    });
    const client = makeMockClient();

    await processWorkflows(state, client, makeConfig(), []);

    expect(client.likeTweet).not.toHaveBeenCalled();
    expect(workflow.actions_done).not.toContain("liked_pinned");
    expect(workflow.current_step).toBe("need_reply_text");
  });

  it("skips like when target has no pinned tweet", async () => {
    const workflow = makeWorkflow({ current_step: "execute_follow" });
    const state = makeState({ workflows: [workflow] });
    const client = makeMockClient({
      getUser: vi.fn().mockResolvedValue({
        result: { data: { id: "12345", public_metrics: { followers_count: 3000 } } },
        rateLimit: "",
      }),
    });

    await processWorkflows(state, client, makeConfig(), []);

    expect(client.likeTweet).not.toHaveBeenCalled();
    expect(workflow.actions_done).not.toContain("liked_pinned");
    expect(workflow.context.pinned_tweet_id).toBeUndefined();
    expect(workflow.current_step).toBe("need_reply_text");
  });

  it("falls back to first tweet when all tweets are replies", async () => {
    const workflow = makeWorkflow({ current_step: "execute_follow" });
    const state = makeState({ workflows: [workflow] });
    const client = makeMockClient({
      getTimeline: vi.fn().mockResolvedValue({
        result: {
          data: [
            { id: "reply_a", text: "Reply A", referenced_tweets: [{ type: "replied_to", id: "x1" }] },
            { id: "reply_b", text: "Reply B", referenced_tweets: [{ type: "replied_to", id: "x2" }] },
          ],
        },
        rateLimit: "",
      }),
    });

    await processWorkflows(state, client, makeConfig(), []);

    expect(workflow.context.target_tweet_id).toBe("reply_a"); // falls back to first
    expect(workflow.current_step).toBe("need_reply_text");
  });

  it("treats timeline API failure as no tweet found", async () => {
    const workflow = makeWorkflow({ current_step: "execute_follow" });
    const state = makeState({ workflows: [workflow] });
    const client = makeMockClient({
      getTimeline: vi.fn().mockRejectedValue(new Error("timeline API error")),
    });

    const result = await processWorkflows(state, client, makeConfig(), []);

    expect(workflow.current_step).toBe("waiting");
    expect(workflow.check_after).not.toBeNull();
    expect(result.next_task).toBeNull();
    expect(result.auto_completed.some((s: string) => s.includes("No suitable tweet"))).toBe(true);
  });

  it("skips reply when reply_text or target_tweet_id missing in context", async () => {
    const workflow = makeWorkflow({
      current_step: "post_reply",
      context: {}, // missing both reply_text and target_tweet_id
    });
    const state = makeState({ workflows: [workflow] });
    const client = makeMockClient();

    await processWorkflows(state, client, makeConfig(), []);

    expect(client.postTweet).not.toHaveBeenCalled();
    expect(workflow.current_step).toBe("waiting");
    expect(workflow.check_after).not.toBeNull();
  });

  it("proceeds to cleanup when followback API fails", async () => {
    const pastDate = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const workflow = makeWorkflow({
      current_step: "waiting",
      check_after: pastDate,
      context: { pinned_tweet_id: "pin123", reply_tweet_id: "reply789" },
    });
    const state = makeState({ workflows: [workflow] });
    const client = makeMockClient({
      getFollowing: vi.fn().mockRejectedValue(new Error("rate limited")),
    });

    await processWorkflows(state, client, makeConfig(), []);

    // Should have proceeded to cleanup despite API failure
    expect(workflow.current_step).toBe("done");
    expect(workflow.outcome).toBe("cleaned_up");
    expect(client.unfollowUser).toHaveBeenCalled();
  });

  it("proceeds to cleanup when 5-page followback limit reached without finding ID", async () => {
    const pastDate = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const workflow = makeWorkflow({
      current_step: "waiting",
      check_after: pastDate,
    });
    const state = makeState({ workflows: [workflow] });
    // Mock: target follows many people, our ID never found across 5 pages
    const client = makeMockClient({
      getFollowing: vi.fn().mockResolvedValue({
        result: { data: [{ id: "other1" }, { id: "other2" }], meta: { next_token: "more" } },
        rateLimit: "",
      }),
    });

    await processWorkflows(state, client, makeConfig(), []);

    // Should have called getFollowing exactly 5 times (MAX_PAGES)
    expect(client.getFollowing).toHaveBeenCalledTimes(5);
    // Not found → cleanup → done
    expect(workflow.current_step).toBe("done");
    expect(workflow.outcome).toBe("cleaned_up");
  });

  it("skips delete during cleanup when delete budget exhausted", async () => {
    const workflow = makeWorkflow({
      current_step: "cleanup",
      context: { pinned_tweet_id: "pin123", reply_tweet_id: "reply789" },
    });
    const state = makeState({
      workflows: [workflow],
      budget: { ...getDefaultState().budget, deletes: 5 },
    });
    const client = makeMockClient();

    await processWorkflows(state, client, makeConfig(), []);

    expect(client.unlikeTweet).toHaveBeenCalledWith("pin123");
    expect(client.deleteTweet).not.toHaveBeenCalled(); // delete budget exhausted
    expect(client.unfollowUser).toHaveBeenCalledWith("12345");
    expect(workflow.outcome).toBe("cleaned_up"); // unfollow succeeded
    expect(workflow.actions_done).toContain("unliked_pinned");
    expect(workflow.actions_done).not.toContain("deleted_reply");
    expect(workflow.actions_done).toContain("unfollowed");
  });

  it("continues cleanup when delete API fails", async () => {
    const workflow = makeWorkflow({
      current_step: "cleanup",
      context: { pinned_tweet_id: "pin123", reply_tweet_id: "reply789" },
    });
    const state = makeState({ workflows: [workflow] });
    const client = makeMockClient({
      deleteTweet: vi.fn().mockRejectedValue(new Error("delete failed")),
    });

    await processWorkflows(state, client, makeConfig(), []);

    expect(client.deleteTweet).toHaveBeenCalledWith("reply789");
    expect(workflow.actions_done).not.toContain("deleted_reply");
    expect(workflow.actions_done).toContain("unfollowed");
    expect(workflow.outcome).toBe("cleaned_up");
  });

  it("sets partially_cleaned_up when unfollow API fails", async () => {
    const workflow = makeWorkflow({
      current_step: "cleanup",
      context: { pinned_tweet_id: "pin123", reply_tweet_id: "reply789" },
    });
    const state = makeState({ workflows: [workflow] });
    const client = makeMockClient({
      unfollowUser: vi.fn().mockRejectedValue(new Error("unfollow failed")),
    });

    await processWorkflows(state, client, makeConfig(), []);

    expect(client.unfollowUser).toHaveBeenCalledWith("12345");
    expect(workflow.actions_done).not.toContain("unfollowed");
    expect(workflow.actions_done).toContain("unliked_pinned");
    expect(workflow.actions_done).toContain("deleted_reply");
    expect(workflow.outcome).toBe("partially_cleaned_up");
  });
});
