import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseConversationId, parseMemoryId, parseMessageId } from "@live-for-llm/protocol";
import { exportMemoriesToMarkdown, importMarkdownEdits, MemoryStore } from "../src/index.ts";

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
    store.appendChatMessage({
      id: parseMessageId("msg_1"),
      conversationId: convId,
      role: "user",
      content: "晚安",
      createdAt: "2026-11-15T05:30:00Z",
    });
    const history = store.listChatMessages(convId);
    assert.equal(history.length, 1);
    assert.equal(history[0]?.content, "晚安");
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
