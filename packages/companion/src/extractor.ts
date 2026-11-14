import type { ModelRouter } from "@live-for-llm/ai";
import type { MemoryStore } from "@live-for-llm/memory";
import {
  type MemoryRecord,
  type RelationshipState,
  parseMemoryDraft,
} from "@live-for-llm/protocol";

const EXTRACT_SYSTEM_PROMPT = `Extract durable personal memories, shared vibes, and evolving communication preferences from the user-companion exchange.
Return ONLY a JSON array of objects with fields:
kind ("fact" | "episode" | "preference" | "relationship"), title, content, tags (string[]), importance (0..1), optional emotionalTone, optional eventDate (YYYY-MM-DD).
Return [] when nothing durable is worth storing.`;

const POSITIVE_CUE_RE = /(谢谢|感谢|开心|高兴|喜欢|辛苦|不错|厉害|哈哈|笑死|晚安|早安|记住|陪伴|thanks|thank you|happy|glad|love|nice|haha|good morning|good night)/i;
const FRICTION_CUE_RE = /(烦死|闭嘴|滚|讨厌|垃圾|难用|太差|失望|别废话|敷衍|生气|annoying|shut up|useless|hate|terrible|awful|stop talking)/i;
const WORK_CUE_RE = /(代码|bug|报错|文件|命令|搜索|打开|浏览器|配置|模型|api|code|error|file|command|search|browser|config|model)/i;

/** Computes a quiet, bounded shift in affinity & internal mood after a turn without exposing UI stats. */
export function computeSilentRelationshipUpdate(params: {
  readonly current: RelationshipState;
  readonly userText: string;
  readonly companionText: string;
  readonly extracted: readonly MemoryRecord[];
}): RelationshipState {
  const { current, userText, companionText, extracted } = params;
  const text = userText.trim();
  let delta = 0.008;
  let nextMood = current.currentMood;

  if (FRICTION_CUE_RE.test(text)) {
    delta = -0.03;
    nextMood = current.affinityScore < 0.4 ? "uneasy" : "calm";
  } else if (POSITIVE_CUE_RE.test(text) || extracted.some((m) => m.kind === "relationship")) {
    delta = 0.025;
    nextMood = "warm";
  } else if (WORK_CUE_RE.test(text)) {
    delta = 0.01;
    nextMood = "focused";
  } else if (text.includes("?") || text.includes("？")) {
    delta = 0.012;
    nextMood = "curious";
  } else if (text.length >= 24 && companionText.length >= 20) {
    delta = 0.015;
    nextMood = extracted.some((m) => m.emotionalTone) ? "warm" : "calm";
  }

  const nextAffinity = Number(
    Math.min(0.99, Math.max(0.05, current.affinityScore + delta)).toFixed(4),
  );

  return {
    ...current,
    affinityScore: nextAffinity,
    currentMood: nextMood,
    updatedAt: new Date().toISOString(),
  };
}

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
