import {
  type ApprovalId,
  type ChatMessage,
  type ConversationId,
  type ConversationSummary,
  type DaemonEvent,
  type HarnessSettings,
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
  type TaskTraceEntry,
  type TrustPolicyMode,
  parseConversationId,
} from "@live-for-llm/protocol";
import { signal, type Signal } from "nsh";
import {
  type BrowserControlResult,
  type BrowserInteractPayload,
  type DaemonTransport,
  DEFAULT_HARNESS_SETTINGS,
  DEFAULT_MODEL_SETTINGS,
  EMPTY_SNAPSHOT,
  createDaemonTransport,
} from "./client";
import { t } from "./i18n.ts";

export type AppPage = "chat" | "settings" | "task_detail";
export type SettingsSection = "general" | "models" | "harness" | "memories";

export interface BrowserFrameSnapshot {
  readonly base64: string;
  readonly url: string;
  readonly capturedAt: string;
}

function generateConversationId(): ConversationId {
  const rand = Math.random().toString(16).slice(2, 10);
  const stamp = Date.now().toString(36).slice(-4);
  return parseConversationId(`conv_${stamp}${rand}`);
}

export interface CompanionUiStore {
  readonly baseUrl: Signal<string>;
  readonly authToken: Signal<string>;
  readonly connected: Signal<boolean>;
  readonly activePage: Signal<AppPage>;
  readonly settingsSection: Signal<SettingsSection>;
  readonly inspectedTaskId: Signal<TaskId | null>;
  readonly sidebarOpen: Signal<boolean>;
  readonly drawerOpen: Signal<boolean>;
  readonly browserWindowOpen: Signal<boolean>;
  readonly conversationId: Signal<ConversationId>;
  readonly conversations: Signal<readonly ConversationSummary[]>;
  readonly messages: Signal<readonly ChatMessage[]>;
  readonly streamingReply: Signal<string>;
  readonly memories: Signal<readonly MemoryRecord[]>;
  readonly relationship: Signal<RelationshipState>;
  readonly tasks: Signal<readonly TaskRecord[]>;
  readonly taskTraces: Signal<Record<string, readonly TaskTraceEntry[]>>;
  readonly browserFrames: Signal<Record<string, BrowserFrameSnapshot>>;
  readonly screenshots: Signal<Record<string, string>>;
  readonly policy: Signal<PolicyConfig>;
  readonly proactiveRules: Signal<readonly ProactiveRule[]>;
  readonly modelSettings: Signal<ModelSettingsSummary>;
  readonly harnessSettings: Signal<HarnessSettings>;
  readonly fetchedModels: Signal<readonly string[]>;
  readonly fetchingModels: Signal<boolean>;
  readonly statusBanner: Signal<string>;
  connect(options?: { readonly waitForBoot?: boolean }): void;
  disconnect(): void;
  switchConversation(nextId: ConversationId): Promise<boolean>;
  createConversation(title?: string): Promise<boolean>;
  renameConversation(id: ConversationId, title: string): Promise<boolean>;
  deleteConversation(id: ConversationId): Promise<boolean>;
  sendChat(text: string, ephemeralHint?: string): Promise<boolean>;
  recallMessage(messageId: MessageId): Promise<boolean>;
  deleteMessages(messageIds: readonly MessageId[]): Promise<boolean>;
  decideApproval(approvalId: ApprovalId, decision: "approved" | "denied"): Promise<void>;
  pauseBrowserTask(taskId: TaskId, instructions?: string): Promise<void>;
  resumeBrowserTask(taskId: TaskId): Promise<void>;
  interactBrowser(req: BrowserInteractPayload): Promise<BrowserControlResult | null>;
  openBrowserWindow(req: {
    readonly taskId?: string;
    readonly url?: string;
    readonly headless?: boolean;
  }): Promise<BrowserControlResult | null>;
  cancelTask(taskId: TaskId): Promise<void>;
  addMemory(draft: MemoryDraft): Promise<void>;
  deleteMemory(memoryId: MemoryId): Promise<void>;
  setPolicyMode(mode: TrustPolicyMode): Promise<void>;
  fetchModels(req: ModelFetchRequest): Promise<readonly string[] | null>;
  updateModelSettings(settings: ModelSettingsUpdate): Promise<boolean>;
  updateHarnessSettings(settings: HarnessSettings): Promise<boolean>;
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
  const initialConvId = parseConversationId(options?.initialConversationId ?? "conv_main");
  const conversationId = signal<ConversationId>(initialConvId);
  const conversations = signal<readonly ConversationSummary[]>([]);
  const baseUrl = signal(options?.initialUrl ?? "http://127.0.0.1:4777");
  const authToken = signal("");
  const connected = signal(false);
  const activePage = signal<AppPage>("chat");
  const settingsSection = signal<SettingsSection>("general");
  const inspectedTaskId = signal<TaskId | null>(null);
  const sidebarOpen = signal(true);
  const drawerOpen = signal(false);
  const browserWindowOpen = signal(false);
  const messages = signal<readonly ChatMessage[]>(EMPTY_SNAPSHOT.messages);
  const streamingReply = signal("");
  const memories = signal<readonly MemoryRecord[]>(EMPTY_SNAPSHOT.memories);
  const relationship = signal<RelationshipState>(EMPTY_SNAPSHOT.relationship);
  const tasks = signal<readonly TaskRecord[]>(EMPTY_SNAPSHOT.tasks);
  const taskTraces = signal<Record<string, readonly TaskTraceEntry[]>>({});
  const browserFrames = signal<Record<string, BrowserFrameSnapshot>>({});
  const screenshots = signal<Record<string, string>>({});
  const policy = signal<PolicyConfig>(EMPTY_SNAPSHOT.policy);
  const proactiveRules = signal<readonly ProactiveRule[]>(EMPTY_SNAPSHOT.proactiveRules);
  const modelSettings = signal<ModelSettingsSummary>(DEFAULT_MODEL_SETTINGS);
  const harnessSettings = signal<HarnessSettings>(DEFAULT_HARNESS_SETTINGS);
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

