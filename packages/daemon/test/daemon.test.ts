import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
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
