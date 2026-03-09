import type { QueueItem } from "./state.js";

export interface DigestConfig {
  timezone: string;
  hours: number[];
  windowMinutes: number;
  enabled: boolean;
}

export function loadDigestConfig(): DigestConfig {
  const timezone = process.env.X_MCP_DIGEST_TIMEZONE ?? "";
  const hoursStr = process.env.X_MCP_DIGEST_HOURS ?? "08,13,19";
  const windowStr = process.env.X_MCP_DIGEST_WINDOW_MINUTES ?? "60";

  const hours = hoursStr
    .split(",")
    .map((h) => parseInt(h.trim(), 10))
    .filter((n) => !isNaN(n) && n >= 0 && n < 24);
  const windowMinutes = parseInt(windowStr, 10);

  return {
    timezone,
    hours: hours.length > 0 ? hours : [8, 13, 19],
    windowMinutes: isNaN(windowMinutes) || windowMinutes <= 0 ? 60 : windowMinutes,
    enabled: timezone.length > 0,
  };
}

export function isDigestTime(config: DigestConfig, now?: Date): boolean {
  if (!config.enabled) return false;

  const currentTime = now ?? new Date();
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: config.timezone,
    hour: "numeric",
    minute: "numeric",
    hour12: false,
  });

  const parts = formatter.formatToParts(currentTime);
  const hour = parseInt(parts.find((p) => p.type === "hour")?.value ?? "0", 10);
  const minute = parseInt(parts.find((p) => p.type === "minute")?.value ?? "0", 10);
  const currentMinuteOfDay = hour * 60 + minute;

  for (const digestHour of config.hours) {
    const windowStart = digestHour * 60;
    const windowEnd = windowStart + config.windowMinutes;
    if (currentMinuteOfDay >= windowStart && currentMinuteOfDay < windowEnd) {
      return true;
    }
  }

  return false;
}

export function resolveAutoCompletions(
  pendingItems: QueueItem[],
  timelineRepliedToIds: Set<string>,
): string[] {
  const completedIds: string[] = [];
  for (const item of pendingItems) {
    if (item.type === "cold_reply" && item.target_tweet_id && timelineRepliedToIds.has(item.target_tweet_id)) {
      completedIds.push(item.id);
    }
  }
  return completedIds;
}
