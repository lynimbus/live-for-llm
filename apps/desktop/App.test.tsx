import { expect, open, test } from "nsh/test";

const BASE_URL = "http://mock-daemon.local:4777";

function makeSnapshot() {
  return {
    conversationId: "conv_default",
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
      currentMood: "warm",
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
    ],
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
    proactiveRules: [
      {
        id: "sched_1",
        label: "Evening check-in",
        cronOrIntervalMinutes: 120,
        quietHoursStart: 23,
        quietHoursEnd: 7,
        enabled: true,
        promptHint: "Ask how the day went.",
      },
    ],
  };
}

test("renders zh-CN chat with silent affinity, immediate clear, recall/multiselect, tasks sidebar, and settings page", async () => {
  const postedCommands: Array<{ kind: string; [key: string]: unknown }> = [];
  let exportedCount = 0;

  const app = await open("./App.tsx", {
    width: 1200,
    height: 820,
    platform: "linux",
    host: {
      params: {
        daemonUrl: BASE_URL,
        drawerOpen: false,
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
  expect(app.texts()).toContain("与 Lyn");
  expect(app.texts()).toContain("需要确认：Submit public post on example.com");
  expect(app.texts().some((line) => line.toLowerCase().includes("affinity"))).toBe(false);

  await app.type("id:chat-input", "早安呀");
  await app.press("id:send-btn");
  expect(app.value("id:chat-input")).toBe("");
  expect(app.texts()).toContain("1 轮");
  expect(postedCommands.some((c) => c.kind === "chat.send" && c.content === "早安呀")).toBe(true);

  await app.press("id:recall-msg_1");
  await app.waitFor("id:recalled-msg_1");
  expect(app.texts()).toContain("Livia 撤回了一条消息");
  expect(postedCommands.some((c) => c.kind === "chat.recall" && c.messageId === "msg_1")).toBe(true);

  await app.press("id:select-msg_2");
  await app.waitFor("id:selection-toolbar");
  await app.press("id:delete-selected-btn");
  expect(
    postedCommands.some(
      (c) =>
        c.kind === "chat.delete" &&
        Array.isArray(c.messageIds) &&
        c.messageIds.includes("msg_2"),
    ),
  ).toBe(true);

  await app.press("id:banner-approve-btn");
  expect(
    postedCommands.some(
      (c) => c.kind === "approval.decide" && c.approvalId === "appr_1" && c.decision === "approved",
    ),
  ).toBe(true);

  await app.press("id:toggle-drawer");
  await app.waitFor("id:tasks-sidebar");
  expect(app.texts()).toContain("Post release note");

  await app.press("id:toggle-settings");
  await app.waitFor("id:settings-page");

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
  await app.waitFor("id:policy-confirm_external");
  await app.press("id:policy-confirm_external");
  expect(
    postedCommands.some((c) => {
      if (c.kind !== "policy.update") return false;
      const policy = c.policy as { mode?: string } | undefined;
      return policy?.mode === "confirm_external";
    }),
  ).toBe(true);

  await app.press("id:lang-en");
  await app.waitFor("text:Back to Chat");
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
        drawerOpen: true,
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
  await app.waitFor("id:tasks-sidebar");
  expect(app.texts()).toContain("Livia · live-for-llm");
  expect(app.texts()).toContain("平时聊天自然简短点，不用太像客服。");

  await app.press("text:平时聊天自然简短点，不用太像客服。");
  expect(
    postedCommands.some(
      (c) => c.kind === "chat.send" && c.content === "平时聊天自然简短点，不用太像客服。",
    ),
  ).toBe(true);
});
