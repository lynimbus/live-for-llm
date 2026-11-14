import type {
  ChatTurnMessage,
  CompletionResponse,
  ModelProfile,
  StreamChunk,
  ToolCallRequest,
  ToolSpec,
} from "./types.ts";

export type FetchLike = typeof fetch;

function resolveApiKey(profile: ModelProfile): string | undefined {
  if (profile.apiKey) return profile.apiKey;
  if (profile.apiKeyEnv) return process.env[profile.apiKeyEnv];
  return undefined;
}

function stripTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

async function readJsonOrThrow(response: Response, provider: string): Promise<Record<string, unknown>> {
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${provider} API error (${response.status}): ${text.slice(0, 400)}`);
  }
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${provider} API returned non-object JSON`);
  }
  return parsed as Record<string, unknown>;
}

async function* iterateSseEvents(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<{ event?: string; data: string }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let currentEvent: string | undefined;
  let dataLines: string[] = [];

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let newlineIdx = buffer.indexOf("\n");
      while (newlineIdx !== -1) {
        const line = buffer.slice(0, newlineIdx).replace(/\r$/, "");
        buffer = buffer.slice(newlineIdx + 1);

        if (line === "") {
          if (dataLines.length > 0) {
            yield {
              ...(currentEvent !== undefined ? { event: currentEvent } : {}),
              data: dataLines.join("\n"),
            };
          }
          currentEvent = undefined;
          dataLines = [];
        } else if (line.startsWith("event:")) {
          currentEvent = line.slice(6).trim();
        } else if (line.startsWith("data:")) {
          dataLines.push(line.slice(5).trimStart());
        }
        newlineIdx = buffer.indexOf("\n");
      }
    }
    if (dataLines.length > 0) {
      yield {
        ...(currentEvent !== undefined ? { event: currentEvent } : {}),
        data: dataLines.join("\n"),
      };
    }
  } finally {
    reader.releaseLock();
  }
}

function safeParseJsonObject(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return { value: parsed };
  } catch {
    return { raw };
  }
}

function toOpenAiMessages(messages: readonly ChatTurnMessage[]): unknown[] {
  return messages.map((msg) => {
    if (msg.role === "tool") {
      return {
        role: "tool",
        tool_call_id: msg.toolCallId ?? "unknown",
        content: msg.content,
      };
    }
    if (msg.role === "assistant" && msg.toolCalls && msg.toolCalls.length > 0) {
      return {
        role: "assistant",
        content: msg.content || null,
        tool_calls: msg.toolCalls.map((call) => ({
          id: call.id,
          type: "function",
          function: {
            name: call.name,
            arguments: JSON.stringify(call.arguments),
          },
        })),
      };
    }
    if (msg.imageBase64 && msg.imageMimeType) {
      return {
        role: msg.role,
        content: [
          { type: "text", text: msg.content },
          {
            type: "image_url",
            image_url: { url: `data:${msg.imageMimeType};base64,${msg.imageBase64}` },
          },
        ],
      };
    }
    return { role: msg.role, content: msg.content };
  });
}

function buildOpenAiPayload(params: {
  readonly profile: ModelProfile;
  readonly messages: readonly ChatTurnMessage[];
  readonly tools?: readonly ToolSpec[];
  readonly stream: boolean;
}): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    model: params.profile.model,
    messages: toOpenAiMessages(params.messages),
    stream: params.stream,
  };
  if (params.profile.temperature !== undefined) {
    payload["temperature"] = params.profile.temperature;
  }
  if (params.profile.maxTokens !== undefined) {
    payload["max_tokens"] = params.profile.maxTokens;
  }
  if (params.tools && params.tools.length > 0) {
    payload["tools"] = params.tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }));
  }
  return payload;
}

