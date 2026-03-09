import type { Workflow, XApiClient, StateFile, BudgetConfig, LlmTask, AdvanceResult } from "./workflow-types.js";
import type { QueueItem } from "./state.js";
import { enqueueItem } from "./state.js";
import type { ProtectedAccount } from "./safety.js";
import { checkBudget, recordAction, checkDedup, isProtectedAccount } from "./safety.js";
import { isColdReplyBlocked, buildIntentUrl } from "./helpers.js";

// --- Follow Cycle State Machine ---
// Steps: execute_follow → get_reply_context → need_reply_text → post_reply → waiting → check_followback → cleanup → done

export async function advanceFollowCycle(
  workflow: Workflow,
  client: XApiClient,
  state: StateFile,
  budgetConfig: BudgetConfig,
  protectedAccounts: ProtectedAccount[],
): Promise<AdvanceResult> {
  const step = workflow.current_step;

  if (step === "execute_follow") {
    // Check follow budget
    const budgetErr = checkBudget("follow_user", state, budgetConfig);
    if (budgetErr) {
      return { llmNeeded: false, summary: `Follow budget exhausted for @${workflow.target_username}: ${budgetErr}` };
    }

    // Check follow dedup
    const dedupErr = checkDedup("follow_user", workflow.target_user_id, state);
    if (dedupErr) {
      workflow.outcome = "skipped_duplicate";
      workflow.current_step = "done";
      return { llmNeeded: false, summary: `Skipped @${workflow.target_username}: ${dedupErr}` };
    }

    // Follow user
    try {
      await client.followUser(workflow.target_user_id);
      recordAction("follow_user", workflow.target_user_id, state);
      workflow.actions_done.push("followed");
    } catch (e: unknown) {
      workflow.outcome = "follow_failed";
      workflow.current_step = "done";
      return { llmNeeded: false, summary: `Follow failed for @${workflow.target_username}: ${e instanceof Error ? e.message : String(e)}` };
    }

    // Get user to find pinned tweet
    try {
      const { result } = await client.getUser({ userId: workflow.target_user_id });
      const data = result as { data?: { pinned_tweet_id?: string; public_metrics?: { followers_count?: number } } };
      // Store follower count for LLM context
      if (data.data?.public_metrics?.followers_count !== undefined) {
        workflow.context.author_followers = String(data.data.public_metrics.followers_count);
      }
      if (data.data?.pinned_tweet_id) {
        workflow.context.pinned_tweet_id = data.data.pinned_tweet_id;

        // Like pinned tweet if budget allows
        const likeBudgetErr = checkBudget("like_tweet", state, budgetConfig);
        if (!likeBudgetErr) {
          const likeDedupErr = checkDedup("like_tweet", data.data.pinned_tweet_id, state);
          if (!likeDedupErr) {
            try {
              await client.likeTweet(data.data.pinned_tweet_id);
              recordAction("like_tweet", data.data.pinned_tweet_id, state);
              workflow.actions_done.push("liked_pinned");
            } catch {
              // Like failure is non-fatal
            }
          }
        }
      }
    } catch {
      // getUser failure is non-fatal for liking pinned
    }

    workflow.current_step = "get_reply_context";
    // Continue auto-executing
    return advanceFollowCycle(workflow, client, state, budgetConfig, protectedAccounts);
  }

  if (step === "get_reply_context") {
    try {
      // Resolve user ID for timeline (may already have it)
      const { result } = await client.getTimeline(workflow.target_user_id, 5);
      const resp = result as { data?: Array<{ id?: string; text?: string; note_tweet?: { text?: string }; referenced_tweets?: Array<{ type?: string }> }> };
      if (resp.data && resp.data.length > 0) {
        // Pick most recent non-reply tweet
        const candidate = resp.data.find(
          (t) => !t.referenced_tweets?.some((r) => r.type === "replied_to"),
        ) ?? resp.data[0];
        workflow.context.target_tweet_id = candidate.id ?? "";
        workflow.context.target_tweet_text = candidate.note_tweet?.text ?? candidate.text ?? "";
      }
    } catch {
      // Timeline failure — no tweet to reply to
    }

    // If no target tweet was found, skip the reply step entirely
    if (!workflow.context.target_tweet_id) {
      const checkDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      workflow.check_after = checkDate;
      workflow.current_step = "waiting";
      return { llmNeeded: false, summary: `No suitable tweet found for @${workflow.target_username}, skipping reply. Check-back set for ${checkDate}.` };
    }

    workflow.current_step = "need_reply_text";
    // Now return to LLM
    return { llmNeeded: true, summary: null };
  }

  if (step === "need_reply_text") {
    // This step requires LLM input
    return { llmNeeded: true, summary: null };
  }

  if (step === "post_reply") {
    const replyText = workflow.context.reply_text;
    const targetTweetId = workflow.context.target_tweet_id;

    if (!replyText || !targetTweetId) {
      workflow.current_step = "waiting";
      const checkDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      workflow.check_after = checkDate;
      return { llmNeeded: false, summary: `No reply context for @${workflow.target_username}, skipping reply. Check-back set for ${checkDate}.` };
    }

    // Check reply budget
    const budgetErr = checkBudget("reply_to_tweet", state, budgetConfig);
    if (budgetErr) {
      workflow.current_step = "waiting";
      const checkDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      workflow.check_after = checkDate;
      return { llmNeeded: false, summary: `Reply budget exhausted for @${workflow.target_username}. Check-back set for ${checkDate}.` };
    }

    try {
      let authorId: string | undefined;
      try {
        const { result: tweetData } = await client.getTweet(targetTweetId);
        authorId = (tweetData as { data?: { author_id?: string } })?.data?.author_id;
      } catch {
        // getTweet failure — fall through to queue path
      }

      const canReply = authorId ? state.mentioned_by.includes(authorId) : false;

      if (canReply) {
        try {
          const { result } = await client.postTweet({ text: replyText, reply_to: targetTweetId });
          const data = result as { data?: { id?: string } };
          if (data.data?.id) workflow.context.reply_tweet_id = data.data.id;
          workflow.actions_done.push("replied");
          recordAction("reply_to_tweet", targetTweetId, state);
        } catch (err) {
          if (!isColdReplyBlocked(err)) throw err;
          // Stale cache — fall through to queue
        }
      }

      // Queue if not posted directly (cold reply or stale cache)
      if (!workflow.actions_done.includes("replied")) {
        const intentUrl = buildIntentUrl({ text: replyText, in_reply_to: targetTweetId });
        const item: QueueItem = {
          id: `q:${targetTweetId}`, type: "cold_reply", status: "pending",
          created_at: new Date().toISOString(),
          target_tweet_id: targetTweetId, target_author: `@${workflow.target_username}`,
          target_text_snippet: workflow.context.target_tweet_text?.slice(0, 100),
          text: replyText, intent_url: intentUrl,
          source_tool: "reply_to_tweet", source_workflow_id: workflow.id,
        };
        enqueueItem(state, item);
        recordAction("reply_to_tweet", targetTweetId, state);
        workflow.actions_done.push("reply_queued");
      }
    } catch {
      // Reply failure — continue to waiting state anyway
      workflow.actions_done.push("reply_failed");
    }

    const checkDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    workflow.check_after = checkDate;
    workflow.current_step = "waiting";
    return { llmNeeded: false, summary: `Follow cycle for @${workflow.target_username}: reply posted. Check-back scheduled for ${checkDate}.` };
  }

  if (step === "waiting") {
    // check_after is enforced by processWorkflows — if we're here, we're due
    workflow.current_step = "check_followback";
    return advanceFollowCycle(workflow, client, state, budgetConfig, protectedAccounts);
  }

  if (step === "check_followback") {
    try {
      const myId = await client.getAuthenticatedUserId();
      // Check if target follows us by paginating through the target's following list.
      // This is more reliable than checking our followers (which could be >1000 pages).
      // The target likely follows far fewer people than we have followers.
      // Limitation: scans max 5 pages (5000 users). If the target follows >5000 people,
      // followback may go undetected and trigger a false cleanup.
      let nextToken: string | undefined;
      const MAX_PAGES = 5;
      for (let page = 0; page < MAX_PAGES; page++) {
        const { result } = await client.getFollowing(workflow.target_user_id, 1000, nextToken);
        const resp = result as { data?: Array<{ id?: string }>; meta?: { next_token?: string } };
        const followingIds = (resp.data ?? []).map((u) => u.id);

        if (followingIds.includes(myId)) {
          workflow.outcome = "followed_back";
          workflow.current_step = "done";
          return { llmNeeded: false, summary: `@${workflow.target_username} followed back!` };
        }

        nextToken = resp.meta?.next_token;
        if (!nextToken) break;
      }
    } catch {
      // If followback check fails, proceed to cleanup anyway
    }

    workflow.current_step = "cleanup";
    return advanceFollowCycle(workflow, client, state, budgetConfig, protectedAccounts);
  }

  if (step === "cleanup") {
    // Check protected accounts
    if (isProtectedAccount(workflow.target_username, protectedAccounts) || isProtectedAccount(workflow.target_user_id, protectedAccounts)) {
      workflow.outcome = "protected_kept";
      workflow.current_step = "done";
      return { llmNeeded: false, summary: `@${workflow.target_username} is protected — kept follow, skipped cleanup.` };
    }

    // Unlike pinned tweet (ignore errors)
    if (workflow.context.pinned_tweet_id) {
      try {
        await client.unlikeTweet(workflow.context.pinned_tweet_id);
        workflow.actions_done.push("unliked_pinned");
      } catch {
        // Ignore
      }
    }

    // Delete reply within budget (ignore errors)
    if (workflow.context.reply_tweet_id) {
      const deleteBudgetErr = checkBudget("delete_tweet", state, budgetConfig);
      if (!deleteBudgetErr) {
        try {
          await client.deleteTweet(workflow.context.reply_tweet_id);
          recordAction("delete_tweet", null, state);
          workflow.actions_done.push("deleted_reply");
        } catch {
          // Ignore
        }
      }
    }

    // Unfollow within budget
    const unfollowBudgetErr = checkBudget("unfollow_user", state, budgetConfig);
    if (!unfollowBudgetErr) {
      try {
        await client.unfollowUser(workflow.target_user_id);
        recordAction("unfollow_user", null, state);
        workflow.actions_done.push("unfollowed");
      } catch {
        // Ignore
      }
    }

    const cleanupActions = workflow.actions_done.filter((a) => a.startsWith("unliked") || a.startsWith("deleted") || a.startsWith("unfollowed"));
    workflow.outcome = cleanupActions.includes("unfollowed") ? "cleaned_up" : "partially_cleaned_up";
    workflow.current_step = "done";
    return { llmNeeded: false, summary: `@${workflow.target_username} cleaned up (${cleanupActions.join(", ")}).` };
  }

  // "done" or unknown step
  return { llmNeeded: false, summary: null };
}

// --- LLM Task Builder ---

export function buildLlmTask(workflow: Workflow): LlmTask {
  if (workflow.type === "follow_cycle" && workflow.current_step === "need_reply_text") {
    return {
      workflow_id: workflow.id,
      instruction: "Write a genuine, insightful reply to this tweet. Spark conversation, don't be generic. Keep it under 280 characters.",
      context: {
        tweet_id: workflow.context.target_tweet_id || "",
        tweet_text: workflow.context.target_tweet_text || "",
        author: `@${workflow.target_username}`,
        author_followers: workflow.context.author_followers || "unknown",
      },
      respond_with: "submit_task",
    };
  }

  // Fallback for unknown steps that need LLM
  return {
    workflow_id: workflow.id,
    instruction: `Workflow ${workflow.type} at step ${workflow.current_step} needs input.`,
    context: { ...workflow.context },
    respond_with: "submit_task",
  };
}
