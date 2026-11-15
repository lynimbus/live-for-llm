import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_POLICY_CONFIG,
  evaluatePolicyDecision,
  isConversationId,
  parseClientCommand,
  parseConversationId,
  parseDaemonEvent,
  parseMemoryDraft,
  parseMemoryRecord,
  parseTaskRecord,
} from "../src/index.ts";

test("branded id guard and parser accept safe ids and reject invalid input", () => {
  assert.equal(isConversationId("conv_main-01"), true);
  assert.equal(parseConversationId("conv_main-01"), "conv_main-01");
  assert.equal(isConversationId(""), false);
  assert.equal(isConversationId("../escape"), false);
  assert.throws(() => parseConversationId("bad id with spaces"), /Invalid ConversationId/);
});

test("evaluatePolicyDecision enforces trust_auto, confirm_external, and allowlist", () => {
  assert.equal(
    evaluatePolicyDecision({
      policy: {
        mode: "yolo",
        autoApproveDomains: [],
        alwaysConfirmTiers: ["destructive", "external_send"],
      },
      riskTier: "destructive",
      domain: "mail.example.com",
    }),
    "allow",
  );
  assert.equal(
    evaluatePolicyDecision({
      policy: DEFAULT_POLICY_CONFIG,
      riskTier: "external_send",
      domain: "x.com",
    }),
    "allow",
  );
  assert.equal(
    evaluatePolicyDecision({
      policy: DEFAULT_POLICY_CONFIG,
      riskTier: "destructive",
      domain: "x.com",
    }),
    "require_approval",
  );
  assert.equal(
    evaluatePolicyDecision({
      policy: {
        mode: "confirm_external",
        autoApproveDomains: [],
        alwaysConfirmTiers: ["destructive"],
      },
      riskTier: "external_send",
      domain: "x.com",
    }),
    "require_approval",
  );
  assert.equal(
    evaluatePolicyDecision({
      policy: {
        mode: "allowlist",
        autoApproveDomains: ["github.com"],
        alwaysConfirmTiers: ["destructive"],
      },
      riskTier: "external_send",
      domain: "api.github.com",
    }),
    "allow",
  );
  assert.equal(
    evaluatePolicyDecision({
      policy: {
        mode: "allowlist",
        autoApproveDomains: ["github.com"],
        alwaysConfirmTiers: ["destructive"],
      },
      riskTier: "external_send",
      domain: "mail.example.com",
    }),
    "require_approval",
  );
});

test("parseClientCommand parses valid commands and rejects malformed payloads", () => {
  const cmd = parseClientCommand({
    kind: "chat.send",
    conversationId: "conv_1",
    content: "帮我查一下今天的消息",
    deviceId: "desktop_linux",
  });
  assert.equal(cmd.kind, "chat.send");
  if (cmd.kind === "chat.send") {
    assert.equal(cmd.conversationId, "conv_1");
    assert.equal(cmd.deviceId, "desktop_linux");
  }

  assert.throws(
    () => parseClientCommand({ kind: "chat.send", conversationId: "conv_1", content: "   " }),
    /expected non-empty string/,
  );
  assert.throws(() => parseClientCommand({ kind: "unknown.cmd" }), /Invalid ClientCommand.kind/);

  const convCreate = parseClientCommand({
    kind: "conversation.create",
    conversationId: "conv_new_1",
    title: "测试会话",
  });
  assert.equal(convCreate.kind, "conversation.create");

  const harnessUpdate = parseClientCommand({
    kind: "harness.update",
    settings: {
      defaultBackend: "codex",
      browserBackend: "follow_harness",
      workingDir: "/tmp/work",
    },
  });
  assert.equal(harnessUpdate.kind, "harness.update");
  if (harnessUpdate.kind === "harness.update") {
    assert.equal(harnessUpdate.settings.browserBackend, "follow_harness");
  }

  const pauseCmd = parseClientCommand({
    kind: "task.pause_user",
    taskId: "task_12",
    instructions: "Log in first",
  });
  assert.equal(pauseCmd.kind, "task.pause_user");
  if (pauseCmd.kind === "task.pause_user") {
    assert.equal(pauseCmd.instructions, "Log in first");
  }

  const relUpdate = parseClientCommand({
    kind: "relationship.update",
    patch: { companionName: "Livia", companionAvatar: "data:image/png;base64,abc" },
  });
  assert.equal(relUpdate.kind, "relationship.update");
  if (relUpdate.kind === "relationship.update") {
    assert.equal(relUpdate.patch.companionAvatar, "data:image/png;base64,abc");
  }
});