function parseOpenAiCompletion(json: Record<string, unknown>): CompletionResponse {
  const choices = Array.isArray(json["choices"]) ? json["choices"] : [];
  const first = (choices[0] ?? {}) as Record<string, unknown>;
  const message = (first["message"] ?? {}) as Record<string, unknown>;
  const text = typeof message["content"] === "string" ? message["content"] : "";
  const rawCalls = Array.isArray(message["tool_calls"]) ? message["tool_calls"] : [];
  const toolCalls: ToolCallRequest[] = rawCalls.map((entry, idx) => {
    const item = entry as Record<string, unknown>;
    const fn = (item["function"] ?? {}) as Record<string, unknown>;
    return {
      id: typeof item["id"] === "string" ? item["id"] : `call_${idx}`,
      name: typeof fn["name"] === "string" ? fn["name"] : "unknown",
      arguments: safeParseJsonObject(typeof fn["arguments"] === "string" ? fn["arguments"] : "{}"),
    };
  });
  const usageObj = json["usage"] as Record<string, unknown> | undefined;
  const usage =
    usageObj &&
    typeof usageObj["prompt_tokens"] === "number" &&
    typeof usageObj["completion_tokens"] === "number"
      ? {
          inputTokens: usageObj["prompt_tokens"],
          outputTokens: usageObj["completion_tokens"],
        }
      : undefined;
  return {
    text,
    toolCalls,
    ...(usage !== undefined ? { usage } : {}),
  };
}

function buildAnthropicPayload(params: {
  readonly profile: ModelProfile;
  readonly messages: readonly ChatTurnMessage[];
  readonly tools?: readonly ToolSpec[];
  readonly stream: boolean;
}): Record<string, unknown> {
  const systemParts: string[] = [];
  const wireMessages: unknown[] = [];

  for (const msg of params.messages) {
    if (msg.role === "system") {
      systemParts.push(msg.content);
      continue;
    }
    if (msg.role === "tool") {
      wireMessages.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: msg.toolCallId ?? "unknown",
            content: msg.content,
          },
        ],
      });
      continue;
    }
    if (msg.role === "assistant" && msg.toolCalls && msg.toolCalls.length > 0) {
      const blocks: unknown[] = [];
      if (msg.content) blocks.push({ type: "text", text: msg.content });
      for (const call of msg.toolCalls) {
        blocks.push({
          type: "tool_use",
          id: call.id,
          name: call.name,
          input: call.arguments,
        });
      }
      wireMessages.push({ role: "assistant", content: blocks });
      continue;
    }
    if (msg.imageBase64 && msg.imageMimeType) {
      wireMessages.push({
        role: msg.role,
        content: [
          { type: "text", text: msg.content },
          {
            type: "image",
            source: {
              type: "base64",
              media_type: msg.imageMimeType,
              data: msg.imageBase64,
            },
          },
        ],
      });
      continue;
    }
    wireMessages.push({ role: msg.role, content: msg.content });
  }

  const payload: Record<string, unknown> = {
    model: params.profile.model,
    max_tokens: params.profile.maxTokens ?? 2048,
    messages: wireMessages,
    stream: params.stream,
  };
  if (systemParts.length > 0) {
    payload["system"] = systemParts.join("\n\n");
  }
  if (params.profile.temperature !== undefined) {
    payload["temperature"] = params.profile.temperature;
  }
  if (params.tools && params.tools.length > 0) {
    payload["tools"] = params.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.parameters,
    }));
  }
  return payload;
}

function parseAnthropicCompletion(json: Record<string, unknown>): CompletionResponse {
  const content = Array.isArray(json["content"]) ? json["content"] : [];
  const texts: string[] = [];
  const toolCalls: ToolCallRequest[] = [];
  for (const block of content) {
    const item = block as Record<string, unknown>;
    if (item["type"] === "text" && typeof item["text"] === "string") {
      texts.push(item["text"]);
    } else if (item["type"] === "tool_use") {
      toolCalls.push({
        id: typeof item["id"] === "string" ? item["id"] : `tool_${toolCalls.length}`,
        name: typeof item["name"] === "string" ? item["name"] : "unknown",
        arguments:
          typeof item["input"] === "object" && item["input"] !== null
            ? (item["input"] as Record<string, unknown>)
            : {},
      });
    }
  }
  const usageObj = json["usage"] as Record<string, unknown> | undefined;
  const usage =
    usageObj &&
    typeof usageObj["input_tokens"] === "number" &&
    typeof usageObj["output_tokens"] === "number"
      ? {
          inputTokens: usageObj["input_tokens"],
          outputTokens: usageObj["output_tokens"],
        }
      : undefined;
  return {
    text: texts.join(""),
    toolCalls,
    ...(usage !== undefined ? { usage } : {}),
  };
}

