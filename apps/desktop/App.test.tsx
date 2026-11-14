import { expect, open, test } from "nsh/test";

const BASE_URL = "http://mock-daemon.local:4777";

function makeSnapshot() {
  return {
    conversationId: "conv_default",
    conversations: [
      {
        id: "conv_default",
        title: "日常聊聊",
        createdAt: "2026-11-15T05:00:00.000Z",
        updatedAt: "2026-11-15T05:00:10.000Z",
        lastMessagePreview: "今天工作怎么样",
      },
      {
        id: "conv_code",
        title: "调试后端",
        createdAt: "2026-11-15T04:00:00.000Z",
        updatedAt: "2026-11-15T04:30:00.000Z",
      },
    ],
    messages: [
      {
        id: "msg_1",
        conversationId: "conv_default",
        role: "companion",
        content: "欢迎回来，**一切已同步**。",
        createdAt: "2026-11-15T05:00:00.000Z",
      },
      {
        id: "msg_2",
        conversationId: "conv_default",
        role: "user",
        content: "今天工作怎么样",
        createdAt: "2026-11-15T05:00:10.000Z",
      },
    ],
    memories: [
      {
        id: "mem_1",
        kind: "fact",
        title: "Favorite tea",
        content: "Prefers unsweetened oolong tea.",
        tags: ["drink"],
        importance: 0.8,
        source: "chat_extract",
        createdAt: "2026-11-14T10:00:00.000Z",
        updatedAt: "2026-11-14T10:00:00.000Z",
      },
      {
        id: "mem_2",
        kind: "preference",
        title: "Tone",
        content: "Likes concise practical updates.",
        tags: ["style"],
        importance: 0.7,
        source: "user_edit",
        createdAt: "2026-11-14T11:00:00.000Z",
        updatedAt: "2026-11-14T11:00:00.000Z",
      },
    ],
    relationship: {
      companionName: "Livia",
      userName: "Lyn",
      affinityScore: 0.72,
      currentMood: "calm",
      insideJokes: [],
      anniversaries: [],
      updatedAt: "2026-11-15T05:00:00.000Z",
    },
    tasks: [
      {
        id: "task_post_1",
        conversationId: "conv_default",
        taskKind: "browser_post",
        title: "Post release note",
        runnerId: "builtin-agent",
        state: {
          kind: "awaiting_approval",
          approvalId: "appr_1",
          actionSummary: "Submit public post on example.com",
          riskTier: "external_send",
          domain: "example.com",
          draftPreview: "Hello world",
          requestedAt: "2026-11-15T05:01:00.000Z",
        },
        createdAt: "2026-11-15T05:01:00.000Z",
        updatedAt: "2026-11-15T05:01:00.000Z",
      },
      {
        id: "task_done_1",
        conversationId: "conv_default",
        taskKind: "shell_utility",
        title: "Check workspace status",
        runnerId: "builtin-agent",
        state: {
          kind: "completed",
          summary: "Workspace clean.",
          completedAt: "2026-11-15T04:55:00.000Z",
        },
        createdAt: "2026-11-15T04:50:00.000Z",
        updatedAt: "2026-11-15T04:55:00.000Z",
      },
    ],
    taskTraces: {
      task_done_1: [
        {
          id: "tr_1",
          taskId: "task_done_1",
          seq: 1,
          kind: "tool_call",
          toolName: "run_shell_command",
          title: "Call run_shell_command",
          detail: '{"command":"jj status"}',
          createdAt: "2026-11-15T04:50:05.000Z",
        },
      ],
    },
    policy: {
      mode: "trust_auto",
      autoApproveDomains: [],
      alwaysConfirmTiers: ["destructive"],
    },
    modelSettings: {
      provider: "openai_compatible",
      baseUrl: "https://api.openai.com/v1",
      companionModel: "gpt-4o-mini",
      taskModel: "gpt-4o",
      memoryModel: "gpt-4o-mini",
      visionModel: "gpt-4o",
      embeddingModel: "text-embedding-3-small",
      hasApiKey: false,
    },
    harnessSettings: {
      defaultBackend: "builtin",
    },
    proactiveRules: [],
  };
}

