import type { ModelRouter } from "@live-for-llm/ai";
import type { MemoryStore } from "@live-for-llm/memory";
import { type MemoryRecord, parseMemoryDraft } from "@live-for-llm/protocol";

const EXTRACT_SYSTEM_PROMPT = `Extract durable personal memories from the user-companion exchange.
Return ONLY a JSON array of objects with fields:
kind ("fact" | "episode" | "preference" | "relationship"), title, content, tags (string[]), importance (0..1), optional emotionalTone, optional eventDate (YYYY-MM-DD).
Return [] when nothing durable is worth storing.`;

function extractJsonArray(raw: string): unknown[] {
  const trimmed = raw.trim();
  const start = trimmed.indexOf("[");
  const end = trimmed.lastIndexOf("]");
  if (start === -1 || end === -1 || end < start) return [];
  try {
    const parsed: unknown = JSON.parse(trimmed.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Extracts durable memories after a chat turn and persists them into MemoryStore. */
export async function extractMemoriesFromTurn(params: {
  readonly router: ModelRouter;
  readonly store: MemoryStore;
  readonly userText: string;
  readonly companionText: string;
  readonly enableEmbeddings?: boolean;
}): Promise<MemoryRecord[]> {
  const response = await params.router.generate({
    role: "memory_extract",
    messages: [
      { role: "system", content: EXTRACT_SYSTEM_PROMPT },
      {
        role: "user",
        content: `User: ${params.userText}\nCompanion: ${params.companionText}`,
      },
    ],
  });

  const candidates = extractJsonArray(response.text);
  const saved: MemoryRecord[] = [];

  for (const rawItem of candidates) {
    try {
      const draft = parseMemoryDraft({
        ...(typeof rawItem === "object" && rawItem !== null ? rawItem : {}),
        source: "chat_extract",
      });
      let embedding: Float32Array | undefined;
      if (params.enableEmbeddings) {
        try {
          const [vec] = await params.router.embed([`${draft.title}\n${draft.content}`]);
          embedding = vec;
        } catch {
          embedding = undefined;
        }
      }
      saved.push(params.store.upsertMemory(draft, embedding));
    } catch {
      continue;
    }
  }

  return saved;
}
