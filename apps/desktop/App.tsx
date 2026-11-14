import type { TaskRecord } from "@live-for-llm/protocol";
import { DaemonDefaults, SessionMetrics, StatusPill } from "companiondesktop/native";
import { cleanup, host, mount, Scroll, signal, Text, View } from "nsh";
import { Button, Input } from "nsh/base";
import { DrawerPanel } from "./src/DrawerPanel.tsx";
import { createCompanionUiStore, type CompanionUiStore, type DrawerTab } from "./src/state.ts";

export interface AppProps {
  readonly store?: CompanionUiStore;
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
      return `Approval needed: ${task.state.actionSummary}`;
    case "paused_for_user":
      return `Paused for user: ${task.state.instructions}`;
    default:
      return task.title;
  }
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

  store.connect();

  cleanup(() => {
    store.disconnect();
    metrics.dispose();
  });

  async function submitMessage() {
    if (sending()) {
      return;
    }
    const text = composerText().trim();
    if (!text) {
      return;
    }
    sending.set(true);
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
          <Text testID="companion-name" class="text-base font-semibold text-foreground">
            {store.relationship().companionName}
          </Text>
          <Text class="text-xs text-muted-foreground">
            {`for ${store.relationship().userName} • ${store.relationship().currentMood} • affinity ${store.relationship().affinityScore}`}
          </Text>
        </View>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Text class="text-xs text-muted-foreground">{`turns ${turnCount()}`}</Text>
          <StatusPill
            testID="status-pill"
            label={connectionLabel()}
            tone={connectionTone()}
            onPress={() => {
              store.activeTab.set("settings");
              store.drawerOpen.set(true);
            }}
          />
          <Button
            testID="toggle-drawer"
            onPress={() => store.drawerOpen.update((open) => !open)}
            class="px-3 py-1 rounded-md bg-secondary"
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
            class="px-4 py-2 bg-secondary border-b border-border"
            style={{
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 12,
            }}
          >
            <Text class="text-xs font-medium text-foreground">
              {describeAttentionTask(task())}
            </Text>
            <View style={{ flexDirection: "row", gap: 8 }}>
              <If when={task().state.kind === "awaiting_approval"}>
                <Button
                  testID="banner-approve-btn"
                  onPress={() => {
                    const state = task().state;
                    if (state.kind === "awaiting_approval") {
                      void store.decideApproval(state.approvalId, "approved");
                    }
                  }}
                  class="px-3 py-1 rounded bg-primary"
                >
                  <Text class="text-xs text-primary-foreground">Approve</Text>
                </Button>
                <Button
                  testID="banner-deny-btn"
                  onPress={() => {
                    const state = task().state;
                    if (state.kind === "awaiting_approval") {
                      void store.decideApproval(state.approvalId, "denied");
                    }
                  }}
                  class="px-3 py-1 rounded bg-destructive"
                >
                  <Text class="text-xs text-primary-foreground">Deny</Text>
                </Button>
              </If>
              <If when={task().state.kind === "paused_for_user"}>
                <Button
                  testID="banner-resume-btn"
                  onPress={() => void store.resumeBrowserTask(task().id)}
                  class="px-3 py-1 rounded bg-primary"
                >
                  <Text class="text-xs text-primary-foreground">Resume Browser</Text>
                </Button>
              </If>
            </View>
          </View>
        )}
      </If>

      <View style={{ flex: 1, flexDirection: "row" }}>
        <View style={{ flex: 1 }}>
          <Scroll style={{ flex: 1 }} contentStyle={{ padding: 16, gap: 12 }}>
            <If
              when={store.messages().length > 0}
              else={
                <View class="p-4 rounded-xl border border-border bg-card" style={{ gap: 4 }}>
                  <Text class="text-sm font-medium text-foreground">
                    {`${store.relationship().companionName} is ready.`}
                  </Text>
                  <Text class="text-xs text-muted-foreground">
                    Chat naturally or ask for browser search, posting, and background harness tasks.
                  </Text>
                </View>
              }
            >
              <Each of={store.messages()}>
                {(msg) => {
                  const isUser = () => msg().role === "user";
                  return (
                    <View
                      class={
                        isUser()
                          ? "self-end max-w-[78%] px-3.5 py-2.5 rounded-xl bg-primary"
                          : "self-start max-w-[78%] px-3.5 py-2.5 rounded-xl bg-card border border-border"
                      }
                      style={{ gap: 4 }}
                    >
                      <Text
                        class={
                          isUser()
                            ? "text-xs font-semibold text-primary-foreground"
                            : "text-xs font-semibold text-muted-foreground"
                        }
                      >
                        {isUser()
                          ? store.relationship().userName
                          : msg().proactive
                            ? `${store.relationship().companionName} (proactive)`
                            : msg().role === "system"
                              ? "System"
                              : store.relationship().companionName}
                      </Text>
                      <Text
                        class={
                          isUser() ? "text-sm text-primary-foreground" : "text-sm text-foreground"
                        }
                      >
                        {msg().content}
                      </Text>
                    </View>
                  );
                }}
              </Each>
            </If>

            <If when={store.streamingReply()}>
              {(partial) => (
                <View
                  testID="streaming-bubble"
                  class="self-start max-w-[78%] px-3.5 py-2.5 rounded-xl bg-card border border-border"
                  style={{ gap: 4 }}
                >
                  <Text class="text-xs font-semibold text-muted-foreground">
                    {`${store.relationship().companionName} typing...`}
                  </Text>
                  <Text class="text-sm text-foreground">{partial()}</Text>
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
              placeholder="Say something or assign a task..."
              submitBehavior="submit"
              onChange={(e) => composerText.set(e.value)}
              onSubmit={() => void submitMessage()}
              class="flex-1 px-3 py-2 rounded-lg border border-border bg-background text-sm text-foreground"
            />
            <Button
              testID="send-btn"
              onPress={() => void submitMessage()}
              class="px-4 py-2 rounded-lg bg-primary"
            >
              <Text class="text-sm font-medium text-primary-foreground">Send</Text>
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
