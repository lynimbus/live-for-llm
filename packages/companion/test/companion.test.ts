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
  ProactiveScheduler,
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
    assert.ok(store.listMemories().some((m) => m.title === "深夜写作习惯"));
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
