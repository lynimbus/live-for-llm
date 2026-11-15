import type { ChatMessage, MessageId, TaskRecord } from "@live-for-llm/protocol";
import { DaemonDefaults, DaemonSidecar, SessionMetrics } from "companiondesktop/native";
import {
  cleanup,
  Clipboard,
  effect,
  host,
  mount,
  Scroll,
  type ScrollRef,
  signal,
  Text,
  View,
} from "nsh";
import { Button, Input, TextView } from "nsh/base";
import { Menu, Window } from "nsh/desktop";
import { currentLocale, loadPersistedLocale, t } from "./src/i18n.ts";
import { NewChatIcon, SendArrowIcon, SidebarIcon, TasksIcon } from "./src/icons.tsx";
import {
  animateLayout,
  BUTTON_ACTIVE_STYLE,
  BUTTON_MOTION_STYLE,
  createEnterMotion,
} from "./src/motion.ts";
import { SessionsSidebar } from "./src/SessionsSidebar.tsx";
import { SettingsPage } from "./src/SettingsPage.tsx";
import {
  createCompanionUiStore,
  type CompanionUiStore,
  type SettingsSection,
} from "./src/state.ts";
import { TaskDetailView } from "./src/TaskDetailView.tsx";
import { TasksSidebar } from "./src/TasksSidebar.tsx";
import { CompanionAvatar } from "./src/ui.tsx";

export interface AppProps {
  readonly store?: CompanionUiStore;
}

function getStarterPrompts(): readonly string[] {
  if (currentLocale() === "en-US") {
    return [
      "Hey, how's your day going?",
      "Help me figure out what to eat tonight.",
      "Anything fun or interesting going on online today?",
    ];
  }
  return [
    "今天过得怎么样？陪我随便聊聊",
    "晚上不知道吃啥，帮我想几个点子",
    "最近有什么有意思的新鲜事？",
  ];
}

