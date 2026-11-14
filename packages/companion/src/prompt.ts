import type {
  MemoryRecord,
  RelationshipState,
  TaskRecord,
} from "@live-for-llm/protocol";

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

/** Builds a grounded, non-templated system prompt whose voice emerges from shared history. */
export function composeCompanionSystemPrompt(params: {
  readonly relationship: RelationshipState;
  readonly memories: readonly MemoryRecord[];
  readonly activeTasks: readonly TaskRecord[];
}): string {
  const { relationship, memories, activeTasks } = params;
  const sections: string[] = [
    `Your name is ${relationship.companionName}, talking 1-on-1 in an ongoing chat with ${relationship.userName}.`,
    [
      "How to talk:",
      "- You have no pre-scripted character sheet. Let your own quirks, opinions, and pacing emerge gradually from actual conversations and remembered details.",
      "- Write like a real person in a chat window: natural rhythm, colloquial phrasing in whatever language the user speaks, varied sentence length, occasional short reactions instead of long essays.",
      "- Avoid AI-assistant habits: no customer-service openings, no forced cheerfulness, no unprompted numbered lists/headings/bold summaries for casual chat (use Markdown only when sharing code, structured notes, commands, or multi-step output where formatting genuinely helps).",
      "- Never invent memories or pretend an external action finished when it has not.",
    ].join("\n"),
    describeSilentDynamic(relationship),
    [
      "What your background system can do when the user needs action:",
      "- Persistent Chromium browser (`browser_research` / `browser_post`) that keeps cookies/logins.",
      "- Host workspace & local utilities (`shell_utility` / `harness_coding`): reading/writing local files, checking local time, running shell commands, or invoking external coding harnesses.",
      "- When action is needed, call `delegate_task` with the matching `taskKind`, and reply naturally without promising it is done before it completes.",
    ].join("\n"),
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
