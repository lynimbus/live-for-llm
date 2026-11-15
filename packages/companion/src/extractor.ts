import type { ModelRouter } from "@live-for-llm/ai";
import type { MemoryStore } from "@live-for-llm/memory";
import {
  type MemoryRecord,
  type MessageId,
  type RelationshipState,
  parseMemoryDraft,
} from "@live-for-llm/protocol";

export type RelationshipAnniversary = RelationshipState["anniversaries"][number];

const EXTRACT_SYSTEM_PROMPT = `Extract durable personal memories, shared vibes, and evolving communication preferences from the user-companion exchange.
Return ONLY a JSON object with fields:
{
  "memories": [
    { "kind": "fact" | "episode" | "preference" | "relationship", "title": string, "content": string, "tags": string[], "importance": 0..1, "emotionalTone"?: string, "eventDate"?: "YYYY-MM-DD" }
  ],
  "mood"?: "warm" | "curious" | "focused" | "tired" | "uneasy" | "calm",
  "affinityDelta"?: number (-0.05..0.05),
  "insideJokes"?: string[],
  "anniversaries"?: [{ "label": string, "date": "YYYY-MM-DD or MM-DD" }],
  "conversationTitle"?: string (optional short first-person companion note <= 14 chars when this is a new chat topic, e.g. "陪你聊Rust与茶")
}
When nothing durable is worth storing, return {"memories": []}.`;

const POSITIVE_CUE_RE = /(谢谢|感谢|开心|高兴|喜欢|辛苦|不错|厉害|哈哈|笑死|晚安|早安|记住|陪伴|thanks|thank you|happy|glad|love|nice|haha|good morning|good night)/i;
const FRICTION_CUE_RE = /(烦死|闭嘴|滚|讨厌|垃圾|难用|太差|失望|别废话|敷衍|生气|annoying|shut up|useless|hate|terrible|awful|stop talking)/i;
const WORK_CUE_RE = /(代码|bug|报错|文件|命令|搜索|打开|浏览器|配置|模型|api|code|error|file|command|search|browser|config|model)/i;

const VALID_MOODS = new Set(["warm", "curious", "focused", "tired", "uneasy", "calm"]);

export interface TurnExtractionOutcome {
  readonly memories: readonly MemoryRecord[];
  readonly mood?: string;
  readonly affinityDelta?: number;
  readonly insideJokes: readonly string[];
  readonly anniversaries: readonly RelationshipAnniversary[];
  readonly conversationTitle?: string;
}