function readHostString(key: string): string | undefined {
  const value = host.params[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readHostBoolean(key: string): boolean | undefined {
  const value = host.params[key];
  return typeof value === "boolean" ? value : undefined;
}

function findAttentionTask(tasks: readonly TaskRecord[]): TaskRecord | undefined {
  return tasks.find(
    (task) => task.state.kind === "awaiting_approval" || task.state.kind === "paused_for_user",
  );
}

function describeAttentionTask(task: TaskRecord): string {
  switch (task.state.kind) {
    case "awaiting_approval":
      return t("attentionApproval", { summary: task.state.actionSummary });
    case "paused_for_user":
      return t("attentionPaused", { instructions: task.state.instructions });
    default:
      return task.title;
  }
}

async function copyText(store: CompanionUiStore, text: string): Promise<void> {
  if (!text) return;
  try {
    await Clipboard.writeText(text);
    store.statusBanner.set(t("statusCopied"));
  } catch {
    // Ignore clipboard unavailability in headless tests.
  }
}

function MarkdownContent(props: {
  readonly content: () => string;
  readonly streaming?: boolean;
}) {
  return (
    <TextView
      markdown={props.content()}
      selectable
      links="open"
      options={props.streaming ? { streaming: true } : undefined}
      classes={{
        root: "text-sm text-foreground",
        paragraph: "text-sm text-foreground",
        heading1: "text-base font-bold text-foreground",
        heading2: "text-sm font-bold text-foreground",
        heading3: "text-sm font-semibold text-foreground",
        code: "font-mono text-xs bg-muted px-1 py-0.5 rounded text-foreground",
        codeBlock: "rounded-xl bg-card p-3 border border-border",
        codeBlockCode: "font-mono text-xs text-foreground",
        blockquote: "border-l-2 border-muted-foreground pl-3 text-muted-foreground",
        link: "text-foreground underline",
      }}
      styles={{
        root: { lineHeight: 22 },
        paragraph: { lineHeight: 22 },
      }}
    />
  );
}

function ChatBubble(props: {
  readonly message: () => ChatMessage;
  readonly companionName: () => string;
  readonly companionAvatar: () => string | undefined;
  readonly companionInitial: () => string;
  readonly selectionMode: () => boolean;
  readonly selected: () => boolean;
  readonly onToggleSelect: (id: MessageId) => void;
  readonly onEnterSelection: (id: MessageId) => void;
  readonly onRecall: (id: MessageId) => void;
  readonly onDelete: (id: MessageId) => void;
  readonly onCopy: (text: string) => void;
}) {
  const bubbleMotion = createEnterMotion("fadeInUp", 150);
  const msg = () => props.message();
  const isUser = () => msg().role === "user";

  if (msg().recalled) {
    const recalledLabel =
      msg().recalledBy === "companion"
        ? t("recalledByCompanion", { name: props.companionName() })
        : t("recalledByUser");
    return (
      <View
        testID={`recalled-${msg().id}`}
        style={[bubbleMotion.style, { alignSelf: "center", paddingVertical: 4 }]}
      >
        <View class="px-3 py-1 rounded-full bg-secondary border border-border">
          <Text class="text-[11px] text-muted-foreground">{recalledLabel}</Text>
        </View>
      </View>
    );
  }

  const openBubbleMenu = (pagePosition: { x: number; y: number }) => {
    const items: Parameters<typeof Menu.popup>[0] = [
      { label: t("btnCopy"), onSelect: () => props.onCopy(msg().content) },
      { label: t("btnMultiSelect"), onSelect: () => props.onEnterSelection(msg().id) },
      { type: "separator" },
      ...(isUser()
        ? [{ label: t("btnRecall"), onSelect: () => props.onRecall(msg().id) }]
        : []),
      { label: t("btnDelete"), onSelect: () => props.onDelete(msg().id) },
    ];
    void Menu.popup(items, pagePosition);
  };

  return (
    <View
      testID={`msg-row-${msg().id}`}
      style={[
        bubbleMotion.style,
        {
          flexDirection: "row",
          alignItems: "flex-start",
          justifyContent: isUser() ? "flex-end" : "flex-start",
          gap: 10,
          width: "100%",
        },
      ]}
    >
      <If when={props.selectionMode()}>
        <Button
          testID={`select-check-${msg().id}`}
          onPress={() => props.onToggleSelect(msg().id)}
          class={
            props.selected()
              ? "px-2 py-1 rounded-md bg-primary border border-primary"
              : "px-2 py-1 rounded-md bg-secondary border border-border"
          }
          style={[BUTTON_MOTION_STYLE, { alignSelf: "center" }]}
          activeStyle={BUTTON_ACTIVE_STYLE}
        >
          <Text
            class={
              props.selected()
                ? "text-xs font-bold text-primary-foreground"
                : "text-xs text-muted-foreground"
            }
          >
            {props.selected() ? "✓" : "○"}
          </Text>
        </Button>
      </If>

      <If
        when={isUser()}
        else={
          <View
            testID={`msg-bubble-${msg().id}`}
            onContextMenu={(e) => openBubbleMenu(e.pagePosition)}
            onPress={
              props.selectionMode() ? () => props.onToggleSelect(msg().id) : undefined
            }
            class={
              props.selected()
                ? "px-3 py-2 rounded-2xl bg-secondary border border-primary"
                : "py-1 rounded-2xl"
            }
            style={{
              flex: 1,
              minWidth: 0,
              flexDirection: "row",
              alignItems: "flex-start",
              gap: 12,
            }}
          >
            <View style={{ marginTop: 2 }}>
              <CompanionAvatar
                avatarSrc={props.companionAvatar}
                initial={props.companionInitial}
                size={26}
                class="bg-card border border-border"
                textClass="text-[11px] font-bold text-foreground"
              />
            </View>
            <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
              <If when={msg().proactive || msg().role === "system"}>
                <Text class="text-[11px] font-medium text-muted-foreground">
                  {msg().role === "system"
                    ? t("systemSender")
                    : t("proactiveBadge", { name: props.companionName() })}
                </Text>
              </If>
              <MarkdownContent content={() => msg().content} />
            </View>
          </View>
        }
      >
        <View
          testID={`msg-bubble-${msg().id}`}
          onContextMenu={(e) => openBubbleMenu(e.pagePosition)}
          onPress={
            props.selectionMode() ? () => props.onToggleSelect(msg().id) : undefined
          }
          class={
            props.selected()
              ? "px-4 py-2.5 rounded-3xl bg-secondary border-2 border-primary"
              : "px-4 py-2.5 rounded-3xl bg-secondary"
          }
          style={{
            maxWidth: "74%",
            minWidth: 0,
          }}
        >
          <Text class="text-sm text-foreground" style={{ lineHeight: 22 }}>
            {msg().content}
          </Text>
        </View>
      </If>
    </View>
  );
}

export function App(props: AppProps = {}) {
  loadPersistedLocale();

  const initialUrl = readHostString("daemonUrl") ?? DaemonDefaults.defaultUrl();
  const store = props.store ?? createCompanionUiStore({ initialUrl });

  const initialToken = readHostString("authToken");
  if (initialToken) {
    store.authToken.set(initialToken);
  }
  const initialDrawer = readHostBoolean("drawerOpen");
  if (initialDrawer !== undefined) {
    store.drawerOpen.set(initialDrawer);
  }
  const initialSidebar = readHostBoolean("sidebarOpen");
  if (initialSidebar !== undefined) {
    store.sidebarOpen.set(initialSidebar);
  }
  const initialTab = readHostString("activeTab");
  if (initialTab === "settings" || initialTab === "models") {
    store.activePage.set("settings");
    store.settingsSection.set("models");
  } else if (initialTab === "memories") {
    store.activePage.set("settings");
    store.settingsSection.set("memories");
  } else if (initialTab === "harness") {
    store.activePage.set("settings");
    store.settingsSection.set("harness");
  } else if (initialTab === "general") {
    store.activePage.set("settings");
    store.settingsSection.set("general");
  }

  const composerText = signal("");
  const selectedPillId = signal<string | null>(null);
  const turnCount = signal(0);

  const pilulierPills = [
    {
      id: "brief",
      labelKey: "pillBrief" as const,
      hint: "Keep this reply brief and direct in 2-3 sentences max.",
    },
    {
      id: "honest",
      labelKey: "pillHonest" as const,
      hint: "Be candid and direct without sugarcoating on this single reply.",
    },
    {
      id: "action",
      labelKey: "pillAction" as const,
      hint: "Focus only on concrete, immediate next steps or commands.",
    },
    {
      id: "warm",
      labelKey: "pillWarm" as const,
      hint: "Use an extra gentle, warm, and reassuring tone on this reply.",
    },
  ];
  const inFlightSends = signal(0);
  const selectionMode = signal(false);
  const selectedIds = signal<ReadonlySet<MessageId>>(new Set());
  const metrics = new SessionMetrics();
  const attentionMotion = createEnterMotion("fadeInDown", 180);

  let chatScrollRef: ScrollRef | undefined;
  let chatContentHeight = 0;

  function scrollChatToBottom(animated = true): void {
    const runScroll = () => {
      try {
        chatScrollRef?.scrollTo({
          y: Math.max(chatContentHeight, 999_999),
          animated,
        });
      } catch {
        // Ignore in unmounted test frames.
      }
    };
    queueMicrotask(runScroll);
    setTimeout(runScroll, 24);
  }

  effect(() => {
    const _msgCount = store.messages().length;
    const _stream = store.streamingReply();
    const _conv = store.conversationId();
    if (_msgCount > 0 || _stream.length > 0) {
      scrollChatToBottom(true);
    } else if (_conv) {
      scrollChatToBottom(false);
    }
  });

  effect(() => {
    const name = store.relationship().companionName;
    try {
      Window.get("main")?.set({ title: `${name} · ${t("appTag")}` });
    } catch {
      // Ignore in non-desktop test environments.
    }
  });

  const sidecar = props.store ? undefined : new DaemonSidecar();
  const sidecarState = sidecar ? sidecar.ensureLocal(store.baseUrl()) : "mock-store";
  store.connect({ waitForBoot: sidecarState === "started" });

  cleanup(() => {
    store.disconnect();
    metrics.dispose();
    sidecar?.stop();
    sidecar?.dispose();
  });

  async function submitMessage(overrideText?: string) {
    const text = (overrideText ?? composerText()).trim();
    if (!text) {
      return;
    }
    const activePillId = selectedPillId();
    const activeHint = activePillId
      ? pilulierPills.find((p) => p.id === activePillId)?.hint
      : undefined;
    if (activePillId) {
      selectedPillId.set(null);
    }
    if (!overrideText) {
      composerText.set("");
    }
    inFlightSends.update((n) => n + 1);
    animateLayout("spring");
    scrollChatToBottom(true);
    try {
      const ok = await store.sendChat(text, activeHint);
      if (ok) {
        turnCount.set(metrics.recordTurn());
        scrollChatToBottom(true);
      } else if (!overrideText && !composerText().trim()) {
        composerText.set(text);
        if (activePillId) selectedPillId.set(activePillId);
      }
    } finally {
      inFlightSends.update((n) => Math.max(0, n - 1));
    }
  }

  function enterSelection(initialId: MessageId) {
    animateLayout("ease");
    selectionMode.set(true);
    selectedIds.set(new Set([initialId]));
  }

  function toggleSelected(id: MessageId) {
    selectedIds.update((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  function selectAllMessages() {
    const all = store
      .messages()
      .filter((m) => !m.recalled)
      .map((m) => m.id);
    selectedIds.set(new Set(all));
  }

  function exitSelection() {
    animateLayout("ease");
    selectionMode.set(false);
    selectedIds.set(new Set());
  }

  async function deleteSelectedMessages() {
    const ids = Array.from(selectedIds());
    if (ids.length === 0) return;
    animateLayout("spring");
    const ok = await store.deleteMessages(ids);
    if (ok) {
      exitSelection();
    }
  }

  async function copySelectedMessages() {
    const chosen = selectedIds();
    const joined = store
      .messages()
      .filter((m) => chosen.has(m.id) && !m.recalled && m.content)
      .map((m) => {
        const sender =
          m.role === "user"
            ? store.relationship().userName
            : store.relationship().companionName;
        return `${sender}: ${m.content}`;
      })
      .join("\n\n");
    await copyText(store, joined);
  }

  const sessionTasks = () =>
    store.tasks().filter((task) => task.conversationId === store.conversationId());

  const isCompanionBusy = () =>
    Boolean(store.streamingReply()) ||
    inFlightSends() > 0 ||
    sessionTasks().some((task) => task.state.kind === "running");

  const activeTaskCount = () =>
    sessionTasks()
      .filter(
        (task) =>
          task.state.kind === "queued" ||
          task.state.kind === "running" ||
          task.state.kind === "awaiting_approval" ||
          task.state.kind === "paused_for_user",
      ).length;

  const companionInitial = () => {
    const name = store.relationship().companionName.trim();
    return name ? name.slice(0, 1).toUpperCase() : "L";
  };

  const openSettingsSection = (section: SettingsSection = "general") => {
    animateLayout("ease");
    store.settingsSection.set(section);
    store.activePage.set("settings");
  };

  return (
    <View
      class="bg-background"
      style={{
        flex: 1,
        paddingTop: "env(safe-area-inset-top)",
        paddingRight: "env(safe-area-inset-right)",
        paddingBottom: "env(safe-area-inset-bottom)",
        paddingLeft: "env(safe-area-inset-left)",
      }}
    >
      <If
        when={store.activePage() === "settings"}
        else={
          <View style={{ flex: 1, flexDirection: "row", minWidth: 0, overflow: "hidden" }}>
            <If when={store.sidebarOpen()}>
              <SessionsSidebar store={store} isBusy={isCompanionBusy} />
            </If>

            <View style={{ flex: 1, minWidth: 0, overflow: "hidden" }}>
              <If
                when={store.activePage() === "task_detail"}
                else={
                  <View style={{ flex: 1, minWidth: 0, overflow: "hidden" }}>
                    {/* Minimal ChatGPT-style top header */}
                    <View
                class="px-3 py-2.5 border-b border-border bg-background"
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 8,
                }}
              >
                <View
                  style={{
                    flex: 1,
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 8,
                    minWidth: 0,
                    overflow: "hidden",
                  }}
                >
                  <If when={!store.sidebarOpen()}>
                    <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
                      <Button
                        testID="open-sidebar-btn"
                        tooltip={t("navShowSidebar")}
                        onPress={() => {
                          animateLayout("ease");
                          store.sidebarOpen.set(true);
                        }}
                        class="p-2 rounded-lg"
                        style={BUTTON_MOTION_STYLE}
                        hoverStyle={{ backgroundColor: "rgba(255,255,255,0.06)" }}
                        activeStyle={BUTTON_ACTIVE_STYLE}
                      >
                        <SidebarIcon size={17} colorToken="muted-foreground" />
                      </Button>
                      <Button
                        testID="header-new-chat-btn"
                        tooltip={t("navNewChat")}
                        onPress={() => {
                          animateLayout("ease");
                          void store.createConversation();
                        }}
                        class="p-2 rounded-lg"
                        style={BUTTON_MOTION_STYLE}
                        hoverStyle={{ backgroundColor: "rgba(255,255,255,0.06)" }}
                        activeStyle={BUTTON_ACTIVE_STYLE}
                      >
                        <NewChatIcon size={17} colorToken="muted-foreground" />
                      </Button>
                    </View>
                  </If>

                  <Button
                    testID="avatar-settings-btn"
                    tooltip={t("sidebarProfileHint")}
                    onPress={() => openSettingsSection("general")}
                    class="p-0.5 rounded-full"
                    style={[
                      BUTTON_MOTION_STYLE,
                      { flexDirection: "row", alignItems: "center", gap: 8, flexShrink: 0 },
                    ]}
                    hoverStyle={{ opacity: 0.88 }}
                    activeStyle={BUTTON_ACTIVE_STYLE}
                  >
                    <View style={{ width: 28, height: 28, position: "relative" }}>
                      <CompanionAvatar
                        avatarSrc={() => store.relationship().companionAvatar}
                        initial={companionInitial}
                        size={28}
                      />
                      <View
                        class={
                          isCompanionBusy()
                            ? "bg-amber-400"
                            : store.connected()
                              ? "bg-emerald-400"
                              : "bg-muted-foreground"
                        }
                        style={{
                          width: 9,
                          height: 9,
                          borderRadius: 5,
                          position: "absolute",
                          right: -1,
                          bottom: -1,
                          borderWidth: 1.5,
                          borderColor: "#212121",
                        }}
                      />
                    </View>
                  </Button>

                  <View
                    style={{
                      flex: 1,
                      flexDirection: "row",
                      alignItems: "center",
                      gap: 6,
                      minWidth: 0,
                      overflow: "hidden",
                    }}
                  >
                    <Text testID="companion-name" class="text-sm font-semibold text-foreground truncate">
                      {store.relationship().companionName}
                    </Text>
                    <Text class="text-xs text-muted-foreground truncate">
                      {t("headerForUser", { user: store.relationship().userName })}
                    </Text>
                    <View
                      class="px-2 py-0.5 rounded-md bg-secondary border border-border"
                      style={{ flexShrink: 1, minWidth: 0, overflow: "hidden" }}
                    >
                      <Text class="text-[11px] text-muted-foreground truncate">
                        {store.modelSettings().companionModel}
                      </Text>
                    </View>
                  </View>
                </View>

                <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexShrink: 0 }}>
                  <If when={!(store.sidebarOpen() && store.drawerOpen())}>
                    <Text class="text-xs text-muted-foreground">
                      {t("turnsLabel", { count: turnCount() })}
                    </Text>
                  </If>
                  <Button
                    testID="status-pill"
                    onPress={() => openSettingsSection("models")}
                    class="px-2 py-1 rounded-full bg-secondary border border-border"
                    style={[
                      BUTTON_MOTION_STYLE,
                      { flexDirection: "row", alignItems: "center", gap: 5 },
                    ]}
                    hoverStyle={{ opacity: 0.9 }}
                    activeStyle={BUTTON_ACTIVE_STYLE}
                  >
                    <View
                      class={store.connected() ? "bg-emerald-400" : "bg-amber-400"}
                      style={{ width: 6, height: 6, borderRadius: 3 }}
                    />
                    <Text class="text-[11px] text-muted-foreground">
                      {store.connected() ? t("statusConnected") : t("statusOffline")}
                    </Text>
                  </Button>

                  <Button
                    testID="toggle-drawer"
                    tooltip={store.drawerOpen() ? t("navHideTasks") : t("navShowTasks")}
                    onPress={() => {
                      animateLayout("spring");
                      store.drawerOpen.update((open) => !open);
                    }}
                    class={
                      store.drawerOpen()
                        ? "p-2 rounded-lg bg-secondary border border-border"
                        : "p-2 rounded-lg"
                    }
                    style={[
                      BUTTON_MOTION_STYLE,
                      { flexDirection: "row", alignItems: "center", gap: 4 },
                    ]}
                    hoverStyle={{ backgroundColor: "rgba(255,255,255,0.06)" }}
                    activeStyle={BUTTON_ACTIVE_STYLE}
                  >
                    <TasksIcon
                      size={17}
                      colorToken={store.drawerOpen() ? "foreground" : "muted-foreground"}
                    />
                    <If when={activeTaskCount() > 0}>
                      <View class="px-1.5 py-0.5 rounded-full bg-primary">
                        <Text class="text-[10px] font-bold text-primary-foreground">
                          {String(activeTaskCount())}
                        </Text>
                      </View>
                    </If>
                  </Button>
                </View>
              </View>

              <If when={store.statusBanner()}>
                {(banner) => (
                  <View class="px-4 py-1.5 bg-card border-b border-border">
                    <Text testID="status-banner" class="text-xs text-muted-foreground">
                      {banner()}
                    </Text>
                  </View>
                )}
              </If>

              <If when={findAttentionTask(sessionTasks())}>
                {(task) => (
                  <View
                    testID="attention-banner"
                    class="px-4 py-2 bg-secondary border-b border-border"
                    style={[
                      attentionMotion.style,
                      {
                        flexDirection: "row",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: 12,
                      },
                    ]}
                  >
                    <Text
                      class="text-xs font-medium text-foreground"
                      style={{ flex: 1, minWidth: 0 }}
                    >
                      {describeAttentionTask(task())}
                    </Text>
                    <View style={{ flexDirection: "row", gap: 6 }}>
                      <If when={task().state.kind === "awaiting_approval"}>
                        <Button
                          testID="banner-approve-btn"
                          onPress={() => {
                            const state = task().state;
                            if (state.kind === "awaiting_approval") {
                              animateLayout("ease");
                              void store.decideApproval(state.approvalId, "approved");
                            }
                          }}
                          class="px-3 py-1 rounded-md bg-primary"
                          style={BUTTON_MOTION_STYLE}
                          activeStyle={BUTTON_ACTIVE_STYLE}
                        >
                          <Text class="text-xs font-semibold text-primary-foreground">
                            {t("btnApprove")}
                          </Text>
                        </Button>
                        <Button
                          testID="banner-deny-btn"
                          onPress={() => {
                            const state = task().state;
                            if (state.kind === "awaiting_approval") {
                              animateLayout("ease");
                              void store.decideApproval(state.approvalId, "denied");
                            }
                          }}
                          class="px-3 py-1 rounded-md bg-destructive"
                          style={BUTTON_MOTION_STYLE}
                          activeStyle={BUTTON_ACTIVE_STYLE}
                        >
                          <Text class="text-xs font-semibold text-foreground">
                            {t("btnDeny")}
                          </Text>
                        </Button>
                      </If>
                      <If when={task().state.kind === "paused_for_user"}>
                        <Button
                          testID="banner-inspect-btn"
                          onPress={() => {
                            animateLayout("ease");
                            store.inspectedTaskId.set(task().id);
                            store.activePage.set("task_detail");
                          }}
                          class="px-3 py-1 rounded-md border border-border bg-secondary"
                          style={BUTTON_MOTION_STYLE}
                          activeStyle={BUTTON_ACTIVE_STYLE}
                        >
                          <Text class="text-xs font-semibold text-foreground">
                            {t("btnInspectBrowser")}
                          </Text>
                        </Button>
                        <Button
                          testID="banner-resume-btn"
                          onPress={() => void store.resumeBrowserTask(task().id)}
                          class="px-3 py-1 rounded-md bg-primary"
                          style={BUTTON_MOTION_STYLE}
                          activeStyle={BUTTON_ACTIVE_STYLE}
                        >
                          <Text class="text-xs font-semibold text-primary-foreground">
                            {t("btnResumeBrowser")}
                          </Text>
                        </Button>
                      </If>
                    </View>
                  </View>
                )}
              </If>

              {/* Main chat scroll container */}
              <Scroll
                ref={(ref) => {
                  chatScrollRef = ref;
                }}
                style={{ flex: 1, minWidth: 0 }}
                contentStyle={{ paddingHorizontal: 20, paddingVertical: 18, alignItems: "center" }}
              >
                <View
                  onLayout={(e) => {
                    chatContentHeight = e.bounds.size.height;
                  }}
                  style={{
                    width: "100%",
                    maxWidth: 740,
                    minWidth: 0,
                    gap: 16,
                  }}
                >
                  <If
                    when={store.messages().length > 0}
                    else={
                      <View
                        testID="welcome-card"
                        style={{
                          paddingTop: 32,
                          paddingBottom: 16,
                          alignItems: "center",
                          gap: 12,
                          width: "100%",
                          minWidth: 0,
                        }}
                      >
                        <CompanionAvatar
                          avatarSrc={() => store.relationship().companionAvatar}
                          initial={companionInitial}
                          size={44}
                          class="bg-secondary border border-border"
                          textClass="text-base font-bold text-foreground"
                        />
                        <Text
                          class="text-lg font-semibold text-foreground"
                          style={{ textAlign: "center" }}
                        >
                          {t("welcomeTitle")}
                        </Text>
                        <Text
                          class="text-xs text-muted-foreground"
                          style={{
                            maxWidth: 500,
                            lineHeight: 18,
                            textAlign: "center",
                          }}
                        >
                          {t("welcomeDesc")}
                        </Text>
                        <View
                          style={{
                            flexDirection: "column",
                            alignItems: "center",
                            gap: 6,
                            marginTop: 6,
                            width: "100%",
                            maxWidth: 520,
                            minWidth: 0,
                          }}
                        >
                          <Each of={getStarterPrompts()}>
                            {(prompt) => (
                              <Button
                                onPress={() => void submitMessage(prompt())}
                                class="px-3.5 py-2 rounded-xl bg-secondary border border-border"
                                style={[
                                  BUTTON_MOTION_STYLE,
                                  { maxWidth: "100%", minWidth: 0, flexShrink: 1 },
                                ]}
                                hoverStyle={{ opacity: 0.9 }}
                                activeStyle={BUTTON_ACTIVE_STYLE}
                              >
                                <Text
                                  class="text-xs text-foreground"
                                  style={{ flexShrink: 1, minWidth: 0, lineHeight: 17 }}
                                >
                                  {prompt()}
                                </Text>
                              </Button>
                            )}
                          </Each>
                        </View>
                      </View>
                    }
                  >
                    <Each of={store.messages()}>
                      {(msg) => (
                        <ChatBubble
                          message={msg}
                          companionName={() => store.relationship().companionName}
                          companionAvatar={() => store.relationship().companionAvatar}
                          companionInitial={companionInitial}
                          selectionMode={() => selectionMode()}
                          selected={() => selectedIds().has(msg().id)}
                          onToggleSelect={toggleSelected}
                          onEnterSelection={enterSelection}
                          onRecall={(id) => void store.recallMessage(id)}
                          onDelete={(id) => void store.deleteMessages([id])}
                          onCopy={(content) => void copyText(store, content)}
                        />
                      )}
                    </Each>
                  </If>

                  <If when={store.streamingReply()}>
                    {(partial) => (
                      <View
                        testID="streaming-bubble"
                        style={{
                          flexDirection: "row",
                          alignItems: "flex-start",
                          gap: 12,
                          width: "100%",
                        }}
                      >
                        <View style={{ marginTop: 2 }}>
                          <CompanionAvatar
                            avatarSrc={() => store.relationship().companionAvatar}
                            initial={companionInitial}
                            size={26}
                            class="bg-card border border-border"
                            textClass="text-[11px] font-bold text-foreground"
                          />
                        </View>
                        <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
                          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                            <View
                              class="bg-foreground"
                              style={{
                                width: 6,
                                height: 6,
                                borderRadius: 3,
                                animationName: "pulse",
                                animationDuration: 900,
                                animationIterationCount: "infinite",
                              }}
                            />
                            <Text class="text-[11px] text-muted-foreground">
                              {t("typingLabel", { name: store.relationship().companionName })}
                            </Text>
                          </View>
                          <MarkdownContent content={partial} streaming />
                        </View>
                      </View>
                    )}
                  </If>
                </View>
              </Scroll>

              {/* Floating ChatGPT-style capsule composer or multi-select bar */}
              <View style={{ paddingHorizontal: 20, paddingBottom: 14, paddingTop: 6, alignItems: "center" }}>
                <View style={{ width: "100%", maxWidth: 740, minWidth: 0 }}>
                  <If
                    when={selectionMode()}
                    else={
                      <View style={{ gap: 6 }}>
                        <View
                          style={{
                            flexDirection: "row",
                            flexWrap: "wrap",
                            gap: 6,
                            paddingHorizontal: 4,
                          }}
                        >
                          {pilulierPills.map((pill) => {
                            const active = () => selectedPillId() === pill.id;
                            return (
                              <Button
                                testID={`pilulier-pill-${pill.id}`}
                                onPress={() =>
                                  selectedPillId.set(active() ? null : pill.id)
                                }
                                class={
                                  active()
                                    ? "px-2.5 py-1 rounded-full bg-primary border border-primary"
                                    : "px-2.5 py-1 rounded-full bg-card border border-border"
                                }
                                style={BUTTON_MOTION_STYLE}
                                activeStyle={BUTTON_ACTIVE_STYLE}
                              >
                                <Text
                                  class={
                                    active()
                                      ? "text-xs font-medium text-primary-foreground"
                                      : "text-xs text-muted-foreground"
                                  }
                                >
                                  {t(pill.labelKey)}
                                </Text>
                              </Button>
                            );
                          })}
                        </View>
                        <View
                          class="px-3.5 py-2 rounded-3xl bg-secondary border border-border"
                          style={{
                            flexDirection: "row",
                            alignItems: "center",
                            gap: 8,
                          }}
                        >
                          <Input
                            testID="chat-input"
                            value={composerText()}
                            placeholder={t("inputPlaceholder", {
                              name: store.relationship().companionName,
                            })}
                            submitBehavior="submit"
                            onChange={(e) => composerText.set(e.value)}
                            onSubmit={() => void submitMessage()}
                            class="flex-1 px-1.5 py-1.5 bg-secondary text-sm text-foreground"
                            style={{ minWidth: 0 }}
                          />
                          <Button
                            testID="send-btn"
                            onPress={() => void submitMessage()}
                            class="rounded-full bg-primary"
                            style={[
                              BUTTON_MOTION_STYLE,
                              {
                                width: 32,
                                height: 32,
                                alignItems: "center",
                                justifyContent: "center",
                                flexShrink: 0,
                              },
                            ]}
                            hoverStyle={{ opacity: 0.9 }}
                            activeStyle={BUTTON_ACTIVE_STYLE}
                          >
                            <SendArrowIcon size={16} colorToken="primary-foreground" />
                          </Button>
                        </View>
                      </View>
                    }
                  >
                    <View
                      testID="selection-toolbar"
                      class="px-4 py-2.5 rounded-2xl border border-border bg-card"
                      style={{
                        flexDirection: "row",
                        flexWrap: "wrap",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: 8,
                      }}
                    >
                      <Text class="text-xs font-semibold text-foreground">
                        {t("selectionCount", { count: selectedIds().size })}
                      </Text>
                      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
                        <Button
                          testID="select-all-btn"
                          onPress={selectAllMessages}
                          class="px-3 py-1.5 rounded-lg bg-secondary border border-border"
                          style={BUTTON_MOTION_STYLE}
                          activeStyle={BUTTON_ACTIVE_STYLE}
                        >
                          <Text class="text-xs text-secondary-foreground">{t("btnSelectAll")}</Text>
                        </Button>
                        <Button
                          testID="copy-selected-btn"
                          disabled={selectedIds().size === 0}
                          onPress={() => void copySelectedMessages()}
                          class="px-3 py-1.5 rounded-lg bg-secondary border border-border disabled:opacity-50"
                          style={BUTTON_MOTION_STYLE}
                          activeStyle={BUTTON_ACTIVE_STYLE}
                        >
                          <Text class="text-xs text-secondary-foreground">
                            {t("btnCopySelected")}
                          </Text>
                        </Button>
                        <Button
                          testID="delete-selected-btn"
                          disabled={selectedIds().size === 0}
                          onPress={() => void deleteSelectedMessages()}
                          class="px-3 py-1.5 rounded-lg bg-destructive disabled:opacity-50"
                          style={BUTTON_MOTION_STYLE}
                          activeStyle={BUTTON_ACTIVE_STYLE}
                        >
                          <Text class="text-xs font-semibold text-foreground">
                            {t("btnDeleteSelected", { count: selectedIds().size })}
                          </Text>
                        </Button>
                        <Button
                          testID="exit-selection-btn"
                          onPress={exitSelection}
                          class="px-3 py-1.5 rounded-lg bg-muted"
                          style={BUTTON_MOTION_STYLE}
                          activeStyle={BUTTON_ACTIVE_STYLE}
                        >
                          <Text class="text-xs text-muted-foreground">{t("btnCancel")}</Text>
                        </Button>
                      </View>
                    </View>
                  </If>
                </View>
              </View>
                  </View>
                }
              >
                <TaskDetailView store={store} />
              </If>
            </View>

            <If when={store.drawerOpen()}>
              <TasksSidebar store={store} />
            </If>
          </View>
        }
      >
        <SettingsPage store={store} />
      </If>
    </View>
  );
}

mount(App);
