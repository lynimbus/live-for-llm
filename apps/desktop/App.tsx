import type { ChatMessage, TaskRecord } from "@live-for-llm/protocol";
import { DaemonDefaults, DaemonSidecar, SessionMetrics, StatusPill } from "companiondesktop/native";
import { cleanup, effect, host, mount, Scroll, signal, Text, View } from "nsh";
import { Button, Input } from "nsh/base";
import { Window } from "nsh/desktop";
import { DrawerPanel } from "./src/DrawerPanel.tsx";
import {
  animateLayout,
  BUTTON_ACTIVE_STYLE,
  BUTTON_MOTION_STYLE,
  CARD_ELEVATION_STYLE,
  createEnterMotion,
} from "./src/motion.ts";
import { createCompanionUiStore, type CompanionUiStore, type DrawerTab } from "./src/state.ts";

export interface AppProps {
  readonly store?: CompanionUiStore;
}

const STARTER_PROMPTS = [
  "你好 Livia，先帮我看看现在有哪些进行中的任务？",
  "帮我打开浏览器搜索一下今天的关键信息并总结给我。",
  "记住我平时喜欢简洁直接的汇报方式。",
] as const;

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
      return `Approval needed: ${task.state.actionSummary}`;
    case "paused_for_user":
      return `Paused for user: ${task.state.instructions}`;
    default:
      return task.title;
  }
}

