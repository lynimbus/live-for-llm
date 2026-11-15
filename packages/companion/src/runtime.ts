import { randomUUID } from "node:crypto";
import type { ChatTurnMessage, ModelRouter, ToolSpec } from "@live-for-llm/ai";
import type { TaskRunnerRegistry } from "@live-for-llm/harness";
import type { MemoryStore } from "@live-for-llm/memory";
import {
  type ApprovalDecision,
  type ApprovalId,
  type ChatMessage,
  type ConversationId,
  type DaemonEvent,
  TASK_KINDS,
  type TaskId,
  type TaskKind,
  type TaskRecord,
  parseApprovalId,
  parseMessageId,
  parseTaskId,
} from "@live-for-llm/protocol";
import {
  computeSilentRelationshipUpdate,
  extractMemoriesFromTurn,
} from "./extractor.ts";
import { composeCompanionSystemPrompt } from "./prompt.ts";

const DELEGATE_TASK_TOOL: ToolSpec = {
  name: "delegate_task",
  description:
    "Delegate an actionable request to the background TaskRunner: local workspace files/shell utility, coding harness, web research in persistent Chromium, or posting/sending messages.",
  parameters: {
    type: "object",
    properties: {
      title: { type: "string" },
      goal: { type: "string" },
      taskKind: { type: "string", enum: [...TASK_KINDS] },
      runnerId: { type: "string" },
    },
    required: ["title", "goal", "taskKind"],
  },
};

function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

/** Coordinates companion chat, memory extraction, background task delegation, and approval gates. */
export class CompanionRuntime {
  private readonly router: ModelRouter;
  private readonly store: MemoryStore;
  private readonly runners: TaskRunnerRegistry;
  private readonly emit: (event: DaemonEvent) => void;
  private readonly enableEmbeddings: boolean;
  private readonly getDefaultRunnerId?: (taskKind: TaskKind) => string | undefined;
  private readonly activeAbortControllers = new Map<TaskId, AbortController>();
  private readonly pendingApprovals = new Map<
    ApprovalId,
    (decision: ApprovalDecision) => void
  >();
  private readonly pendingUserResumes = new Map<TaskId, () => void>();
  private readonly manualPauseHandlers = new Map<TaskId, (instructions?: string) => void>();

  constructor(params: {
    readonly router: ModelRouter;
    readonly store: MemoryStore;
    readonly runners: TaskRunnerRegistry;
    readonly emit: (event: DaemonEvent) => void;
    readonly enableEmbeddings?: boolean;
    readonly getDefaultRunnerId?: (taskKind: TaskKind) => string | undefined;
  }) {
    this.router = params.router;
    this.store = params.store;
    this.runners = params.runners;
    this.emit = params.emit;
    this.enableEmbeddings = params.enableEmbeddings ?? false;
    if (params.getDefaultRunnerId !== undefined) {
      this.getDefaultRunnerId = params.getDefaultRunnerId;
    }
  }

