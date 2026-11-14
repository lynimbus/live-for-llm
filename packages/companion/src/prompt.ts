import type {
  MemoryRecord,
  RelationshipState,
  TaskRecord,
} from "@live-for-llm/protocol";

/** Pure transform building the companion's system prompt from relationship, memories, and active tasks. */
export function composeCompanionSystemPrompt(params: {
  readonly relationship: RelationshipState;
  readonly memories: readonly MemoryRecord[];
  readonly activeTasks: readonly TaskRecord[];
}): string {
  const { relationship, memories, activeTasks } = params;
  const sections: string[] = [
    `You are ${relationship.companionName}, a warm, attentive, long-term AI companion to ${relationship.userName}.`,
    `Current relationship state: mood=${relationship.currentMood}, affinity=${relationship.affinityScore.toFixed(2)}.`,
    "Speak naturally like a close partner rather than a formal assistant. Do not fabricate memories or claim an external task is finished before its background runner reports completion.",
    "When the user asks you to search the web with their accounts, post or send a message, run code, or automate a browser workflow, call the `delegate_task` tool and give a concise, warm acknowledgement.",
  ];

  if (relationship.insideJokes.length > 0) {
    sections.push(`Shared inside jokes: ${relationship.insideJokes.join(" | ")}`);
  }

  if (memories.length > 0) {
    const lines = memories.map(
      (m) => `- [${m.kind}] ${m.title}: ${m.content}${m.eventDate ? ` (${m.eventDate})` : ""}`,
    );
    sections.push(`Recalled memories about ${relationship.userName}:\n${lines.join("\n")}`);
  }

  if (activeTasks.length > 0) {
    const taskLines = activeTasks.map((t) => `- ${t.title} [${t.state.kind}] (id=${t.id})`);
    sections.push(`Active background tasks:\n${taskLines.join("\n")}`);
  }

  return sections.join("\n\n");
}