  let hasSyncedOnce = false;

  function applySnapshot(
    snap: Awaited<ReturnType<DaemonTransport["fetchState"]>>,
    adoptConversation = false,
  ): void {
    if (adoptConversation && snap.conversationId) {
      conversationId.set(snap.conversationId);
    }
    const activeId = conversationId();
    const list = snap.conversations && snap.conversations.length > 0
      ? snap.conversations
      : [
          {
            id: snap.conversationId ?? activeId,
            title: t("conversationDefaultTitle"),
            createdAt: "",
            updatedAt: "",
          },
        ];
    conversations.set(list);
    messages.set(snap.messages);
    memories.set(snap.memories);
    relationship.set(snap.relationship);
    tasks.set(snap.tasks);
    if (snap.taskTraces) {
      taskTraces.set(snap.taskTraces);
    }
    const seededShots: Record<string, string> = {};
    const seededFrames: Record<string, BrowserFrameSnapshot> = {};
    for (const task of snap.tasks) {
      if (task.state.kind === "running" && task.state.latestScreenshotBase64) {
        seededShots[task.id] = task.state.latestScreenshotBase64;
        seededFrames[task.id] = {
          base64: task.state.latestScreenshotBase64,
          url: task.state.latestUrl ?? "",
          capturedAt: task.updatedAt,
        };
      }
    }
    if (Object.keys(seededShots).length > 0) {
      screenshots.update((prev) => ({ ...seededShots, ...prev }));
      browserFrames.update((prev) => ({ ...seededFrames, ...prev }));
    }
    policy.set(snap.policy);
    proactiveRules.set(snap.proactiveRules);
    if (snap.modelSettings) {
      modelSettings.set(snap.modelSettings);
    }
    if (snap.harnessSettings) {
      harnessSettings.set(snap.harnessSettings);
    }
  }

