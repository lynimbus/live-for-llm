import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { createModelRouter, type TieredModelConfig } from "@live-for-llm/ai";
import { TaskRunnerRegistry, type TaskRunner } from "@live-for-llm/harness";
import { MemoryStore } from "@live-for-llm/memory";
import {
  type DaemonEvent,
  parseConversationId,
  parseScheduleId,
} from "@live-for-llm/protocol";
import {
  CompanionRuntime,
  PROMPT_CACHE_DYNAMIC_BOUNDARY,
  ProactiveScheduler,
  composeCompanionStaticPrefix,
  composeCompanionSystemPrompt,
  computeProactiveCooldownMinutes,
  countTrailingUnansweredProactive,
  createUtilityTools,
  decayRelationshipState,
  detectAuthOrChallengeHint,
  isWithinQuietHours,
} from "../src/index.ts";

function buildConfig(baseUrl: string): TieredModelConfig {
  const profile = {
    id: "test",
    provider: "openai_compatible" as const,
    baseUrl,
    model: "test-model",
  };
  return {
    companion_chat: profile,
    memory_extract: profile,
    task_planner: profile,
    vision_browser: profile,
    embedding: profile,
  };
}

test("CompanionRuntime chats, recalls memories, delegates background task, and extracts new memory", async () => {
  const seenPrompts: string[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        messages: Array<{ role: string; content: string }>;
        stream?: boolean;
      };
      const sys = body.messages.find((m) => m.role === "system")?.content ?? "";
      seenPrompts.push(sys);

      if (sys.includes("Extract durable personal memories")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify([
                    {
                      kind: "preference",
                      title: "深夜写作习惯",
                      content: "喜欢在深夜一边喝茶一边写代码。",
                      tags: ["habit"],
                      importance: 0.85,
                    },
                  ]),
                },
              },
            ],
          }),
        );
        return;
      }

      if (body.stream) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write('data: {"choices":[{"delta":{"content":"好呀，我马上帮你去查。"}}]}\n\n');
        res.write(
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c_del","function":{"name":"delegate_task","arguments":"{\\"title\\":\\"查资料\\",\\"goal\\":\\"Search nsh\\",\\"taskKind\\":\\"browser_research\\"}"}}]}}]}\n\n',
        );
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }

      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  assert.ok(addr && typeof addr !== "string");

  const store = new MemoryStore(":memory:");
  store.upsertMemory({
    kind: "fact",
    title: "常用语言",
    content: "主力使用 TypeScript 和 Rust。",
    tags: ["tech"],
    importance: 0.9,
    source: "user_edit",
  });

  const events: DaemonEvent[] = [];
  const fakeRunner: TaskRunner = {
    id: "fake-browser",
    label: "Fake Browser",
    supportedKinds: ["browser_research"],
    async run(ctx) {
      ctx.reportProgress("Opening target page");
      const decision = await ctx.requestApproval({
        actionSummary: "Send summary DM",
        riskTier: "external_send",
        domain: "example.com",
      });
      return decision === "approved"
        ? { kind: "completed", summary: "已整理好 3 条重点摘要。" }
        : { kind: "failed", error: "denied" };
    },
  };

  try {
    const runtime = new CompanionRuntime({
      router: createModelRouter({ config: buildConfig(`http://127.0.0.1:${addr.port}`) }),
      store,
      runners: new TaskRunnerRegistry().register(fakeRunner),
      emit: (evt) => {
        events.push(evt);
        if (evt.kind === "approval.requested") {
          runtime.resolveApproval(evt.approval.id, "approved");
        }
      },
    });

    const convId = parseConversationId("conv_main");
    const result = await runtime.handleUserMessage({
      conversationId: convId,
      content: "帮我查一下 nsh 的 TypeScript 写法",
    });

    assert.equal(result.reply.content, "好呀，我马上帮你去查。");
    assert.equal(result.spawnedTaskIds.length, 1);
    assert.ok(seenPrompts.some((p) => p.includes("主力使用 TypeScript 和 Rust")));

    await new Promise((r) => setTimeout(r, 80));

    assert.ok(events.some((e) => e.kind === "task.updated" && e.task.state.kind === "completed"));
    assert.ok(events.some((e) => e.kind === "memory.updated"));
    assert.ok(events.some((e) => e.kind === "relationship.updated"));
    assert.ok(store.listMemories().some((m) => m.title === "深夜写作习惯"));
    assert.ok(store.getRelationshipState().affinityScore > 0.5);

    const utilityTools = createUtilityTools({
      workspaceRoot: process.cwd(),
      getPolicy: () => store.getPolicy(),
    });
    const timeTool = utilityTools.find((tool) => tool.spec.name === "get_current_time");
    assert.ok(timeTool);
    const timeOut = await timeTool.execute({}, {
      taskId: result.spawnedTaskIds[0]!,
      conversationId: convId,
      taskKind: "shell_utility",
      goal: "time",
      signal: new AbortController().signal,
      reportProgress: () => {},
      requestApproval: async () => "approved",
      requestUserPause: async () => {},
    });
    assert.ok(JSON.parse(timeOut).iso);

    const promptText = composeCompanionSystemPrompt({
      relationship: store.getRelationshipState(),
      memories: store.listMemories(),
      activeTasks: [],
    });
    assert.equal(promptText.includes("affinity="), false);
    assert.ok(promptText.includes("shell_utility"));
  } finally {
    store.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("ProactiveScheduler respects quiet hours and emits due check-ins", async () => {
  assert.equal(isWithinQuietHours({ hour: 2, quietHoursStart: 23, quietHoursEnd: 8 }), true);
  assert.equal(isWithinQuietHours({ hour: 10, quietHoursStart: 23, quietHoursEnd: 8 }), false);

  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        choices: [{ message: { content: "早呀，记得先喝口水再看代码。" } }],
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  assert.ok(addr && typeof addr !== "string");

  const store = new MemoryStore(":memory:");
  const events: DaemonEvent[] = [];
  try {
    store.upsertProactiveRule({
      id: parseScheduleId("sched_morning"),
      label: "Morning greeting",
      cronOrIntervalMinutes: 60,
      quietHoursStart: 23,
      quietHoursEnd: 8,
      enabled: true,
      promptHint: "Say good morning warmly.",
    });

    const scheduler = new ProactiveScheduler({
      store,
      router: createModelRouter({ config: buildConfig(`http://127.0.0.1:${addr.port}`) }),
      conversationId: parseConversationId("conv_main"),
      emit: (evt) => events.push(evt),
    });

    const quietFired = await scheduler.tick(new Date(2026, 10, 15, 2, 0, 0));
    assert.equal(quietFired, 0);

    const activeFired = await scheduler.tick(new Date(2026, 10, 15, 10, 0, 0));
    assert.equal(activeFired, 1);
    assert.equal(events[0]?.kind, "proactive.message");
  } finally {
    store.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("Temporal decay, prompt cache partition, rich joint extraction, Pilulier burn-after-reading, and [SKIP] + backoff", async () => {
  // 1. Temporal context + static/dynamic prefix stability
  const store = new MemoryStore(":memory:");
  const seenChatRequests: Array<{ messages: Array<{ role: string; content: string }> }> = [];
  let extractPromptUserText = "";

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        messages: Array<{ role: string; content: string }>;
        stream?: boolean;
      };
      const sys = body.messages.find((m) => m.role === "system")?.content ?? "";

      if (sys.includes("Extract durable personal memories")) {
        extractPromptUserText = body.messages.find((m) => m.role === "user")?.content ?? "";
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    memories: [
                      {
                        kind: "fact",
                        title: "Deleted item should stay suppressed",
                        content: "Secretly likes pineapple pizza",
                        tags: ["food"],
                        importance: 0.6,
                      },
                      {
                        kind: "preference",
                        title: "Late-night tea",
                        content: "Drinks roasted green tea while debugging",
                        tags: ["tea"],
                        importance: 0.8,
                      },
                    ],
                    mood: "playful",
                    affinityDelta: 0.02,
                    insideJokes: ["debug-tea-club"],
                    anniversaries: [{ label: "First deploy", date: "11-16" }],
                    conversationTitle: "深夜茶话调试",
                  }),
                },
              },
            ],
          }),
        );
        return;
      }

      if (sys.includes("[SKIP]") || body.messages.some((m) => m.content.includes("[SKIP]"))) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content: "[SKIP]" } }] }));
        return;
      }

      seenChatRequests.push({ messages: body.messages });
      if (body.stream) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write('data: {"choices":[{"delta":{"content":"收到，简短说明。"}}]}\n\n');
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  assert.ok(addr && typeof addr !== "string");

  try {
    // Rejection tombstone setup
    const doomed = store.upsertMemory({
      kind: "fact",
      title: "Deleted item should stay suppressed",
      content: "Secretly likes pineapple pizza",
      tags: ["food"],
      importance: 0.6,
      source: "user_edit",
    });
    store.deleteMemory(doomed.id);

    // Mood decay check
    const staleRel = {
      ...store.getRelationshipState(),
      currentMood: "warm",
      updatedAt: new Date(Date.now() - 8 * 3_600_000).toISOString(),
    };
    const decayed = decayRelationshipState(staleRel, new Date(2026, 10, 15, 14, 0, 0));
    assert.equal(decayed.currentMood, "calm");
    const lateNight = decayRelationshipState(decayed, new Date(2026, 10, 15, 23, 30, 0));
    assert.equal(lateNight.currentMood, "tired");

    // Static prefix + dynamic partition check
    const staticA = composeCompanionStaticPrefix({
      companionName: staleRel.companionName,
      userName: staleRel.userName,
    });
    const fullPrompt = composeCompanionSystemPrompt({
      relationship: { ...staleRel, anniversaries: [{ label: "First deploy", date: "11-16" }] },
      memories: [],
      activeTasks: [],
      temporal: {
        now: new Date(2026, 10, 15, 14, 0, 0),
        lastUserMessageAt: new Date(2026, 10, 15, 12, 0, 0).toISOString(),
      },
    });
    assert.ok(fullPrompt.startsWith(staticA));
    assert.ok(fullPrompt.includes(PROMPT_CACHE_DYNAMIC_BOUNDARY));
    assert.ok(fullPrompt.includes("First deploy"));

    // Runtime chat with ephemeralHint + turn-1 companion title + sourceMessageIds
    const events: DaemonEvent[] = [];
    const runtime = new CompanionRuntime({
      router: createModelRouter({ config: buildConfig(`http://127.0.0.1:${addr.port}`) }),
      store,
      runners: new TaskRunnerRegistry(),
      emit: (e) => events.push(e),
    });

    const convId = parseConversationId("conv_main");
    await runtime.handleUserMessage({
      conversationId: convId,
      content: "帮我看看这个问题",
      ephemeralHint: "Be extra brief on this single turn.",
    });

    // ephemeralHint appeared in LLM prompt, NOT in DB history or extractor input
    const chatSysAndUser = seenChatRequests[0]?.messages.map((m) => m.content).join("\n") ?? "";
    assert.ok(chatSysAndUser.includes("Be extra brief on this single turn."));
    assert.equal(extractPromptUserText.includes("Be extra brief on this single turn."), false);
    const storedHistory = store.listChatMessages(convId);
    assert.equal(storedHistory.some((m) => m.content.includes("Be extra brief")), false);

    // Joint extraction respected tombstone, kept Late-night tea with verbatim evidence, updated jokes/anniversaries & title
    const mems = store.listMemories();
    assert.equal(mems.some((m) => m.title.includes("Deleted item")), false);
    const tea = mems.find((m) => m.title === "Late-night tea");
    assert.ok(tea);
    assert.equal(tea.sourceMessageIds?.length, 2);
    const relAfter = store.getRelationshipState();
    assert.ok(relAfter.insideJokes.includes("debug-tea-club"));
    assert.ok(relAfter.anniversaries.some((a) => a.label === "First deploy"));
    assert.equal(store.listConversations().find((c) => c.id === convId)?.title, "深夜茶话调试");

    // Proactive [SKIP] silent gate & backoff math
    assert.equal(computeProactiveCooldownMinutes(60, 0), 60);
    assert.equal(computeProactiveCooldownMinutes(60, 2), 240);
    store.upsertProactiveRule({
      id: parseScheduleId("sched_skip"),
      label: "Quiet ping",
      cronOrIntervalMinutes: 30,
      quietHoursStart: 23,
      quietHoursEnd: 7,
      enabled: true,
      promptHint: "Say hi if helpful.",
    });
    const scheduler = new ProactiveScheduler({
      store,
      router: createModelRouter({ config: buildConfig(`http://127.0.0.1:${addr.port}`) }),
      conversationId: convId,
      emit: (e) => events.push(e),
    });
    const skippedCount = await scheduler.tick(new Date(2026, 10, 15, 11, 0, 0));
    assert.equal(skippedCount, 0);
    assert.equal(events.some((e) => e.kind === "proactive.message"), false);
    assert.equal(countTrailingUnansweredProactive(store.listChatMessages(convId)), 0);

    // Passive auth/challenge detection helper
    assert.ok(
      detectAuthOrChallengeHint({
        url: "https://example.com/login",
        title: "Sign in",
        textExcerpt: "Please verify you are human (CAPTCHA)",
      }),
    );
    assert.equal(
      detectAuthOrChallengeHint({
        url: "https://example.com/docs",
        title: "Docs",
        textExcerpt: "API overview",
      }),
      undefined,
    );
  } finally {
    store.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
