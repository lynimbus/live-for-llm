import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { type DaemonEvent, parseDaemonEvent } from "@live-for-llm/protocol";
import { WebSocket } from "ws";
import { CompanionDaemon, createDefaultDaemonConfig } from "../src/index.ts";

test("CompanionDaemon enforces Bearer auth, serves /api/state, and streams WS chat events", async () => {
  const llmServer = http.createServer((_req, res) => {
    const chunks: Buffer[] = [];
    _req.on("data", (c: Buffer) => chunks.push(c));
    _req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        messages: Array<{ role: string; content: string }>;
        stream?: boolean;
      };
      const sys = body.messages.find((m) => m.role === "system")?.content ?? "";
      if (sys.includes("Extract durable personal memories")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content: "[]" } }] }));
        return;
      }
      if (body.stream) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write('data: {"choices":[{"delta":{"content":"我在呢。"}}]}\n\n');
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "我在呢。" } }] }));
    });
  });

  await new Promise<void>((resolve) => llmServer.listen(0, "127.0.0.1", resolve));
  const llmAddr = llmServer.address();
  assert.ok(llmAddr && typeof llmAddr !== "string");
  const llmUrl = `http://127.0.0.1:${llmAddr.port}`;

  const dataDir = mkdtempSync(join(tmpdir(), "lfl-daemon-"));
  const baseCfg = createDefaultDaemonConfig({
    host: "127.0.0.1",
    port: 0,
    authToken: "secret-tailscale-token",
    dataDir,
    models: {
      companion_chat: { id: "c", provider: "openai_compatible", baseUrl: llmUrl, model: "m" },
      memory_extract: { id: "m", provider: "openai_compatible", baseUrl: llmUrl, model: "m" },
      task_planner: { id: "t", provider: "openai_compatible", baseUrl: llmUrl, model: "m" },
      vision_browser: { id: "v", provider: "openai_compatible", baseUrl: llmUrl, model: "m" },
      embedding: { id: "e", provider: "openai_compatible", baseUrl: llmUrl, model: "m" },
    },
  });

  const daemon = new CompanionDaemon({ config: baseCfg });
  const addr = await daemon.start();
  const httpUrl = `http://${addr.host}:${addr.port}`;

  try {
    const unauth = await fetch(`${httpUrl}/api/state`);
    assert.equal(unauth.status, 401);

    const stateRes = await fetch(`${httpUrl}/api/state?conversationId=conv_main`, {
      headers: { authorization: "Bearer secret-tailscale-token" },
    });
    assert.equal(stateRes.status, 200);
    const initialState = (await stateRes.json()) as { conversationId: string };
    assert.equal(initialState.conversationId, "conv_main");

    const received: DaemonEvent[] = [];
    const ws = new WebSocket(
      `ws://${addr.host}:${addr.port}/ws?token=secret-tailscale-token`,
    );
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });

    ws.on("message", (raw) => {
      received.push(parseDaemonEvent(JSON.parse(raw.toString("utf8"))));
    });

    ws.send(
      JSON.stringify({
        kind: "chat.send",
        conversationId: "conv_main",
        content: "你在吗",
      }),
    );

    const deadline = Date.now() + 3000;
    while (
      Date.now() < deadline &&
      !received.some((e) => e.kind === "chat.message" && e.message.role === "companion")
    ) {
      await new Promise((r) => setTimeout(r, 25));
    }

    assert.ok(received.some((e) => e.kind === "chat.delta" && e.delta === "我在呢。"));
    assert.ok(
      received.some(
        (e) =>
          e.kind === "chat.message" &&
          e.message.role === "companion" &&
          e.message.content === "我在呢。",
      ),
    );

    ws.close();
  } finally {
    await daemon.stop();
    rmSync(dataDir, { recursive: true, force: true });
    await new Promise<void>((resolve) => llmServer.close(() => resolve()));
  }
});

