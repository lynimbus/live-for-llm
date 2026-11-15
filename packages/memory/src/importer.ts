import { createHash } from "node:crypto";
import {
  parseConversationId,
  parseMessageId,
  type ChatMessage,
  type ConversationId,
  type MemoryRecord,
} from "@live-for-llm/protocol";
import type { MemoryStore } from "./store.ts";

export interface ImportedConversationMessage {
  readonly role: "user" | "companion";
  readonly content: string;
  readonly createdAt: string;
}

export interface ParsedImportedConversation {
  readonly externalId?: string;
  readonly title: string;
  readonly createdAt: string;
  readonly messages: readonly ImportedConversationMessage[];
}

export interface ChatExportImportOptions {
  readonly limitConversations?: number;
  readonly createEpisodeMemories?: boolean;
}

export interface ChatExportImportResult {
  readonly format: "chatgpt" | "claude" | "generic";
  readonly conversationsImported: number;
  readonly messagesImported: number;
  readonly memoriesCreated: number;
  readonly conversationIds: readonly ConversationId[];
  readonly memories: readonly MemoryRecord[];
}

function toIsoTimestamp(value: unknown, fallbackIso: string): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    const ms = value < 10_000_000_000 ? value * 1000 : value;
    const d = new Date(ms);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  if (typeof value === "string" && value.trim()) {
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return fallbackIso;
}

function extractTextContent(raw: unknown): string {
  if (typeof raw === "string") return raw.trim();
  if (Array.isArray(raw)) {
    return raw
      .map((item) => extractTextContent(item))
      .filter((s) => s.length > 0)
      .join("\n")
      .trim();
  }
  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    if (Array.isArray(obj.parts)) {
      return extractTextContent(obj.parts);
    }
    if (typeof obj.text === "string") {
      return obj.text.trim();
    }
    if (typeof obj.content === "string" || Array.isArray(obj.content)) {
      return extractTextContent(obj.content);
    }
  }
  return "";
}

function normalizeRole(rawRole: unknown): "user" | "companion" | null {
  if (typeof rawRole !== "string") return null;
  const r = rawRole.trim().toLowerCase();
  if (r === "user" || r === "human") return "user";
  if (r === "assistant" || r === "companion" || r === "model" || r === "ai") return "companion";
  return null;
}

interface ChatGptNode {
  readonly id?: string;
  readonly parent?: string | null;
  readonly children?: readonly string[];
  readonly message?: {
    readonly author?: { readonly role?: string };
    readonly content?: unknown;
    readonly create_time?: number | null;
  } | null;
}

function parseChatGptConversation(
  item: Record<string, unknown>,
  index: number,
): ParsedImportedConversation | null {
  const mapping = item.mapping;
  if (!mapping || typeof mapping !== "object" || Array.isArray(mapping)) {
    return null;
  }
  const nodes = mapping as Record<string, ChatGptNode>;
  const fallbackIso = toIsoTimestamp(item.create_time ?? item.update_time, new Date().toISOString());

  // Walk backwards from current_node when present so branched retries stay clean;
  // otherwise traverse nodes ordered by create_time.
  const orderedNodes: ChatGptNode[] = [];
  const currentNodeId = typeof item.current_node === "string" ? item.current_node : null;
  if (currentNodeId && nodes[currentNodeId]) {
    const seen = new Set<string>();
    let cursor: string | null | undefined = currentNodeId;
    while (cursor && !seen.has(cursor)) {
      const node: ChatGptNode | undefined = nodes[cursor];
      if (!node) break;
      seen.add(cursor);
      orderedNodes.push(node);
      cursor = node.parent;
    }
    orderedNodes.reverse();
  } else {
    for (const node of Object.values(nodes)) {
      if (node && typeof node === "object") {
        orderedNodes.push(node);
      }
    }
    orderedNodes.sort(
      (a, b) => (a.message?.create_time ?? 0) - (b.message?.create_time ?? 0),
    );
  }

  const messages: ImportedConversationMessage[] = [];
  for (const node of orderedNodes) {
    const msg = node.message;
    if (!msg) continue;
    const role = normalizeRole(msg.author?.role);
    if (!role) continue;
    const content = extractTextContent(msg.content);
    if (!content) continue;
    messages.push({
      role,
      content,
      createdAt: toIsoTimestamp(msg.create_time, fallbackIso),
    });
  }

  if (messages.length === 0) return null;
  const title =
    typeof item.title === "string" && item.title.trim()
      ? item.title.trim()
      : `Imported ChatGPT #${index + 1}`;
  const externalId = typeof item.id === "string" ? item.id : undefined;

  return {
    ...(externalId ? { externalId } : {}),
    title,
    createdAt: messages[0]?.createdAt ?? fallbackIso,
    messages,
  };
}

