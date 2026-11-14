import { expect, open, test } from "nsh/test";

const BASE_URL = "http://127.0.0.1:4777";

function makeSnapshot() {
  return {
    conversationId: "conv_default",
    messages: [
      {
        id: "msg_1",
        conversationId: "conv_default",
        role: "companion",
        content: "Welcome back, Lyn. Everything is synced.",
        createdAt: "2026-11-15T05:00:00.000Z",
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
      companionName: "Alma",
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

test("renders companion chat, dispatches chat and approval commands, and drives drawer tabs", async () => {
  const postedCommands: Array<{ kind: string; [key: string]: unknown }> = [];
  let exportedCount = 0;

  const app = await open("./App.tsx", {
    width: 1200,
    height: 800,
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

  await app.waitFor("text:Welcome back, Lyn. Everything is synced.");
  expect(app.texts()).toContain("Alma");
  expect(app.texts()).toContain("Approval needed: Submit public post on example.com");

  await app.type("id:chat-input", "Good morning Alma");
  await app.press("id:send-btn");
  expect(app.texts()).toContain("turns 1");
  expect(postedCommands.some((c) => c.kind === "chat.send" && c.content === "Good morning Alma")).toBe(true);

  await app.press("id:banner-approve-btn");
  expect(
    postedCommands.some(
      (c) => c.kind === "approval.decide" && c.approvalId === "appr_1" && c.decision === "approved",
    ),
  ).toBe(true);

  await app.press("id:toggle-drawer");
  await app.waitFor("id:drawer-panel");

  await app.press("id:tab-memories");
  await app.waitFor("text:[fact] Favorite tea");

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

  await app.press("id:tab-settings");
  await app.waitFor("text:Trust & Safety Mode");
  expect(app.texts()).toContain("Affinity 72/100 • Mood: warm");
  await app.press("id:policy-confirm_external");
  expect(
    postedCommands.some((c) => {
      if (c.kind !== "policy.update") return false;
      const policy = c.policy as { mode?: string } | undefined;
      return policy?.mode === "confirm_external";
    }),
  ).toBe(true);
});