test("parseDaemonEvent and parseTaskRecord validate discriminated task states", () => {
  const task = parseTaskRecord({
    id: "task_42",
    conversationId: "conv_1",
    taskKind: "browser_post",
    title: "Post update",
    runnerId: "browser-runner",
    browserProfileId: "prof_main",
    state: {
      kind: "awaiting_approval",
      approvalId: "appr_7",
      actionSummary: "Send reply on x.com",
      riskTier: "external_send",
      domain: "x.com",
      draftPreview: "Hello world",
      requestedAt: "2026-11-15T05:30:00Z",
    },
    createdAt: "2026-11-15T05:29:00Z",
    updatedAt: "2026-11-15T05:30:00Z",
  });
  assert.equal(task.state.kind, "awaiting_approval");

  const event = parseDaemonEvent({
    kind: "task.updated",
    task,
  });
  assert.equal(event.kind, "task.updated");

  const traceEvt = parseDaemonEvent({
    kind: "task.trace",
    entry: {
      id: "trace_1",
      taskId: "task_42",
      seq: 1,
      kind: "browser_action",
      title: "Searched topic",
      url: "https://example.com",
      createdAt: "2026-11-15T05:30:00Z",
    },
  });
  assert.equal(traceEvt.kind, "task.trace");

  assert.throws(
    () =>
      parseTaskRecord({
        id: "task_42",
        conversationId: "conv_1",
        taskKind: "browser_post",
        title: "Post update",
        runnerId: "browser-builtin",
        state: { kind: "nonexistent" },
        createdAt: "2026-11-15T05:29:00Z",
        updatedAt: "2026-11-15T05:30:00Z",
      }),
    /Invalid TaskState.kind/,
  );
});

test("parseMemoryDraft enforces importance range and memory kind", () => {
  const draft = parseMemoryDraft({
    kind: "preference",
    title: "Coffee preference",
    content: "Prefers iced oat latte without sugar.",
    tags: ["drink"],
    importance: 0.9,
    source: "chat_extract",
  });
  assert.equal(draft.kind, "preference");
  assert.throws(
    () =>
      parseMemoryDraft({
        kind: "fact",
        title: "Bad",
        content: "Out of bounds",
        importance: 1.5,
      }),
    /expected value in \[0, 1\]/,
  );

  const cmdWithPill = parseClientCommand({
    kind: "chat.send",
    conversationId: "conv_main",
    content: "Tell me straight",
    ephemeralHint: "Be blunt once.",
  });
  assert.equal(cmdWithPill.kind, "chat.send");
  if (cmdWithPill.kind === "chat.send") {
    assert.equal(cmdWithPill.ephemeralHint, "Be blunt once.");
  }

  const memRec = parseMemoryRecord({
    id: "mem_01",
    kind: "fact",
    title: "Evidence-linked fact",
    content: "Uses Vim.",
    tags: ["editor"],
    importance: 0.8,
    source: "chat_extract",
    sourceMessageIds: ["msg_u1", "msg_a1"],
    lastRecalledAt: "2026-11-15T06:00:00Z",
    recallCount: 3,
    createdAt: "2026-11-15T05:00:00Z",
    updatedAt: "2026-11-15T06:00:00Z",
  });
  assert.deepEqual(memRec.sourceMessageIds, ["msg_u1", "msg_a1"]);
  assert.equal(memRec.recallCount, 3);
});