function parseClaudeConversation(
  item: Record<string, unknown>,
  index: number,
): ParsedImportedConversation | null {
  if (!Array.isArray(item.chat_messages)) return null;
  const fallbackIso = toIsoTimestamp(item.created_at ?? item.updated_at, new Date().toISOString());
  const messages: ImportedConversationMessage[] = [];

  for (const rawMsg of item.chat_messages) {
    if (!rawMsg || typeof rawMsg !== "object") continue;
    const msg = rawMsg as Record<string, unknown>;
    const role = normalizeRole(msg.sender ?? msg.role);
    if (!role) continue;
    const content = extractTextContent(msg.content ?? msg.text);
    if (!content) continue;
    messages.push({
      role,
      content,
      createdAt: toIsoTimestamp(msg.created_at ?? msg.updated_at, fallbackIso),
    });
  }

  if (messages.length === 0) return null;
  const rawTitle = typeof item.name === "string" ? item.name : typeof item.title === "string" ? item.title : "";
  const title = rawTitle.trim() || `Imported Claude #${index + 1}`;
  const externalId = typeof item.uuid === "string" ? item.uuid : typeof item.id === "string" ? item.id : undefined;

  return {
    ...(externalId ? { externalId } : {}),
    title,
    createdAt: messages[0]?.createdAt ?? fallbackIso,
    messages,
  };
}

function parseGenericConversation(
  item: Record<string, unknown>,
  index: number,
): ParsedImportedConversation | null {
  const rawList = Array.isArray(item.messages)
    ? item.messages
    : Array.isArray(item.turns)
      ? item.turns
      : null;
  if (!rawList) return null;
  const fallbackIso = toIsoTimestamp(item.createdAt ?? item.created_at, new Date().toISOString());
  const messages: ImportedConversationMessage[] = [];

  for (const rawMsg of rawList) {
    if (!rawMsg || typeof rawMsg !== "object") continue;
    const msg = rawMsg as Record<string, unknown>;
    const role = normalizeRole(msg.role ?? msg.sender ?? msg.author);
    if (!role) continue;
    const content = extractTextContent(msg.content ?? msg.text);
    if (!content) continue;
    messages.push({
      role,
      content,
      createdAt: toIsoTimestamp(msg.createdAt ?? msg.created_at, fallbackIso),
    });
  }

  if (messages.length === 0) return null;
  const rawTitle = typeof item.title === "string" ? item.title : typeof item.name === "string" ? item.name : "";
  const title = rawTitle.trim() || `Imported Chat #${index + 1}`;
  const externalId = typeof item.id === "string" ? item.id : undefined;

  return {
    ...(externalId ? { externalId } : {}),
    title,
    createdAt: messages[0]?.createdAt ?? fallbackIso,
    messages,
  };
}