  async handleUserMessage(params: {
    readonly conversationId: ConversationId;
    readonly content: string;
  }): Promise<{ readonly reply: ChatMessage; readonly spawnedTaskIds: TaskId[] }> {
    const userMessage: ChatMessage = {
      id: parseMessageId(newId("msg")),
      conversationId: params.conversationId,
      role: "user",
      content: params.content,
      createdAt: new Date().toISOString(),
    };
    this.store.appendChatMessage(userMessage);
    this.emit({ kind: "chat.message", message: userMessage });

    let queryEmbedding: Float32Array | undefined;
    if (this.enableEmbeddings) {
      try {
        const [vec] = await this.router.embed([params.content]);
        queryEmbedding = vec;
      } catch {
        queryEmbedding = undefined;
      }
    }

    const recalled = this.store
      .searchMemories({
        text: params.content,
        limit: 8,
        ...(queryEmbedding ? { queryEmbedding } : {}),
      })
      .map((r) => r.record);

    const relationship = this.store.getRelationshipState();
    const activeTasks = this.store
      .listTasks(10)
      .filter(
        (t) =>
          t.state.kind === "queued" ||
          t.state.kind === "running" ||
          t.state.kind === "awaiting_approval" ||
          t.state.kind === "paused_for_user",
      );

    const history = this.store
      .listChatMessages(params.conversationId, 20)
      .filter((m) => !m.recalled && m.content.trim().length > 0);
    const messages: ChatTurnMessage[] = [
      {
        role: "system",
        content: composeCompanionSystemPrompt({ relationship, memories: recalled, activeTasks }),
      },
      ...history.map((m) => ({
        role: (m.role === "companion" ? "assistant" : m.role) as "user" | "assistant" | "system",
        content: m.content,
      })),
    ];

    const assistantMessageId = parseMessageId(newId("msg"));
    let replyText = "";
    const toolCalls = [];

    for await (const chunk of this.router.stream({
      role: "companion_chat",
      messages,
      tools: [DELEGATE_TASK_TOOL],
    })) {
      if (chunk.kind === "text_delta") {
        replyText += chunk.delta;
        this.emit({
          kind: "chat.delta",
          conversationId: params.conversationId,
          messageId: assistantMessageId,
          delta: chunk.delta,
        });
      } else if (chunk.kind === "tool_call") {
        toolCalls.push(chunk.call);
      }
    }

    const spawnedTaskIds: TaskId[] = [];
    for (const call of toolCalls) {
      if (call.name !== "delegate_task") continue;
      const title =
        typeof call.arguments["title"] === "string" ? call.arguments["title"] : "Background task";
      const goal =
        typeof call.arguments["goal"] === "string" ? call.arguments["goal"] : params.content;
      const rawKind = call.arguments["taskKind"];
      const taskKind: TaskKind =
        typeof rawKind === "string" && (TASK_KINDS as readonly string[]).includes(rawKind)
          ? (rawKind as TaskKind)
          : "browser_research";
      const runnerId =
        typeof call.arguments["runnerId"] === "string" ? call.arguments["runnerId"] : undefined;

      const taskId = this.startBackgroundTask({
        conversationId: params.conversationId,
        title,
        goal,
        taskKind,
        ...(runnerId ? { runnerId } : {}),
      });
      spawnedTaskIds.push(taskId);
    }

    if (!replyText.trim() && spawnedTaskIds.length > 0) {
      const followRes = await this.router.generate({
        role: "companion_chat",
        messages: [
          ...messages,
          { role: "assistant", content: "", toolCalls },
          ...toolCalls.map((c, idx) => ({
            role: "tool" as const,
            toolCallId: c.id,
            toolName: c.name,
            content: `Started background task ${spawnedTaskIds[idx] ?? "task"}`,
          })),
        ],
      });
      replyText = followRes.text || "好呀，我已经交给后台去处理了，有进展马上告诉你。";
    }

    const reply: ChatMessage = {
      id: assistantMessageId,
      conversationId: params.conversationId,
      role: "companion",
      content: replyText,
      createdAt: new Date().toISOString(),
      ...(spawnedTaskIds[0] ? { linkedTaskId: spawnedTaskIds[0] } : {}),
    };
    this.store.appendChatMessage(reply);
    this.emit({ kind: "chat.message", message: reply });

    let extracted: Awaited<ReturnType<typeof extractMemoriesFromTurn>> = [];
    try {
      extracted = await extractMemoriesFromTurn({
        router: this.router,
        store: this.store,
        userText: params.content,
        companionText: reply.content,
        enableEmbeddings: this.enableEmbeddings,
      });
      if (extracted.length > 0) {
        this.emit({ kind: "memory.updated", records: extracted });
      }
    } catch {
      // Non-fatal memory extraction failure must not interrupt conversation delivery.
    }

    try {
      const nextRel = computeSilentRelationshipUpdate({
        current: this.store.getRelationshipState(),
        userText: params.content,
        companionText: reply.content,
        extracted,
      });
      const persisted = this.store.updateRelationshipState(nextRel);
      this.emit({ kind: "relationship.updated", relationship: persisted });
    } catch {
      // Non-fatal silent relationship drift update.
    }

    return { reply, spawnedTaskIds };
  }