function ChatBubble(props: {
  readonly message: () => ChatMessage;
  readonly companionName: () => string;
  readonly userName: () => string;
}) {
  const bubbleMotion = createEnterMotion("fadeInUp", 180);
  const isUser = () => props.message().role === "user";

  return (
    <View
      class={
        isUser()
          ? "self-end max-w-[78%] px-4 py-2.5 rounded-2xl bg-primary"
          : "self-start max-w-[78%] px-4 py-2.5 rounded-2xl bg-card border border-border"
      }
      style={[
        bubbleMotion.style,
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
          : props.message().proactive
            ? `${props.companionName()} · 主动关心`
            : props.message().role === "system"
              ? "System"
              : props.companionName()}
      </Text>
      <Text
        class={
          isUser() ? "text-sm text-primary-foreground" : "text-sm text-foreground"
        }
        style={{ lineHeight: 20 }}
      >
        {props.message().content}
      </Text>
    </View>
  );
}

export function App(props: AppProps = {}) {
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
  if (initialTab === "tasks" || initialTab === "memories" || initialTab === "settings") {
    store.activeTab.set(initialTab as DrawerTab);
  }

  const composerText = signal("");
  const turnCount = signal(0);
  const sending = signal(false);
  const metrics = new SessionMetrics();
  const attentionMotion = createEnterMotion("fadeInDown", 180);

  effect(() => {
    const name = store.relationship().companionName;
    try {
      Window.get("main")?.set({ title: `${name} · live-for-llm` });
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
    if (sending()) {
      return;
    }
    const text = (overrideText ?? composerText()).trim();
    if (!text) {
      return;
    }
    sending.set(true);
    animateLayout("spring");
    try {
      const ok = await store.sendChat(text);
      if (ok) {
        composerText.set("");
        turnCount.set(metrics.recordTurn());
      }
    } finally {
      sending.set(false);
    }
  }

  const isCompanionBusy = () =>
    Boolean(store.streamingReply()) ||
    store.tasks().some((t) => t.state.kind === "running" || t.state.kind === "queued");

  const connectionTone = () => {
    if (!store.connected()) {
      return "neutral";
    }
    return findAttentionTask(store.tasks()) ? "warning" : "connected";
  };

  const connectionLabel = () => {
    const mode = store.policy().mode;
    return store.connected() ? `Online • ${mode}` : "Connecting...";
  };

  const companionInitial = () => {
    const name = store.relationship().companionName.trim();
    return name ? name.slice(0, 1).toUpperCase() : "L";
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
          gap: 12,
        }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
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
              class={isCompanionBusy() ? "bg-amber-400" : store.connected() ? "bg-emerald-400" : "bg-muted-foreground"}
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
          <View style={{ gap: 1 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
              <Text testID="companion-name" class="text-base font-semibold text-foreground">
                {store.relationship().companionName}
              </Text>
              <View class="px-1.5 py-0.5 rounded bg-accent">
                <Text class="text-[10px] font-semibold text-accent-foreground">live-for-llm</Text>
              </View>
            </View>
            <Text class="text-xs text-muted-foreground">
              {`for ${store.relationship().userName} • ${store.relationship().currentMood} • affinity ${Math.round(store.relationship().affinityScore * 100)}%`}
            </Text>
          </View>
        </View>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Text class="text-xs text-muted-foreground">{`turns ${turnCount()}`}</Text>
          <StatusPill
            testID="status-pill"
            label={connectionLabel()}
            tone={connectionTone()}
            onPress={() => {
              animateLayout("spring");
              store.activeTab.set("settings");
              store.drawerOpen.set(true);
            }}
          />
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
              {store.drawerOpen() ? "Hide Drawer" : "Show Drawer"}
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
            <Text class="text-xs font-semibold text-accent-foreground">
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
                  <Text class="text-xs font-semibold text-primary-foreground">Approve</Text>
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
                  <Text class="text-xs font-semibold text-primary-foreground">Deny</Text>
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
                  <Text class="text-xs font-semibold text-primary-foreground">Resume Browser</Text>
                </Button>
              </If>
            </View>
          </View>
        )}
      </If>

      <View style={{ flex: 1, flexDirection: "row" }}>
        <View style={{ flex: 1 }}>
          <Scroll style={{ flex: 1 }} contentStyle={{ padding: 18, gap: 12 }}>
            <If
              when={store.messages().length > 0}
              else={
                <View
                  class="p-5 rounded-2xl border border-border bg-card"
                  style={[CARD_ELEVATION_STYLE, { gap: 10, maxWidth: 560 }]}
                >
                  <Text class="text-base font-semibold text-foreground">
                    {`${store.relationship().companionName} · live-for-llm 已就绪`}
                  </Text>
                  <Text class="text-xs text-muted-foreground" style={{ lineHeight: 18 }}>
                    直接对话倾诉、让我记住你的偏好，或者交给我后台浏览器与 Harness 任务。如果还没填 API Key，点右上角 Settings 即可自定义 Base URL 与密钥。
                  </Text>
                  <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 4 }}>
                    <Each of={STARTER_PROMPTS}>
                      {(prompt) => (
                        <Button
                          onPress={() => void submitMessage(prompt())}
                          class="px-3 py-1.5 rounded-lg bg-secondary border border-border"
                          style={BUTTON_MOTION_STYLE}
                          hoverStyle={{ opacity: 0.9 }}
                          activeStyle={BUTTON_ACTIVE_STYLE}
                        >
                          <Text class="text-xs text-secondary-foreground">{prompt()}</Text>
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
                      {`${store.relationship().companionName} typing...`}
                    </Text>
                  </View>
                  <Text class="text-sm text-foreground" style={{ lineHeight: 20 }}>
                    {partial()}
                  </Text>
                </View>
              )}
            </If>
          </Scroll>

          <View
            class="p-3 border-t border-border bg-card"
            style={{ flexDirection: "row", alignItems: "center", gap: 8 }}
          >
            <Input
              testID="chat-input"
              value={composerText()}
              placeholder={`和 ${store.relationship().companionName} 聊聊，或派发任务...`}
              submitBehavior="submit"
              onChange={(e) => composerText.set(e.value)}
              onSubmit={() => void submitMessage()}
              class="flex-1 px-3.5 py-2.5 rounded-xl border border-border bg-background text-sm text-foreground"
            />
            <Button
              testID="send-btn"
              disabled={sending()}
              onPress={() => void submitMessage()}
              class="px-4 py-2.5 rounded-xl bg-primary disabled:opacity-50"
              style={BUTTON_MOTION_STYLE}
              hoverStyle={{ opacity: 0.92 }}
              activeStyle={BUTTON_ACTIVE_STYLE}
            >
              <Text class="text-sm font-semibold text-primary-foreground">
                {sending() ? "Sending..." : "Send"}
              </Text>
            </Button>
          </View>
        </View>

        <If when={store.drawerOpen()}>
          <DrawerPanel store={store} />
        </If>
      </View>
    </View>
  );
}

mount(App);
