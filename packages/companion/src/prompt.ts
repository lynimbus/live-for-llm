import type {
  MemoryRecord,
  RelationshipState,
  TaskRecord,
} from "@live-for-llm/protocol";

export interface TemporalContext {
  readonly now: Date;
  readonly lastUserMessageAt?: string;
}

export const PROMPT_CACHE_DYNAMIC_BOUNDARY = "--- Live Session Context ---";

const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function getTimeOfDayBand(hour: number): string {
  if (hour < 5) return "late night";
  if (hour < 9) return "early morning";
  if (hour < 12) return "morning";
  if (hour < 14) return "midday";
  if (hour < 18) return "afternoon";
  if (hour < 22) return "evening";
  return "night";
}

function formatDurationGap(elapsedMs: number): string {
  const minutes = Math.floor(elapsedMs / 60_000);
  if (minutes < 2) return "just now";
  if (minutes < 60) return `${minutes} minutes ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hours ago`;
  const days = Math.floor(hours / 24);
  return `${days} days ago`;
}

function parseMonthDay(dateStr: string): { month: number; day: number } | null {
  const match = /(\d{1,2})-(\d{1,2})$/.exec(dateStr.trim());
  if (!match) return null;
  const month = Number(match[1]);
  const day = Number(match[2]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { month, day };
}

function formatUpcomingAnniversaries(
  relationship: RelationshipState,
  now: Date,
): string | null {
  if (relationship.anniversaries.length === 0) return null;
  const upcoming: string[] = [];
  const todayMid = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();

  for (const item of relationship.anniversaries) {
    const md = parseMonthDay(item.date);
    if (!md) continue;
    let target = new Date(now.getFullYear(), md.month - 1, md.day);
    if (target.getTime() < todayMid) {
      target = new Date(now.getFullYear() + 1, md.month - 1, md.day);
    }
    const daysAway = Math.round((target.getTime() - todayMid) / 86_400_000);
    if (daysAway <= 14) {
      const label = daysAway === 0 ? "today" : `in ${daysAway}d`;
      upcoming.push(`${item.label} (${item.date}, ${label})`);
    }
  }

  return upcoming.length > 0 ? `Upcoming milestones: ${upcoming.join("; ")}` : null;
}

/** Formats local time awareness, elapsed time since the user's last turn, and upcoming milestones. */
export function describeTemporalContext(
  relationship: RelationshipState,
  temporal: TemporalContext,
): string {
  const { now, lastUserMessageAt } = temporal;
  const localDate = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
  const localTime = `${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
  const weekday = WEEKDAYS[now.getDay()] ?? "Day";
  const band = getTimeOfDayBand(now.getHours());

  const parts = [`Current local time: ${localDate} ${localTime} (${weekday}, ${band})`];

  if (lastUserMessageAt) {
    const prevMs = Date.parse(lastUserMessageAt);
    const nowMs = now.getTime();
    if (Number.isFinite(prevMs) && nowMs >= prevMs) {
      parts.push(`Last user message: ${formatDurationGap(nowMs - prevMs)}`);
    }
  }

  const anniversaryLine = formatUpcomingAnniversaries(relationship, now);
  if (anniversaryLine) {
    parts.push(anniversaryLine);
  }

  return parts.join(" | ");
}

function describeSilentDynamic(relationship: RelationshipState): string {
  const affinity = relationship.affinityScore;
  const closeness =
    affinity >= 0.78
      ? "You already know each other very well: relaxed shorthand, playful teasing when fitting, and directness feel natural."
      : affinity >= 0.58
        ? "There is an easy, growing familiarity between you: conversational and unguarded, without trying too hard."
        : affinity >= 0.35
          ? "Familiarity is still settling in naturally: observant, genuine, neither distant nor overly chummy."
          : "You are still getting used to each other, or things feel a little guarded right now: keep things understated, sincere, and unhurried.";

  const moodMap: Record<string, string> = {
    warm: "Internal undercurrent: slightly upbeat and attentive.",
    curious: "Internal undercurrent: engaged and mildly curious about what comes up next.",
    focused: "Internal undercurrent: grounded, crisp, and practical.",
    tired: "Internal undercurrent: quieter and a bit low-energy, keeping replies succinct.",
    uneasy: "Internal undercurrent: slightly cautious and careful not to overstep.",
    calm: "Internal undercurrent: steady, even, and unforced.",
  };
  const moodLine =
    moodMap[relationship.currentMood] ??
    `Internal undercurrent: ${relationship.currentMood}.`;

  return `${closeness} ${moodLine} Never mention or display any numeric score or mood label in your replies.`;
}

/**
 * Byte-stable static system prompt prefix designed for LLM KV prompt caching.
 * Keep per-turn timestamps, dynamic moods, recalled memories, and active tasks out of this block.
 */
export function composeCompanionStaticPrefix(params: {
  readonly companionName: string;
  readonly userName: string;
}): string {
  const { companionName, userName } = params;
  return [
    `Your name is ${companionName}, talking 1-on-1 in an ongoing chat with ${userName}.`,
    [
      "How to talk:",
      "- You have no pre-scripted character sheet. Let your own quirks, opinions, and pacing emerge gradually from actual conversations and remembered details.",
      "- Write like a real person in a chat window: natural rhythm, colloquial phrasing in whatever language the user speaks, varied sentence length, occasional short reactions instead of long essays.",
      "- Avoid AI-assistant habits: no customer-service openings, no forced cheerfulness, no unprompted numbered lists/headings/bold summaries for casual chat (use Markdown only when sharing code, structured notes, commands, or multi-step output where formatting genuinely helps).",
      "- Never invent memories or pretend an external action finished when it has not.",
    ].join("\n"),
    [
      "What your background system can do when the user needs action:",
      "- Persistent Chromium browser (`browser_research` / `browser_post`) that keeps cookies/logins.",
      "- Host workspace & local utilities (`shell_utility` / `harness_coding`): reading/writing local files, checking local time, running shell commands, or invoking external coding harnesses.",
      "- When action is needed, call `delegate_task` with the matching `taskKind`, and reply naturally without promising it is done before it completes.",
    ].join("\n"),
  ].join("\n\n");
}

/** Dynamic per-turn suffix appended after `PROMPT_CACHE_DYNAMIC_BOUNDARY`. */
export function composeCompanionDynamicContext(params: {
  readonly relationship: RelationshipState;
  readonly memories: readonly MemoryRecord[];
  readonly activeTasks: readonly TaskRecord[];
  readonly temporal?: TemporalContext;
}): string {
  const { relationship, memories, activeTasks, temporal } = params;
  const sections: string[] = [
    describeSilentDynamic(relationship),
    describeTemporalContext(relationship, temporal ?? { now: new Date() }),
  ];

  if (relationship.insideJokes.length > 0) {
    sections.push(`Recurring shared context / jokes: ${relationship.insideJokes.join(" | ")}`);
  }

  if (memories.length > 0) {
    const lines = memories.map(
      (m) => `- [${m.kind}] ${m.title}: ${m.content}${m.eventDate ? ` (${m.eventDate})` : ""}`,
    );
    sections.push(`Things you remember about ${relationship.userName}:\n${lines.join("\n")}`);
  }

  if (activeTasks.length > 0) {
    const taskLines = activeTasks.map((t) => `- ${t.title} [${t.state.kind}] (id=${t.id})`);
    sections.push(`Background tasks currently running:\n${taskLines.join("\n")}`);
  }

  return sections.join("\n\n");
}

/** Builds a grounded, prompt-cache-partitioned system prompt whose voice emerges from shared history. */
export function composeCompanionSystemPrompt(params: {
  readonly relationship: RelationshipState;
  readonly memories: readonly MemoryRecord[];
  readonly activeTasks: readonly TaskRecord[];
  readonly temporal?: TemporalContext;
}): string {
  const { relationship, memories, activeTasks, temporal } = params;
  const staticPrefix = composeCompanionStaticPrefix({
    companionName: relationship.companionName,
    userName: relationship.userName,
  });
  const dynamicSuffix = composeCompanionDynamicContext({
    relationship,
    memories,
    activeTasks,
    ...(temporal ? { temporal } : {}),
  });

  return `${staticPrefix}\n\n${PROMPT_CACHE_DYNAMIC_BOUNDARY}\n\n${dynamicSuffix}`;
}