test("ChatGPT-style workspace, right-click own-message recall, sessions sidebar, collapsed tasks accordion, and YOLO harness settings", async () => {
  const postedCommands: Array<{ kind: string; [key: string]: unknown }> = [];
  let exportedCount = 0;

  const app = await open("./App.tsx", {
    width: 1200,
    height: 820,
    platform: "linux",
    host: {
      params: {
        daemonUrl: BASE_URL,
      },
    },
    network: {
      [`GET ${BASE_URL}/api/state*`]: () => ({
        status: 200,
        body: JSON.stringify(makeSnapshot()),
        headers: { "content-type": "application/json" },
      }),
      [`POST ${BASE_URL}/api/command`]: (req) => {
        const parsed = JSON.parse(req.body ?? "{}") as { kind: string; [key: string]: unknown };
        postedCommands.push(parsed);
        return {
          status: 200,
          body: JSON.stringify({ ok: true }),
          headers: { "content-type": "application/json" },
        };
      },
      [`POST ${BASE_URL}/api/models/fetch`]: () => ({
        status: 200,
        body: JSON.stringify({ models: ["deepseek-chat", "gpt-4o-mini"] }),
        headers: { "content-type": "application/json" },
      }),
      [`POST ${BASE_URL}/api/memories/export`]: () => {
        exportedCount += 1;
        return {
          status: 200,
          body: JSON.stringify({ files: ["facts.md", "preferences.md"] }),
          headers: { "content-type": "application/json" },
        };
      },
    },
  });

  await app.waitFor("text:Livia");
  // Tasks sidebar is collapsed by default; sessions sidebar is visible.
  expect(app.shows("id:tasks-sidebar")).toBe(false);
  expect(app.shows("id:sessions-sidebar")).toBe(true);
  expect(app.texts()).toContain("日常聊聊");
  expect(app.texts()).toContain("调试后端");
  expect(app.texts().some((line) => line.toLowerCase().includes("affinity"))).toBe(false);
  // No inline recall/copy chips rendered under bubbles.
  expect(app.count("id:copy-msg_1")).toBe(0);
  expect(app.count("id:recall-msg_2")).toBe(0);

  // Composer clears immediately on submit.
  await app.type("id:chat-input", "早安呀");
  await app.press("id:send-btn");
  expect(app.value("id:chat-input")).toBe("");
  expect(app.texts()).toContain("1 轮");
  expect(postedCommands.some((c) => c.kind === "chat.send" && c.content === "早安呀")).toBe(true);

  // Companion message right-click menu must NOT offer Recall.
  await app.rightClick("id:msg-bubble-msg_1");
  const companionMenu = app.menu();
  expect(companionMenu).not.toBeNull();
  expect(companionMenu!.map((m) => m.label)).toEqual(["复制", "多选", "删除"]);
  await app.chooseMenuItem("多选");
  await app.waitFor("id:selection-toolbar");
  await app.press("id:delete-selected-btn");
  expect(
    postedCommands.some(
      (c) =>
        c.kind === "chat.delete" &&
        Array.isArray(c.messageIds) &&
        c.messageIds.includes("msg_1"),
    ),
  ).toBe(true);

  // Own (user) message right-click menu offers Recall.
  await app.rightClick("id:msg-bubble-msg_2");
  const userMenu = app.menu();
  expect(userMenu).not.toBeNull();
  expect(userMenu!.map((m) => m.label)).toEqual(["复制", "多选", "撤回", "删除"]);
  await app.chooseMenuItem("撤回");
  await app.waitFor("id:recalled-msg_2");
  expect(app.texts()).toContain("你撤回了一条消息");
  expect(postedCommands.some((c) => c.kind === "chat.recall" && c.messageId === "msg_2")).toBe(true);

  // Multi-session creation via New chat button.
  await app.press("id:new-chat-btn");
  await app.waitFor("id:welcome-card");
  expect(postedCommands.some((c) => c.kind === "conversation.create")).toBe(true);

  // Open Tasks sidebar via icon button, expand accordion row, and click content to open Live Task View.
  await app.press("id:toggle-drawer");
  await app.waitFor("id:tasks-sidebar");
  expect(app.shows("id:task-details-task_done_1")).toBe(false);
  await app.press("id:task-toggle-task_done_1");
  await app.waitFor("id:task-details-task_done_1");
  expect(app.texts().some((line) => line.includes("Workspace clean."))).toBe(true);
  await app.press("id:task-open-detail-task_done_1");
  await app.waitFor("id:task-detail-view");
  await app.waitFor("id:trace-item-tr_1");
  await app.press("id:task-detail-back-btn");
  await app.waitFor("id:welcome-card");

  // Click avatar to enter Settings page.
  await app.press("id:avatar-settings-btn");
  await app.waitFor("id:settings-page");

  await app.press("id:settings-tab-models");
  await app.clear("id:api-base-url-input");
  await app.type("id:api-base-url-input", "https://api.custom-llm.example/v1");
  await app.type("id:api-key-input", "sk-custom-test-key");
  await app.press("id:fetch-models-btn");
  await app.waitFor("id:fetched-models-panel");
  await app.press("id:fetched-model-deepseek-chat");
  await app.press("id:save-models-btn");
  expect(
    postedCommands.some((c) => {
      if (c.kind !== "models.update") return false;
      const settings = c.settings as { baseUrl?: string; apiKey?: string; companionModel?: string } | undefined;
      return (
        settings?.baseUrl === "https://api.custom-llm.example/v1" &&
        settings?.apiKey === "sk-custom-test-key" &&
        settings?.companionModel === "deepseek-chat"
      );
    }),
  ).toBe(true);

  await app.press("id:settings-tab-harness");
  await app.waitFor("id:harness-codex");
  expect(app.texts()).not.toContain("内置执行器（浏览器 + 本地工具）");
  expect(app.shows("id:browser-daemon")).toBe(true);
  await app.press("id:harness-codex");
  await app.press("id:browser-follow_harness");
  await app.press("id:save-harness-btn");
  expect(
    postedCommands.some((c) => {
      if (c.kind !== "harness.update") return false;
      const settings = c.settings as { defaultBackend?: string; browserBackend?: string } | undefined;
      return (
        settings?.defaultBackend === "codex" &&
        settings?.browserBackend === "follow_harness"
      );
    }),
  ).toBe(true);

  await app.press("id:policy-yolo");
  expect(
    postedCommands.some((c) => {
      if (c.kind !== "policy.update") return false;
      const policy = c.policy as { mode?: string } | undefined;
      return policy?.mode === "yolo";
    }),
  ).toBe(true);

  await app.press("id:settings-tab-memories");
  await app.waitFor("text:[事实] Favorite tea");
  await app.type("id:memory-new-title", "Morning ritual");
  await app.type("id:memory-new-content", "Checks build status first.");
  await app.press("id:memory-add-btn");
  expect(
    postedCommands.some((c) => {
      if (c.kind !== "memory.upsert") return false;
      const draft = c.draft as { title?: string } | undefined;
      return draft?.title === "Morning ritual";
    }),
  ).toBe(true);
  await app.press("id:memory-export-btn");
  expect(exportedCount).toBe(1);

  await app.press("id:settings-tab-general");
  await app.press("id:lang-en");
  await app.press("id:close-settings-btn");
  await app.waitFor("text:New chat");
});

