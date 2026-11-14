import { timingSafeEqual } from "node:crypto";
import http from "node:http";
import { join } from "node:path";
import {
  createModelRouter,
  fetchAvailableModels,
  type FetchLike,
  type ModelRouter,
} from "@live-for-llm/ai";
import { PersistentBrowserManager } from "@live-for-llm/browser";
import {
  CompanionRuntime,
  createBrowserTools,
  createUtilityTools,
  ProactiveScheduler,
} from "@live-for-llm/companion";
import {
  BuiltinAgentRunner,
  ExternalCliRunner,
  TaskRunnerRegistry,
} from "@live-for-llm/harness";
import {
  exportMemoriesToMarkdown,
  importMarkdownEdits,
  MemoryStore,
} from "@live-for-llm/memory";
import {
  type ClientCommand,
  type DaemonEvent,
  LLM_PROVIDER_KINDS,
  type LlmProviderKind,
  parseBrowserProfileId,
  parseClientCommand,
  parseConversationId,
} from "@live-for-llm/protocol";
import { WebSocket, WebSocketServer } from "ws";
import {
  applyModelSettingsUpdate,
  type DaemonConfig,
  resolveConfiguredRunnerId,
  saveDaemonConfig,
  summarizeModelSettings,
} from "./config.ts";

function parseCustomCliArgs(rawArgs: string | undefined, goal: string): string[] {
  const tokens: string[] = [];
  if (rawArgs && rawArgs.trim()) {
    const regex = /"([^"]*)"|'([^']*)'|\S+/g;
    for (const match of rawArgs.matchAll(regex)) {
      tokens.push(match[1] ?? match[2] ?? match[0]);
    }
  }
  let substituted = false;
  const resolved = tokens.map((tok) => {
    if (tok.includes("{goal}")) {
      substituted = true;
      return tok.replaceAll("{goal}", goal);
    }
    return tok;
  });
  if (!substituted) {
    resolved.push(goal);
  }
  return resolved;
}

export interface CompanionDaemonOptions {
  readonly config: DaemonConfig;
  readonly configPath?: string;
  readonly fetchImpl?: FetchLike;
  readonly defaultConversationId?: string;
}

function safeTokenEquals(expected: string, actual: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(actual, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function isAuthorized(req: http.IncomingMessage, expectedToken?: string): boolean {
  if (!expectedToken) return true;
  const header = req.headers.authorization;
  if (header?.startsWith("Bearer ")) {
    return safeTokenEquals(expectedToken, header.slice(7).trim());
  }
  try {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const token = url.searchParams.get("token");
    return token ? safeTokenEquals(expectedToken, token) : false;
  } catch {
    return false;
  }
}

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

function writeJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
  });
  res.end(JSON.stringify(body));
}

/** Local HTTP and WebSocket daemon hosting memory, companion runtime, harness, and persistent browser. */
export class CompanionDaemon {
  config: DaemonConfig;
  readonly store: MemoryStore;
  readonly browser: PersistentBrowserManager;
  readonly runtime: CompanionRuntime;
  readonly scheduler: ProactiveScheduler;
  private readonly router: ModelRouter;
  private readonly fetchImpl: FetchLike | undefined;
  private readonly configPath: string | undefined;
  private readonly clients = new Set<WebSocket>();
  private readonly startedAt = Date.now();
  private server: http.Server | undefined;
  private wss: WebSocketServer | undefined;
  private actualPort = 0;