test("CompanionDaemon hot-reloads custom API baseUrl/key/models and relationship names", async () => {
  const seenRequests: Array<{ auth?: string; model?: string }> = [];
  const llmServer = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      if (req.url === "/models" && req.method === "GET") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: "custom-chat-v2" }, { id: "custom-task-v2" }] }));
        return;
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        model?: string;
        messages: Array<{ role: string; content: string }>;
        stream?: boolean;
      };
      const sys = body.messages.find((m) => m.role === "system")?.content ?? "";
      if (sys.includes("Extract durable personal memories")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content: "[]" } }] }));
        return;
      }
      seenRequests.push({
        ...(req.headers.authorization ? { auth: req.headers.authorization } : {}),
        ...(body.model ? { model: body.model } : {}),
      });
      if (body.stream) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write('data: {"choices":[{"delta":{"content":"已切换新端点。"}}]}\n\n');
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "已切换新端点。" } }] }));
    });
  });

  await new Promise<void>((resolve) => llmServer.listen(0, "127.0.0.1", resolve));
  const llmAddr = llmServer.address();
  assert.ok(llmAddr && typeof llmAddr !== "string");
  const customUrl = `http://127.0.0.1:${llmAddr.port}`;

  const dataDir = mkdtempSync(join(tmpdir(), "lfl-daemon-cfg-"));
  const configPath = join(dataDir, "config.json");
  const baseCfg = createDefaultDaemonConfig({
    host: "127.0.0.1",
    port: 0,
    authToken: "secret-tailscale-token",
    dataDir,
  });

  const daemon = new CompanionDaemon({ config: baseCfg, configPath });
  const addr = await daemon.start();
  const httpUrl = `http://${addr.host}:${addr.port}`;

  try {
    const received: DaemonEvent[] = [];
    const ws = new WebSocket(
      `ws://${addr.host}:${addr.port}/ws?token=secret-tailscale-token`,
    );
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    ws.on("message", (raw) => {
      received.push(parseDaemonEvent(JSON.parse(raw.toString("utf8"))));
    });

    ws.send(
      JSON.stringify({
        kind: "models.update",
        settings: {
          provider: "openai_compatible",
          baseUrl: customUrl,
          apiKey: "sk-custom-1234567890",
          companionModel: "custom-chat-v2",
          taskModel: "custom-task-v2",
        },
      }),
    );
    ws.send(
      JSON.stringify({
        kind: "relationship.update",
        patch: {
          companionName: "Livia-2",
          userName: "Lynimbus",
        },
      }),
    );

    const cfgDeadline = Date.now() + 3000;
    while (
      Date.now() < cfgDeadline &&
      (!received.some((e) => e.kind === "models.updated") ||
        !received.some((e) => e.kind === "relationship.updated"))
    ) {
      await new Promise((r) => setTimeout(r, 20));
    }

    const modelsEvt = received.find((e) => e.kind === "models.updated");
    assert.ok(modelsEvt && modelsEvt.kind === "models.updated");
    assert.equal(modelsEvt.settings.baseUrl, customUrl);
    assert.equal(modelsEvt.settings.companionModel, "custom-chat-v2");
    assert.equal(modelsEvt.settings.taskModel, "custom-task-v2");
    assert.equal(modelsEvt.settings.hasApiKey, true);
    assert.equal(modelsEvt.settings.apiKeyMasked, "sk-••••7890");

    const relEvt = received.find((e) => e.kind === "relationship.updated");
    assert.ok(relEvt && relEvt.kind === "relationship.updated");
    assert.equal(relEvt.relationship.companionName, "Livia-2");
    assert.equal(relEvt.relationship.userName, "Lynimbus");

    assert.equal(existsSync(configPath), true);
    const saved = JSON.parse(readFileSync(configPath, "utf8")) as {
      models: { companion_chat: { baseUrl: string; apiKey: string; model: string } };
    };
    assert.equal(saved.models.companion_chat.baseUrl, customUrl);
    assert.equal(saved.models.companion_chat.apiKey, "sk-custom-1234567890");
    assert.equal(saved.models.companion_chat.model, "custom-chat-v2");

    const stateRes = await fetch(`${httpUrl}/api/state?conversationId=conv_main`, {
      headers: { authorization: "Bearer secret-tailscale-token" },
    });
    assert.equal(stateRes.status, 200);
    const state = (await stateRes.json()) as {
      relationship: { companionName: string; userName?: string };
      modelSettings: { baseUrl: string; apiKeyMasked?: string; companionModel: string };
    };
    assert.equal(state.relationship.companionName, "Livia-2");
    assert.equal(state.relationship.userName, "Lynimbus");
    assert.equal(state.modelSettings.baseUrl, customUrl);
    assert.equal(state.modelSettings.apiKeyMasked, "sk-••••7890");

    ws.send(
      JSON.stringify({
        kind: "chat.send",
        conversationId: "conv_main",
        content: "测试自定义接口",
      }),
    );

    const chatDeadline = Date.now() + 3000;
    while (
      Date.now() < chatDeadline &&
      !received.some((e) => e.kind === "chat.message" && e.message.role === "companion")
    ) {
      await new Promise((r) => setTimeout(r, 20));
    }

    assert.ok(
      seenRequests.some(
        (r) => r.auth === "Bearer sk-custom-1234567890" && r.model === "custom-chat-v2",
      ),
    );

    const fetchRes = await fetch(`${httpUrl}/api/models/fetch`, {
      method: "POST",
      headers: {
        authorization: "Bearer secret-tailscale-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ provider: "openai_compatible", baseUrl: customUrl }),
    });
    assert.equal(fetchRes.status, 200);
    const fetched = (await fetchRes.json()) as { models: string[] };
    assert.deepEqual(fetched.models, ["custom-chat-v2", "custom-task-v2"]);

    const chatMsgs = daemon.store.listChatMessages("conv_main" as never);
    assert.ok(chatMsgs.length >= 2);
    const userMsg = chatMsgs.find((m) => m.role === "user");
    const companionMsg = chatMsgs.find((m) => m.role === "companion");
    assert.ok(userMsg && companionMsg);

    await assert.rejects(
      () =>
        daemon.handleCommand({
          kind: "chat.recall",
          conversationId: "conv_main" as never,
          messageId: companionMsg.id,
        }),
      /Only your own messages can be recalled/,
    );

    ws.send(
      JSON.stringify({
        kind: "chat.recall",
        conversationId: "conv_main",
        messageId: userMsg.id,
      }),
    );
    const recallDeadline = Date.now() + 2000;
    while (
      Date.now() < recallDeadline &&
      !received.some((e) => e.kind === "chat.updated")
    ) {
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.ok(daemon.store.listChatMessages("conv_main" as never)[0]?.recalled);

    await daemon.handleCommand({
      kind: "conversation.create",
      conversationId: "conv_side" as never,
      title: "副会话",
    });
    await daemon.handleCommand({
      kind: "harness.update",
      settings: { defaultBackend: "codex", browserBackend: "follow_harness", workingDir: "/tmp" },
    });
    assert.equal(daemon.config.harness.defaultBackend, "codex");
    assert.equal(daemon.config.harness.browserBackend, "follow_harness");
    assert.ok(daemon.store.listConversations().some((c) => c.id === "conv_side"));

    const { resolveConfiguredRunnerId } = await import("../src/config.ts");
    assert.equal(
      resolveConfiguredRunnerId({ defaultBackend: "codex", browserBackend: "daemon" }, "browser_research"),
      "browser-runner",
    );
    assert.equal(
      resolveConfiguredRunnerId({ defaultBackend: "codex", browserBackend: "daemon" }, "harness_coding"),
      "codex-cli",
    );
    assert.equal(
      resolveConfiguredRunnerId({ defaultBackend: "pi", browserBackend: "follow_harness" }, "browser_research"),
      "pi-cli",
    );

    ws.close();
  } finally {
    await daemon.stop();
    rmSync(dataDir, { recursive: true, force: true });
    await new Promise<void>((resolve) => llmServer.close(() => resolve()));
  }
});
