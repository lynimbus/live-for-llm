import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { createModelRouter, type TieredModelConfig } from "../src/index.ts";

async function withTestServer(
  handler: (req: http.IncomingMessage, body: string, res: http.ServerResponse) => void,
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      handler(req, Buffer.concat(chunks).toString("utf8"), res);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Unexpected server address");
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

function buildConfig(baseUrl: string): TieredModelConfig {
  return {
    companion_chat: {
      id: "chat",
      provider: "anthropic",
      baseUrl: `${baseUrl}/anthropic`,
      model: "claude-sonnet-test",
      apiKey: "ant-key",
    },
    memory_extract: {
      id: "mem",
      provider: "gemini",
      baseUrl: `${baseUrl}/gemini`,
      model: "gemini-flash-test",
      apiKey: "gem-key",
    },
    task_planner: {
      id: "task",
      provider: "openai_compatible",
      baseUrl: `${baseUrl}/openai`,
      model: "gpt-test",
      apiKey: "oai-key",
    },
    vision_browser: {
      id: "vis",
      provider: "openai_compatible",
      baseUrl: `${baseUrl}/openai`,
      model: "gpt-vision-test",
      apiKey: "oai-key",
    },
    embedding: {
      id: "emb",
      provider: "openai_compatible",
      baseUrl: `${baseUrl}/openai`,
      model: "text-embedding-test",
      apiKey: "oai-key",
    },
  };
}

test("router dispatches tiered roles across anthropic, gemini, and openai endpoints", async () => {
  const seenPaths: string[] = [];
  const srv = await withTestServer((req, body, res) => {
    seenPaths.push(req.url ?? "");
    const parsed = JSON.parse(body) as Record<string, unknown>;

    if (req.url === "/anthropic/messages") {
      assert.equal(req.headers["x-api-key"], "ant-key");
      assert.equal(parsed["system"], "Be warm.");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          content: [{ type: "text", text: "早安，今天怎么样？" }],
          usage: { input_tokens: 10, output_tokens: 8 },
        }),
      );
      return;
    }

    if (req.url?.startsWith("/gemini/models/gemini-flash-test:generateContent")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [{ text: '[{"kind":"fact","title":"wake"}]' }],
              },
            },
          ],
        }),
      );
      return;
    }

    if (req.url === "/openai/embeddings") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          data: [{ embedding: [0.5, 0.25, -0.5] }],
        }),
      );
      return;
    }

    res.writeHead(404);
    res.end("not found");
  });

  try {
    const router = createModelRouter({ config: buildConfig(srv.url) });

    const chatRes = await router.generate({
      role: "companion_chat",
      messages: [
        { role: "system", content: "Be warm." },
        { role: "user", content: "早安" },
      ],
    });
    assert.equal(chatRes.text, "早安，今天怎么样？");
    assert.deepEqual(chatRes.usage, { inputTokens: 10, outputTokens: 8 });

    const memRes = await router.generate({
      role: "memory_extract",
      messages: [{ role: "user", content: "Extract facts" }],
    });
    assert.equal(memRes.text, '[{"kind":"fact","title":"wake"}]');

    const vecs = await router.embed(["hello"]);
    assert.equal(vecs.length, 1);
    assert.deepEqual(Array.from(vecs[0] ?? []), [0.5, 0.25, -0.5]);

    assert.equal(seenPaths.length, 3);
  } finally {
    await srv.close();
  }
});

test("router streams openai SSE text deltas and tool calls", async () => {
  const srv = await withTestServer((req, _body, res) => {
    if (req.url !== "/openai/chat/completions") {
      res.writeHead(500);
      res.end("bad path");
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write('data: {"choices":[{"delta":{"content":"正在"}}]}\n\n');
    res.write('data: {"choices":[{"delta":{"content":"查询"}}]}\n\n');
    res.write(
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"search","arguments":"{\\"q\\":"}}]}}]}\n\n',
    );
    res.write(
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"nsh\\"}"}}]}}]}\n\n',
    );
    res.write("data: [DONE]\n\n");
    res.end();
  });

  try {
    const router = createModelRouter({ config: buildConfig(srv.url) });
    const deltas: string[] = [];
    let finalResponse: { text: string; toolCalls: readonly { name: string; arguments: Record<string, unknown> }[] } | undefined;

    for await (const chunk of router.stream({
      role: "task_planner",
      messages: [{ role: "user", content: "Search nsh" }],
    })) {
      if (chunk.kind === "text_delta") deltas.push(chunk.delta);
      if (chunk.kind === "done") finalResponse = chunk.response;
    }

    assert.deepEqual(deltas, ["正在", "查询"]);
    assert.equal(finalResponse?.text, "正在查询");
    assert.equal(finalResponse?.toolCalls.length, 1);
    assert.equal(finalResponse?.toolCalls[0]?.name, "search");
    assert.deepEqual(finalResponse?.toolCalls[0]?.arguments, { q: "nsh" });
  } finally {
    await srv.close();
  }
});

test("router surfaces HTTP errors cleanly", async () => {
  const srv = await withTestServer((_req, _body, res) => {
    res.writeHead(429, { "content-type": "application/json" });
    res.end('{"error":"rate limited"}');
  });

  try {
    const router = createModelRouter({ config: buildConfig(srv.url) });
    await assert.rejects(
      () =>
        router.generate({
          role: "task_planner",
          messages: [{ role: "user", content: "hi" }],
        }),
      /openai_compatible API error \(429\)/,
    );
  } finally {
    await srv.close();
  }
});
