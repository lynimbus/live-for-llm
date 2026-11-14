import {
  type ApprovalId,
  type ChatMessage,
  type ConversationId,
  type DaemonEvent,
  type MemoryDraft,
  type MemoryId,
  type MemoryRecord,
  type ModelSettingsSummary,
  type ModelSettingsUpdate,
  type PolicyConfig,
  type ProactiveRule,
  type RelationshipState,
  type RelationshipUpdate,
  type TaskId,
  type TaskRecord,
  type TrustPolicyMode,
  parseConversationId,
} from "@live-for-llm/protocol";
import { signal, type Signal } from "nsh";
import {
  type DaemonTransport,
  DEFAULT_MODEL_SETTINGS,
  EMPTY_SNAPSHOT,
  createDaemonTransport,
} from "./client";

export type DrawerTab = "tasks" | "memories" | "settings";

export interface CompanionUiStore {
  readonly baseUrl: Signal<string>;
  readonly authToken: Signal<string>;
  readonly connected: Signal<boolean>;
  readonly drawerOpen: Signal<boolean>;
  readonly activeTab: Signal<DrawerTab>;
  readonly messages: Signal<readonly ChatMessage[]>;
  readonly streamingReply: Signal<string>;
  readonly memories: Signal<readonly MemoryRecord[]>;
  readonly relationship: Signal<RelationshipState>;
  readonly tasks: Signal<readonly TaskRecord[]>;
  readonly screenshots: Signal<Record<string, string>>;
  readonly policy: Signal<PolicyConfig>;
  readonly proactiveRules: Signal<readonly ProactiveRule[]>;
  readonly modelSettings: Signal<ModelSettingsSummary>;
  readonly statusBanner: Signal<string>;
  connect(): void;
  disconnect(): void;
  sendChat(text: string): Promise<boolean>;
  decideApproval(approvalId: ApprovalId, decision: "approved" | "denied"): Promise<void>;
  resumeBrowserTask(taskId: TaskId): Promise<void>;
  cancelTask(taskId: TaskId): Promise<void>;
  addMemory(draft: MemoryDraft): Promise<void>;
  deleteMemory(memoryId: MemoryId): Promise<void>;
  setPolicyMode(mode: TrustPolicyMode): Promise<void>;
  updateModelSettings(settings: ModelSettingsUpdate): Promise<boolean>;
  updateRelationship(patch: RelationshipUpdate): Promise<boolean>;
  exportMarkdown(): Promise<void>;
  importMarkdown(): Promise<void>;
}

