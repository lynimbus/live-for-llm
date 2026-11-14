import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { createModelRouter, type TieredModelConfig } from "@live-for-llm/ai";
import { parseConversationId, parseTaskId } from "@live-for-llm/protocol";
import {
  BuiltinAgentRunner,
  ExternalCliRunner,
  type HarnessTool,
  TaskRunnerRegistry,
} from "../src/index.ts";

function createLocalConfig(baseUrl: string): TieredModelConfig {
  const profile = {
    id: "local",
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

test("BuiltinAgentRunner executes tools, enforces external_send approval gate, and returns summary", async () => {
  let step = 0;
  const server = http.createServer((_req, res) => {
    step += 1;
    res.writeHead(200, { "content-type": "application/json" });
    if (step === 1) {
      res.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content: "",
                tool_calls: [
                  {
                    id: "c1",
                    type: "function",
                    function: { name: "send_post", arguments: '{"text":"hello"}' },
                  },
                ],
              },
            },
          ],
        }),
      );
      return;
    }
    res.end(
      JSON.stringify({
        choices: [{ message: { content: "已通过审批并完成发布。" } }],
      }),
    );
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  assert.ok(addr && typeof addr !== "string");

  try {
    const executed: string[] = [];
    const postTool: HarnessTool = {
      spec: {
        name: "send_post",
        description: "Publish post",
        parameters: { type: "object" },
      },
      riskTier: "external_send",
      domain: "x.com",
      async execute(args) {
        executed.push(String(args["text"]));
        return "published";
      },
    };

    const runner = new BuiltinAgentRunner({
      router: createModelRouter({ config: createLocalConfig(`http://127.0.0.1:${addr.port}`) }),
      tools: [postTool],
    });

    const registry = new TaskRunnerRegistry().register(runner);
    const resolved = registry.resolve({ taskKind: "browser_post" });
    assert.equal(resolved.id, "builtin-agent");

    const approvals: string[] = [];
    const progress: string[] = [];
    const outcome = await resolved.run({
      taskId: parseTaskId("task_1"),
      conversationId: parseConversationId("conv_1"),
      taskKind: "browser_post",
      goal: "Post hello",
      signal: new AbortController().signal,
      reportProgress(s) {
        progress.push(s);
      },
      async requestApproval(req) {
        approvals.push(req.actionSummary);
        return "approved";
      },
      async requestUserPause() {},
    });

    assert.equal(outcome.kind, "completed");
    if (outcome.kind === "completed") {
      assert.match(outcome.summary, /完成发布/);
    }
    assert.deepEqual(executed, ["hello"]);
    assert.equal(approvals.length, 1);
    assert.ok(progress.length >= 2);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("ExternalCliRunner spawns child process, streams progress, and supports abort", async () => {
  const runner = new ExternalCliRunner({
    id: "echo-harness",
    label: "Echo Harness",
    command: process.execPath,
    buildArgs: (goal) => [
      "-e",
      `console.log("step: starting"); console.log(${JSON.stringify(`done: ${goal}`)});`,
    ],
  });

  const progress: string[] = [];
  const res = await runner.run({
    taskId: parseTaskId("task_2"),
    conversationId: parseConversationId("conv_1"),
    taskKind: "harness_coding",
    goal: "fix bug",
    signal: new AbortController().signal,
    reportProgress(s) {
      progress.push(s);
    },
    async requestApproval() {
      return "approved";
    },
    async requestUserPause() {},
  });

  assert.equal(res.kind, "completed");
  if (res.kind === "completed") {
    assert.match(res.summary, /done: fix bug/);
  }
  assert.deepEqual(progress, ["step: starting", "done: fix bug"]);
});

test("BuiltinAgentRunner synthesizes collected tool evidence when maxTurns is reached", async () => {
  let step = 0;
  const server = http.createServer((_req, res) => {
    step += 1;
    res.writeHead(200, { "content-type": "application/json" });
    if (step <= 2) {
      res.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content: "",
                tool_calls: [
                  {
                    id: `c_${step}`,
                    type: "function",
                    function: { name: "lookup", arguments: "{}" },
                  },
                ],
              },
            },
          ],
        }),
      );
      return;
    }
    res.end(
      JSON.stringify({
        choices: [{ message: { content: "汇总已采集结果：研究结论已完成。" } }],
      }),
    );
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  assert.ok(addr && typeof addr !== "string");

  try {
    const traces: string[] = [];
    const lookupTool: HarnessTool = {
      spec: {
        name: "lookup",
        description: "Lookup evidence",
        parameters: { type: "object" },
      },
      riskTier: "read_only",
      async execute() {
        return "evidence item";
      },
    };
    const runner = new BuiltinAgentRunner({
      router: createModelRouter({ config: createLocalConfig(`http://127.0.0.1:${addr.port}`) }),
      tools: [lookupTool],
      maxTurns: 2,
    });
    const outcome = await runner.run({
      taskId: parseTaskId("task_wrapup"),
      conversationId: parseConversationId("conv_1"),
      taskKind: "browser_research",
      goal: "Research topic",
      signal: new AbortController().signal,
      reportProgress() {},
      reportTrace(entry) {
        traces.push(`${entry.kind}:${entry.title}`);
      },
      async requestApproval() {
        return "approved";
      },
      async requestUserPause() {},
    });
    assert.equal(outcome.kind, "completed");
    if (outcome.kind === "completed") {
      assert.match(outcome.summary, /研究结论已完成/);
    }
    assert.ok(traces.some((t) => t.startsWith("tool_call:")));
    assert.ok(traces.some((t) => t.startsWith("tool_result:")));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
