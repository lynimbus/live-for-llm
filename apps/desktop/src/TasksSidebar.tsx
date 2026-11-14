import type { TaskRecord } from "@live-for-llm/protocol";
import { DaemonDefaults } from "companiondesktop/native";
import { Image, Scroll, signal, Text, View } from "nsh";
import { Button } from "nsh/base";
import { currentLocale, t } from "./i18n.ts";
import { ChevronIcon, CloseIcon } from "./icons.tsx";
import {
  animateLayout,
  BUTTON_ACTIVE_STYLE,
  BUTTON_MOTION_STYLE,
  createEnterMotion,
} from "./motion.ts";
import type { CompanionUiStore } from "./state.ts";

export interface TasksSidebarProps {
  readonly store: CompanionUiStore;
}

function getTaskBadge(task: TaskRecord): { readonly label: string; readonly dotClass: string } {
  switch (task.state.kind) {
    case "queued":
      return { label: t("taskBadgeQueued"), dotClass: "bg-muted-foreground" };
    case "running":
      return { label: t("taskBadgeRunning"), dotClass: "bg-amber-400" };
    case "awaiting_approval":
      return { label: t("taskBadgeApproval"), dotClass: "bg-amber-400" };
    case "paused_for_user":
      return { label: t("taskBadgePaused"), dotClass: "bg-amber-400" };
    case "completed":
      return { label: t("taskBadgeCompleted"), dotClass: "bg-emerald-400" };
    case "failed":
      return { label: t("taskBadgeFailed"), dotClass: "bg-destructive" };
    case "cancelled":
      return { label: t("taskBadgeCancelled"), dotClass: "bg-muted-foreground" };
  }
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

/** Collapsible right sidebar showing each background task as a compact title accordion. */
export function TasksSidebar(props: TasksSidebarProps) {
  const { store } = props;
  const sidebarMotion = createEnterMotion("fadeInRight", 180);
  const toggledMap = signal<Record<string, boolean>>({});

  const isExpanded = (task: TaskRecord): boolean => {
    const override = toggledMap()[task.id];
    if (override !== undefined) return override;
    return (
      task.state.kind === "awaiting_approval" || task.state.kind === "paused_for_user"
    );
  };

  const toggleTask = (task: TaskRecord) => {
    animateLayout("ease");
    const nextVal = !isExpanded(task);
    toggledMap.update((prev) => ({ ...prev, [task.id]: nextVal }));
  };

  return (
    <View
      testID="tasks-sidebar"
      class="bg-card border-l border-border"
      style={[
        sidebarMotion.style,
        {
          width: 288,
          minWidth: 248,
          maxWidth: 332,
          flexShrink: 0,
          padding: 12,
          gap: 10,
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
          tooltip={t("btnClose")}
          onPress={() => {
            animateLayout("ease");
            store.drawerOpen.set(false);
          }}
          class="p-1.5 rounded-lg"
          style={BUTTON_MOTION_STYLE}
          hoverStyle={{ backgroundColor: "rgba(255,255,255,0.06)" }}
          activeStyle={BUTTON_ACTIVE_STYLE}
        >
          <CloseIcon size={15} colorToken="muted-foreground" />
        </Button>
      </View>

      <Scroll style={{ flex: 1, minWidth: 0 }} contentStyle={{ gap: 8 }}>
        <If
          when={store.tasks().length > 0}
          else={
            <View class="p-4 rounded-xl border border-border bg-secondary" style={{ gap: 6 }}>
              <Text class="text-xs font-semibold text-foreground">{t("tasksEmptyTitle")}</Text>
              <Text class="text-xs text-muted-foreground" style={{ lineHeight: 17 }}>
                {t("tasksEmptyDesc")}
              </Text>
              <Button
                testID="tasks-open-settings-btn"
                onPress={() => {
                  animateLayout("ease");
                  store.settingsSection.set("harness");
                  store.activePage.set("settings");
                }}
                class="self-start px-2.5 py-1 rounded-md bg-muted border border-border"
                style={[BUTTON_MOTION_STYLE, { marginTop: 4 }]}
                activeStyle={BUTTON_ACTIVE_STYLE}
              >
                <Text class="text-xs text-foreground">{t("tasksOpenSettingsHint")}</Text>
              </Button>
            </View>
          }
        >
          <Each of={store.tasks()}>
            {(task) => {
              const badge = () => getTaskBadge(task());
              const expanded = () => isExpanded(task());
              return (
                <View class="rounded-xl border border-border bg-secondary" style={{ overflow: "hidden" }}>
                  <Button
                    testID={`task-toggle-${task().id}`}
                    onPress={() => toggleTask(task())}
                    class="px-3 py-2.5"
                    style={[
                      BUTTON_MOTION_STYLE,
                      {
                        flexDirection: "row",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: 8,
                        width: "100%",
                      },
                    ]}
                    hoverStyle={{ backgroundColor: "rgba(255,255,255,0.04)" }}
                    activeStyle={BUTTON_ACTIVE_STYLE}
                  >
                    <View
                      style={{
                        flexDirection: "row",
                        alignItems: "center",
                        gap: 8,
                        flex: 1,
                        minWidth: 0,
                      }}
                    >
                      <View
                        class={badge().dotClass}
                        style={{ width: 7, height: 7, borderRadius: 4, flexShrink: 0 }}
                      />
                      <Text
                        class="text-xs font-medium text-foreground truncate"
                        style={{ flex: 1, minWidth: 0 }}
                      >
                        {task().title}
                      </Text>
                    </View>
                    <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexShrink: 0 }}>
                      <Text class="text-[10px] text-muted-foreground">{badge().label}</Text>
                      <ChevronIcon expanded={expanded} size={13} colorToken="muted-foreground" />
                    </View>
                  </Button>

                  <If when={expanded()}>
                    <View
                      testID={`task-details-${task().id}`}
                      class="px-3 pb-3 pt-1 border-t border-border"
                      style={{ gap: 8 }}
                    >
                      <Text class="text-[11px] text-muted-foreground" style={{ lineHeight: 16 }}>
                        {`${task().taskKind} • ${DaemonDefaults.shortId(task().id)} • ${summarizeTaskState(task())}`}
                      </Text>

                      <If when={resolveTaskScreenshot(store, task())}>
                        {(b64) => (
                          <Image
                            testID={`task-shot-${task().id}`}
                            src={`data:image/png;base64,${b64()}`}
                            style={{ width: "100%", height: 136, borderRadius: 8 }}
                          />
                        )}
                      </If>

                      <If when={task().state.kind === "awaiting_approval"}>
                        <View style={{ flexDirection: "row", gap: 6 }}>
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
                            <Text class="text-xs font-semibold text-foreground">
                              {t("btnDeny")}
                            </Text>
                          </Button>
                        </View>
                      </If>

                      <If when={task().state.kind === "paused_for_user"}>
                        <Button
                          testID={`resume-${task().id}`}
                          onPress={() => void store.resumeBrowserTask(task().id)}
                          class="self-start px-3 py-1 rounded-md bg-primary"
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
                          class="self-start px-2.5 py-1 rounded-md bg-muted border border-border"
                          style={BUTTON_MOTION_STYLE}
                          activeStyle={BUTTON_ACTIVE_STYLE}
                        >
                          <Text class="text-xs font-medium text-foreground">
                            {t("btnCancel")}
                          </Text>
                        </Button>
                      </If>
                    </View>
                  </If>
                </View>
              );
            }}
          </Each>
        </If>
      </Scroll>
    </View>
  );
}
