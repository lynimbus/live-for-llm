import {
  LLM_PROVIDER_KINDS,
  type LlmProviderKind,
  MEMORY_KINDS,
  TRUST_POLICY_MODES,
  type MemoryKind,
  type TaskRecord,
  type TrustPolicyMode,
} from "@live-for-llm/protocol";
import { DaemonDefaults } from "companiondesktop/native";
import { effect, Image, Scroll, signal, Text, View } from "nsh";
import { Button, Input } from "nsh/base";
import {
  animateLayout,
  BUTTON_ACTIVE_STYLE,
  BUTTON_MOTION_STYLE,
  CARD_ELEVATION_STYLE,
  createEnterMotion,
} from "./motion.ts";
import type { CompanionUiStore, DrawerTab } from "./state.ts";

export interface DrawerPanelProps {
  readonly store: CompanionUiStore;
}

const PROVIDER_LABELS: Record<LlmProviderKind, string> = {
  openai_compatible: "OpenAI / Compatible",
  anthropic: "Anthropic",
  gemini: "Gemini",
};

const POLICY_DESCRIPTIONS: Record<TrustPolicyMode, string> = {
  trust_auto: "授权后自动执行浏览、发帖与任务派发，高危动作仍拦截。",
  confirm_external: "对外发消息或公开发帖前暂停并弹出确认卡片。",
  allowlist: "仅白名单域名自动放行，其余外部操作均需确认。",
};

function summarizeTaskState(task: TaskRecord): string {
  switch (task.state.kind) {
    case "queued":
      return `Queued (${task.state.queuedAt})`;
    case "running":
      return `Running: ${task.state.stepSummary}`;
    case "awaiting_approval":
      return `Awaiting approval [${task.state.riskTier}] ${task.state.actionSummary}`;
    case "paused_for_user":
      return `Paused (${task.state.reason}): ${task.state.instructions}`;
    case "completed":
      return `Completed: ${task.state.summary}`;
    case "failed":
      return `Failed: ${task.state.error}`;
    case "cancelled":
      return `Cancelled (${task.state.cancelledAt})`;
  }
}

function resolveTaskScreenshot(store: CompanionUiStore, task: TaskRecord): string | undefined {
  const fromMap = store.screenshots()[task.id];
  if (fromMap) {
    return fromMap;
  }
  if (task.state.kind === "running") {
    return task.state.latestScreenshotBase64;
  }
  return undefined;
}

function SelectablePill(props: {
  readonly label: string;
  readonly selected: () => boolean;
  readonly testID?: string;
  readonly compact?: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Button
      testID={props.testID}
      selected={props.selected()}
      onPress={props.onPress}
      class={
        props.compact
          ? "group px-2.5 py-1 rounded-md bg-secondary selected:bg-primary border border-transparent selected:border-primary"
          : "group px-3 py-1.5 rounded-lg bg-secondary selected:bg-primary border border-transparent selected:border-primary"
      }
      style={BUTTON_MOTION_STYLE}
      hoverStyle={{ opacity: 0.92 }}
      activeStyle={BUTTON_ACTIVE_STYLE}
    >
      <Text
        class={
          props.selected()
            ? "text-xs font-semibold text-primary-foreground"
            : "text-xs font-medium text-secondary-foreground"
        }
      >
        {props.label}
      </Text>
    </Button>
  );
}

function TabButton(props: {
  readonly label: string;
  readonly tab: DrawerTab;
  readonly testID: string;
  readonly store: CompanionUiStore;
}) {
  return (
    <SelectablePill
      testID={props.testID}
      label={props.label}
      selected={() => props.store.activeTab() === props.tab}
      onPress={() => {
        animateLayout("ease");
        props.store.activeTab.set(props.tab);
      }}
    />
  );
}