export function sanitizeCompanionTitle(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const cleaned = raw
    .replace(/[\r\n]+/g, " ")
    .replace(/^["'「『【]+|["'」』】]+$/g, "")
    .trim();
  if (cleaned.length < 2 || cleaned.length > 28) return undefined;
  if (/^(ok|done|none|null|undefined|新对话|new chat)$/i.test(cleaned)) return undefined;
  return cleaned;
}

/**
 * Naturally decays transient mood toward `calm` after long idle gaps (>= 6h),
 * and reflects late-night hours as a gentler `tired` undertone when idle/calm.
 */
export function decayRelationshipState(
  current: RelationshipState,
  now: Date = new Date(),
): RelationshipState {
  const updatedMs = Date.parse(current.updatedAt);
  const elapsedHours = Number.isFinite(updatedMs)
    ? Math.max(0, (now.getTime() - updatedMs) / 3_600_000)
    : 0;

  let nextMood = current.currentMood;
  if (elapsedHours >= 6 && nextMood !== "calm") {
    nextMood = "calm";
  }
  const hour = now.getHours();
  if ((hour >= 23 || hour < 5) && nextMood === "calm") {
    nextMood = "tired";
  }

  if (nextMood === current.currentMood) {
    return current;
  }
  return {
    ...current,
    currentMood: nextMood,
  };
}

/** Computes a quiet, bounded shift in affinity, mood, inside jokes, and anniversaries without exposing UI stats. */
export function computeSilentRelationshipUpdate(params: {
  readonly current: RelationshipState;
  readonly userText: string;
  readonly companionText: string;
  readonly extracted: readonly MemoryRecord[];
  readonly analysis?: Pick<
    TurnExtractionOutcome,
    "mood" | "affinityDelta" | "insideJokes" | "anniversaries"
  >;
}): RelationshipState {
  const { current, userText, companionText, extracted, analysis } = params;
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

  if (analysis?.mood && VALID_MOODS.has(analysis.mood)) {
    nextMood = analysis.mood;
  }
  if (typeof analysis?.affinityDelta === "number" && Number.isFinite(analysis.affinityDelta)) {
    delta = Math.max(-0.05, Math.min(0.05, analysis.affinityDelta));
  }

  const mergedJokes = [...current.insideJokes];
  const jokeSeen = new Set(mergedJokes.map((j) => j.trim().toLowerCase()));
  for (const joke of analysis?.insideJokes ?? []) {
    const clean = joke.trim();
    const key = clean.toLowerCase();
    if (clean && !jokeSeen.has(key)) {
      jokeSeen.add(key);
      mergedJokes.push(clean);
    }
  }

  const mergedAnniversaries = [...current.anniversaries];
  const annivSeen = new Set(
    mergedAnniversaries.map((a) => `${a.date.trim()}|${a.label.trim().toLowerCase()}`),
  );
  for (const anniv of analysis?.anniversaries ?? []) {
    const label = anniv.label.trim();
    const date = anniv.date.trim();
    const key = `${date}|${label.toLowerCase()}`;
    if (label && date && !annivSeen.has(key)) {
      annivSeen.add(key);
      mergedAnniversaries.push({ label, date });
    }
  }

  const nextAffinity = Number(
    Math.min(0.99, Math.max(0.05, current.affinityScore + delta)).toFixed(4),
  );

  return {
    ...current,
    affinityScore: nextAffinity,
    currentMood: nextMood,
    insideJokes: mergedJokes.slice(-24),
    anniversaries: mergedAnniversaries.slice(-24),
    updatedAt: new Date().toISOString(),
  };
}

interface ParsedExtractionJson {
  readonly candidates: unknown[];
  readonly mood?: string;
  readonly affinityDelta?: number;
  readonly insideJokes: readonly string[];
  readonly anniversaries: readonly RelationshipAnniversary[];
  readonly conversationTitle?: string;
}

function parseExtractionJson(raw: string): ParsedExtractionJson {
  const empty: ParsedExtractionJson = {
    candidates: [],
    insideJokes: [],
    anniversaries: [],
  };
  const trimmed = raw.trim();
  const objStart = trimmed.indexOf("{");
  const objEnd = trimmed.lastIndexOf("}");
  const arrStart = trimmed.indexOf("[");
  const arrEnd = trimmed.lastIndexOf("]");

  // If `{...}` wraps an object before any `[`, parse object first; otherwise fall back to array `[...]`.
  if (objStart !== -1 && objEnd > objStart && (arrStart === -1 || objStart < arrStart)) {
    try {
      const parsed: unknown = JSON.parse(trimmed.slice(objStart, objEnd + 1));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const rec = parsed as Record<string, unknown>;
        const candidates = Array.isArray(rec.memories) ? rec.memories : [];
        const rawMood = typeof rec.mood === "string" ? rec.mood.trim().toLowerCase() : undefined;
        const mood = rawMood && VALID_MOODS.has(rawMood) ? rawMood : undefined;
        const affinityDelta =
          typeof rec.affinityDelta === "number" && Number.isFinite(rec.affinityDelta)
            ? rec.affinityDelta
            : undefined;
        const insideJokes = Array.isArray(rec.insideJokes)
          ? rec.insideJokes.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
          : [];
        const anniversaries = Array.isArray(rec.anniversaries)
          ? rec.anniversaries.filter(
              (item): item is RelationshipAnniversary =>
                typeof item === "object" &&
                item !== null &&
                typeof (item as { label?: unknown }).label === "string" &&
                typeof (item as { date?: unknown }).date === "string",
            )
          : [];
        const conversationTitle = sanitizeCompanionTitle(rec.conversationTitle);
        return {
          candidates,
          ...(mood ? { mood } : {}),
          ...(affinityDelta !== undefined ? { affinityDelta } : {}),
          insideJokes,
          anniversaries,
          ...(conversationTitle ? { conversationTitle } : {}),
        };
      }
    } catch {
      // Fall through to array parser
    }
  }

  if (arrStart !== -1 && arrEnd >= arrStart) {
    try {
      const parsed: unknown = JSON.parse(trimmed.slice(arrStart, arrEnd + 1));
      if (Array.isArray(parsed)) {
        return { ...empty, candidates: parsed };
      }
    } catch {
      return empty;
    }
  }

  return empty;
}

/** Extracts durable memories, relationship shifts, inside jokes, and anniversaries in one LLM call. */
export async function extractTurnAnalysis(params: {
  readonly router: ModelRouter;
  readonly store: MemoryStore;
  readonly userText: string;
  readonly companionText: string;
  readonly sourceMessageIds?: readonly MessageId[];
  readonly enableEmbeddings?: boolean;
}): Promise<TurnExtractionOutcome> {
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

  const parsed = parseExtractionJson(response.text);
  const saved: MemoryRecord[] = [];
  const turnEvidence = params.sourceMessageIds ?? [];

  for (const rawItem of parsed.candidates) {
    try {
      const rawObj = typeof rawItem === "object" && rawItem !== null ? (rawItem as Record<string, unknown>) : {};
      const draft = parseMemoryDraft({
        ...rawObj,
        source: "chat_extract",
        ...(turnEvidence.length > 0 ? { sourceMessageIds: turnEvidence } : {}),
      });

      // Respect user rejection tombstones so deleted memories are never re-created automatically.
      if (params.store.isMemoryRejected(draft.title, draft.content)) {
        continue;
      }

      // Deduplicate against an existing semantically similar memory of the same kind.
      const similar = params.store.findSimilarMemory({
        kind: draft.kind,
        title: draft.title,
        content: draft.content,
      });
      const mergedDraft = similar
        ? {
            ...draft,
            id: similar.id,
            tags: Array.from(new Set([...similar.tags, ...draft.tags])),
            importance: Math.max(similar.importance, draft.importance),
            sourceMessageIds: Array.from(
              new Set([...(similar.sourceMessageIds ?? []), ...(draft.sourceMessageIds ?? [])]),
            ),
          }
        : draft;

      let embedding: Float32Array | undefined;
      if (params.enableEmbeddings) {
        try {
          const [vec] = await params.router.embed([`${mergedDraft.title}\n${mergedDraft.content}`]);
          embedding = vec;
        } catch {
          embedding = undefined;
        }
      }
      saved.push(params.store.upsertMemory(mergedDraft, embedding));
    } catch {
      continue;
    }
  }

  return {
    memories: saved,
    ...(parsed.mood ? { mood: parsed.mood } : {}),
    ...(parsed.affinityDelta !== undefined ? { affinityDelta: parsed.affinityDelta } : {}),
    insideJokes: parsed.insideJokes,
    anniversaries: parsed.anniversaries,
    ...(parsed.conversationTitle ? { conversationTitle: parsed.conversationTitle } : {}),
  };
}

/** Extracts durable memories after a chat turn and persists them into MemoryStore. */
export async function extractMemoriesFromTurn(params: {
  readonly router: ModelRouter;
  readonly store: MemoryStore;
  readonly userText: string;
  readonly companionText: string;
  readonly sourceMessageIds?: readonly MessageId[];
  readonly enableEmbeddings?: boolean;
}): Promise<MemoryRecord[]> {
  const outcome = await extractTurnAnalysis(params);
  return [...outcome.memories];
}