function buildGeminiPayload(params: {
  readonly profile: ModelProfile;
  readonly messages: readonly ChatTurnMessage[];
  readonly tools?: readonly ToolSpec[];
}): Record<string, unknown> {
  const systemParts: string[] = [];
  const contents: unknown[] = [];

  for (const msg of params.messages) {
    if (msg.role === "system") {
      systemParts.push(msg.content);
      continue;
    }
    const role = msg.role === "assistant" ? "model" : "user";
    const parts: unknown[] = [];
    if (msg.role === "tool") {
      parts.push({
        functionResponse: {
          name: msg.toolName ?? "tool",
          response: { content: msg.content },
        },
      });
    } else {
      if (msg.content) parts.push({ text: msg.content });
      if (msg.imageBase64 && msg.imageMimeType) {
        parts.push({
          inlineData: {
            mimeType: msg.imageMimeType,
            data: msg.imageBase64,
          },
        });
      }
      if (msg.toolCalls) {
        for (const call of msg.toolCalls) {
          parts.push({
            functionCall: { name: call.name, args: call.arguments },
          });
        }
      }
    }
    contents.push({ role, parts });
  }

  const payload: Record<string, unknown> = { contents };
  if (systemParts.length > 0) {
    payload["systemInstruction"] = { parts: [{ text: systemParts.join("\n\n") }] };
  }
  if (params.profile.temperature !== undefined || params.profile.maxTokens !== undefined) {
    payload["generationConfig"] = {
      ...(params.profile.temperature !== undefined
        ? { temperature: params.profile.temperature }
        : {}),
      ...(params.profile.maxTokens !== undefined
        ? { maxOutputTokens: params.profile.maxTokens }
        : {}),
    };
  }
  if (params.tools && params.tools.length > 0) {
    payload["tools"] = [
      {
        functionDeclarations: params.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        })),
      },
    ];
  }
  return payload;
}

function parseGeminiCompletion(json: Record<string, unknown>): CompletionResponse {
  const candidates = Array.isArray(json["candidates"]) ? json["candidates"] : [];
  const first = (candidates[0] ?? {}) as Record<string, unknown>;
  const content = (first["content"] ?? {}) as Record<string, unknown>;
  const parts = Array.isArray(content["parts"]) ? content["parts"] : [];
  const texts: string[] = [];
  const toolCalls: ToolCallRequest[] = [];

  for (const part of parts) {
    const item = part as Record<string, unknown>;
    if (typeof item["text"] === "string") {
      texts.push(item["text"]);
    }
    const fnCall = item["functionCall"] as Record<string, unknown> | undefined;
    if (fnCall && typeof fnCall["name"] === "string") {
      toolCalls.push({
        id: `gemini_call_${toolCalls.length}`,
        name: fnCall["name"],
        arguments:
          typeof fnCall["args"] === "object" && fnCall["args"] !== null
            ? (fnCall["args"] as Record<string, unknown>)
            : {},
      });
    }
  }
  return { text: texts.join(""), toolCalls };
}

