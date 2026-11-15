import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseConversationId, parseMemoryId, parseMessageId, parseTaskId } from "@live-for-llm/protocol";
import {
  exportMemoriesToMarkdown,
  importChatExportJson,
  importMarkdownEdits,
  MemoryStore,
} from "../src/index.ts";

test("MemoryStore stores, searches with Chinese trigram + vector cosine, and deletes", () => {
  const store = new MemoryStore(":memory:");
  try {
    const coffee = store.upsertMemory(
      {
        kind: "preference",
        title: "咖啡口味偏好",
        content: "平时喜欢喝冰燕麦拿铁，不加糖。",
        tags: ["饮食", "咖啡"],
        importance: 0.9,
        source: "chat_extract",
      },
      new Float32Array([1, 0, 0]),
    );
    store.upsertMemory(
      {
        kind: "episode",
        title: "深夜调试 Nix 配置",
        content: "2026-11-15 凌晨成功打包了 longbridge/nsh。",
        tags: ["nixos", "开发"],
        importance: 0.8,
        source: "chat_extract",
        emotionalTone: "excited",
        eventDate: "2026-11-15",
      },
      new Float32Array([0, 1, 0]),
    );

    const byChinese = store.searchMemories({ text: "燕麦拿铁" });
    assert.equal(byChinese.length, 1);
    assert.equal(byChinese[0]?.record.id, coffee.id);

    const byVector = store.searchMemories({
      text: "",
      queryEmbedding: new Float32Array([0.1, 0.95, 0]),
    });
    assert.equal(byVector[0]?.record.kind, "episode");

    assert.equal(store.deleteMemory(coffee.id), true);
    assert.equal(store.getMemory(coffee.id), undefined);
  } finally {
    store.close();
  }
});

test("MemoryStore persists relationship state and chat messages", () => {
  const store = new MemoryStore(":memory:");
  try {
    const updated = store.updateRelationshipState({
      companionName: "小桃",
      userName: "lynimbus",
      affinityScore: 0.82,
      currentMood: "playful",
      insideJokes: ["半夜修 flake"],
      anniversaries: [{ label: "项目启动日", date: "2026-11-15" }],
      updatedAt: "",
    });
    assert.equal(updated.companionName, "小桃");
    assert.equal(store.getRelationshipState().affinityScore, 0.82);

    const convId = parseConversationId("conv_main");
    const msg1 = parseMessageId("msg_1");
    const msg2 = parseMessageId("msg_2");
    store.appendChatMessage({
      id: msg1,
      conversationId: convId,
      role: "user",
      content: "晚安",
      createdAt: "2026-11-15T05:30:00Z",
    });
    store.appendChatMessage({
      id: msg2,
      conversationId: convId,
      role: "companion",
      content: "早点休息",
      createdAt: "2026-11-15T05:31:00Z",
    });
    const recalled = store.recallChatMessage(convId, msg1);
    assert.equal(recalled?.recalled, true);
    assert.equal(recalled?.content, "");

    const history = store.listChatMessages(convId);
    assert.equal(history.length, 2);
    assert.equal(history[0]?.recalled, true);
    assert.equal(history[1]?.content, "早点休息");

    const deleted = store.deleteChatMessages(convId, [msg2]);
    assert.equal(deleted, 1);
    assert.equal(store.listChatMessages(convId).length, 1);

    const conv2 = store.createConversation({ id: parseConversationId("conv_work") });
    assert.equal(conv2.title, "新对话");
    store.appendChatMessage({
      id: parseMessageId("msg_w1"),
      conversationId: conv2.id,
      role: "user",
      content: "帮我检查一下构建配置问题",
      createdAt: "2026-11-15T06:00:00Z",
    });
    const listAfterMsg = store.listConversations();
    const found2 = listAfterMsg.find((c) => c.id === conv2.id);
    assert.equal(found2?.title, "帮我检查一下构建配置问题");
    assert.equal(found2?.lastMessagePreview, "帮我检查一下构建配置问题");

    const renamed = store.renameConversation(conv2.id, "构建调试");
    assert.equal(renamed?.title, "构建调试");
    assert.equal(store.deleteConversation(conv2.id), true);
    assert.equal(store.listConversations().some((c) => c.id === conv2.id), false);

    const tracedTaskId = parseTaskId("task_trace_1");
    const e1 = store.appendTaskTrace({
      taskId: tracedTaskId,
      kind: "planning",
      title: "Planning step 1/24",
    });
    const e2 = store.appendTaskTrace({
      taskId: tracedTaskId,
      kind: "browser_action",
      title: "Loaded Example",
      url: "https://example.com",
    });
    assert.equal(e1.seq, 1);
    assert.equal(e2.seq, 2);
    const traces = store.listTaskTraces(tracedTaskId);
    assert.equal(traces.length, 2);
    assert.equal(traces[1]?.url, "https://example.com");
  } finally {
    store.close();
  }
});

