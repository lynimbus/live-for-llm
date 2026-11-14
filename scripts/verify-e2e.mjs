import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CompanionDaemon, createDefaultDaemonConfig } from "../packages/daemon/src/index.ts";

function startHttpServer(handler) {
  return new Promise((resolvePromise) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolvePromise({
        server,
        url: `http://127.0.0.1:${addr.port}`,
      });
    });
  });
}

function runNshStdin(appEntry, scriptBody) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn("nsh", ["test", appEntry], {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += String(d);
    });
    child.stderr.on("data", (d) => {
      stderr += String(d);
    });
    child.on("close", (code) => {
      if (code === 0) {
        resolvePromise({ stdout, stderr });
      } else {
        rejectPromise(new Error(`nsh test exited ${code}\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`));
      }
    });
    child.stdin.write(scriptBody);
    child.stdin.end();
  });
}

const tempRoot = mkdtempSync(join(tmpdir(), "live-for-llm-e2e-"));
const authToken = "e2e-secret-token";

const targetSite = await startHttpServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(
    "<!doctype html><html><head><title>Live Browser Target</title></head><body><h1>Live Browser Target</h1><p>Companion verified via Chromium.</p></body></html>",
  );
});

let plannerSawToolResult = false;

const llmServer = await startHttpServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const messages = body.messages ?? [];
    const sys = messages.find((m) => m.role === "system")?.content ?? "";

    if (sys.includes("Extract durable personal memories")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify([
                  {
                    kind: "episode",
                    title: "Requested live target check",
                    content: "Asked Livia to inspect the local E2E browser target page.",
                    tags: ["e2e"],
                    importance: 0.7,
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
      res.write('data: {"choices":[{"delta":{"content":"Checking the live page for you!"}}]}\n\n');
      const delegateArgs = JSON.stringify({
        title: "Inspect local target",
        goal: `Navigate to ${targetSite.url} and verify its title.`,
        taskKind: "browser_research",
      });
      res.write(
        `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"tc_delegate","function":{"name":"delegate_task","arguments":${JSON.stringify(delegateArgs)}}}]}}]}\n\n`,
      );
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }

    const toolMsg = messages.find((m) => m.role === "tool");
    if (!toolMsg) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content: "",
                tool_calls: [
                  {
                    id: "tc_nav",
                    type: "function",
                    function: {
                      name: "browser_navigate",
                      arguments: JSON.stringify({ url: targetSite.url }),
                    },
                  },
                ],
              },
            },
          ],
        }),
      );
      return;
    }

    plannerSawToolResult = String(toolMsg.content).includes("Live Browser Target");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        choices: [
          {
            message: {
              content: "Verified title: Live Browser Target",
            },
          },
        ],
      }),
    );
  });
});

const llmBaseUrl = `${llmServer.url}/v1`;
const llmProfile = {
  id: "e2e-llm",
  provider: "openai_compatible",
  baseUrl: llmBaseUrl,
  model: "e2e-model",
};

const daemon = new CompanionDaemon({
  config: createDefaultDaemonConfig({
    host: "127.0.0.1",
    port: 0,
    authToken,
    dataDir: join(tempRoot, "data"),
    markdownExportDir: join(tempRoot, "md"),
    models: {
      companion_chat: llmProfile,
      memory_extract: llmProfile,
      task_planner: llmProfile,
      vision_browser: llmProfile,
      embedding: llmProfile,
    },
  }),
});

try {
  const { host, port } = await daemon.start();
  const daemonUrl = `http://${host}:${port}`;

  const appEntryPath = resolve("apps/desktop/App.tsx");
  const steps = `
    const liveApp = await open(${JSON.stringify(appEntryPath)}, {
      width: 1200,
      height: 800,
      platform: "linux",
      network: "live",
      host: {
        params: {
          daemonUrl: ${JSON.stringify(daemonUrl)},
          authToken: ${JSON.stringify(authToken)},
          drawerOpen: true,
          activeTab: "tasks",
        },
      },
    });
    await liveApp.waitFor("text:Online • trust_auto");
    await liveApp.type("id:chat-input", "Please inspect the local page");
    await liveApp.press("id:send-btn");
    await liveApp.waitFor("text:Checking the live page for you!");
    await liveApp.waitFor("text:Inspect local target", { timeout: 15000 });
    await liveApp.waitFor("text:browser_research • Completed: Verified title: Live Browser Target", { timeout: 15000 });
    await liveApp.press("id:tab-memories");
    await liveApp.waitFor("text:[episode] Requested live target check", { timeout: 5000 });
  `;

  const result = await runNshStdin("apps/desktop/App.tsx", steps);
  assert.equal(plannerSawToolResult, true, "Planner should observe Chromium extracted title");
  console.log("Live E2E verification passed.");
  if (result.stdout.trim()) {
    console.log(result.stdout.trim());
  }
} finally {
  await daemon.stop();
  llmServer.server.close();
  targetSite.server.close();
  rmSync(tempRoot, { recursive: true, force: true });
}