  constructor(options: CompanionDaemonOptions) {
    this.config = options.config;
    this.fetchImpl = options.fetchImpl;
    this.configPath = options.configPath;
    const dbPath =
      this.config.dataDir === ":memory:"
        ? ":memory:"
        : join(this.config.dataDir, "companion.db");

    this.store = new MemoryStore(dbPath);
    const profilesRoot =
      this.config.dataDir === ":memory:"
        ? join("/tmp", "live-for-llm-test-profiles")
        : join(this.config.dataDir, "browser-profiles");

    this.browser = new PersistentBrowserManager({ profilesRootDir: profilesRoot });

    const router = createModelRouter({
      config: this.config.models,
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    });
    this.router = router;

    const profileId = parseBrowserProfileId("default_user");
    const browserTools = createBrowserTools({
      browser: this.browser,
      profileId,
      getPolicy: () => this.store.getPolicy(),
    });
    const utilityTools = createUtilityTools({
      workspaceRoot: process.cwd(),
      getWorkspaceRoot: () => this.config.harness.workingDir || process.cwd(),
      getPolicy: () => this.store.getPolicy(),
    });
    const resolveCwd = () => this.config.harness.workingDir || undefined;

    const registry = new TaskRunnerRegistry()
      .register(
        new BuiltinAgentRunner({
          id: "builtin-agent",
          label: "Built-in Browser & Workspace Agent",
          router,
          getPolicy: () => this.store.getPolicy(),
          tools: [...browserTools, ...utilityTools],
          systemPrompt:
            "You are the background execution harness. You have both persistent browser automation tools (browser_*) and local workspace/utility tools (get_current_time, list_directory, read_local_file, write_local_file, run_shell_command). Use the right tools for the goal and return a concise factual summary.",
        }),
      )
      .register(
        new ExternalCliRunner({
          id: "codex-cli",
          label: "Codex CLI",
          command: "codex",
          cwd: resolveCwd,
          buildArgs: (goal) =>
            this.store.getPolicy().mode === "yolo"
              ? ["exec", "--dangerously-bypass-approvals-and-sandbox", goal]
              : ["exec", "--full-auto", goal],
          supportedKinds: ["harness_coding", "shell_utility"],
        }),
      )
      .register(
        new ExternalCliRunner({
          id: "claude-cli",
          label: "Claude Code CLI",
          command: "claude",
          cwd: resolveCwd,
          buildArgs: (goal) =>
            this.store.getPolicy().mode === "yolo"
              ? ["-p", "--dangerously-skip-permissions", goal]
              : ["-p", goal],
          supportedKinds: ["harness_coding", "shell_utility"],
        }),
      )
      .register(
        new ExternalCliRunner({
          id: "pi-cli",
          label: "External Pi Harness",
          command: "pi",
          cwd: resolveCwd,
          buildArgs: (goal) => ["--print", goal],
          supportedKinds: ["harness_coding", "shell_utility"],
        }),
      )
      .register(
        new ExternalCliRunner({
          id: "opencode-cli",
          label: "OpenCode CLI",
          command: "opencode",
          cwd: resolveCwd,
          buildArgs: (goal) => ["run", goal],
          supportedKinds: ["harness_coding", "shell_utility"],
        }),
      )
      .register(
        new ExternalCliRunner({
          id: "custom-cli",
          label: "Custom Harness CLI",
          command: () => {
            const cmd = this.config.harness.customCommand?.trim() ?? "";
            if (!cmd) {
              throw new Error("Custom harness command is not configured");
            }
            return cmd;
          },
          cwd: resolveCwd,
          buildArgs: (goal) => parseCustomCliArgs(this.config.harness.customArgs, goal),
          supportedKinds: ["harness_coding", "shell_utility"],
        }),
      );

    const broadcast = (event: DaemonEvent) => {
      const sendRaw = (evt: DaemonEvent) => {
        const payload = JSON.stringify(evt);
        for (const client of this.clients) {
          if (client.readyState === WebSocket.OPEN) {
            client.send(payload);
          }
        }
      };
      sendRaw(event);
      if (event.kind === "chat.message" || event.kind === "proactive.message") {
        sendRaw({
          kind: "conversations.updated",
          conversations: this.store.listConversations(),
        });
      }
    };

    this.runtime = new CompanionRuntime({
      router,
      store: this.store,
      runners: registry,
      emit: broadcast,
      enableEmbeddings: this.config.enableEmbeddings,
      getDefaultRunnerId: (taskKind) => resolveConfiguredRunnerId(this.config.harness, taskKind),
    });

    this.scheduler = new ProactiveScheduler({
      store: this.store,
      router,
      conversationId: parseConversationId(options.defaultConversationId ?? "conv_main"),
      emit: broadcast,
    });
  }

  get port(): number {
    return this.actualPort;
  }