/** Sends a single non-streaming completion request to the configured provider. */
export async function generateCompletion(params: {
  readonly profile: ModelProfile;
  readonly messages: readonly ChatTurnMessage[];
  readonly tools?: readonly ToolSpec[];
  readonly signal?: AbortSignal;
  readonly fetchImpl?: FetchLike;
}): Promise<CompletionResponse> {
  const fetchFn = params.fetchImpl ?? fetch;
  const baseUrl = stripTrailingSlash(params.profile.baseUrl);
  const apiKey = resolveApiKey(params.profile);

  switch (params.profile.provider) {
    case "openai_compatible": {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (apiKey) headers["authorization"] = `Bearer ${apiKey}`;
      const res = await fetchFn(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify(
          buildOpenAiPayload({
            profile: params.profile,
            messages: params.messages,
            ...(params.tools ? { tools: params.tools } : {}),
            stream: false,
          }),
        ),
        ...(params.signal ? { signal: params.signal } : {}),
      });
      return parseOpenAiCompletion(await readJsonOrThrow(res, "openai_compatible"));
    }
    case "anthropic": {
      const headers: Record<string, string> = {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
      };
      if (apiKey) headers["x-api-key"] = apiKey;
      const res = await fetchFn(`${baseUrl}/messages`, {
        method: "POST",
        headers,
        body: JSON.stringify(
          buildAnthropicPayload({
            profile: params.profile,
            messages: params.messages,
            ...(params.tools ? { tools: params.tools } : {}),
            stream: false,
          }),
        ),
        ...(params.signal ? { signal: params.signal } : {}),
      });
      return parseAnthropicCompletion(await readJsonOrThrow(res, "anthropic"));
    }
    case "gemini": {
      const url = `${baseUrl}/models/${encodeURIComponent(params.profile.model)}:generateContent${apiKey ? `?key=${encodeURIComponent(apiKey)}` : ""}`;
      const res = await fetchFn(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          buildGeminiPayload({
            profile: params.profile,
            messages: params.messages,
            ...(params.tools ? { tools: params.tools } : {}),
          }),
        ),
        ...(params.signal ? { signal: params.signal } : {}),
      });
      return parseGeminiCompletion(await readJsonOrThrow(res, "gemini"));
    }
    default: {
      const _exhaustive: never = params.profile.provider;
      return _exhaustive;
    }
  }
}

