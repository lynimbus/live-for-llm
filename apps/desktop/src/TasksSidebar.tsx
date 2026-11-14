import type { TaskRecord } from "@live-for-llm/protocol";
import { DaemonDefaults } from "companiondesktop/native";
import { Image, Scroll, Text, View } from "nsh";
import { Button } from "nsh/base";
import { currentLocale, t } from "./i18n.ts";
import {
  animateLayout,
  BUTTON_ACTIVE_STYLE,
  BUTTON_MOTION_STYLE,
  CARD_ELEVATION_STYLE,
  createEnterMotion,
} from "./motion.ts";
import type { CompanionUiStore } from "./state.ts";

export interface TasksSidebarProps {
  readonly store: CompanionUiStore;
}

function summarizeTaskState(task: TaskRecord): string {
  const isZh = currentLocale() === "zh-CN";
  switch (task.state.kind) {
    case "queued":
      return isZh ? `排队中 (${task.state.queuedAt})` : `Queued (${task.state.queuedAt})`;
    case "running":
      return isZh
        ? `执行中：${task.state.stepSummary}`
        : `Running: ${task.state.stepSummary}`;
    case "awaiting_approval":
      return isZh
        ? `等待确认 [${task.state.riskTier}] ${task.state.actionSummary}`
        : `Awaiting approval [${task.state.riskTier}] ${task.state.actionSummary}`;
    case "paused_for_user":
      return isZh
        ? `等待操作 (${task.state.reason})：${task.state.instructions}`
        : `Paused (${task.state.reason}): ${task.state.instructions}`;
    case "completed":
      return isZh ? `已完成：${task.state.summary}` : `Completed: ${task.state.summary}`;
    case "failed":
      return isZh ? `失败：${task.state.error}` : `Failed: ${task.state.error}`;
    case "cancelled":
      return isZh
        ? `已取消 (${task.state.cancelledAt})`
        : `Cancelled (${task.state.cancelledAt})`;
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

/** Collapsible right sidebar focused solely on background tasks and approvals. */
export function TasksSidebar(props: TasksSidebarProps) {
  const { store } = props;
  const sidebarMotion = createEnterMotion("fadeInRight", 200);

  return (
    <View
      testID="tasks-sidebar"
      class="bg-card border-l border-border"
      style={[
        sidebarMotion.style,
        {
          width: "36%",
          minWidth: 280,
          maxWidth: 380,
          padding: 14,
          gap: 12,
          overflow: "hidden",
        },
      ]}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
        }}
      >
        <Text class="text-sm font-semibold text-foreground">{t("tasksTitle")}</Text>
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
          <Text class="text-xs font-medium text-muted-foreground">{t("btnClose")}</Text>
        </Button>
      </View>

      <Scroll style={{ flex: 1, minWidth: 0 }} contentStyle={{ gap: 10 }}>
        <If
          when={store.tasks().length > 0}
          else={
            <View class="p-4 rounded-xl border border-border bg-background" style={{ gap: 6 }}>
              <Text class="text-sm font-medium text-foreground">{t("tasksEmptyTitle")}</Text>
              <Text class="text-xs text-muted-foreground" style={{ lineHeight: 17 }}>
                {t("tasksEmptyDesc")}
              </Text>
              <Button
                testID="tasks-open-settings-btn"
                onPress={() => {
                  animateLayout("ease");
                  store.settingsSection.set("models");
                  store.activePage.set("settings");
                }}
                class="self-start px-2.5 py-1 rounded-md bg-secondary border border-border"
                style={[BUTTON_MOTION_STYLE, { marginTop: 4 }]}
                activeStyle={BUTTON_ACTIVE_STYLE}
              >
                <Text class="text-xs text-secondary-foreground">
                  {t("tasksOpenSettingsHint")}
                </Text>
              </Button>
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
                    gap: 8,
                  }}
                >
                  <Text
                    class="text-sm font-semibold text-foreground"
                    style={{ flex: 1, minWidth: 0 }}
                  >
                    {task().title}
                  </Text>
                  <Text class="text-xs text-muted-foreground">
                    {DaemonDefaults.shortId(task().id)}
                  </Text>
                </View>
                <Text class="text-xs text-muted-foreground" style={{ lineHeight: 16 }}>
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
                      <Text class="text-xs font-semibold text-primary-foreground">
                        {t("btnApprove")}
                      </Text>
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
                      <Text class="text-xs font-semibold text-primary-foreground">
                        {t("btnDeny")}
                      </Text>
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
                      {t("btnResumeLogin")}
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
                    <Text class="text-xs font-medium text-secondary-foreground">
                      {t("btnCancel")}
                    </Text>
                  </Button>
                </If>
              </View>
            )}
          </Each>
        </If>
      </Scroll>
    </View>
  );
}