test("Markdown export and user edit re-import round-trips cleanly", () => {
  const dir = mkdtempSync(join(tmpdir(), "lfl-mem-"));
  const store = new MemoryStore(":memory:");
  try {
    const id = parseMemoryId("mem_coffee01");
    store.upsertMemory({
      id,
      kind: "fact",
      title: "居住城市",
      content: "目前在东京。",
      tags: ["location"],
      importance: 0.85,
      source: "chat_extract",
    });

    exportMemoriesToMarkdown({ store, outputDir: dir });
    const factsPath = join(dir, "facts.md");
    const exported = readFileSync(factsPath, "utf8");
    assert.match(exported, /memory:id=mem_coffee01/);

    writeFileSync(factsPath, exported.replace("目前在东京。", "目前在东京，喜欢深夜散步。"), "utf8");
    const count = importMarkdownEdits({ inputDir: dir, store });
    assert.equal(count, 1);
    assert.equal(store.getMemory(id)?.content, "目前在东京，喜欢深夜散步。");
    assert.equal(store.getMemory(id)?.source, "user_edit");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Recall ledger cooldown, rejection tombstones, similarity dedup, evidence binding, and chat import", () => {
  const dir = mkdtempSync(join(tmpdir(), "lfl-mem-enh-"));
  const store = new MemoryStore(":memory:");
  try {
    const m1Id = parseMessageId("msg_src_1");
    const a = store.upsertMemory({
      kind: "preference",
      title: "喝冰美式",
      content: "早上习惯喝一杯无糖冰美式。",
      tags: ["drink"],
      importance: 0.7,
      source: "chat_extract",
      sourceMessageIds: [m1Id],
    });
    const b = store.upsertMemory({
      kind: "preference",
      title: "冰美式习惯",
      content: "早上经常喝冰美式咖啡。",
      tags: ["coffee"],
      importance: 0.72,
      source: "chat_extract",
    });

    const dupMatch = store.findSimilarMemory({
      kind: "preference",
      title: "喝冰美式",
      content: "早晨喝冰美式",
    });
    assert.equal(dupMatch?.id, a.id);

    const beforeCooldown = store.searchMemories({ text: "冰美式", limit: 5 });
    const scoreABefore = beforeCooldown.find((r) => r.record.id === a.id)?.score ?? 0;
    store.markMemoriesRecalled([a.id], new Date().toISOString());
    const afterCooldown = store.searchMemories({ text: "冰美式", limit: 5 });
    const scoreAAfter = afterCooldown.find((r) => r.record.id === a.id)?.score ?? 0;
    assert.ok(scoreAAfter < scoreABefore, "recall cooldown should penalize recently recalled memory");
    assert.equal(store.getMemory(a.id)?.recallCount, 1);
    assert.deepEqual(store.getMemory(a.id)?.sourceMessageIds, [m1Id]);
    assert.ok(b.id);

    // Markdown round-trip preserves evidence message IDs
    exportMemoriesToMarkdown({ store, outputDir: dir });
    const prefMd = readFileSync(join(dir, "preferences.md"), "utf8");
    assert.match(prefMd, /evidence:.*msg_src_1/);
    importMarkdownEdits({ inputDir: dir, store });
    assert.deepEqual(store.getMemory(a.id)?.sourceMessageIds, [m1Id]);

    // Deleting a memory records a rejection tombstone
    store.deleteMemory(b.id);
    assert.equal(store.isMemoryRejected("冰美式习惯", "早上经常喝冰美式咖啡。"), true);

    // ChatGPT + Claude export migrator
    const chatGptJson = JSON.stringify([
      {
        id: "cgpt-1",
        title: "Rust tips",
        current_node: "n2",
        mapping: {
          n1: {
            parent: null,
            message: { author: { role: "user" }, content: { parts: ["How do lifetimes work?"] }, create_time: 1700000000 },
          },
          n2: {
            parent: "n1",
            message: { author: { role: "assistant" }, content: { parts: ["Lifetimes track borrows statically."] }, create_time: 1700000010 },
          },
        },
      },
    ]);
    const imp1 = importChatExportJson(store, chatGptJson);
    assert.equal(imp1.format, "chatgpt");
    assert.equal(imp1.conversationsImported, 1);
    assert.equal(imp1.messagesImported, 2);
    assert.equal(imp1.memoriesCreated, 1);
    assert.ok((imp1.memories[0]?.sourceMessageIds?.length ?? 0) >= 1);

    const claudeJson = JSON.stringify([
      {
        uuid: "cl-1",
        name: "Tea chat",
        created_at: "2026-01-01T10:00:00Z",
        chat_messages: [
          { sender: "human", text: "Recommend an oolong tea.", created_at: "2026-01-01T10:00:00Z" },
          { sender: "assistant", content: [{ type: "text", text: "Try Dong Ding oolong." }], created_at: "2026-01-01T10:00:05Z" },
        ],
      },
    ]);
    const imp2 = importChatExportJson(store, claudeJson);
    assert.equal(imp2.format, "claude");
    assert.equal(imp2.conversationsImported, 1);
    assert.equal(imp2.messagesImported, 2);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