/** Streams completion chunks for providers supporting SSE, or yields one turn for Gemini. */
export async function* streamCompletion(params: {
  readonly profile: ModelProfile;
  readonly messages: readonly ChatTurnMessage[];
  readonly tools?: readonly ToolSpec[];
  readonly signal?: AbortSignal;
  readonly fetchImpl?: FetchLike;
}): AsyncGenerator<StreamChunk> {
  const fetchFn = params.fetchImpl ?? fetch;
  const baseUrl = stripTrailingSlash(params.profile.baseUrl);
  const apiKey = resolveApiKey(params.profile);

  if (params.profile.provider === "openai_compatible") {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (apiKey) headers["authorization"] = `Bearer ${apiKey}`;
    const res = await fetchFn(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(
        buildOpenAiPayload({
          profile: params.profile,
          messages: params.messages,
          ...(params.tools ? { tools: params.tools } : {}),
          stream: true,
        }),
      ),
      ...(params.signal ? { signal: params.signal } : {}),
    });
    if (!res.ok || !res.body) {
      await readJsonOrThrow(res, "openai_compatible");
      throw new Error("openai_compatible stream missing response body");
    }

    let fullText = "";
    const partialCalls = new Map<number, { id: string; name: string; args: string }>();

    for await (const evt of iterateSseEvents(res.body)) {
      if (evt.data === "[DONE]") break;
      const chunk = safeParseJsonObject(evt.data);
      const choices = Array.isArray(chunk["choices"]) ? chunk["choices"] : [];
      const first = (choices[0] ?? {}) as Record<string, unknown>;
      const delta = (first["delta"] ?? {}) as Record<string, unknown>;

      if (typeof delta["content"] === "string" && delta["content"].length > 0) {
        fullText += delta["content"];
        yield { kind: "text_delta", delta: delta["content"] };
      }

      const rawCalls = Array.isArray(delta["tool_calls"]) ? delta["tool_calls"] : [];
      for (const entry of rawCalls) {
        const item = entry as Record<string, unknown>;
        const idx = typeof item["index"] === "number" ? item["index"] : 0;
        const fn = (item["function"] ?? {}) as Record<string, unknown>;
        const prev = partialCalls.get(idx) ?? {
          id: typeof item["id"] === "string" ? item["id"] : `call_${idx}`,
          name: "",
          args: "",
        };
        if (typeof item["id"] === "string") prev.id = item["id"];
        if (typeof fn["name"] === "string") prev.name += fn["name"];
        if (typeof fn["arguments"] === "string") prev.args += fn["arguments"];
        partialCalls.set(idx, prev);
      }
    }

    const toolCalls: ToolCallRequest[] = [];
    for (const entry of partialCalls.values()) {
      const call: ToolCallRequest = {
        id: entry.id,
        name: entry.name || "unknown",
        arguments: safeParseJsonObject(entry.args),
      };
      toolCalls.push(call);
      yield { kind: "tool_call", call };
    }
    yield { kind: "done", response: { text: fullText, toolCalls } };
    return;
  }

  if (params.profile.provider === "anthropic") {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
    };
    if (apiKey) headers["x-api-key"] = apiKey;
    const res = await fetchFn(`${baseUrl}/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify(
        buildAnthropicPayload({
          profile: params.profile,
          messages: params.messages,
          ...(params.tools ? { tools: params.tools } : {}),
          stream: true,
        }),
      ),
      ...(params.signal ? { signal: params.signal } : {}),
    });
    if (!res.ok || !res.body) {
      await readJsonOrThrow(res, "anthropic");
      throw new Error("anthropic stream missing response body");
    }

    let fullText = "";
    const toolCalls: ToolCallRequest[] = [];
    const activeTools = new Map<number, { id: string; name: string; json: string }>();

    for await (const evt of iterateSseEvents(res.body)) {
      const payload = safeParseJsonObject(evt.data);
      const eventType = evt.event ?? (typeof payload["type"] === "string" ? payload["type"] : "");
      if (eventType === "content_block_start") {
        const idx = typeof payload["index"] === "number" ? payload["index"] : 0;
        const block = (payload["content_block"] ?? {}) as Record<string, unknown>;
        if (block["type"] === "tool_use") {
          activeTools.set(idx, {
            id: typeof block["id"] === "string" ? block["id"] : `tool_${idx}`,
            name: typeof block["name"] === "string" ? block["name"] : "unknown",
            json: "",
          });
        }
      } else if (eventType === "content_block_delta") {
        const idx = typeof payload["index"] === "number" ? payload["index"] : 0;
        const delta = (payload["delta"] ?? {}) as Record<string, unknown>;
        if (delta["type"] === "text_delta" && typeof delta["text"] === "string") {
          fullText += delta["text"];
          yield { kind: "text_delta", delta: delta["text"] };
        } else if (delta["type"] === "input_json_delta" && typeof delta["partial_json"] === "string") {
          const active = activeTools.get(idx);
          if (active) active.json += delta["partial_json"];
        }
      } else if (eventType === "content_block_stop") {
        const idx = typeof payload["index"] === "number" ? payload["index"] : 0;
        const active = activeTools.get(idx);
        if (active) {
          const call: ToolCallRequest = {
            id: active.id,
            name: active.name,
            arguments: safeParseJsonObject(active.json),
          };
          toolCalls.push(call);
          activeTools.delete(idx);
          yield { kind: "tool_call", call };
        }
      }
    }

    yield { kind: "done", response: { text: fullText, toolCalls } };
    return;
  }

  const response = await generateCompletion(params);
  if (response.text) {
    yield { kind: "text_delta", delta: response.text };
  }
  for (const call of response.toolCalls) {
    yield { kind: "tool_call", call };
  }
  yield { kind: "done", response };
}

/** Generates float32 embeddings from an OpenAI-compatible or Gemini embedding endpoint. */
export async function generateEmbeddings(params: {
  readonly profile: ModelProfile;
  readonly texts: readonly string[];
  readonly signal?: AbortSignal;
  readonly fetchImpl?: FetchLike;
}): Promise<Float32Array[]> {
  if (params.texts.length === 0) return [];
  const fetchFn = params.fetchImpl ?? fetch;
  const baseUrl = stripTrailingSlash(params.profile.baseUrl);
  const apiKey = resolveApiKey(params.profile);

  if (params.profile.provider === "openai_compatible") {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (apiKey) headers["authorization"] = `Bearer ${apiKey}`;
    const res = await fetchFn(`${baseUrl}/embeddings`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: params.profile.model,
        input: params.texts,
      }),
      ...(params.signal ? { signal: params.signal } : {}),
    });
    const json = await readJsonOrThrow(res, "openai_compatible");
    const data = Array.isArray(json["data"]) ? json["data"] : [];
    return data.map((entry) => {
      const row = entry as Record<string, unknown>;
      const vec = Array.isArray(row["embedding"]) ? row["embedding"] : [];
      return Float32Array.from(vec.map((n) => (typeof n === "number" ? n : 0)));
    });
  }

  if (params.profile.provider === "gemini") {
    const vectors: Float32Array[] = [];
    for (const text of params.texts) {
      const url = `${baseUrl}/models/${encodeURIComponent(params.profile.model)}:embedContent${apiKey ? `?key=${encodeURIComponent(apiKey)}` : ""}`;
      const res = await fetchFn(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: { parts: [{ text }] } }),
        ...(params.signal ? { signal: params.signal } : {}),
      });
      const json = await readJsonOrThrow(res, "gemini");
      const embedding = (json["embedding"] ?? {}) as Record<string, unknown>;
      const values = Array.isArray(embedding["values"]) ? embedding["values"] : [];
      vectors.push(Float32Array.from(values.map((n) => (typeof n === "number" ? n : 0))));
    }
    return vectors;
  }

  throw new Error(`Provider ${params.profile.provider} does not support embeddings`);
}

/** Queries the configured provider endpoint for available model identifiers (Magpie-style setup). */
export async function fetchAvailableModels(params: {
  readonly provider: ModelProfile["provider"];
  readonly baseUrl: string;
  readonly apiKey?: string;
  readonly signal?: AbortSignal;
  readonly fetchImpl?: FetchLike;
}): Promise<string[]> {
  const fetchFn = params.fetchImpl ?? fetch;
  const baseUrl = stripTrailingSlash(params.baseUrl.trim());
  const apiKey = params.apiKey?.trim();
  if (!baseUrl) {
    throw new Error("Base URL is required to fetch models");
  }

  let url: string;
  const headers: Record<string, string> = {};

  if (params.provider === "openai_compatible") {
    url = `${baseUrl}/models`;
    if (apiKey) headers["authorization"] = `Bearer ${apiKey}`;
  } else if (params.provider === "anthropic") {
    const root = baseUrl.endsWith("/v1") ? baseUrl : `${baseUrl}/v1`;
    url = `${root}/models`;
    headers["anthropic-version"] = "2023-06-01";
    if (apiKey) headers["x-api-key"] = apiKey;
  } else {
    url = `${baseUrl}/models${apiKey ? `?key=${encodeURIComponent(apiKey)}` : ""}`;
  }

  const res = await fetchFn(url, {
    method: "GET",
    headers,
    ...(params.signal ? { signal: params.signal } : {}),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${params.provider} /models error (${res.status}): ${text.slice(0, 300)}`);
  }

  const parsed: unknown = JSON.parse(text);
  const rawList = Array.isArray(parsed)
    ? parsed
    : typeof parsed === "object" && parsed !== null
      ? ((parsed as Record<string, unknown>)["data"] ??
        (parsed as Record<string, unknown>)["models"] ??
        [])
      : [];

  if (!Array.isArray(rawList)) {
    return [];
  }

  const ids = new Set<string>();
  for (const item of rawList) {
    if (typeof item === "string" && item.trim()) {
      ids.add(item.trim());
    } else if (typeof item === "object" && item !== null) {
      const row = item as Record<string, unknown>;
      const rawId =
        typeof row["id"] === "string"
          ? row["id"]
          : typeof row["name"] === "string"
            ? row["name"]
            : "";
      const cleaned = rawId.replace(/^models\//, "").trim();
      if (cleaned) ids.add(cleaned);
    }
  }
  return Array.from(ids).sort((a, b) => a.localeCompare(b));
}