export function DrawerPanel(props: DrawerPanelProps) {
  const { store } = props;
  const drawerMotion = createEnterMotion("fadeInRight", 220);

  const memoryFilter = signal<MemoryKind | "all">("all");
  const memorySearch = signal("");
  const newKind = signal<MemoryKind>("fact");
  const newTitle = signal("");
  const newContent = signal("");

  const personaName = signal(store.relationship().companionName);
  const userName = signal(store.relationship().userName);
  const personaDirty = signal(false);

  const apiProvider = signal<LlmProviderKind>(store.modelSettings().provider);
  const apiBaseUrl = signal(store.modelSettings().baseUrl);
  const apiKey = signal("");
  const chatModel = signal(store.modelSettings().companionModel);
  const taskModel = signal(store.modelSettings().taskModel);
  const memoryModel = signal(store.modelSettings().memoryModel);
  const modelsDirty = signal(false);

  effect(() => {
    const rel = store.relationship();
    if (!personaDirty()) {
      personaName.set(rel.companionName);
      userName.set(rel.userName);
    }
  });

  effect(() => {
    const cfg = store.modelSettings();
    if (!modelsDirty()) {
      apiProvider.set(cfg.provider);
      apiBaseUrl.set(cfg.baseUrl);
      chatModel.set(cfg.companionModel);
      taskModel.set(cfg.taskModel);
      memoryModel.set(cfg.memoryModel);
    }
  });

  const filteredMemories = () => {
    const kind = memoryFilter();
    const query = memorySearch().trim().toLowerCase();
    return store.memories().filter((item) => {
      if (kind !== "all" && item.kind !== kind) {
        return false;
      }
      if (!query) {
        return true;
      }
      return (
        item.title.toLowerCase().includes(query) ||
        item.content.toLowerCase().includes(query) ||
        item.tags.some((tag) => tag.toLowerCase().includes(query))
      );
    });
  };

  async function submitNewMemory() {
    const title = newTitle().trim();
    const content = newContent().trim();
    if (!title || !content) {
      return;
    }
    animateLayout("spring");
    await store.addMemory({
      kind: newKind(),
      title,
      content,
      tags: [],
      importance: 0.7,
      source: "user_edit",
    });
    newTitle.set("");
    newContent.set("");
  }

  async function savePersonaSettings() {
    const companion = personaName().trim();
    const user = userName().trim();
    if (!companion && !user) {
      return;
    }
    const ok = await store.updateRelationship({
      ...(companion ? { companionName: companion } : {}),
      ...(user ? { userName: user } : {}),
    });
    if (ok) {
      personaDirty.set(false);
    }
  }

  async function saveModelSettings() {
    const baseUrl = apiBaseUrl().trim();
    const cModel = chatModel().trim();
    const tModel = taskModel().trim() || cModel;
    const mModel = memoryModel().trim() || cModel;
    if (!baseUrl || !cModel) {
      store.statusBanner.set("请填写有效的 Base URL 与 Chat Model");
      return;
    }
    const keyVal = apiKey().trim();
    const ok = await store.updateModelSettings({
      provider: apiProvider(),
      baseUrl,
      companionModel: cModel,
      taskModel: tModel,
      memoryModel: mModel,
      visionModel: tModel,
      ...(keyVal ? { apiKey: keyVal } : {}),
    });
    if (ok) {
      apiKey.set("");
      modelsDirty.set(false);
    }
  }

  return (
    <View
      testID="drawer-panel"
      class="bg-card border-l border-border"
      style={[drawerMotion.style, { width: 432, padding: 14, gap: 12 }]}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
        }}
      >
        <View style={{ flexDirection: "row", gap: 6 }}>
          <TabButton label="Tasks" tab="tasks" testID="tab-tasks" store={store} />
          <TabButton label="Memories" tab="memories" testID="tab-memories" store={store} />
          <TabButton label="Settings" tab="settings" testID="tab-settings" store={store} />
        </View>
        <Button
          testID="close-drawer"
          onPress={() => {
            animateLayout("spring");
            store.drawerOpen.set(false);
          }}
          class="px-2.5 py-1 rounded-md bg-muted"
          style={BUTTON_MOTION_STYLE}
          hoverStyle={{ opacity: 0.85 }}
          activeStyle={BUTTON_ACTIVE_STYLE}
        >
          <Text class="text-xs font-medium text-muted-foreground">Close</Text>
        </Button>
      </View>

      <If when={store.activeTab() === "tasks"}>
        <Scroll style={{ flex: 1 }} contentStyle={{ gap: 10 }}>
          <If
            when={store.tasks().length > 0}
            else={
              <View class="p-4 rounded-xl border border-border bg-background" style={{ gap: 4 }}>
                <Text class="text-sm font-medium text-foreground">No background tasks yet</Text>
                <Text class="text-xs text-muted-foreground">
                  Ask Livia in chat to browse, summarize, or run a harness task.
                </Text>
              </View>
            }
          >
            <Each of={store.tasks()}>
              {(task) => (
                <View
                  class="p-3 rounded-xl border border-border bg-background"
                  style={[CARD_ELEVATION_STYLE, { gap: 6 }]}
                >
                  <View
                    style={{
                      flexDirection: "row",
                      justifyContent: "space-between",
                      alignItems: "center",
                    }}
                  >
                    <Text class="text-sm font-semibold text-foreground">{task().title}</Text>
                    <Text class="text-xs text-muted-foreground">
                      {DaemonDefaults.shortId(task().id)}
                    </Text>
                  </View>
                  <Text class="text-xs text-muted-foreground">
                    {`${task().taskKind} • ${summarizeTaskState(task())}`}
                  </Text>
                  <If when={resolveTaskScreenshot(store, task())}>
                    {(b64) => (
                      <Image
                        testID={`task-shot-${task().id}`}
                        src={`data:image/png;base64,${b64()}`}
                        style={{ width: "100%", height: 140, borderRadius: 8 }}
                      />
                    )}
                  </If>
                  <If when={task().state.kind === "awaiting_approval"}>
                    <View style={{ flexDirection: "row", gap: 8 }}>
                      <Button
                        testID={`approve-${task().id}`}
                        onPress={() => {
                          const state = task().state;
                          if (state.kind === "awaiting_approval") {
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
                        testID={`deny-${task().id}`}
                        onPress={() => {
                          const state = task().state;
                          if (state.kind === "awaiting_approval") {
                            void store.decideApproval(state.approvalId, "denied");
                          }
                        }}
                        class="px-3 py-1 rounded-md bg-destructive"
                        style={BUTTON_MOTION_STYLE}
                        activeStyle={BUTTON_ACTIVE_STYLE}
                      >
                        <Text class="text-xs font-semibold text-primary-foreground">Deny</Text>
                      </Button>
                    </View>
                  </If>
                  <If when={task().state.kind === "paused_for_user"}>
                    <Button
                      testID={`resume-${task().id}`}
                      onPress={() => void store.resumeBrowserTask(task().id)}
                      class="px-3 py-1 rounded-md bg-primary"
                      style={BUTTON_MOTION_STYLE}
                      activeStyle={BUTTON_ACTIVE_STYLE}
                    >
                      <Text class="text-xs font-semibold text-primary-foreground">
                        Resume After Login
                      </Text>
                    </Button>
                  </If>
                  <If
                    when={
                      task().state.kind === "queued" ||
                      task().state.kind === "running" ||
                      task().state.kind === "awaiting_approval" ||
                      task().state.kind === "paused_for_user"
                    }
                  >
                    <Button
                      testID={`cancel-${task().id}`}
                      onPress={() => void store.cancelTask(task().id)}
                      class="px-3 py-1 rounded-md bg-secondary"
                      style={BUTTON_MOTION_STYLE}
                      activeStyle={BUTTON_ACTIVE_STYLE}
                    >
                      <Text class="text-xs font-medium text-secondary-foreground">Cancel</Text>
                    </Button>
                  </If>
                </View>
              )}
            </Each>
          </If>
        </Scroll>
      </If>

      <If when={store.activeTab() === "memories"}>
        <View style={{ flex: 1, gap: 10 }}>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
            <SelectablePill
              testID="filter-all"
              label="all"
              compact
              selected={() => memoryFilter() === "all"}
              onPress={() => {
                animateLayout("ease");
                memoryFilter.set("all");
              }}
            />
            <Each of={MEMORY_KINDS}>
              {(kind) => (
                <SelectablePill
                  testID={`filter-${kind()}`}
                  label={kind()}
                  compact
                  selected={() => memoryFilter() === kind()}
                  onPress={() => {
                    animateLayout("ease");
                    memoryFilter.set(kind());
                  }}
                />
              )}
            </Each>
          </View>

          <Input
            testID="memory-search"
            value={memorySearch()}
            placeholder="Search memories..."
            onChange={(e) => memorySearch.set(e.value)}
            class="px-3 py-1.5 rounded-lg border border-border bg-background text-sm text-foreground"
          />

          <View
            class="p-3 rounded-xl border border-border bg-background"
            style={[CARD_ELEVATION_STYLE, { gap: 8 }]}
          >
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 4 }}>
              <Each of={MEMORY_KINDS}>
                {(kind) => (
                  <SelectablePill
                    label={kind()}
                    compact
                    selected={() => newKind() === kind()}
                    onPress={() => newKind.set(kind())}
                  />
                )}
              </Each>
            </View>
            <Input
              testID="memory-new-title"
              value={newTitle()}
              placeholder="Memory title"
              onChange={(e) => newTitle.set(e.value)}
              class="px-2.5 py-1.5 rounded-md border border-border bg-card text-sm text-foreground"
            />
            <Input
              testID="memory-new-content"
              value={newContent()}
              placeholder="Memory details"
              onChange={(e) => newContent.set(e.value)}
              class="px-2.5 py-1.5 rounded-md border border-border bg-card text-sm text-foreground"
            />
            <View style={{ flexDirection: "row", gap: 6 }}>
              <Button
                testID="memory-add-btn"
                onPress={() => void submitNewMemory()}
                class="px-3 py-1.5 rounded-md bg-primary"
                style={BUTTON_MOTION_STYLE}
                activeStyle={BUTTON_ACTIVE_STYLE}
              >
                <Text class="text-xs font-semibold text-primary-foreground">Add Memory</Text>
              </Button>
              <Button
                testID="memory-export-btn"
                onPress={() => void store.exportMarkdown()}
                class="px-3 py-1.5 rounded-md bg-secondary"
                style={BUTTON_MOTION_STYLE}
                activeStyle={BUTTON_ACTIVE_STYLE}
              >
                <Text class="text-xs font-medium text-secondary-foreground">Export MD</Text>
              </Button>
              <Button
                testID="memory-import-btn"
                onPress={() => void store.importMarkdown()}
                class="px-3 py-1.5 rounded-md bg-secondary"
                style={BUTTON_MOTION_STYLE}
                activeStyle={BUTTON_ACTIVE_STYLE}
              >
                <Text class="text-xs font-medium text-secondary-foreground">Import MD</Text>
              </Button>
            </View>
          </View>

          <Scroll style={{ flex: 1 }} contentStyle={{ gap: 8 }}>
            <Each of={filteredMemories()}>
              {(mem) => (
                <View class="p-2.5 rounded-lg border border-border bg-background" style={{ gap: 4 }}>
                  <View
                    style={{
                      flexDirection: "row",
                      justifyContent: "space-between",
                      alignItems: "center",
                    }}
                  >
                    <Text class="text-sm font-medium text-foreground">
                      {`[${mem().kind}] ${mem().title}`}
                    </Text>
                    <Button
                      testID={`delete-memory-${mem().id}`}
                      onPress={() => {
                        animateLayout("ease");
                        void store.deleteMemory(mem().id);
                      }}
                      class="px-2 py-0.5 rounded bg-muted"
                      style={BUTTON_MOTION_STYLE}
                      activeStyle={BUTTON_ACTIVE_STYLE}
                    >
                      <Text class="text-xs text-muted-foreground">Delete</Text>
                    </Button>
                  </View>
                  <Text class="text-xs text-muted-foreground">{mem().content}</Text>
                </View>
              )}
            </Each>
          </Scroll>
        </View>
      </If>

      <If when={store.activeTab() === "settings"}>
        <Scroll style={{ flex: 1 }} contentStyle={{ gap: 12 }}>
          <View
            class="p-3 rounded-xl border border-border bg-background"
            style={[CARD_ELEVATION_STYLE, { gap: 8 }]}
          >
            <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
              <Text class="text-sm font-semibold text-foreground">
                {`${store.relationship().companionName} · 伙伴档案`}
              </Text>
              <Text class="text-xs font-medium text-primary">
                {`Affinity ${Math.round(store.relationship().affinityScore * 100)}/100 • Mood: ${store.relationship().currentMood}`}
              </Text>
            </View>
            <View class="h-1.5 rounded-full bg-muted" style={{ overflow: "hidden" }}>
              <View
                class="h-1.5 rounded-full bg-primary"
                style={{
                  width: `${Math.max(8, Math.min(100, Math.round(store.relationship().affinityScore * 100)))}%`,
                  transitionProperty: "all",
                  transitionDuration: 240,
                }}
              />
            </View>
            <View style={{ flexDirection: "row", gap: 6 }}>
              <Input
                testID="persona-companion-input"
                value={personaName()}
                placeholder="Companion name (e.g. Livia)"
                onChange={(e) => {
                  personaDirty.set(true);
                  personaName.set(e.value);
                }}
                class="flex-1 px-2.5 py-1.5 rounded-md border border-border bg-card text-xs text-foreground"
              />
              <Input
                testID="persona-user-input"
                value={userName()}
                placeholder="Your name"
                onChange={(e) => {
                  personaDirty.set(true);
                  userName.set(e.value);
                }}
                class="flex-1 px-2.5 py-1.5 rounded-md border border-border bg-card text-xs text-foreground"
              />
            </View>
            <Button
              testID="save-persona-btn"
              onPress={() => void savePersonaSettings()}
              class="px-3 py-1.5 rounded-md bg-secondary"
              style={BUTTON_MOTION_STYLE}
              activeStyle={BUTTON_ACTIVE_STYLE}
            >
              <Text class="text-xs font-semibold text-secondary-foreground">Save Persona</Text>
            </Button>
          </View>

          <View
            class="p-3 rounded-xl border border-border bg-background"
            style={[CARD_ELEVATION_STYLE, { gap: 8 }]}
          >
            <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
              <Text class="text-sm font-semibold text-foreground">Model & Custom API</Text>
              <Text class="text-xs text-muted-foreground">
                {store.modelSettings().hasApiKey
                  ? `Key: ${store.modelSettings().apiKeyMasked ?? "configured"}`
                  : "Key: 未配置"}
              </Text>
            </View>

            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
              <Each of={LLM_PROVIDER_KINDS}>
                {(provider) => (
                  <SelectablePill
                    testID={`provider-${provider()}`}
                    label={PROVIDER_LABELS[provider()]}
                    compact
                    selected={() => apiProvider() === provider()}
                    onPress={() => {
                      modelsDirty.set(true);
                      apiProvider.set(provider());
                    }}
                  />
                )}
              </Each>
            </View>

            <Input
              testID="api-base-url-input"
              value={apiBaseUrl()}
              placeholder="Base URL (e.g. https://api.openai.com/v1)"
              onChange={(e) => {
                modelsDirty.set(true);
                apiBaseUrl.set(e.value);
              }}
              class="px-2.5 py-1.5 rounded-md border border-border bg-card text-xs text-foreground"
            />
            <Input
              testID="api-key-input"
              value={apiKey()}
              placeholder={
                store.modelSettings().hasApiKey
                  ? `API Key (留空保留当前 ${store.modelSettings().apiKeyMasked ?? "密钥"})`
                  : "API Key (sk-...)"
              }
              masked
              onChange={(e) => {
                modelsDirty.set(true);
                apiKey.set(e.value);
              }}
              class="px-2.5 py-1.5 rounded-md border border-border bg-card text-xs text-foreground"
            />
            <Input
              testID="chat-model-input"
              value={chatModel()}
              placeholder="Chat Model (e.g. gpt-4o-mini / deepseek-chat)"
              onChange={(e) => {
                modelsDirty.set(true);
                chatModel.set(e.value);
              }}
              class="px-2.5 py-1.5 rounded-md border border-border bg-card text-xs text-foreground"
            />
            <View style={{ flexDirection: "row", gap: 6 }}>
              <Input
                testID="task-model-input"
                value={taskModel()}
                placeholder="Task Model"
                onChange={(e) => {
                  modelsDirty.set(true);
                  taskModel.set(e.value);
                }}
                class="flex-1 px-2.5 py-1.5 rounded-md border border-border bg-card text-xs text-foreground"
              />
              <Input
                testID="memory-model-input"
                value={memoryModel()}
                placeholder="Memory Model"
                onChange={(e) => {
                  modelsDirty.set(true);
                  memoryModel.set(e.value);
                }}
                class="flex-1 px-2.5 py-1.5 rounded-md border border-border bg-card text-xs text-foreground"
              />
            </View>
            <Button
              testID="save-models-btn"
              onPress={() => void saveModelSettings()}
              class="px-3 py-1.5 rounded-md bg-primary"
              style={BUTTON_MOTION_STYLE}
              activeStyle={BUTTON_ACTIVE_STYLE}
            >
              <Text class="text-xs font-semibold text-primary-foreground">Save & Apply API</Text>
            </Button>
          </View>

          <View
            class="p-3 rounded-xl border border-border bg-background"
            style={[CARD_ELEVATION_STYLE, { gap: 8 }]}
          >
            <Text class="text-sm font-semibold text-foreground">Trust & Safety Mode</Text>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
              <Each of={TRUST_POLICY_MODES}>
                {(mode) => {
                  const typedMode = (): TrustPolicyMode => mode();
                  return (
                    <SelectablePill
                      testID={`policy-${typedMode()}`}
                      label={typedMode()}
                      selected={() => store.policy().mode === typedMode()}
                      onPress={() => void store.setPolicyMode(typedMode())}
                    />
                  );
                }}
              </Each>
            </View>
            <Text class="text-xs text-muted-foreground">
              {POLICY_DESCRIPTIONS[store.policy().mode]}
            </Text>
          </View>

          <View
            class="p-3 rounded-xl border border-border bg-background"
            style={[CARD_ELEVATION_STYLE, { gap: 8 }]}
          >
            <Text class="text-sm font-semibold text-foreground">Daemon Connection</Text>
            <Input
              testID="daemon-url-input"
              value={store.baseUrl()}
              placeholder="http://127.0.0.1:4777"
              onChange={(e) => store.baseUrl.set(e.value)}
              class="px-2.5 py-1.5 rounded-md border border-border bg-card text-xs text-foreground"
            />
            <Input
              testID="daemon-token-input"
              value={store.authToken()}
              placeholder="Bearer token (optional)"
              masked
              onChange={(e) => store.authToken.set(e.value)}
              class="px-2.5 py-1.5 rounded-md border border-border bg-card text-xs text-foreground"
            />
            <Button
              testID="reconnect-btn"
              onPress={() => store.connect()}
              class="px-3 py-1.5 rounded-md bg-secondary"
              style={BUTTON_MOTION_STYLE}
              activeStyle={BUTTON_ACTIVE_STYLE}
            >
              <Text class="text-xs font-semibold text-secondary-foreground">Reconnect</Text>
            </Button>
          </View>

          <View
            class="p-3 rounded-xl border border-border bg-background"
            style={[CARD_ELEVATION_STYLE, { gap: 6 }]}
          >
            <Text class="text-sm font-semibold text-foreground">Proactive Rules</Text>
            <If
              when={store.proactiveRules().length > 0}
              else={
                <Text class="text-xs text-muted-foreground">No proactive schedules active.</Text>
              }
            >
              <Each of={store.proactiveRules()}>
                {(rule) => (
                  <Text class="text-xs text-muted-foreground">
                    {`${rule().label}: every ${rule().cronOrIntervalMinutes}m (quiet ${rule().quietHoursStart}-${rule().quietHoursEnd})`}
                  </Text>
                )}
              </Each>
            </If>
          </View>
        </Scroll>
      </If>
    </View>
  );
}