  async handleCommand(cmd: ClientCommand): Promise<void> {
    switch (cmd.kind) {
      case "chat.send": {
        await this.runtime.handleUserMessage({
          conversationId: cmd.conversationId,
          content: cmd.content,
        });
        return;
      }
      case "chat.recall": {
        const target = this.store.getChatMessage(cmd.conversationId, cmd.messageId);
        if (!target) {
          throw new Error(`Message not found: ${cmd.messageId}`);
        }
        if (target.role !== "user") {
          throw new Error("Only your own messages can be recalled");
        }
        this.store.recallChatMessage(cmd.conversationId, cmd.messageId, "user");
        this.broadcastDirect({
          kind: "chat.updated",
          conversationId: cmd.conversationId,
          messages: this.store.listChatMessages(cmd.conversationId, 100),
        });
        this.broadcastDirect({
          kind: "conversations.updated",
          conversations: this.store.listConversations(),
        });
        return;
      }
      case "chat.delete": {
        this.store.deleteChatMessages(cmd.conversationId, cmd.messageIds);
        this.broadcastDirect({
          kind: "chat.updated",
          conversationId: cmd.conversationId,
          messages: this.store.listChatMessages(cmd.conversationId, 100),
        });
        this.broadcastDirect({
          kind: "conversations.updated",
          conversations: this.store.listConversations(),
        });
        return;
      }
      case "conversation.create": {
        this.store.createConversation({
          ...(cmd.conversationId ? { id: cmd.conversationId } : {}),
          ...(cmd.title ? { title: cmd.title } : {}),
        });
        this.broadcastDirect({
          kind: "conversations.updated",
          conversations: this.store.listConversations(),
        });
        return;
      }
      case "conversation.rename": {
        this.store.renameConversation(cmd.conversationId, cmd.title);
        this.broadcastDirect({
          kind: "conversations.updated",
          conversations: this.store.listConversations(),
        });
        return;
      }
      case "conversation.delete": {
        this.store.deleteConversation(cmd.conversationId);
        if (this.store.listConversations(1).length === 0) {
          this.store.createConversation({ id: parseConversationId("conv_main") });
        }
        this.broadcastDirect({
          kind: "conversations.updated",
          conversations: this.store.listConversations(),
        });
        return;
      }
      case "approval.decide": {
        this.runtime.resolveApproval(cmd.approvalId, cmd.decision);
        return;
      }
      case "task.cancel": {
        this.runtime.cancelTask(cmd.taskId);
        return;
      }
      case "browser.resume_user": {
        this.runtime.resumePausedTask(cmd.taskId);
        return;
      }
      case "memory.upsert": {
        const record = this.store.upsertMemory(cmd.draft);
        this.broadcastDirect({ kind: "memory.updated", records: [record] });
        return;
      }
      case "memory.delete": {
        this.store.deleteMemory(cmd.memoryId);
        this.broadcastDirect({
          kind: "memory.updated",
          records: this.store.listMemories({ limit: 50 }),
          replaced: true,
        });
        return;
      }
      case "policy.update": {
        this.store.savePolicy(cmd.policy);
        this.broadcastDirect({ kind: "policy.updated", policy: cmd.policy });
        return;
      }
      case "schedule.upsert": {
        this.store.upsertProactiveRule(cmd.rule);
        return;
      }
      case "models.update": {
        const nextModels = applyModelSettingsUpdate(this.config.models, cmd.settings);
        this.config = { ...this.config, models: nextModels };
        this.router.updateConfig(nextModels);
        if (this.config.dataDir !== ":memory:") {
          const targetPath = this.configPath ?? join(this.config.dataDir, "config.json");
          saveDaemonConfig(this.config, targetPath);
        }
        this.broadcastDirect({
          kind: "models.updated",
          settings: summarizeModelSettings(nextModels),
        });
        return;
      }
      case "harness.update": {
        this.config = { ...this.config, harness: cmd.settings };
        if (this.config.dataDir !== ":memory:") {
          const targetPath = this.configPath ?? join(this.config.dataDir, "config.json");
          saveDaemonConfig(this.config, targetPath);
        }
        this.broadcastDirect({
          kind: "harness.updated",
          settings: this.config.harness,
        });
        return;
      }
      case "relationship.update": {
        const current = this.store.getRelationshipState();
        const next = this.store.updateRelationshipState({
          ...current,
          ...(cmd.patch.companionName ? { companionName: cmd.patch.companionName } : {}),
          ...(cmd.patch.userName ? { userName: cmd.patch.userName } : {}),
          ...(cmd.patch.currentMood ? { currentMood: cmd.patch.currentMood } : {}),
        });
        this.broadcastDirect({
          kind: "relationship.updated",
          relationship: next,
        });
        return;
      }
      case "ping": {
        this.broadcastDirect({ kind: "pong", receivedAt: new Date().toISOString() });
        return;
      }
      default: {
        const _exhaustive: never = cmd;
        return _exhaustive;
      }
    }
  }