  function applyEvent(event: DaemonEvent): void {
    switch (event.kind) {
      case "chat.delta":
        if (event.conversationId === conversationId()) {
          streamingReply.update((prev) => prev + event.delta);
        }
        return;
      case "chat.message":
      case "proactive.message":
        if (event.message.conversationId !== conversationId()) {
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
        if (event.conversationId === conversationId()) {
          messages.set(event.messages);
        }
        return;
      case "conversations.updated":
        conversations.set(event.conversations);
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
          const url = event.task.state.latestUrl ?? "";
          screenshots.update((prev) => ({ ...prev, [event.task.id]: shot }));
          browserFrames.update((prev) => ({
            ...prev,
            [event.task.id]: { base64: shot, url, capturedAt: event.task.updatedAt },
          }));
        }
        return;
      case "task.trace":
        taskTraces.update((prev) => {
          const list = prev[event.entry.taskId] ?? [];
          if (list.some((item) => item.id === event.entry.id)) return prev;
          return {
            ...prev,
            [event.entry.taskId]: [...list, event.entry].slice(-200),
          };
        });
        return;
      case "browser.screenshot":
        screenshots.update((prev) => ({
          ...prev,
          [event.taskId]: event.base64,
        }));
        browserFrames.update((prev) => ({
          ...prev,
          [event.taskId]: {
            base64: event.base64,
            url: event.url,
            capturedAt: event.capturedAt,
          },
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
      case "harness.updated":
        harnessSettings.set(event.settings);
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

  function syncSnapshot(seq: number, retriesRemaining = 0): void {
    if (retryTimer !== undefined) {
      clearTimeout(retryTimer);
      retryTimer = undefined;
    }
    void transport
      .fetchState(conversationId())
      .then((snap) => {
        if (seq !== connectSeq) return;
        const isFirstSync = !hasSyncedOnce;
        hasSyncedOnce = true;
        applySnapshot(snap, isFirstSync);
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
    inspectedTaskId,
    sidebarOpen,
    drawerOpen,
    browserWindowOpen,
    conversationId,
    conversations,
    messages,
    streamingReply,
    memories,
    relationship,
    tasks,
    taskTraces,
    browserFrames,
    screenshots,
    policy,
    proactiveRules,
    modelSettings,
    harnessSettings,
    fetchedModels,
    fetchingModels,
    statusBanner,
    connect,
    disconnect,
    async switchConversation(nextId: ConversationId): Promise<boolean> {
      conversationId.set(nextId);
      streamingReply.set("");
      activePage.set("chat");
      return runAction(async () => {
        const snap = await transport.fetchState(nextId);
        applySnapshot(snap);
      });
    },
    async createConversation(title?: string): Promise<boolean> {
      const nextId = generateConversationId();
      const resolvedTitle = title?.trim() || t("conversationDefaultTitle");
      const now = new Date().toISOString();
      conversationId.set(nextId);
      streamingReply.set("");
      messages.set([]);
      activePage.set("chat");
      conversations.update((prev) => [
        { id: nextId, title: resolvedTitle, createdAt: now, updatedAt: now },
        ...prev,
      ]);
      return runAction(async () => {
        await transport.sendCommand({
          kind: "conversation.create",
          conversationId: nextId,
          title: resolvedTitle,
        });
      });
    },
    async renameConversation(id: ConversationId, title: string): Promise<boolean> {
      const trimmed = title.trim();
      if (!trimmed) return false;
      conversations.update((prev) =>
        prev.map((c) => (c.id === id ? { ...c, title: trimmed } : c)),
      );
      return runAction(async () => {
        await transport.sendCommand({
          kind: "conversation.rename",
          conversationId: id,
          title: trimmed,
        });
      });
    },
    async deleteConversation(id: ConversationId): Promise<boolean> {
      const remaining = conversations().filter((c) => c.id !== id);
      conversations.set(remaining);
      const ok = await runAction(async () => {
        await transport.sendCommand({
          kind: "conversation.delete",
          conversationId: id,
        });
      });
      if (!ok) return false;
      if (conversationId() === id) {
        const next = remaining[0];
        if (next) {
          await this.switchConversation(next.id);
        } else {
          await this.createConversation();
        }
      }
      return true;
    },
    async sendChat(text: string, ephemeralHint?: string): Promise<boolean> {
      const trimmed = text.trim();
      if (!trimmed) return false;
      const hint = ephemeralHint?.trim();
      const targetConv = conversationId();
      return runAction(async () => {
        await transport.sendCommand({
          kind: "chat.send",
          conversationId: targetConv,
          content: trimmed,
          ...(hint ? { ephemeralHint: hint } : {}),
        });
      });
    },
    async recallMessage(messageId: MessageId): Promise<boolean> {
      const target = messages().find((m) => m.id === messageId);
      if (!target || target.role !== "user") {
        return false;
      }
      const targetConv = conversationId();
      return runAction(async () => {
        await transport.sendCommand({
          kind: "chat.recall",
          conversationId: targetConv,
          messageId,
          by: "user",
        });
        messages.update((prev) =>
          prev.map((m) =>
            m.id === messageId ? { ...m, content: "", recalled: true, recalledBy: "user" } : m,
          ),
        );
      });
    },
    async deleteMessages(messageIds: readonly MessageId[]): Promise<boolean> {
      if (messageIds.length === 0) return true;
      const targetConv = conversationId();
      return runAction(async () => {
        await transport.sendCommand({
          kind: "chat.delete",
          conversationId: targetConv,
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
    async pauseBrowserTask(taskId: TaskId, instructions?: string) {
      await runAction(async () => {
        await transport.sendCommand({
          kind: "task.pause_user",
          taskId,
          ...(instructions ? { instructions } : {}),
        });
      });
    },
    async resumeBrowserTask(taskId: TaskId) {
      await runAction(async () => {
        await transport.sendCommand({ kind: "browser.resume_user", taskId });
        statusBanner.set("");
      });
    },
    async interactBrowser(req: BrowserInteractPayload): Promise<BrowserControlResult | null> {
      let out: BrowserControlResult | null = null;
      await runAction(async () => {
        const res = await transport.interactBrowser(req);
        if (typeof res.headless === "boolean") {
          browserWindowOpen.set(!res.headless);
        }
        if (req.taskId && res.screenshotBase64) {
          const shot = res.screenshotBase64;
          const capturedAt = res.capturedAt ?? new Date().toISOString();
          browserFrames.update((prev) => ({
            ...prev,
            [req.taskId!]: { base64: shot, url: res.url, capturedAt },
          }));
          screenshots.update((prev) => ({ ...prev, [req.taskId!]: shot }));
        }
        out = res;
      });
      return out;
    },
    async openBrowserWindow(req: {
      readonly taskId?: string;
      readonly url?: string;
      readonly headless?: boolean;
    }): Promise<BrowserControlResult | null> {
      let out: BrowserControlResult | null = null;
      await runAction(async () => {
        const res = await transport.openBrowserWindow(req);
        if (typeof res.headless === "boolean") {
          browserWindowOpen.set(!res.headless);
        }
        if (req.taskId && res.screenshotBase64) {
          const shot = res.screenshotBase64;
          const capturedAt = res.capturedAt ?? new Date().toISOString();
          browserFrames.update((prev) => ({
            ...prev,
            [req.taskId!]: { base64: shot, url: res.url, capturedAt },
          }));
          screenshots.update((prev) => ({ ...prev, [req.taskId!]: shot }));
        }
        out = res;
      });
      return out;
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
    async updateHarnessSettings(settings: HarnessSettings): Promise<boolean> {
      return runAction(async () => {
        await transport.sendCommand({ kind: "harness.update", settings });
        harnessSettings.set(settings);
        statusBanner.set(t("statusHarnessSaved"));
      });
    },
    async updateRelationship(patch: RelationshipUpdate): Promise<boolean> {
      return runAction(async () => {
        await transport.sendCommand({ kind: "relationship.update", patch });
        relationship.update((prev) => {
          const next: RelationshipState = {
            ...prev,
            ...(patch.companionName ? { companionName: patch.companionName } : {}),
            ...(patch.userName ? { userName: patch.userName } : {}),
            ...(patch.currentMood ? { currentMood: patch.currentMood } : {}),
          };
          if (patch.companionAvatar !== undefined) {
            if (patch.companionAvatar) {
              return { ...next, companionAvatar: patch.companionAvatar };
            }
            const { companionAvatar: _removed, ...rest } = next;
            return rest;
          }
          return next;
        });
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
        const snap = await transport.fetchState(conversationId());
        memories.set(snap.memories);
      });
    },
  };
}
