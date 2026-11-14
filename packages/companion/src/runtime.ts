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
  private readonly activeAbortControllers = new Map<TaskId, AbortController>();
  private readonly pendingApprovals = new Map<
    ApprovalId,
    (decision: ApprovalDecision) => void
  >();
  private readonly pendingUserResumes = new Map<TaskId, () => void>();

  constructor(params: {
    readonly router: ModelRouter;
    readonly store: MemoryStore;
    readonly runners: TaskRunnerRegistry;
    readonly emit: (event: DaemonEvent) => void;
    readonly enableEmbeddings?: boolean;
  }) {
    this.router = params.router;
    this.store = params.store;
    this.runners = params.runners;
    this.emit = params.emit;
    this.enableEmbeddings = params.enableEmbeddings ?? false;
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
    const runner = this.runners.resolve({
      ...(params.runnerId ? { runnerId: params.runnerId } : {}),
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

    const abortController = new AbortController();
    this.activeAbortControllers.set(taskId, abortController);

    void (async () => {
      commitTask({
        kind: "running",
        startedAt: new Date().toISOString(),
        stepSummary: `Starting ${runner.label}`,
      });

      try {
        const outcome = await runner.run({
          taskId,
          conversationId: params.conversationId,
          taskKind: params.taskKind,
          goal: params.goal,
          signal: abortController.signal,
          reportProgress: (stepSummary, screenshotBase64) => {
            commitTask({
              kind: "running",
              startedAt:
                current.state.kind === "running"
                  ? current.state.startedAt
                  : new Date().toISOString(),
              stepSummary,
              ...(screenshotBase64 ? { latestScreenshotBase64: screenshotBase64 } : {}),
            });
            if (screenshotBase64) {
              this.emit({
                kind: "browser.screenshot",
                taskId,
                mimeType: "image/jpeg",
                base64: screenshotBase64,
                url: "",
                capturedAt: new Date().toISOString(),
              });
            }
          },
          requestApproval: (req) =>
            new Promise<ApprovalDecision>((resolve) => {
              const approvalId = parseApprovalId(newId("appr"));
              const requestedAt = new Date().toISOString();
              this.pendingApprovals.set(approvalId, (decision) => {
                this.pendingApprovals.delete(approvalId);
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
                resolve();
              });
              commitTask({
                kind: "paused_for_user",
                reason: req.reason,
                instructions: req.instructions,
                pausedAt: new Date().toISOString(),
              });
            }),
        });

        if (outcome.kind === "completed") {
          commitTask({
            kind: "completed",
            summary: outcome.summary,
            completedAt: new Date().toISOString(),
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
        } else {
          commitTask({
            kind: "failed",
            error: outcome.error,
            failedAt: new Date().toISOString(),
          });
        }
      } catch (err) {
        commitTask({
          kind: "failed",
          error: err instanceof Error ? err.message : String(err),
          failedAt: new Date().toISOString(),
        });
      } finally {
        this.activeAbortControllers.delete(taskId);
        this.pendingUserResumes.delete(taskId);
      }
    })();

    return taskId;
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
