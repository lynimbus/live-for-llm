import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  type ChatMessage,
  type ConversationId,
  type ConversationSummary,
  DEFAULT_POLICY_CONFIG,
  type MemoryDraft,
  type MemoryId,
  type MemoryKind,
  type MemoryQuery,
  type MemoryRecord,
  type MemorySearchResult,
  type PolicyConfig,
  type ProactiveRule,
  type RelationshipState,
  type ScheduleId,
  type TaskId,
  type TaskRecord,
  parseConversationId,
  parseMemoryId,
  parseMessageId,
  parseTaskId,
  parseTaskRecord,
} from "@live-for-llm/protocol";

export interface MemorySearchOptions extends MemoryQuery {
  readonly queryEmbedding?: Float32Array;
}

const DEFAULT_RELATIONSHIP_STATE: RelationshipState = {
  companionName: "Livia",
  userName: "你",
  affinityScore: 0.5,
  currentMood: "calm",
  insideJokes: [],
  anniversaries: [],
  updatedAt: new Date(0).toISOString(),
};

function encodeEmbedding(vec: Float32Array): Buffer {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

function decodeEmbedding(blob: Uint8Array): Float32Array {
  const copy = new Uint8Array(blob.byteLength);
  copy.set(blob);
  return new Float32Array(copy.buffer);
}

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const va = a[i] ?? 0;
    const vb = b[i] ?? 0;
    dot += va * vb;
    normA += va * va;
    normB += vb * vb;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

function extractSearchTokens(raw: string): string[] {
  const cleaned = raw.trim().toLowerCase();
  if (!cleaned) return [];
  const pieces = cleaned
    .split(/[\s,.;:!?，。；：！？、"'`()\[\]{}<>/\\|+-]+/)
    .map((p) => p.trim())
    .filter((p) => p.length >= 2);
  const tokens = new Set<string>(pieces);
  for (const piece of pieces) {
    if (/[\u4e00-\u9fff]/.test(piece) && piece.length >= 2) {
      for (let i = 0; i <= piece.length - 2; i++) {
        tokens.add(piece.slice(i, i + 2));
      }
    }
  }
  return Array.from(tokens).slice(0, 24);
}

function buildFtsTrigramQuery(tokens: readonly string[]): string {
  const trigramTokens = tokens
    .map((t) => t.replace(/"/g, "").trim())
    .filter((t) => t.length >= 3);
  if (trigramTokens.length === 0) return "";
  return trigramTokens.map((t) => `"${t}"`).join(" OR ");
}

interface RawMemoryRow {
  id: string;
  kind: string;
  title: string;
  content: string;
  tags_json: string;
  importance: number;
  source: string;
  emotional_tone: string | null;
  event_date: string | null;
  embedding: Uint8Array | null;
  created_at: string;
  updated_at: string;
}

function rowToMemoryRecord(row: RawMemoryRow): MemoryRecord {
  return {
    id: parseMemoryId(row.id),
    kind: row.kind as MemoryKind,
    title: row.title,
    content: row.content,
    tags: JSON.parse(row.tags_json) as string[],
    importance: row.importance,
    source: row.source as MemoryRecord["source"],
    ...(row.emotional_tone !== null ? { emotionalTone: row.emotional_tone } : {}),
    ...(row.event_date !== null ? { eventDate: row.event_date } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Local SQLite-backed store for memories, conversations, tasks, policies, and proactive rules. */
export class MemoryStore {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        tags_json TEXT NOT NULL,
        importance REAL NOT NULL,
        source TEXT NOT NULL,
        emotional_tone TEXT,
        event_date TEXT,
        embedding BLOB,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
        memory_id UNINDEXED,
        title,
        content,
        tags,
        tokenize = 'trigram'
      );

      CREATE TABLE IF NOT EXISTS relationship_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        state_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS chat_messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        proactive INTEGER NOT NULL DEFAULT 0,
        linked_task_id TEXT,
        recalled INTEGER NOT NULL DEFAULT 0,
        recalled_at TEXT,
        recalled_by TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_chat_conv_created
        ON chat_messages(conversation_id, created_at);

      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        task_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS proactive_rules (
        id TEXT PRIMARY KEY,
        rule_json TEXT NOT NULL,
        last_fired_at TEXT
      );

      CREATE TABLE IF NOT EXISTS policy_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        policy_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);

    const cols = this.db
      .prepare("PRAGMA table_info(chat_messages)")
      .all() as unknown as Array<{ name: string }>;
    const existing = new Set(cols.map((c) => c.name));
    if (!existing.has("recalled")) {
      this.db.exec("ALTER TABLE chat_messages ADD COLUMN recalled INTEGER NOT NULL DEFAULT 0;");
    }
    if (!existing.has("recalled_at")) {
      this.db.exec("ALTER TABLE chat_messages ADD COLUMN recalled_at TEXT;");
    }
    if (!existing.has("recalled_by")) {
      this.db.exec("ALTER TABLE chat_messages ADD COLUMN recalled_by TEXT;");
    }

    // Backfill any pre-existing conversations from chat_messages.
    const orphanConvs = this.db
      .prepare(
        `SELECT DISTINCT cm.conversation_id AS id,
                MIN(cm.created_at) AS created_at,
                MAX(cm.created_at) AS updated_at
         FROM chat_messages cm
         LEFT JOIN conversations c ON c.id = cm.conversation_id
         WHERE c.id IS NULL
         GROUP BY cm.conversation_id`,
      )
      .all() as unknown as Array<{ id: string; created_at: string; updated_at: string }>;
    for (const row of orphanConvs) {
      this.db
        .prepare("INSERT OR IGNORE INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)")
        .run(row.id, "新对话", row.created_at, row.updated_at);
    }
    const convCount = this.db.prepare("SELECT COUNT(*) AS cnt FROM conversations").get() as unknown as {
      cnt: number;
    };
    if (convCount.cnt === 0) {
      const now = new Date().toISOString();
      this.db
        .prepare("INSERT OR IGNORE INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)")
        .run("conv_main", "新对话", now, now);
    }
  }

  close(): void {
    this.db.close();
  }

  upsertMemory(draft: MemoryDraft, embedding?: Float32Array): MemoryRecord {
    const now = new Date().toISOString();
    const id = draft.id ?? parseMemoryId(`mem_${randomUUID().replace(/-/g, "").slice(0, 16)}`);
    const existing = this.getMemory(id);
    const createdAt = existing?.createdAt ?? now;
    const tagsJson = JSON.stringify(draft.tags);
    const embeddingBlob = embedding ? encodeEmbedding(embedding) : null;

    this.db
      .prepare(
        `INSERT INTO memories (
          id, kind, title, content, tags_json, importance, source,
          emotional_tone, event_date, embedding, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          kind = excluded.kind,
          title = excluded.title,
          content = excluded.content,
          tags_json = excluded.tags_json,
          importance = excluded.importance,
          source = excluded.source,
          emotional_tone = excluded.emotional_tone,
          event_date = excluded.event_date,
          embedding = COALESCE(excluded.embedding, memories.embedding),
          updated_at = excluded.updated_at`,
      )
      .run(
        id,
        draft.kind,
        draft.title,
        draft.content,
        tagsJson,
        draft.importance,
        draft.source,
        draft.emotionalTone ?? null,
        draft.eventDate ?? null,
        embeddingBlob,
        createdAt,
        now,
      );

    this.db.prepare("DELETE FROM memories_fts WHERE memory_id = ?").run(id);
    this.db
      .prepare("INSERT INTO memories_fts (memory_id, title, content, tags) VALUES (?, ?, ?, ?)")
      .run(id, draft.title, draft.content, draft.tags.join(" "));

    return {
      id,
      kind: draft.kind,
      title: draft.title,
      content: draft.content,
      tags: [...draft.tags],
      importance: draft.importance,
      source: draft.source,
      ...(draft.emotionalTone !== undefined ? { emotionalTone: draft.emotionalTone } : {}),
      ...(draft.eventDate !== undefined ? { eventDate: draft.eventDate } : {}),
      createdAt,
      updatedAt: now,
    };
  }

  getMemory(id: MemoryId): MemoryRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM memories WHERE id = ?")
      .get(id) as unknown as RawMemoryRow | undefined;
    return row ? rowToMemoryRecord(row) : undefined;
  }

  listMemories(filter?: { readonly kinds?: readonly MemoryKind[]; readonly limit?: number }): MemoryRecord[] {
    const limit = filter?.limit ?? 200;
    if (filter?.kinds && filter.kinds.length > 0) {
      const placeholders = filter.kinds.map(() => "?").join(", ");
      const rows = this.db
        .prepare(`SELECT * FROM memories WHERE kind IN (${placeholders}) ORDER BY updated_at DESC LIMIT ?`)
        .all(...filter.kinds, limit) as unknown as RawMemoryRow[];
      return rows.map(rowToMemoryRecord);
    }
    const rows = this.db
      .prepare("SELECT * FROM memories ORDER BY updated_at DESC LIMIT ?")
      .all(limit) as unknown as RawMemoryRow[];
    return rows.map(rowToMemoryRecord);
  }

  deleteMemory(id: MemoryId): boolean {
    const res = this.db.prepare("DELETE FROM memories WHERE id = ?").run(id);
    this.db.prepare("DELETE FROM memories_fts WHERE memory_id = ?").run(id);
    return Number(res.changes) > 0;
  }

  searchMemories(options: MemorySearchOptions): MemorySearchResult[] {
    const limit = options.limit ?? 12;
    const ftsScores = new Map<string, number>();
    const tokens = extractSearchTokens(options.text);
    const ftsQuery = buildFtsTrigramQuery(tokens);

    if (ftsQuery) {
      const rows = this.db
        .prepare("SELECT memory_id, bm25(memories_fts) AS rank FROM memories_fts WHERE memories_fts MATCH ? LIMIT 64")
        .all(ftsQuery) as unknown as { memory_id: string; rank: number }[];
      for (const row of rows) {
        ftsScores.set(row.memory_id, 1 / (1 + Math.max(0, -row.rank)));
      }
    }

    const candidates = this.db
      .prepare("SELECT * FROM memories ORDER BY updated_at DESC LIMIT 500")
      .all() as unknown as RawMemoryRow[];

    const nowMs = Date.now();
    const results: MemorySearchResult[] = [];

    for (const row of candidates) {
      if (options.kinds && options.kinds.length > 0 && !options.kinds.includes(row.kind as MemoryKind)) {
        continue;
      }

      const ftsScore = ftsScores.get(row.id) ?? 0;
      const haystack = `${row.title}\n${row.content}\n${row.tags_json}`.toLowerCase();
      let matchedTokens = 0;
      for (const token of tokens) {
        if (haystack.includes(token)) matchedTokens += 1;
      }
      const lexicalFallback =
        tokens.length > 0 ? Math.min(0.85, (matchedTokens / Math.min(tokens.length, 4)) * 0.65) : 0;

      let vectorScore = 0;
      if (options.queryEmbedding && row.embedding) {
        vectorScore = Math.max(0, cosineSimilarity(options.queryEmbedding, decodeEmbedding(row.embedding)));
      }

      const ageDays = Math.max(0, (nowMs - Date.parse(row.updated_at)) / 86_400_000);
      const recencyBoost = 1 / (1 + ageDays / 30);
      const textSignal = Math.max(ftsScore, lexicalFallback);

      if (tokens.length > 0 && textSignal === 0 && vectorScore < 0.25) {
        continue;
      }

      const score =
        textSignal * 0.45 +
        vectorScore * 0.35 +
        row.importance * 0.12 +
        recencyBoost * 0.08;

      results.push({ record: rowToMemoryRecord(row), score });
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit);
  }

  getRelationshipState(): RelationshipState {
    const row = this.db
      .prepare("SELECT state_json FROM relationship_state WHERE id = 1")
      .get() as unknown as { state_json: string } | undefined;
    if (!row) {
      return { ...DEFAULT_RELATIONSHIP_STATE, updatedAt: new Date().toISOString() };
    }
    return JSON.parse(row.state_json) as RelationshipState;
  }

  updateRelationshipState(next: RelationshipState): RelationshipState {
    const stamped: RelationshipState = { ...next, updatedAt: new Date().toISOString() };
    this.db
      .prepare(
        `INSERT INTO relationship_state (id, state_json, updated_at)
         VALUES (1, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           state_json = excluded.state_json,
           updated_at = excluded.updated_at`,
      )
      .run(JSON.stringify(stamped), stamped.updatedAt);
    return stamped;
  }

  appendChatMessage(message: ChatMessage): void {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)",
      )
      .run(message.conversationId, "新对话", message.createdAt, message.createdAt);

    if (message.role === "user" && !message.recalled && message.content.trim().length > 0) {
      const conv = this.db
        .prepare("SELECT title FROM conversations WHERE id = ?")
        .get(message.conversationId) as unknown as { title: string } | undefined;
      if (conv && (conv.title === "新对话" || conv.title === "New chat")) {
        const firstLine = message.content.trim().split(/\r?\n/)[0]?.trim() ?? "";
        if (firstLine) {
          const autoTitle = firstLine.length > 28 ? `${firstLine.slice(0, 28)}…` : firstLine;
          this.db
            .prepare("UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?")
            .run(autoTitle, message.createdAt, message.conversationId);
        }
      }
    }

    this.db
      .prepare("UPDATE conversations SET updated_at = ? WHERE id = ?")
      .run(message.createdAt, message.conversationId);

    this.db
      .prepare(
        `INSERT OR REPLACE INTO chat_messages (
          id, conversation_id, role, content, proactive, linked_task_id,
          recalled, recalled_at, recalled_by, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        message.id,
        message.conversationId,
        message.role,
        message.content,
        message.proactive ? 1 : 0,
        message.linkedTaskId ?? null,
        message.recalled ? 1 : 0,
        message.recalledAt ?? null,
        message.recalledBy ?? null,
        message.createdAt,
      );
  }

  getChatMessage(
    conversationId: ConversationId,
    messageId: ChatMessage["id"],
  ): ChatMessage | undefined {
    const row = this.db
      .prepare("SELECT * FROM chat_messages WHERE conversation_id = ? AND id = ?")
      .get(conversationId, messageId) as unknown as
      | {
          id: string;
          conversation_id: string;
          role: "user" | "companion" | "system";
          content: string;
          proactive: number;
          linked_task_id: string | null;
          recalled: number;
          recalled_at: string | null;
          recalled_by: "user" | "companion" | null;
          created_at: string;
        }
      | undefined;
    if (!row) return undefined;
    return {
      id: parseMessageId(row.id),
      conversationId: parseConversationId(row.conversation_id),
      role: row.role,
      content: row.content,
      createdAt: row.created_at,
      ...(row.proactive === 1 ? { proactive: true } : {}),
      ...(row.linked_task_id !== null ? { linkedTaskId: parseTaskId(row.linked_task_id) } : {}),
      ...(row.recalled === 1 ? { recalled: true } : {}),
      ...(row.recalled_at !== null ? { recalledAt: row.recalled_at } : {}),
      ...(row.recalled_by !== null ? { recalledBy: row.recalled_by } : {}),
    };
  }

  createConversation(params?: {
    readonly id?: ConversationId;
    readonly title?: string;
  }): ConversationSummary {
    const id =
      params?.id ?? parseConversationId(`conv_${randomUUID().replace(/-/g, "").slice(0, 12)}`);
    const title = params?.title?.trim() || "新对话";
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO conversations (id, title, created_at, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at`,
      )
      .run(id, title, now, now);
    return { id, title, createdAt: now, updatedAt: now };
  }

  renameConversation(
    id: ConversationId,
    title: string,
  ): ConversationSummary | undefined {
    const trimmed = title.trim();
    if (!trimmed) return undefined;
    const now = new Date().toISOString();
    this.db
      .prepare("UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?")
      .run(trimmed, now, id);
    return this.listConversations(100).find((c) => c.id === id);
  }

  deleteConversation(id: ConversationId): boolean {
    this.db.prepare("DELETE FROM chat_messages WHERE conversation_id = ?").run(id);
    const info = this.db.prepare("DELETE FROM conversations WHERE id = ?").run(id);
    return Number(info.changes ?? 0) > 0;
  }

  listConversations(limit = 50): ConversationSummary[] {
    const rows = this.db
      .prepare(
        `SELECT c.id, c.title, c.created_at, c.updated_at,
                (
                  SELECT cm.content
                  FROM chat_messages cm
                  WHERE cm.conversation_id = c.id AND cm.recalled = 0 AND LENGTH(TRIM(cm.content)) > 0
                  ORDER BY cm.created_at DESC
                  LIMIT 1
                ) AS last_preview
         FROM conversations c
         ORDER BY c.updated_at DESC
         LIMIT ?`,
      )
      .all(limit) as unknown as Array<{
      id: string;
      title: string;
      created_at: string;
      updated_at: string;
      last_preview: string | null;
    }>;

    return rows.map((row) => ({
      id: parseConversationId(row.id),
      title: row.title,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      ...(row.last_preview !== null && row.last_preview.trim()
        ? { lastMessagePreview: row.last_preview.trim().slice(0, 60) }
        : {}),
    }));
  }

  recallChatMessage(
    conversationId: ConversationId,
    messageId: ChatMessage["id"],
    by?: "user" | "companion",
  ): ChatMessage | undefined {
    const row = this.db
      .prepare("SELECT * FROM chat_messages WHERE conversation_id = ? AND id = ?")
      .get(conversationId, messageId) as unknown as
      | {
          id: string;
          conversation_id: string;
          role: "user" | "companion" | "system";
          content: string;
          proactive: number;
          linked_task_id: string | null;
          recalled: number;
          recalled_at: string | null;
          recalled_by: "user" | "companion" | null;
          created_at: string;
        }
      | undefined;
    if (!row) return undefined;

    const recalledAt = new Date().toISOString();
    const recalledBy = by ?? (row.role === "companion" ? "companion" : "user");
    this.db
      .prepare(
        `UPDATE chat_messages
         SET content = '', recalled = 1, recalled_at = ?, recalled_by = ?
         WHERE conversation_id = ? AND id = ?`,
      )
      .run(recalledAt, recalledBy, conversationId, messageId);

    return {
      id: parseMessageId(row.id),
      conversationId: parseConversationId(row.conversation_id),
      role: row.role,
      content: "",
      createdAt: row.created_at,
      ...(row.proactive === 1 ? { proactive: true } : {}),
      ...(row.linked_task_id !== null ? { linkedTaskId: parseTaskId(row.linked_task_id) } : {}),
      recalled: true,
      recalledAt,
      recalledBy,
    };
  }

  deleteChatMessages(
    conversationId: ConversationId,
    messageIds: readonly ChatMessage["id"][],
  ): number {
    if (messageIds.length === 0) return 0;
    const stmt = this.db.prepare(
      "DELETE FROM chat_messages WHERE conversation_id = ? AND id = ?",
    );
    let deleted = 0;
    for (const id of messageIds) {
      const info = stmt.run(conversationId, id);
      deleted += Number(info.changes ?? 0);
    }
    return deleted;
  }

  listChatMessages(conversationId: ConversationId, limit = 100): ChatMessage[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM (
          SELECT * FROM chat_messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT ?
        ) ORDER BY created_at ASC`,
      )
      .all(conversationId, limit) as unknown as {
      id: string;
      conversation_id: string;
      role: "user" | "companion" | "system";
      content: string;
      proactive: number;
      linked_task_id: string | null;
      recalled: number;
      recalled_at: string | null;
      recalled_by: "user" | "companion" | null;
      created_at: string;
    }[];

    return rows.map((row) => ({
      id: parseMessageId(row.id),
      conversationId: parseConversationId(row.conversation_id),
      role: row.role,
      content: row.content,
      createdAt: row.created_at,
      ...(row.proactive === 1 ? { proactive: true } : {}),
      ...(row.linked_task_id !== null ? { linkedTaskId: parseTaskId(row.linked_task_id) } : {}),
      ...(row.recalled === 1 ? { recalled: true } : {}),
      ...(row.recalled_at !== null ? { recalledAt: row.recalled_at } : {}),
      ...(row.recalled_by !== null ? { recalledBy: row.recalled_by } : {}),
    }));
  }

  upsertTask(task: TaskRecord): void {
    this.db
      .prepare(
        `INSERT INTO tasks (id, conversation_id, task_json, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           task_json = excluded.task_json,
           updated_at = excluded.updated_at`,
      )
      .run(task.id, task.conversationId, JSON.stringify(task), task.updatedAt);
  }

  getTask(id: TaskId): TaskRecord | undefined {
    const row = this.db
      .prepare("SELECT task_json FROM tasks WHERE id = ?")
      .get(id) as unknown as { task_json: string } | undefined;
    return row ? parseTaskRecord(JSON.parse(row.task_json)) : undefined;
  }

  listTasks(limit = 50): TaskRecord[] {
    const rows = this.db
      .prepare("SELECT task_json FROM tasks ORDER BY updated_at DESC LIMIT ?")
      .all(limit) as unknown as { task_json: string }[];
    return rows.map((row) => parseTaskRecord(JSON.parse(row.task_json)));
  }

  getPolicy(): PolicyConfig {
    const row = this.db
      .prepare("SELECT policy_json FROM policy_state WHERE id = 1")
      .get() as unknown as { policy_json: string } | undefined;
    return row ? (JSON.parse(row.policy_json) as PolicyConfig) : DEFAULT_POLICY_CONFIG;
  }

  savePolicy(policy: PolicyConfig): void {
    this.db
      .prepare(
        `INSERT INTO policy_state (id, policy_json) VALUES (1, ?)
         ON CONFLICT(id) DO UPDATE SET policy_json = excluded.policy_json`,
      )
      .run(JSON.stringify(policy));
  }

  upsertProactiveRule(rule: ProactiveRule): void {
    this.db
      .prepare(
        `INSERT INTO proactive_rules (id, rule_json) VALUES (?, ?)
         ON CONFLICT(id) DO UPDATE SET rule_json = excluded.rule_json`,
      )
      .run(rule.id, JSON.stringify(rule));
  }

  listProactiveRules(): Array<{ readonly rule: ProactiveRule; readonly lastFiredAt?: string }> {
    const rows = this.db
      .prepare("SELECT rule_json, last_fired_at FROM proactive_rules")
      .all() as unknown as { rule_json: string; last_fired_at: string | null }[];
    return rows.map((row) => ({
      rule: JSON.parse(row.rule_json) as ProactiveRule,
      ...(row.last_fired_at !== null ? { lastFiredAt: row.last_fired_at } : {}),
    }));
  }

  markProactiveRuleFired(id: ScheduleId, firedAt: string): void {
    this.db.prepare("UPDATE proactive_rules SET last_fired_at = ? WHERE id = ?").run(firedAt, id);
  }
}
