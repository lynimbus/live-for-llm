import {
  MEMORY_KINDS,
  TRUST_POLICY_MODES,
  type MemoryKind,
  type TaskRecord,
  type TrustPolicyMode,
} from "@live-for-llm/protocol";
import { DaemonDefaults } from "companiondesktop/native";
import { Image, Scroll, signal, Text, View } from "nsh";
import { Button, Input } from "nsh/base";
import type { CompanionUiStore, DrawerTab } from "./state.ts";

export interface DrawerPanelProps {
  readonly store: CompanionUiStore;
}

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

function TabButton(props: {
  readonly label: string;
  readonly tab: DrawerTab;
  readonly testID: string;
  readonly store: CompanionUiStore;
}) {
  return (
    <Button
      testID={props.testID}
      selected={props.store.activeTab() === props.tab}
      onPress={() => props.store.activeTab.set(props.tab)}
      class="px-3 py-1.5 rounded-md bg-secondary selected:bg-primary"
    >
      <Text class="text-xs font-medium text-secondary-foreground">{props.label}</Text>
    </Button>
  );
}

export function DrawerPanel(props: DrawerPanelProps) {
  const { store } = props;
  const memoryFilter = signal<MemoryKind | "all">("all");
  const memorySearch = signal("");
  const newKind = signal<MemoryKind>("fact");
  const newTitle = signal("");
  const newContent = signal("");

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

  return (
    <View
      testID="drawer-panel"
      class="bg-card border-l border-border"
      style={{ width: 420, padding: 14, gap: 12 }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <View style={{ flexDirection: "row", gap: 6 }}>
          <TabButton label="Tasks" tab="tasks" testID="tab-tasks" store={store} />
          <TabButton label="Memories" tab="memories" testID="tab-memories" store={store} />
          <TabButton label="Settings" tab="settings" testID="tab-settings" store={store} />
        </View>
        <Button
          testID="close-drawer"
          onPress={() => store.drawerOpen.set(false)}
          class="px-2 py-1 rounded bg-muted"
        >
          <Text class="text-xs text-muted-foreground">Close</Text>
        </Button>
      </View>

      <If when={store.activeTab() === "tasks"}>
        <Scroll style={{ flex: 1 }} contentStyle={{ gap: 10 }}>
          <If
            when={store.tasks().length > 0}
            else={
              <Text class="text-sm text-muted-foreground">No background tasks yet.</Text>
            }
          >
            <Each of={store.tasks()}>
              {(task) => (
                <View class="p-3 rounded-lg border border-border bg-background" style={{ gap: 6 }}>
                  <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
                    <Text class="text-sm font-semibold text-foreground">{task().title}</Text>
                    <Text class="text-xs text-muted-foreground">{DaemonDefaults.shortId(task().id)}</Text>
                  </View>
                  <Text class="text-xs text-muted-foreground">
                    {`${task().taskKind} • ${summarizeTaskState(task())}`}
                  </Text>
                  <If when={resolveTaskScreenshot(store, task())}>
                    {(b64) => (
                      <Image
                        testID={`task-shot-${task().id}`}
                        src={`data:image/png;base64,${b64()}`}
                        style={{ width: "100%", height: 140, borderRadius: 6 }}
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
                        class="px-3 py-1 rounded bg-primary"
                      >
                        <Text class="text-xs text-primary-foreground">Approve</Text>
                      </Button>
                      <Button
                        testID={`deny-${task().id}`}
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
                    </View>
                  </If>
                  <If when={task().state.kind === "paused_for_user"}>
                    <Button
                      testID={`resume-${task().id}`}
                      onPress={() => void store.resumeBrowserTask(task().id)}
                      class="px-3 py-1 rounded bg-primary"
                    >
                      <Text class="text-xs text-primary-foreground">Resume After Login</Text>
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
                      class="px-3 py-1 rounded bg-secondary"
                    >
                      <Text class="text-xs text-secondary-foreground">Cancel</Text>
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
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 4 }}>
            <Button
              testID="filter-all"
              selected={memoryFilter() === "all"}
              onPress={() => memoryFilter.set("all")}
              class="px-2 py-1 rounded bg-secondary selected:bg-primary"
            >
              <Text class="text-xs text-secondary-foreground">all</Text>
            </Button>
            <Each of={MEMORY_KINDS}>
              {(kind) => (
                <Button
                  testID={`filter-${kind()}`}
                  selected={memoryFilter() === kind()}
                  onPress={() => memoryFilter.set(kind())}
                  class="px-2 py-1 rounded bg-secondary selected:bg-primary"
                >
                  <Text class="text-xs text-secondary-foreground">{kind()}</Text>
                </Button>
              )}
            </Each>
          </View>

          <Input
            testID="memory-search"
            value={memorySearch()}
            placeholder="Search memories..."
            onChange={(e) => memorySearch.set(e.value)}
            class="px-3 py-1.5 rounded border border-border bg-background text-sm text-foreground"
          />

          <View class="p-2.5 rounded-lg border border-border bg-background" style={{ gap: 6 }}>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 4 }}>
              <Each of={MEMORY_KINDS}>
                {(kind) => (
                  <Button
                    selected={newKind() === kind()}
                    onPress={() => newKind.set(kind())}
                    class="px-2 py-0.5 rounded bg-secondary selected:bg-primary"
                  >
                    <Text class="text-xs text-secondary-foreground">{kind()}</Text>
                  </Button>
                )}
              </Each>
            </View>
            <Input
              testID="memory-new-title"
              value={newTitle()}
              placeholder="Memory title"
              onChange={(e) => newTitle.set(e.value)}
              class="px-2.5 py-1 rounded border border-border bg-card text-sm text-foreground"
            />
            <Input
              testID="memory-new-content"
              value={newContent()}
              placeholder="Memory details"
              onChange={(e) => newContent.set(e.value)}
              class="px-2.5 py-1 rounded border border-border bg-card text-sm text-foreground"
            />
            <View style={{ flexDirection: "row", gap: 6 }}>
              <Button
                testID="memory-add-btn"
                onPress={() => void submitNewMemory()}
                class="px-3 py-1 rounded bg-primary"
              >
                <Text class="text-xs text-primary-foreground">Add Memory</Text>
              </Button>
              <Button
                testID="memory-export-btn"
                onPress={() => void store.exportMarkdown()}
                class="px-3 py-1 rounded bg-secondary"
              >
                <Text class="text-xs text-secondary-foreground">Export MD</Text>
              </Button>
              <Button
                testID="memory-import-btn"
                onPress={() => void store.importMarkdown()}
                class="px-3 py-1 rounded bg-secondary"
              >
                <Text class="text-xs text-secondary-foreground">Import MD</Text>
              </Button>
            </View>
          </View>

          <Scroll style={{ flex: 1 }} contentStyle={{ gap: 8 }}>
            <Each of={filteredMemories()}>
              {(mem) => (
                <View class="p-2.5 rounded border border-border bg-background" style={{ gap: 4 }}>
                  <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
                    <Text class="text-sm font-medium text-foreground">{`[${mem().kind}] ${mem().title}`}</Text>
                    <Button
                      testID={`delete-memory-${mem().id}`}
                      onPress={() => void store.deleteMemory(mem().id)}
                      class="px-2 py-0.5 rounded bg-muted"
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
          <View class="p-3 rounded-lg border border-border bg-background" style={{ gap: 4 }}>
            <Text class="text-sm font-semibold text-foreground">
              {`${store.relationship().companionName} <-> ${store.relationship().userName}`}
            </Text>
            <Text class="text-xs text-muted-foreground">
              {`Affinity ${Math.round(store.relationship().affinityScore * 100)}/100 • Mood: ${store.relationship().currentMood}`}
            </Text>
          </View>

          <View class="p-3 rounded-lg border border-border bg-background" style={{ gap: 8 }}>
            <Text class="text-sm font-semibold text-foreground">Daemon Connection</Text>
            <Input
              testID="daemon-url-input"
              value={store.baseUrl()}
              placeholder="http://127.0.0.1:4777"
              onChange={(e) => store.baseUrl.set(e.value)}
              class="px-2.5 py-1 rounded border border-border bg-card text-sm text-foreground"
            />
            <Input
              testID="daemon-token-input"
              value={store.authToken()}
              placeholder="Bearer token (optional)"
              masked
              onChange={(e) => store.authToken.set(e.value)}
              class="px-2.5 py-1 rounded border border-border bg-card text-sm text-foreground"
            />
            <Button
              testID="reconnect-btn"
              onPress={() => store.connect()}
              class="px-3 py-1.5 rounded bg-primary"
            >
              <Text class="text-xs text-primary-foreground">Reconnect</Text>
            </Button>
          </View>

          <View class="p-3 rounded-lg border border-border bg-background" style={{ gap: 6 }}>
            <Text class="text-sm font-semibold text-foreground">Trust & Safety Mode</Text>
            <Each of={TRUST_POLICY_MODES}>
              {(mode) => {
                const typedMode = (): TrustPolicyMode => mode();
                return (
                  <Button
                    testID={`policy-${typedMode()}`}
                    selected={store.policy().mode === typedMode()}
                    onPress={() => void store.setPolicyMode(typedMode())}
                    class="px-3 py-1.5 rounded bg-secondary selected:bg-primary"
                  >
                    <Text class="text-xs text-secondary-foreground">{typedMode()}</Text>
                  </Button>
                );
              }}
            </Each>
          </View>

          <View class="p-3 rounded-lg border border-border bg-background" style={{ gap: 6 }}>
            <Text class="text-sm font-semibold text-foreground">Proactive Rules</Text>
            <If
              when={store.proactiveRules().length > 0}
              else={<Text class="text-xs text-muted-foreground">No proactive schedules active.</Text>}
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