test("renders empty welcome card in narrow split layout and submits starter prompt", async () => {
  const emptySnapshot = {
    ...makeSnapshot(),
    messages: [],
    tasks: [],
  };
  const postedCommands: Array<{ kind: string; content?: string }> = [];

  const app = await open("./App.tsx", {
    platform: "linux",
    width: 760,
    height: 840,
    host: {
      params: {
        daemonUrl: BASE_URL,
        sidebarOpen: false,
        drawerOpen: false,
      },
    },
    network: {
      [`GET ${BASE_URL}/api/state*`]: () => ({
        status: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(emptySnapshot),
      }),
      [`POST ${BASE_URL}/api/command`]: (req) => {
        const parsed = JSON.parse(req.body ?? "{}") as { kind: string; content?: string };
        postedCommands.push(parsed);
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ok: true }),
        };
      },
    },
  });

  await app.waitFor("id:welcome-card");
  expect(app.shows("id:sessions-sidebar")).toBe(false);
  expect(app.shows("id:tasks-sidebar")).toBe(false);
  expect(app.texts()).toContain("平时聊天自然简短点，不用太像客服。");

  await app.press("text:平时聊天自然简短点，不用太像客服。");
  expect(
    postedCommands.some(
      (c) => c.kind === "chat.send" && c.content === "平时聊天自然简短点，不用太像客服。",
    ),
  ).toBe(true);
});
