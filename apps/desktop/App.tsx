import type { ChatMessage, MessageId, TaskRecord } from "@live-for-llm/protocol";
import { DaemonDefaults, DaemonSidecar, SessionMetrics, StatusPill } from "companiondesktop/native";
import {
  cleanup,
  Clipboard,
  effect,
  host,
  mount,
  Scroll,
  signal,
  Text,
  View,
} from "nsh";
import { Button, Input, TextView } from "nsh/base";
import { Menu, Window } from "nsh/desktop";
import { currentLocale, loadPersistedLocale, t } from "./src/i18n.ts";
import {
  animateLayout,
  BUTTON_ACTIVE_STYLE,
  BUTTON_MOTION_STYLE,
  CARD_ELEVATION_STYLE,
  createEnterMotion,
} from "./src/motion.ts";
import { SettingsPage } from "./src/SettingsPage.tsx";
import {
  createCompanionUiStore,
  type CompanionUiStore,
  type SettingsSection,
} from "./src/state.ts";
import { TasksSidebar } from "./src/TasksSidebar.tsx";

export interface AppProps {
  readonly store?: CompanionUiStore;
}

function getStarterPrompts(): readonly string[] {
  if (currentLocale() === "en-US") {
    return [
      "What background tasks or local checks can you run right now?",
      "Help me look something up in the browser and summarize it.",
      "Keep replies casual and concise unless we are reviewing code.",
    ];
  }
  return [
    "先帮我看看你现在都能做哪些后台或本地操作？",
    "帮我查点资料，用自己的话说重点就行。",
    "平时聊天自然简短点，不用太像客服。",
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
        codeBlock: "rounded-lg bg-muted p-2.5 border border-border",
        codeBlockCode: "font-mono text-xs text-foreground",
        blockquote: "border-l-2 border-primary pl-2.5 text-muted-foreground",
        link: "text-primary underline",
      }}
      styles={{
        root: { lineHeight: 20 },
        paragraph: { lineHeight: 20 },
      }}
    />
  );
}

function BubbleActionChip(props: {
  readonly testID?: string;
  readonly label: string;
  readonly danger?: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Button
      testID={props.testID}
      onPress={props.onPress}
      class="px-2 py-0.5 rounded bg-muted border border-border"
      style={BUTTON_MOTION_STYLE}
      hoverStyle={{ opacity: 0.9 }}
      activeStyle={BUTTON_ACTIVE_STYLE}
    >
      <Text
        class={props.danger ? "text-[10px] text-destructive" : "text-[10px] text-muted-foreground"}
      >
        {props.label}
      </Text>
    </Button>
  );
}

