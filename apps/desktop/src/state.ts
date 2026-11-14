import {
  type ApprovalId,
  type ChatMessage,
  type ConversationId,
  type DaemonEvent,
  type MemoryDraft,
  type MemoryId,
  type MemoryRecord,
  type MessageId,
  type ModelFetchRequest,
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
import { t } from "./i18n.ts";

export type AppPage = "chat" | "settings";
export type SettingsSection = "models" | "memories" | "general";

export interface CompanionUiStore {
  readonly baseUrl: Signal<string>;
  readonly authToken: Signal<string>;
  readonly connected: Signal<boolean>;
  readonly activePage: Signal<AppPage>;
  readonly settingsSection: Signal<SettingsSection>;
  readonly drawerOpen: Signal<boolean>;
  readonly messages: Signal<readonly ChatMessage[]>;
  readonly streamingReply: Signal<string>;
  readonly memories: Signal<readonly MemoryRecord[]>;
  readonly relationship: Signal<RelationshipState>;
  readonly tasks: Signal<readonly TaskRecord[]>;
  readonly screenshots: Signal<Record<string, string>>;
  readonly policy: Signal<PolicyConfig>;
  readonly proactiveRules: Signal<readonly ProactiveRule[]>;
  readonly modelSettings: Signal<ModelSettingsSummary>;
  readonly fetchedModels: Signal<readonly string[]>;
  readonly fetchingModels: Signal<boolean>;
  readonly statusBanner: Signal<string>;
  connect(options?: { readonly waitForBoot?: boolean }): void;
  disconnect(): void;
  sendChat(text: string): Promise<boolean>;
  recallMessage(messageId: MessageId): Promise<boolean>;
  deleteMessages(messageIds: readonly MessageId[]): Promise<boolean>;
  decideApproval(approvalId: ApprovalId, decision: "approved" | "denied"): Promise<void>;
  resumeBrowserTask(taskId: TaskId): Promise<void>;
  cancelTask(taskId: TaskId): Promise<void>;
  addMemory(draft: MemoryDraft): Promise<void>;
  deleteMemory(memoryId: MemoryId): Promise<void>;
  setPolicyMode(mode: TrustPolicyMode): Promise<void>;
  fetchModels(req: ModelFetchRequest): Promise<readonly string[] | null>;
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
  const activePage = signal<AppPage>("chat");
  const settingsSection = signal<SettingsSection>("models");
  const drawerOpen = signal(true);
  const messages = signal<readonly ChatMessage[]>(EMPTY_SNAPSHOT.messages);
  const streamingReply = signal("");
  const memories = signal<readonly MemoryRecord[]>(EMPTY_SNAPSHOT.memories);
  const relationship = signal<RelationshipState>(EMPTY_SNAPSHOT.relationship);
  const tasks = signal<readonly TaskRecord[]>(EMPTY_SNAPSHOT.tasks);
  const screenshots = signal<Record<string, string>>({});
  const policy = signal<PolicyConfig>(EMPTY_SNAPSHOT.policy);
  const proactiveRules = signal<readonly ProactiveRule[]>(EMPTY_SNAPSHOT.proactiveRules);
  const modelSettings = signal<ModelSettingsSummary>(DEFAULT_MODEL_SETTINGS);
  const fetchedModels = signal<readonly string[]>([]);
  const fetchingModels = signal(false);
  const statusBanner = signal("");

  const makeTransport = options?.transportFactory ?? createDaemonTransport;
  let transport = makeTransport({
    baseUrl: baseUrl(),
    ...(authToken().trim() ? { authToken: authToken().trim() } : {}),
  });
  let closeEvents: (() => void) | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let connectSeq = 0;

  async function runAction(action: () => Promise<void>): Promise<boolean> {
    try {
      await action();
      return true;
    } catch (err) {
      statusBanner.set(
        t("statusOpFailed", { err: err instanceof Error ? err.message : String(err) }),
      );
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
      case "chat.updated":
        if (event.conversationId === conversationId) {
          messages.set(event.messages);
        }
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
        statusBanner.set(t("attentionApproval", { summary: event.approval.actionSummary }));
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
        statusBanner.set(`${event.code}: ${event.message}`);
        return;
      default: {
        const _exhaustive: never = event;
        return _exhaustive;
      }
    }
  }

  function disconnect(): void {
    connectSeq += 1;
    if (retryTimer !== undefined) {
      clearTimeout(retryTimer);
      retryTimer = undefined;
    }
    closeEvents?.();
    closeEvents = undefined;
    connected.set(false);
  }

  let hasSyncedOnce = false;

  function syncSnapshot(seq: number, retriesRemaining = 0): void {
    if (retryTimer !== undefined) {
      clearTimeout(retryTimer);
      retryTimer = undefined;
    }
    void transport
      .fetchState(conversationId)
      .then((snap) => {
        if (seq !== connectSeq) return;
        hasSyncedOnce = true;
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
        if (retriesRemaining > 0) {
          statusBanner.set(t("statusWaking"));
          retryTimer = setTimeout(() => {
            retryTimer = undefined;
            if (seq === connectSeq) {
              syncSnapshot(seq, retriesRemaining - 1);
            }
          }, 250);
          return;
        }
        statusBanner.set(
          t("statusUnreachable", { err: err instanceof Error ? err.message : String(err) }),
        );
      });
  }

  function connect(options?: { readonly waitForBoot?: boolean }): void {
    disconnect();
    hasSyncedOnce = false;
    const seq = ++connectSeq;
    transport = makeTransport({
      baseUrl: baseUrl(),
      ...(authToken().trim() ? { authToken: authToken().trim() } : {}),
    });

    syncSnapshot(seq, options?.waitForBoot ? 24 : 0);

    let hasConnectedOnce = false;
    closeEvents = transport.connectEvents(applyEvent, (isUp) => {
      if (seq !== connectSeq) return;
      const wasUp = connected();
      connected.set(isUp);
      if (isUp) {
        if (!hasSyncedOnce || (hasConnectedOnce && !wasUp)) {
          syncSnapshot(seq, 0);
        }
        hasConnectedOnce = true;
      }
    });
  }

  return {
    baseUrl,
    authToken,
    connected,
    activePage,
    settingsSection,
    drawerOpen,
    messages,
    streamingReply,
    memories,
    relationship,
    tasks,
    screenshots,
    policy,
    proactiveRules,
    modelSettings,
    fetchedModels,
    fetchingModels,
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
    async recallMessage(messageId: MessageId): Promise<boolean> {
      return runAction(async () => {
        const target = messages().find((m) => m.id === messageId);
        const by = target?.role === "companion" ? "companion" : "user";
        await transport.sendCommand({
          kind: "chat.recall",
          conversationId,
          messageId,
          by,
        });
        messages.update((prev) =>
          prev.map((m) =>
            m.id === messageId ? { ...m, content: "", recalled: true, recalledBy: by } : m,
          ),
        );
      });
    },
    async deleteMessages(messageIds: readonly MessageId[]): Promise<boolean> {
      if (messageIds.length === 0) return true;
      return runAction(async () => {
        await transport.sendCommand({
          kind: "chat.delete",
          conversationId,
          messageIds,
        });
        const removeSet = new Set(messageIds);
        messages.update((prev) => prev.filter((m) => !removeSet.has(m.id)));
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
    async fetchModels(req: ModelFetchRequest): Promise<readonly string[] | null> {
      fetchingModels.set(true);
      try {
        const res = await transport.fetchModels(req);
        fetchedModels.set(res.models);
        statusBanner.set(
          res.models.length > 0
            ? t("statusModelsFetched", { count: res.models.length })
            : t("statusModelsFetchEmpty"),
        );
        return res.models;
      } catch (err) {
        statusBanner.set(
          t("statusOpFailed", { err: err instanceof Error ? err.message : String(err) }),
        );
        return null;
      } finally {
        fetchingModels.set(false);
      }
    },
    async updateModelSettings(settings: ModelSettingsUpdate): Promise<boolean> {
      return runAction(async () => {
        await transport.sendCommand({ kind: "models.update", settings });
        statusBanner.set(t("statusModelsSaved"));
      });
    },
    async updateRelationship(patch: RelationshipUpdate): Promise<boolean> {
      return runAction(async () => {
        await transport.sendCommand({ kind: "relationship.update", patch });
        statusBanner.set(t("statusPersonaSaved"));
      });
    },
    async exportMarkdown() {
      await runAction(async () => {
        const res = await transport.exportMemories();
        statusBanner.set(t("statusExported", { count: res.files.length }));
      });
    },
    async importMarkdown() {
      await runAction(async () => {
        const res = await transport.importMemories();
        statusBanner.set(t("statusImported", { count: res.imported }));
        const snap = await transport.fetchState(conversationId);
        memories.set(snap.memories);
      });
    },
  };
}