  startBackgroundTask(params: {
    readonly conversationId: ConversationId;
    readonly title: string;
    readonly goal: string;
    readonly taskKind: TaskKind;
    readonly runnerId?: string;
  }): TaskId {
    const resolvedRunnerId = params.runnerId ?? this.getDefaultRunnerId?.(params.taskKind);
    const runner = this.runners.resolve({
      ...(resolvedRunnerId ? { runnerId: resolvedRunnerId } : {}),
      taskKind: params.taskKind,
    });
    const taskId = parseTaskId(newId("task"));
    const now = new Date().toISOString();

    let current: TaskRecord = {
      id: taskId,
      conversationId: params.conversationId,
      taskKind: params.taskKind,
      title: params.title,
      runnerId: runner.id,
      state: { kind: "queued", queuedAt: now },
      createdAt: now,
      updatedAt: now,
    };

    const commitTask = (nextState: TaskRecord["state"]) => {
      current = {
        ...current,
        state: nextState,
        updatedAt: new Date().toISOString(),
      };
      this.store.upsertTask(current);
      this.emit({ kind: "task.updated", task: current });
    };

    this.store.upsertTask(current);
    this.emit({ kind: "task.updated", task: current });

    const emitTrace = (input: Parameters<NonNullable<Parameters<typeof runner.run>[0]["reportTrace"]>>[0]) => {
      const entry = this.store.appendTaskTrace({
        taskId,
        kind: input.kind,
        title: input.title,
        ...(input.detail !== undefined ? { detail: input.detail } : {}),
        ...(input.toolName !== undefined ? { toolName: input.toolName } : {}),
        ...(input.url !== undefined ? { url: input.url } : {}),
        ...(input.isError ? { isError: true } : {}),
      });
      this.emit({ kind: "task.trace", entry });
    };

    const abortController = new AbortController();
    this.activeAbortControllers.set(taskId, abortController);
    let lastShot: string | undefined;
    let lastUrl = "";
    let manualPausePromise: Promise<void> | undefined;

    const triggerManualPause = (instructions?: string) => {
      if (manualPausePromise) return;
      const reasonText =
        instructions?.trim() || "请在浏览器界面完成登录或人工操作后点击继续";
      manualPausePromise = new Promise<void>((resolve) => {
        this.pendingUserResumes.set(taskId, () => {
          this.pendingUserResumes.delete(taskId);
          manualPausePromise = undefined;
          commitTask({
            kind: "running",
            startedAt:
              current.state.kind === "running"
                ? current.state.startedAt
                : new Date().toISOString(),
            stepSummary: "Resuming after user intervention",
            ...(lastShot ? { latestScreenshotBase64: lastShot } : {}),
            ...(lastUrl ? { latestUrl: lastUrl } : {}),
          });
          emitTrace({
            kind: "status",
            title: "User resumed session",
          });
          resolve();
        });
      });
      commitTask({
        kind: "paused_for_user",
        reason: "manual_intervention",
        instructions: reasonText,
        pausedAt: new Date().toISOString(),
      });
      emitTrace({
        kind: "approval",
        title: "Paused for manual intervention",
        detail: reasonText,
      });
    };
    this.manualPauseHandlers.set(taskId, triggerManualPause);

    void (async () => {
      const startSummary = `Starting ${runner.label}`;
      commitTask({
        kind: "running",
        startedAt: new Date().toISOString(),
        stepSummary: startSummary,
      });
      emitTrace({
        kind: "status",
        title: startSummary,
        detail: params.goal,
      });

      try {
        const outcome = await runner.run({
          taskId,
          conversationId: params.conversationId,
          taskKind: params.taskKind,
          goal: params.goal,
          signal: abortController.signal,
          reportProgress: (stepSummary, screenshotBase64, pageUrl) => {
            if (screenshotBase64) lastShot = screenshotBase64;
            if (pageUrl !== undefined && pageUrl) lastUrl = pageUrl;
            const resolvedShot = screenshotBase64 ?? lastShot;
            commitTask({
              kind: "running",
              startedAt:
                current.state.kind === "running"
                  ? current.state.startedAt
                  : new Date().toISOString(),
              stepSummary,
              ...(resolvedShot ? { latestScreenshotBase64: resolvedShot } : {}),
              ...(lastUrl ? { latestUrl: lastUrl } : {}),
            });
            if (screenshotBase64) {
              this.emit({
                kind: "browser.screenshot",
                taskId,
                mimeType: "image/jpeg",
                base64: screenshotBase64,
                url: lastUrl,
                capturedAt: new Date().toISOString(),
              });
            }
          },
          reportTrace: (entry) => {
            if (entry.screenshotBase64) {
              lastShot = entry.screenshotBase64;
              if (entry.url) lastUrl = entry.url;
              this.emit({
                kind: "browser.screenshot",
                taskId,
                mimeType: "image/jpeg",
                base64: entry.screenshotBase64,
                url: lastUrl,
                capturedAt: new Date().toISOString(),
              });
            } else if (entry.url) {
              lastUrl = entry.url;
            }
            emitTrace(entry);
          },
          requestApproval: (req) =>
            new Promise<ApprovalDecision>((resolve) => {
              const approvalId = parseApprovalId(newId("appr"));
              const requestedAt = new Date().toISOString();
              this.pendingApprovals.set(approvalId, (decision) => {
                this.pendingApprovals.delete(approvalId);
                emitTrace({
                  kind: "approval",
                  title: `Approval ${decision}: ${req.actionSummary}`,
                });
                resolve(decision);
              });
              commitTask({
                kind: "awaiting_approval",
                approvalId,
                actionSummary: req.actionSummary,
                riskTier: req.riskTier,
                ...(req.domain ? { domain: req.domain } : {}),
                ...(req.draftPreview ? { draftPreview: req.draftPreview } : {}),
                requestedAt,
              });
              emitTrace({
                kind: "approval",
                title: `Awaiting approval [${req.riskTier}]: ${req.actionSummary}`,
                ...(req.draftPreview ? { detail: req.draftPreview } : {}),
              });
              this.emit({
                kind: "approval.requested",
                approval: {
                  id: approvalId,
                  taskId,
                  actionSummary: req.actionSummary,
                  riskTier: req.riskTier,
                  ...(req.domain ? { domain: req.domain } : {}),
                  ...(req.draftPreview ? { draftPreview: req.draftPreview } : {}),
                  requestedAt,
                },
              });
            }),
          requestUserPause: (req) =>
            new Promise<void>((resolve) => {
              this.pendingUserResumes.set(taskId, () => {
                this.pendingUserResumes.delete(taskId);
                emitTrace({
                  kind: "status",
                  title: "User resumed session",
                });
                resolve();
              });
              commitTask({
                kind: "paused_for_user",
                reason: req.reason,
                instructions: req.instructions,
                pausedAt: new Date().toISOString(),
              });
              emitTrace({
                kind: "approval",
                title: `Paused (${req.reason})`,
                detail: req.instructions,
              });
            }),
          waitIfPaused: async () => {
            if (!manualPausePromise) return false;
            await manualPausePromise;
            return true;
          },
        });

        if (outcome.kind === "completed") {
          commitTask({
            kind: "completed",
            summary: outcome.summary,
            completedAt: new Date().toISOString(),
          });
          emitTrace({
            kind: "status",
            title: "Task completed",
            detail: outcome.summary.slice(0, 800),
          });
          const reportMsg: ChatMessage = {
            id: parseMessageId(newId("msg")),
            conversationId: params.conversationId,
            role: "companion",
            content: `刚才交代给我的「${params.title}」做好了：\n\n${outcome.summary}`,
            linkedTaskId: taskId,
            createdAt: new Date().toISOString(),
          };
          this.store.appendChatMessage(reportMsg);
          this.emit({ kind: "chat.message", message: reportMsg });
        } else if (outcome.kind === "cancelled") {
          commitTask({ kind: "cancelled", cancelledAt: new Date().toISOString() });
          emitTrace({ kind: "status", title: "Task cancelled" });
        } else {
          commitTask({
            kind: "failed",
            error: outcome.error,
            failedAt: new Date().toISOString(),
          });
          emitTrace({
            kind: "error",
            title: "Task failed",
            detail: outcome.error,
            isError: true,
          });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        commitTask({
          kind: "failed",
          error: message,
          failedAt: new Date().toISOString(),
        });
        emitTrace({
          kind: "error",
          title: "Task crashed",
          detail: message,
          isError: true,
        });
      } finally {
        this.activeAbortControllers.delete(taskId);
        this.pendingUserResumes.delete(taskId);
        this.manualPauseHandlers.delete(taskId);
      }
    })();

    return taskId;
  }

  pauseTaskForUser(taskId: TaskId, instructions?: string): boolean {
    const handler = this.manualPauseHandlers.get(taskId);
    if (!handler) return false;
    handler(instructions);
    return true;
  }

  resolveApproval(approvalId: ApprovalId, decision: ApprovalDecision): boolean {
    const resolver = this.pendingApprovals.get(approvalId);
    if (!resolver) return false;
    resolver(decision);
    return true;
  }

  resumePausedTask(taskId: TaskId): boolean {
    const resolver = this.pendingUserResumes.get(taskId);
    if (!resolver) return false;
    resolver();
    return true;
  }

  cancelTask(taskId: TaskId): boolean {
    const controller = this.activeAbortControllers.get(taskId);
    if (!controller) return false;
    controller.abort();
    return true;
  }
}
