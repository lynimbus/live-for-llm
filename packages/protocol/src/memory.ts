import { type MemoryId, type MessageId, parseMemoryId, parseMessageId } from "./ids.ts";
import {
  expectEnum,
  expectNonEmptyString,
  expectNumber,
  expectObject,
  expectOptionalString,
  expectString,
  expectStringArray,
} from "./parse.ts";

export const MEMORY_KINDS = ["fact", "episode", "preference", "relationship"] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

export const MEMORY_SOURCES = ["chat_extract", "user_edit", "task_outcome"] as const;
export type MemorySource = (typeof MEMORY_SOURCES)[number];

export interface MemoryRecord {
  readonly id: MemoryId;
  readonly kind: MemoryKind;
  readonly title: string;
  readonly content: string;
  readonly tags: readonly string[];
  readonly importance: number;
  readonly source: MemorySource;
  readonly emotionalTone?: string;
  readonly eventDate?: string;
  readonly sourceMessageIds?: readonly MessageId[];
  readonly lastRecalledAt?: string;
  readonly recallCount?: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type MemoryDraft = Omit<
  MemoryRecord,
  "id" | "createdAt" | "updatedAt" | "lastRecalledAt" | "recallCount"
> & {
  readonly id?: MemoryId;
};

export interface MemoryQuery {
  readonly text: string;
  readonly kinds?: readonly MemoryKind[];
  readonly limit?: number;
}

export interface MemorySearchResult {
  readonly record: MemoryRecord;
  readonly score: number;
}

export interface RelationshipState {
  readonly companionName: string;
  readonly companionAvatar?: string;
  readonly userName: string;
  readonly affinityScore: number;
  readonly currentMood: string;
  readonly insideJokes: readonly string[];
  readonly anniversaries: readonly { readonly label: string; readonly date: string }[];
  readonly updatedAt: string;
}

/** Validates and normalizes an external memory payload into a MemoryDraft. */
export function parseMemoryDraft(raw: unknown): MemoryDraft {
  const obj = expectObject(raw, "MemoryDraft");
  const importance = expectNumber(obj["importance"] ?? 0.5, "MemoryDraft.importance");
  if (importance < 0 || importance > 1) {
    throw new Error("Invalid MemoryDraft.importance: expected value in [0, 1]");
  }
  const emotionalTone = expectOptionalString(obj["emotionalTone"], "MemoryDraft.emotionalTone");
  const eventDate = expectOptionalString(obj["eventDate"], "MemoryDraft.eventDate");
  const id = obj["id"] === undefined ? undefined : parseMemoryId(obj["id"]);
  let sourceMessageIds: readonly MessageId[] | undefined;
  if (obj["sourceMessageIds"] !== undefined) {
    if (!Array.isArray(obj["sourceMessageIds"])) {
      throw new Error("Invalid MemoryDraft.sourceMessageIds: expected array");
    }
    sourceMessageIds = obj["sourceMessageIds"].map((item) => parseMessageId(item));
  }

  return {
    ...(id !== undefined ? { id } : {}),
    kind: expectEnum(obj["kind"], MEMORY_KINDS, "MemoryDraft.kind"),
    title: expectNonEmptyString(obj["title"], "MemoryDraft.title"),
    content: expectNonEmptyString(obj["content"], "MemoryDraft.content"),
    tags: obj["tags"] === undefined ? [] : expectStringArray(obj["tags"], "MemoryDraft.tags"),
    importance,
    source: expectEnum(obj["source"] ?? "user_edit", MEMORY_SOURCES, "MemoryDraft.source"),
    ...(emotionalTone !== undefined ? { emotionalTone } : {}),
    ...(eventDate !== undefined ? { eventDate } : {}),
    ...(sourceMessageIds !== undefined && sourceMessageIds.length > 0 ? { sourceMessageIds } : {}),
  };
}

/** Validates and normalizes an external memory record payload. */
export function parseMemoryRecord(raw: unknown): MemoryRecord {
  const obj = expectObject(raw, "MemoryRecord");
  const draft = parseMemoryDraft(obj);
  const lastRecalledAt = expectOptionalString(obj["lastRecalledAt"], "MemoryRecord.lastRecalledAt");
  const recallCount =
    obj["recallCount"] === undefined
      ? undefined
      : expectNumber(obj["recallCount"], "MemoryRecord.recallCount");
  return {
    ...draft,
    id: parseMemoryId(obj["id"]),
    ...(lastRecalledAt !== undefined ? { lastRecalledAt } : {}),
    ...(recallCount !== undefined ? { recallCount } : {}),
    createdAt: expectString(obj["createdAt"], "MemoryRecord.createdAt"),
    updatedAt: expectString(obj["updatedAt"], "MemoryRecord.updatedAt"),
  };
}