  private broadcastDirect(event: DaemonEvent): void {
    const payload = JSON.stringify(event);
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload);
      }
    }
  }

  async start(): Promise<{ readonly host: string; readonly port: number }> {
    const server = http.createServer(async (req, res) => {
      if (req.method === "OPTIONS") {
        res.writeHead(204, {
          "access-control-allow-origin": "*",
          "access-control-allow-headers": "content-type, authorization",
          "access-control-allow-methods": "GET, POST, OPTIONS",
        });
        res.end();
        return;
      }

      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/health" && req.method === "GET") {
        writeJson(res, 200, {
          ok: true,
          uptimeMs: Date.now() - this.startedAt,
        });
        return;
      }

      if (!isAuthorized(req, this.config.authToken)) {
        writeJson(res, 401, { error: "Unauthorized" });
        return;
      }

      try {
        if (url.pathname === "/api/state" && req.method === "GET") {
          const convId = parseConversationId(
            url.searchParams.get("conversationId") ?? "conv_main",
          );
          writeJson(res, 200, {
            conversationId: convId,
            conversations: this.store.listConversations(),
            messages: this.store.listChatMessages(convId, 100),
            memories: this.store.listMemories({ limit: 100 }),
            relationship: this.store.getRelationshipState(),
            tasks: this.store.listTasks(30),
            policy: this.store.getPolicy(),
            proactiveRules: this.store.listProactiveRules().map((r) => r.rule),
            modelSettings: summarizeModelSettings(this.config.models),
            harnessSettings: this.config.harness,
          });
          return;
        }

        if (url.pathname === "/api/memories/export" && req.method === "POST") {
          const files = exportMemoriesToMarkdown({
            store: this.store,
            outputDir: this.config.markdownExportDir,
          });
          writeJson(res, 200, { files });
          return;
        }

        if (url.pathname === "/api/memories/import" && req.method === "POST") {
          const imported = importMarkdownEdits({
            inputDir: this.config.markdownExportDir,
            store: this.store,
          });
          writeJson(res, 200, { imported });
          return;
        }

        if (url.pathname === "/api/models/fetch" && req.method === "POST") {
          const raw = (await readJsonBody(req)) as Record<string, unknown>;
          const rawProvider = raw["provider"];
          const provider: LlmProviderKind =
            typeof rawProvider === "string" &&
            (LLM_PROVIDER_KINDS as readonly string[]).includes(rawProvider)
              ? (rawProvider as LlmProviderKind)
              : this.config.models.companion_chat.provider;
          const baseUrl =
            typeof raw["baseUrl"] === "string" && raw["baseUrl"].trim()
              ? raw["baseUrl"].trim()
              : this.config.models.companion_chat.baseUrl;
          const rawKey = typeof raw["apiKey"] === "string" ? raw["apiKey"].trim() : "";
          const savedProfile = this.config.models.companion_chat;
          const envKey = savedProfile.apiKeyEnv ? process.env[savedProfile.apiKeyEnv] : undefined;
          const apiKey = rawKey || savedProfile.apiKey || envKey;

          const models = await fetchAvailableModels({
            provider,
            baseUrl,
            ...(apiKey ? { apiKey } : {}),
            ...(this.fetchImpl ? { fetchImpl: this.fetchImpl } : {}),
          });
          writeJson(res, 200, { models });
          return;
        }

        if (url.pathname === "/api/command" && req.method === "POST") {
          const raw = await readJsonBody(req);
          const cmd = parseClientCommand(raw);
          await this.handleCommand(cmd);
          writeJson(res, 200, { ok: true });
          return;
        }

        writeJson(res, 404, { error: "Not found" });
      } catch (err) {
        writeJson(res, 400, {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });

    const wss = new WebSocketServer({ noServer: true });
    server.on("upgrade", (req, socket, head) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== "/ws") {
        socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
        socket.destroy();
        return;
      }
      if (!isAuthorized(req, this.config.authToken)) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req);
      });
    });

    wss.on("connection", (ws) => {
      this.clients.add(ws);
      ws.on("close", () => this.clients.delete(ws));
      ws.on("message", (data) => {
        void (async () => {
          try {
            const parsed: unknown = JSON.parse(data.toString("utf8"));
            const cmd = parseClientCommand(parsed);
            await this.handleCommand(cmd);
          } catch (err) {
            const evt: DaemonEvent = {
              kind: "error",
              code: "COMMAND_ERROR",
              message: err instanceof Error ? err.message : String(err),
            };
            ws.send(JSON.stringify(evt));
          }
        })();
      });
    });

    await new Promise<void>((resolve) => {
      server.listen(this.config.port, this.config.host, resolve);
    });

    const addr = server.address();
    if (!addr || typeof addr === "string") {
      throw new Error("Failed to resolve daemon listen address");
    }
    this.actualPort = addr.port;
    this.server = server;
    this.wss = wss;
    this.scheduler.start();

    return { host: this.config.host, port: this.actualPort };
  }

  async stop(): Promise<void> {
    this.scheduler.stop();
    for (const client of this.clients) {
      client.close();
    }
    this.clients.clear();
    await new Promise<void>((resolve) => {
      if (this.wss) {
        this.wss.close(() => resolve());
      } else {
        resolve();
      }
    });
    await new Promise<void>((resolve) => {
      if (this.server) {
        this.server.close(() => resolve());
      } else {
        resolve();
      }
    });
    await this.browser.closeAll();
    this.store.close();
  }
}