/** Creates the reactive signal store driving the nsh desktop UI. */
export function createCompanionUiStore(options?: {
  readonly initialUrl?: string;
  readonly initialConversationId?: string;
  readonly transportFactory?: (params: {
    readonly baseUrl: string;
    readonly authToken?: string;
  }) => DaemonTransport;
}): CompanionUiStore {
  const conversationId: ConversationId = parseConversationId(
    options?.initialConversationId ?? "conv_main",
  );
  const baseUrl = signal(options?.initialUrl ?? "http://127.0.0.1:4777");
  const authToken = signal("");
  const connected = signal(false);
  const drawerOpen = signal(true);
  const activeTab = signal<DrawerTab>("tasks");
  const messages = signal<readonly ChatMessage[]>(EMPTY_SNAPSHOT.messages);
  const streamingReply = signal("");
  const memories = signal<readonly MemoryRecord[]>(EMPTY_SNAPSHOT.memories);
  const relationship = signal<RelationshipState>(EMPTY_SNAPSHOT.relationship);
  const tasks = signal<readonly TaskRecord[]>(EMPTY_SNAPSHOT.tasks);
  const screenshots = signal<Record<string, string>>({});
  const policy = signal<PolicyConfig>(EMPTY_SNAPSHOT.policy);
  const proactiveRules = signal<readonly ProactiveRule[]>(EMPTY_SNAPSHOT.proactiveRules);
  const modelSettings = signal<ModelSettingsSummary>(DEFAULT_MODEL_SETTINGS);
  const statusBanner = signal("");

  const makeTransport = options?.transportFactory ?? createDaemonTransport;
  let transport = makeTransport({
    baseUrl: baseUrl(),
    ...(authToken().trim() ? { authToken: authToken().trim() } : {}),
  });
  let closeEvents: (() => void) | undefined;
  let connectSeq = 0;

  async function runAction(action: () => Promise<void>): Promise<boolean> {
    try {
      await action();
      return true;
    } catch (err) {
      statusBanner.set(`操作失败: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  function applyEvent(event: DaemonEvent): void {
    switch (event.kind) {
      case "chat.delta":
        if (event.conversationId === conversationId) {
          streamingReply.update((prev) => prev + event.delta);
        }
        return;
      case "chat.message":
      case "proactive.message":
        if (event.message.conversationId !== conversationId) {
          return;
        }
        if (event.message.role === "companion") {
          streamingReply.set("");
        }
        messages.update((prev) =>
          prev.some((m) => m.id === event.message.id) ? prev : [...prev, event.message],
        );
        return;
      case "task.updated":
        tasks.update((prev) => {
          const rest = prev.filter((t) => t.id !== event.task.id);
          return [event.task, ...rest];
        });
        if (
          event.task.state.kind === "running" &&
          event.task.state.latestScreenshotBase64
        ) {
          const shot = event.task.state.latestScreenshotBase64;
          screenshots.update((prev) => ({ ...prev, [event.task.id]: shot }));
        } else if (
          event.task.state.kind === "completed" ||
          event.task.state.kind === "failed" ||
          event.task.state.kind === "cancelled"
        ) {
          screenshots.update((prev) => {
            if (!(event.task.id in prev)) return prev;
            const next = { ...prev };
            delete next[event.task.id];
            return next;
          });
        }
        return;
      case "browser.screenshot":
        screenshots.update((prev) => ({
          ...prev,
          [event.taskId]: event.base64,
        }));
        return;
      case "approval.requested":
        statusBanner.set(`需要确认: ${event.approval.actionSummary}`);
        return;
      case "memory.updated":
        if (event.replaced) {
          memories.set(event.records);
          return;
        }
        memories.update((prev) => {
          const byId = new Map(prev.map((m) => [m.id, m]));
          for (const rec of event.records) {
            byId.set(rec.id, rec);
          }
          return Array.from(byId.values());
        });
        return;
      case "policy.updated":
        policy.set(event.policy);
        return;
      case "models.updated":
        modelSettings.set(event.settings);
        return;
      case "relationship.updated":
        relationship.set(event.relationship);
        return;
      case "pong":
        return;
      case "error":
        statusBanner.set(`错误 (${event.code}): ${event.message}`);
        return;
      default: {
        const _exhaustive: never = event;
        return _exhaustive;
      }
    }
  }

  function disconnect(): void {
    connectSeq += 1;
    closeEvents?.();
    closeEvents = undefined;
    connected.set(false);
  }

  function syncSnapshot(seq: number): void {
    void transport
      .fetchState(conversationId)
      .then((snap) => {
        if (seq !== connectSeq) return;
        messages.set(snap.messages);
        memories.set(snap.memories);
        relationship.set(snap.relationship);
        tasks.set(snap.tasks);
        policy.set(snap.policy);
        proactiveRules.set(snap.proactiveRules);
        if (snap.modelSettings) {
          modelSettings.set(snap.modelSettings);
        }
        statusBanner.set("");
      })
      .catch((err) => {
        if (seq !== connectSeq) return;
        statusBanner.set(`无法连接后端: ${err instanceof Error ? err.message : String(err)}`);
      });
  }

  function connect(): void {
    disconnect();
    const seq = ++connectSeq;
    transport = makeTransport({
      baseUrl: baseUrl(),
      ...(authToken().trim() ? { authToken: authToken().trim() } : {}),
    });

    syncSnapshot(seq);

    let hasConnectedOnce = false;
    closeEvents = transport.connectEvents(applyEvent, (isUp) => {
      if (seq !== connectSeq) return;
      const wasUp = connected();
      connected.set(isUp);
      if (isUp) {
        if (hasConnectedOnce && !wasUp) {
          syncSnapshot(seq);
        }
        hasConnectedOnce = true;
      }
    });
  }

  return {
    baseUrl,
    authToken,
    connected,
    drawerOpen,
    activeTab,
    messages,
    streamingReply,
    memories,
    relationship,
    tasks,
    screenshots,
    policy,
    proactiveRules,
    modelSettings,
    statusBanner,
    connect,
    disconnect,
    async sendChat(text: string): Promise<boolean> {
      const trimmed = text.trim();
      if (!trimmed) return false;
      return runAction(async () => {
        await transport.sendCommand({
          kind: "chat.send",
          conversationId,
          content: trimmed,
        });
      });
    },
    async decideApproval(approvalId: ApprovalId, decision: "approved" | "denied") {
      await runAction(async () => {
        await transport.sendCommand({
          kind: "approval.decide",
          approvalId,
          decision,
        });
        statusBanner.set("");
      });
    },
    async resumeBrowserTask(taskId: TaskId) {
      await runAction(async () => {
        await transport.sendCommand({ kind: "browser.resume_user", taskId });
        statusBanner.set("");
      });
    },
    async cancelTask(taskId: TaskId) {
      await runAction(async () => {
        await transport.sendCommand({ kind: "task.cancel", taskId });
      });
    },
    async addMemory(draft: MemoryDraft) {
      await runAction(async () => {
        await transport.sendCommand({ kind: "memory.upsert", draft });
      });
    },
    async deleteMemory(memoryId: MemoryId) {
      await runAction(async () => {
        await transport.sendCommand({ kind: "memory.delete", memoryId });
        memories.update((prev) => prev.filter((m) => m.id !== memoryId));
      });
    },
    async setPolicyMode(mode: TrustPolicyMode) {
      await runAction(async () => {
        const next: PolicyConfig = { ...policy(), mode };
        await transport.sendCommand({ kind: "policy.update", policy: next });
        policy.set(next);
      });
    },
    async updateModelSettings(settings: ModelSettingsUpdate): Promise<boolean> {
      return runAction(async () => {
        await transport.sendCommand({ kind: "models.update", settings });
        statusBanner.set("API 与模型配置已保存并生效");
      });
    },
    async updateRelationship(patch: RelationshipUpdate): Promise<boolean> {
      return runAction(async () => {
        await transport.sendCommand({ kind: "relationship.update", patch });
        statusBanner.set("伙伴档案已更新");
      });
    },
    async exportMarkdown() {
      await runAction(async () => {
        const res = await transport.exportMemories();
        statusBanner.set(`已导出 ${res.files.length} 个 Markdown 文件`);
      });
    },
    async importMarkdown() {
      await runAction(async () => {
        const res = await transport.importMemories();
        statusBanner.set(`已同步 ${res.imported} 条 Markdown 修改`);
        const snap = await transport.fetchState(conversationId);
        memories.set(snap.memories);
      });
    },
  };
}