function ChatBubble(props: {
  readonly message: () => ChatMessage;
  readonly companionName: () => string;
  readonly userName: () => string;
  readonly selectionMode: () => boolean;
  readonly selected: () => boolean;
  readonly onToggleSelect: (id: MessageId) => void;
  readonly onEnterSelection: (id: MessageId) => void;
  readonly onRecall: (id: MessageId) => void;
  readonly onDelete: (id: MessageId) => void;
  readonly onCopy: (text: string) => void;
}) {
  const bubbleMotion = createEnterMotion("fadeInUp", 160);
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
        <View class="px-3 py-1 rounded-full bg-muted border border-border">
          <Text class="text-[11px] text-muted-foreground">{recalledLabel}</Text>
        </View>
      </View>
    );
  }

  const openBubbleMenu = (pagePosition: { x: number; y: number }) => {
    void Menu.popup(
      [
        { label: t("btnCopy"), onSelect: () => props.onCopy(msg().content) },
        { label: t("btnRecall"), onSelect: () => props.onRecall(msg().id) },
        { label: t("btnMultiSelect"), onSelect: () => props.onEnterSelection(msg().id) },
        { type: "separator" },
        { label: t("btnDelete"), onSelect: () => props.onDelete(msg().id) },
      ],
      pagePosition,
    );
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
          gap: 8,
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
              : "px-2 py-1 rounded-md bg-muted border border-border"
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

      <View
        style={{
          maxWidth: "78%",
          minWidth: 0,
          alignItems: isUser() ? "flex-end" : "flex-start",
          gap: 4,
        }}
      >
        <View
          testID={`msg-bubble-${msg().id}`}
          onContextMenu={(e) => openBubbleMenu(e.pagePosition)}
          onPress={
            props.selectionMode() ? () => props.onToggleSelect(msg().id) : undefined
          }
          class={
            props.selected()
              ? isUser()
                ? "px-4 py-2.5 rounded-2xl bg-primary border-2 border-foreground"
                : "px-4 py-2.5 rounded-2xl bg-card border-2 border-primary"
              : isUser()
                ? "px-4 py-2.5 rounded-2xl bg-primary"
                : "px-4 py-2.5 rounded-2xl bg-card border border-border"
          }
          style={[
            !isUser() ? CARD_ELEVATION_STYLE : undefined,
            isUser() ? { borderTopRightRadius: 6, gap: 4 } : { borderTopLeftRadius: 6, gap: 4 },
          ]}
        >
          <Text
            class={
              isUser()
                ? "text-xs font-semibold text-primary-foreground"
                : "text-xs font-semibold text-muted-foreground"
            }
          >
            {isUser()
              ? props.userName()
              : msg().proactive
                ? t("proactiveBadge", { name: props.companionName() })
                : msg().role === "system"
                  ? t("systemSender")
                  : props.companionName()}
          </Text>
          <If
            when={!isUser()}
            else={
              <Text class="text-sm text-primary-foreground" style={{ lineHeight: 20 }}>
                {msg().content}
              </Text>
            }
          >
            <MarkdownContent content={() => msg().content} />
          </If>
        </View>

        <If when={!props.selectionMode()}>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 4 }}>
            <BubbleActionChip
              testID={`copy-${msg().id}`}
              label={t("btnCopy")}
              onPress={() => props.onCopy(msg().content)}
            />
            <BubbleActionChip
              testID={`recall-${msg().id}`}
              label={t("btnRecall")}
              onPress={() => props.onRecall(msg().id)}
            />
            <BubbleActionChip
              testID={`select-${msg().id}`}
              label={t("btnMultiSelect")}
              onPress={() => props.onEnterSelection(msg().id)}
            />
            <BubbleActionChip
              testID={`delete-${msg().id}`}
              label={t("btnDelete")}
              danger
              onPress={() => props.onDelete(msg().id)}
            />
          </View>
        </If>
      </View>
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
  const initialTab = readHostString("activeTab");
  if (initialTab === "settings") {
    store.activePage.set("settings");
    store.settingsSection.set("models");
  } else if (initialTab === "memories") {
    store.activePage.set("settings");
    store.settingsSection.set("memories");
  } else if (initialTab === "general") {
    store.activePage.set("settings");
    store.settingsSection.set("general");
  }

  const composerText = signal("");
  const turnCount = signal(0);
  const inFlightSends = signal(0);
  const selectionMode = signal(false);
  const selectedIds = signal<ReadonlySet<MessageId>>(new Set());
  const metrics = new SessionMetrics();
  const attentionMotion = createEnterMotion("fadeInDown", 180);

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
    if (!overrideText) {
      composerText.set("");
    }
    inFlightSends.update((n) => n + 1);
    animateLayout("spring");
    try {
      const ok = await store.sendChat(text);
      if (ok) {
        turnCount.set(metrics.recordTurn());
      } else if (!overrideText && !composerText().trim()) {
        composerText.set(text);
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

  const isCompanionBusy = () =>
    Boolean(store.streamingReply()) ||
    inFlightSends() > 0 ||
    store.tasks().some((task) => task.state.kind === "running");

  const activeTaskCount = () =>
    store
      .tasks()
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

  const connectionTone = () => (store.connected() ? "ok" : "warn");
  const connectionLabel = () =>
    store.connected() ? t("statusConnected") : t("statusOffline");

  const openSettingsSection = (section: SettingsSection = "models") => {
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
      <View
        class="px-4 py-3 border-b border-border bg-card"
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 10,
        }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10, minWidth: 0, flexShrink: 1 }}>
          <View
            class="bg-primary"
            style={{
              width: 34,
              height: 34,
              borderRadius: 17,
              alignItems: "center",
              justifyContent: "center",
              position: "relative",
            }}
          >
            <Text class="text-sm font-bold text-primary-foreground">{companionInitial()}</Text>
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
                borderWidth: 2,
                borderColor: "#181820",
                animationName: isCompanionBusy() ? "pulse" : "none",
                animationDuration: 1200,
                animationIterationCount: "infinite",
              }}
            />
          </View>
          <View style={{ gap: 1, minWidth: 0, flexShrink: 1 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
              <Text testID="companion-name" class="text-base font-semibold text-foreground">
                {store.relationship().companionName}
              </Text>
              <View class="px-1.5 py-0.5 rounded bg-accent">
                <Text class="text-[10px] font-semibold text-accent-foreground">
                  {t("appTag")}
                </Text>
              </View>
            </View>
            <Text class="text-xs text-muted-foreground">
              {t("headerForUser", { user: store.relationship().userName })}
            </Text>
          </View>
        </View>

        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Text class="text-xs text-muted-foreground">
            {t("turnsLabel", { count: turnCount() })}
          </Text>
          <StatusPill
            testID="status-pill"
            label={connectionLabel()}
            tone={connectionTone()}
            onPress={() => openSettingsSection("models")}
          />
          <If when={store.activePage() === "chat"}>
            <Button
              testID="toggle-drawer"
              onPress={() => {
                animateLayout("spring");
                store.drawerOpen.update((open) => !open);
              }}
              class="px-3 py-1.5 rounded-lg bg-secondary border border-border"
              style={BUTTON_MOTION_STYLE}
              hoverStyle={{ opacity: 0.9 }}
              activeStyle={BUTTON_ACTIVE_STYLE}
            >
              <Text class="text-xs font-medium text-secondary-foreground">
                {activeTaskCount() > 0
                  ? `${store.drawerOpen() ? t("navHideTasks") : t("navShowTasks")} (${activeTaskCount()})`
                  : store.drawerOpen()
                    ? t("navHideTasks")
                    : t("navShowTasks")}
              </Text>
            </Button>
          </If>
          <Button
            testID="toggle-settings"
            onPress={() => {
              animateLayout("ease");
              if (store.activePage() === "settings") {
                store.activePage.set("chat");
              } else {
                store.activePage.set("settings");
              }
            }}
            class={
              store.activePage() === "settings"
                ? "px-3 py-1.5 rounded-lg bg-primary"
                : "px-3 py-1.5 rounded-lg bg-secondary border border-border"
            }
            style={BUTTON_MOTION_STYLE}
            hoverStyle={{ opacity: 0.9 }}
            activeStyle={BUTTON_ACTIVE_STYLE}
          >
            <Text
              class={
                store.activePage() === "settings"
                  ? "text-xs font-semibold text-primary-foreground"
                  : "text-xs font-medium text-secondary-foreground"
              }
            >
              {store.activePage() === "settings" ? t("navBackToChat") : t("navSettings")}
            </Text>
          </Button>
        </View>
      </View>

      <If when={store.statusBanner()}>
        {(banner) => (
          <View class="px-4 py-1.5 bg-muted border-b border-border">
            <Text testID="status-banner" class="text-xs text-muted-foreground">
              {banner()}
            </Text>
          </View>
        )}
      </If>

      <If when={findAttentionTask(store.tasks())}>
        {(task) => (
          <View
            testID="attention-banner"
            class="px-4 py-2.5 bg-accent border-b border-border"
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
              class="text-xs font-semibold text-accent-foreground"
              style={{ flex: 1, minWidth: 0 }}
            >
              {describeAttentionTask(task())}
            </Text>
            <View style={{ flexDirection: "row", gap: 8 }}>
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
                  <Text class="text-xs font-semibold text-primary-foreground">
                    {t("btnDeny")}
                  </Text>
                </Button>
              </If>
              <If when={task().state.kind === "paused_for_user"}>
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

      <If
        when={store.activePage() === "settings"}
        else={
          <View style={{ flex: 1, flexDirection: "row", minWidth: 0 }}>
            <View style={{ flex: 1, minWidth: 0, overflow: "hidden" }}>
              <Scroll style={{ flex: 1, minWidth: 0 }} contentStyle={{ padding: 18, gap: 12 }}>
                <If
                  when={store.messages().length > 0}
                  else={
                    <View
                      testID="welcome-card"
                      class="p-5 rounded-2xl border border-border bg-card"
                      style={[
                        CARD_ELEVATION_STYLE,
                        {
                          gap: 10,
                          width: "100%",
                          maxWidth: 560,
                          minWidth: 0,
                          overflow: "hidden",
                        },
                      ]}
                    >
                      <Text class="text-base font-semibold text-foreground">
                        {t("welcomeTitle", { name: store.relationship().companionName })}
                      </Text>
                      <Text class="text-xs text-muted-foreground" style={{ lineHeight: 18 }}>
                        {t("welcomeDesc")}
                      </Text>
                      <View
                        style={{
                          flexDirection: "column",
                          alignItems: "flex-start",
                          gap: 6,
                          marginTop: 4,
                          width: "100%",
                          minWidth: 0,
                        }}
                      >
                        <Each of={getStarterPrompts()}>
                          {(prompt) => (
                            <Button
                              onPress={() => void submitMessage(prompt())}
                              class="px-3 py-1.5 rounded-lg bg-secondary border border-border"
                              style={[
                                BUTTON_MOTION_STYLE,
                                { maxWidth: "100%", minWidth: 0, flexShrink: 1 },
                              ]}
                              hoverStyle={{ opacity: 0.9 }}
                              activeStyle={BUTTON_ACTIVE_STYLE}
                            >
                              <Text
                                class="text-xs text-secondary-foreground"
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
                        userName={() => store.relationship().userName}
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
                      class="self-start max-w-[78%] px-4 py-2.5 rounded-2xl bg-card border border-border"
                      style={[CARD_ELEVATION_STYLE, { borderTopLeftRadius: 6, gap: 4 }]}
                    >
                      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                        <View
                          class="bg-primary"
                          style={{
                            width: 7,
                            height: 7,
                            borderRadius: 4,
                            animationName: "pulse",
                            animationDuration: 900,
                            animationIterationCount: "infinite",
                          }}
                        />
                        <Text class="text-xs font-semibold text-muted-foreground">
                          {t("typingLabel", { name: store.relationship().companionName })}
                        </Text>
                      </View>
                      <MarkdownContent content={partial} streaming />
                    </View>
                  )}
                </If>
              </Scroll>

              <If
                when={selectionMode()}
                else={
                  <View
                    class="p-3 border-t border-border bg-card"
                    style={{ flexDirection: "row", alignItems: "center", gap: 8 }}
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
                      class="flex-1 px-3.5 py-2.5 rounded-xl border border-border bg-background text-sm text-foreground"
                      style={{ minWidth: 0 }}
                    />
                    <Button
                      testID="send-btn"
                      onPress={() => void submitMessage()}
                      class="px-4 py-2.5 rounded-xl bg-primary"
                      style={BUTTON_MOTION_STYLE}
                      hoverStyle={{ opacity: 0.92 }}
                      activeStyle={BUTTON_ACTIVE_STYLE}
                    >
                      <Text class="text-sm font-semibold text-primary-foreground">
                        {t("btnSend")}
                      </Text>
                    </Button>
                  </View>
                }
              >
                <View
                  testID="selection-toolbar"
                  class="p-3 border-t border-border bg-card"
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
                      <Text class="text-xs text-secondary-foreground">{t("btnCopySelected")}</Text>
                    </Button>
                    <Button
                      testID="delete-selected-btn"
                      disabled={selectedIds().size === 0}
                      onPress={() => void deleteSelectedMessages()}
                      class="px-3 py-1.5 rounded-lg bg-destructive disabled:opacity-50"
                      style={BUTTON_MOTION_STYLE}
                      activeStyle={BUTTON_ACTIVE_STYLE}
                    >
                      <Text class="text-xs font-semibold text-primary-foreground">
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