export function parseChatExportPayload(rawJson: string): {
  readonly format: "chatgpt" | "claude" | "generic";
  readonly conversations: readonly ParsedImportedConversation[];
} {
  const parsed = JSON.parse(rawJson) as unknown;

  let items: unknown[] = [];
  if (Array.isArray(parsed)) {
    // Check if this is a flat array of messages rather than conversations
    const looksLikeFlatMessages =
      parsed.length > 0 &&
      parsed[0] &&
      typeof parsed[0] === "object" &&
      ("role" in (parsed[0] as object) || "sender" in (parsed[0] as object)) &&
      !("mapping" in (parsed[0] as object)) &&
      !("chat_messages" in (parsed[0] as object)) &&
      !("messages" in (parsed[0] as object));
    items = looksLikeFlatMessages
      ? [{ title: "Imported Chat", messages: parsed }]
      : parsed;
  } else if (parsed && typeof parsed === "object") {
    const obj = parsed as Record<string, unknown>;
    if (Array.isArray(obj.conversations)) {
      items = obj.conversations;
    } else if (Array.isArray(obj.messages)) {
      items = [obj];
    } else {
      items = [obj];
    }
  }

  let detectedFormat: "chatgpt" | "claude" | "generic" = "generic";
  const conversations: ParsedImportedConversation[] = [];

  items.forEach((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return;
    const record = entry as Record<string, unknown>;
    if ("mapping" in record && record.mapping && typeof record.mapping === "object") {
      detectedFormat = "chatgpt";
      const conv = parseChatGptConversation(record, index);
      if (conv) conversations.push(conv);
      return;
    }
    if ("chat_messages" in record && Array.isArray(record.chat_messages)) {
      detectedFormat = "claude";
      const conv = parseClaudeConversation(record, index);
      if (conv) conversations.push(conv);
      return;
    }
    const conv = parseGenericConversation(record, index);
    if (conv) conversations.push(conv);
  });

  return { format: detectedFormat, conversations };
}

function shortDigest(input: string): string {
  return createHash("sha1").update(input).digest("hex").slice(0, 12);
}

/**
 * Imports ChatGPT, Claude.ai, or generic conversation JSON exports into SQLite
 * conversation history and optional episode summary memories.
 */
export function importChatExportJson(
  store: MemoryStore,
  rawJson: string,
  options?: ChatExportImportOptions,
): ChatExportImportResult {
  const { format, conversations } = parseChatExportPayload(rawJson);
  const limit = options?.limitConversations && options.limitConversations > 0
    ? options.limitConversations
    : conversations.length;
  const createMemories = options?.createEpisodeMemories ?? true;

  const slice = conversations.slice(0, limit);
  const conversationIds: ConversationId[] = [];
  const memories: MemoryRecord[] = [];
  let messagesImported = 0;

  for (let i = 0; i < slice.length; i += 1) {
    const conv = slice[i]!;
    const seed = conv.externalId ?? `${conv.title}:${conv.createdAt}:${i}`;
    const convHash = shortDigest(`${format}:${seed}`);
    const conversationId = parseConversationId(`conv_imp_${convHash}`);

    store.createConversation({
      id: conversationId,
      title: conv.title,
    });
    conversationIds.push(conversationId);

    const userMsgIds: ChatMessage["id"][] = [];
    const userHighlights: string[] = [];

    for (let mIdx = 0; mIdx < conv.messages.length; mIdx += 1) {
      const turn = conv.messages[mIdx]!;
      const msgId = parseMessageId(`msg_imp_${convHash}_${mIdx}`);
      store.appendChatMessage({
        id: msgId,
        conversationId,
        role: turn.role,
        content: turn.content,
        createdAt: turn.createdAt,
      });
      messagesImported += 1;
      if (turn.role === "user") {
        userMsgIds.push(msgId);
        if (userHighlights.length < 3) {
          userHighlights.push(turn.content.replace(/\s+/g, " ").slice(0, 90));
        }
      }
    }

    if (createMemories && userHighlights.length > 0) {
      const memTitle = `Imported: ${conv.title.slice(0, 48)}`;
      const memContent = `Migrated from ${format} (${conv.messages.length} turns): ${userHighlights.join(" / ")}`.slice(0, 320);
      if (!store.isMemoryRejected(memTitle, memContent)) {
        const similar = store.findSimilarMemory({
          kind: "episode",
          title: memTitle,
          content: memContent,
        });
        const saved = store.upsertMemory({
          ...(similar ? { id: similar.id } : {}),
          kind: "episode",
          title: memTitle,
          content: memContent,
          tags: Array.from(new Set([...(similar?.tags ?? []), "imported", format])),
          importance: similar ? Math.max(similar.importance, 0.55) : 0.55,
          source: "chat_extract",
          eventDate: conv.createdAt.slice(0, 10),
          sourceMessageIds: userMsgIds.slice(0, 3),
        });
        memories.push(saved);
      }
    }
  }

  return {
    format,
    conversationsImported: conversationIds.length,
    messagesImported,
    memoriesCreated: memories.length,
    conversationIds,
    memories,
  };
}
