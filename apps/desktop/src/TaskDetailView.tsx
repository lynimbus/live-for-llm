import type { TaskRecord, TaskTraceEntry, TaskTraceKind } from "@live-for-llm/protocol";
import { DaemonDefaults } from "companiondesktop/native";
import { effect, Image, Scroll, type ScrollRef, signal, Text, View } from "nsh";
import { Button } from "nsh/base";
import { currentLocale, t } from "./i18n.ts";
import { CloseIcon } from "./icons.tsx";
import {
  animateLayout,
  BUTTON_ACTIVE_STYLE,
  BUTTON_MOTION_STYLE,
  createEnterMotion,
} from "./motion.ts";
import type { CompanionUiStore } from "./state.ts";

export interface TaskDetailViewProps {
  readonly store: CompanionUiStore;
}

function getTraceKindMeta(kind: TaskTraceKind, isError?: boolean): {
  readonly label: string;
  readonly badgeClass: string;
} {
  if (isError || kind === "error") {
    return { label: t("taskDetailTraceError"), badgeClass: "bg-destructive text-foreground" };
  }
  switch (kind) {
    case "planning":
      return { label: t("taskDetailTracePlan"), badgeClass: "bg-secondary text-muted-foreground" };
    case "tool_call":
      return { label: t("taskDetailTraceCall"), badgeClass: "bg-primary text-primary-foreground" };
    case "tool_result":
      return { label: t("taskDetailTraceResult"), badgeClass: "bg-secondary text-emerald-400" };
    case "browser_action":
      return { label: t("taskDetailTraceBrowser"), badgeClass: "bg-secondary text-foreground" };
    case "cli_output":
      return { label: t("taskDetailTraceCli"), badgeClass: "bg-secondary text-muted-foreground" };
    case "approval":
      return { label: t("taskDetailTraceApproval"), badgeClass: "bg-secondary text-amber-400" };
    case "status":
      return { label: t("taskDetailTraceStatus"), badgeClass: "bg-secondary text-foreground" };
  }
}

function getTaskStatusMeta(task: TaskRecord): { readonly label: string; readonly dotClass: string } {
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

function formatTraceTime(iso: string): string {
  const idx = iso.indexOf("T");
  if (idx === -1) return iso;
  return iso.slice(idx + 1, idx + 9);
}

function formatActiveStep(state: TaskRecord["state"]): string {
  switch (state.kind) {
    case "running":
      return state.stepSummary;
    case "awaiting_approval":
      return state.actionSummary;
    case "paused_for_user":
      return state.instructions;
    default:
      return currentLocale() === "zh-CN" ? "任务正在等待执行…" : "Task queued…";
  }
}

function formatOutcomeText(state: TaskRecord["state"]): string {
  if (state.kind === "completed") return state.summary;
  if (state.kind === "failed") return state.error;
  return "";
}

/** Alma-style live execution inspector showing real-time LLM steps, CLI output, and browser viewport. */
export function TaskDetailView(props: TaskDetailViewProps) {
  const { store } = props;
  const viewMotion = createEnterMotion("fadeInUp", 160);
  const traceScrollRef = signal<ScrollRef | undefined>(undefined);
  const traceViewportHeight = signal(0);
  const traceContentHeight = signal(0);

  const currentTask = (): TaskRecord | undefined => {
    const id = store.inspectedTaskId();
    if (!id) return store.tasks()[0];
    return store.tasks().find((item) => item.id === id) ?? store.tasks()[0];
  };

  const traces = (): readonly TaskTraceEntry[] => {
    const task = currentTask();
    if (!task) return [];
    return store.taskTraces()[task.id] ?? [];
  };

  const browserFrame = () => {
    const task = currentTask();
    if (!task) return undefined;
    const frame = store.browserFrames()[task.id];
    if (frame) return frame;
    const fallbackShot = store.screenshots()[task.id];
    if (fallbackShot) {
      return { base64: fallbackShot, url: "", capturedAt: task.updatedAt };
    }
    if (task.state.kind === "running" && task.state.latestScreenshotBase64) {
      return {
        base64: task.state.latestScreenshotBase64,
        url: task.state.latestUrl ?? "",
        capturedAt: task.updatedAt,
      };
    }
    return undefined;
  };

  const showBrowserPane = (): boolean => {
    const task = currentTask();
    if (!task) return false;
    return (
      task.taskKind === "browser_research" ||
      task.taskKind === "browser_post" ||
      browserFrame() !== undefined
    );
  };

  effect(() => {
    const list = traces();
    const ref = traceScrollRef();
    const contentH = traceContentHeight();
    const viewH = traceViewportHeight();
    if (!ref || list.length === 0 || contentH <= 0) return;
    const y = viewH > 0 ? Math.max(0, contentH - viewH) : contentH;
    ref.scrollTo({ y, animated: true });
  });

  const goBack = () => {
    animateLayout("ease");
    store.activePage.set("chat");
  };

  return (
    <View
      testID="task-detail-view"
      class="bg-background"
      style={[viewMotion.style, { flex: 1, minWidth: 0, overflow: "hidden" }]}
    >
      {/* Top inspector header */}
      <View
        class="px-4 py-2.5 border-b border-border bg-card"
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 10,
        }}
      >
        <View
          style={{
            flex: 1,
            flexDirection: "row",
            alignItems: "center",
            gap: 10,
            minWidth: 0,
            overflow: "hidden",
          }}
        >
          <Button
            testID="task-detail-back-btn"
            onPress={goBack}
            class="px-2.5 py-1.5 rounded-lg bg-secondary border border-border"
            style={[BUTTON_MOTION_STYLE, { flexShrink: 0 }]}
            hoverStyle={{ opacity: 0.9 }}
            activeStyle={BUTTON_ACTIVE_STYLE}
          >
            <Text class="text-xs font-medium text-foreground">{t("taskDetailBack")}</Text>
          </Button>

          <If when={currentTask()}>
            {(task) => {
              const meta = () => getTaskStatusMeta(task());
              return (
                <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 6, minWidth: 0 }}>
                    <View
                      class={meta().dotClass}
                      style={{ width: 8, height: 8, borderRadius: 4, flexShrink: 0 }}
                    />
                    <Text class="text-sm font-semibold text-foreground truncate">
                      {task().title}
                    </Text>
                  </View>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                    <Text class="text-[11px] text-muted-foreground">
                      {`${meta().label} · ${t("taskDetailRunnerLabel", { runner: task().runnerId })} · ${DaemonDefaults.shortId(task().id)} · ${t("taskDetailStepsCount", { count: traces().length })}`}
                    </Text>
                  </View>
                </View>
              );
            }}
          </If>
        </View>

        <Button
          testID="task-detail-close-btn"
          tooltip={t("btnClose")}
          onPress={goBack}
          class="p-1.5 rounded-lg"
          style={[BUTTON_MOTION_STYLE, { flexShrink: 0 }]}
          hoverStyle={{ backgroundColor: "rgba(255,255,255,0.06)" }}
          activeStyle={BUTTON_ACTIVE_STYLE}
        >
          <CloseIcon size={16} colorToken="muted-foreground" />
        </Button>
      </View>

      {/* Main inspector body */}
      <View style={{ flex: 1, padding: 14, gap: 12, minWidth: 0, overflow: "hidden" }}>
        <If when={currentTask()}>
          {(task) => (
            <If
              when={
                task().state.kind === "awaiting_approval" ||
                task().state.kind === "paused_for_user" ||
                task().state.kind === "running" ||
                task().state.kind === "queued"
              }
            >
              <View
                class="px-3 py-2 rounded-xl border border-border bg-card"
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 8,
                  flexWrap: "wrap",
                }}
              >
                <Text class="text-xs text-muted-foreground" style={{ flex: 1, minWidth: 160 }}>
                  {formatActiveStep(task().state)}
                </Text>
                <View style={{ flexDirection: "row", gap: 6, flexShrink: 0 }}>
                  <If when={task().state.kind === "awaiting_approval"}>
                    <Button
                      testID={`detail-approve-${task().id}`}
                      onPress={() => {
                        const st = task().state;
                        if (st.kind === "awaiting_approval") {
                          void store.decideApproval(st.approvalId, "approved");
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
                      testID={`detail-deny-${task().id}`}
                      onPress={() => {
                        const st = task().state;
                        if (st.kind === "awaiting_approval") {
                          void store.decideApproval(st.approvalId, "denied");
                        }
                      }}
                      class="px-3 py-1 rounded-md bg-destructive"
                      style={BUTTON_MOTION_STYLE}
                      activeStyle={BUTTON_ACTIVE_STYLE}
                    >
                      <Text class="text-xs font-semibold text-foreground">{t("btnDeny")}</Text>
                    </Button>
                  </If>
                  <If when={task().state.kind === "paused_for_user"}>
                    <Button
                      testID={`detail-resume-${task().id}`}
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
                      testID={`detail-cancel-${task().id}`}
                      onPress={() => void store.cancelTask(task().id)}
                      class="px-2.5 py-1 rounded-md bg-secondary border border-border"
                      style={BUTTON_MOTION_STYLE}
                      activeStyle={BUTTON_ACTIVE_STYLE}
                    >
                      <Text class="text-xs font-medium text-foreground">{t("btnCancel")}</Text>
                    </Button>
                  </If>
                </View>
              </View>
            </If>
          )}
        </If>

        {/* Live Browser Viewport Panel (shown for browser tasks / screenshots) */}
        <If when={showBrowserPane()}>
          <View
            testID="task-detail-browser-pane"
            class="rounded-xl border border-border bg-card"
            style={{ overflow: "hidden", flexShrink: 0 }}
          >
            <View
              class="px-3 py-2 border-b border-border bg-secondary"
              style={{
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 8,
              }}
            >
              <Text class="text-xs font-semibold text-foreground" style={{ flexShrink: 0 }}>
                {t("taskDetailBrowserTitle")}
              </Text>
              <View
                class="px-2.5 py-1 rounded-md bg-background border border-border"
                style={{ flex: 1, minWidth: 0, overflow: "hidden" }}
              >
                <Text testID="task-detail-browser-url" class="text-[11px] text-muted-foreground truncate">
                  {browserFrame()?.url || "about:blank"}
                </Text>
              </View>
            </View>

            <If
              when={browserFrame()}
              else={
                <View
                  style={{
                    height: 170,
                    alignItems: "center",
                    justifyContent: "center",
                    padding: 16,
                  }}
                >
                  <Text class="text-xs text-muted-foreground">{t("taskDetailWaitingBrowser")}</Text>
                </View>
              }
            >
              {(frame) => (
                <Image
                  testID="task-detail-browser-shot"
                  src={`data:image/jpeg;base64,${frame().base64}`}
                  style={{ width: "100%", height: 230 }}
                />
              )}
            </If>
          </View>
        </If>

        {/* Real-time LLM / CLI Action Stream */}
        <View
          class="rounded-xl border border-border bg-card"
          style={{ flex: 1, minHeight: 0, overflow: "hidden" }}
        >
          <View class="px-3 py-2 border-b border-border">
            <Text class="text-xs font-semibold text-foreground">
              {t("taskDetailTimelineTitle")}
            </Text>
          </View>

          <Scroll
            ref={(el) => traceScrollRef.set(el)}
            onLayout={(e) => traceViewportHeight.set(e.bounds.size.height)}
            style={{ flex: 1 }}
            contentStyle={{ padding: 12, gap: 8 }}
          >
            <View
              onLayout={(e) => traceContentHeight.set(e.bounds.size.height)}
              style={{ gap: 8 }}
            >
              <If
                when={traces().length > 0}
                else={
                  <Text class="text-xs text-muted-foreground" style={{ paddingVertical: 8 }}>
                    {t("taskDetailNoTraces")}
                  </Text>
                }
              >
                <Each of={traces()}>
                  {(entry) => {
                    const meta = () => getTraceKindMeta(entry().kind, entry().isError);
                    return (
                      <View
                        testID={`trace-item-${entry().id}`}
                        class="p-2.5 rounded-lg border border-border bg-secondary"
                        style={{ gap: 4 }}
                      >
                        <View
                          style={{
                            flexDirection: "row",
                            alignItems: "center",
                            justifyContent: "space-between",
                            gap: 8,
                          }}
                        >
                          <View
                            style={{
                              flexDirection: "row",
                              alignItems: "center",
                              gap: 6,
                              flex: 1,
                              minWidth: 0,
                            }}
                          >
                            <View class={`px-1.5 py-0.5 rounded ${meta().badgeClass}`}>
                              <Text class="text-[10px] font-semibold">{meta().label}</Text>
                            </View>
                            <If when={entry().toolName}>
                              {(toolName) => (
                                <View class="px-1.5 py-0.5 rounded bg-background border border-border">
                                  <Text class="text-[10px] text-foreground">{toolName()}</Text>
                                </View>
                              )}
                            </If>
                            <Text class="text-xs font-medium text-foreground truncate">
                              {entry().title}
                            </Text>
                          </View>
                          <Text class="text-[10px] text-muted-foreground" style={{ flexShrink: 0 }}>
                            {formatTraceTime(entry().createdAt)}
                          </Text>
                        </View>

                        <If when={entry().url}>
                          {(url) => (
                            <Text class="text-[11px] text-muted-foreground truncate">
                              {url()}
                            </Text>
                          )}
                        </If>

                        <If when={entry().detail}>
                          {(detail) => (
                            <Text
                              class={
                                entry().isError
                                  ? "text-[11px] text-destructive"
                                  : "text-[11px] text-muted-foreground"
                              }
                              style={{ lineHeight: 16 }}
                            >
                              {detail()}
                            </Text>
                          )}
                        </If>
                      </View>
                    );
                  }}
                </Each>
              </If>

              <If when={currentTask()}>
                {(task) => (
                  <If when={task().state.kind === "completed" || task().state.kind === "failed"}>
                    <View
                      class={
                        task().state.kind === "failed"
                          ? "p-3 rounded-lg border border-destructive bg-secondary"
                          : "p-3 rounded-lg border border-border bg-secondary"
                      }
                      style={{ gap: 4, marginTop: 4 }}
                    >
                      <Text class="text-xs font-semibold text-foreground">
                        {task().state.kind === "completed"
                          ? t("taskBadgeCompleted")
                          : t("taskBadgeFailed")}
                      </Text>
                      <Text
                        class={
                          task().state.kind === "failed"
                            ? "text-xs text-destructive"
                            : "text-xs text-foreground"
                        }
                        style={{ lineHeight: 18 }}
                      >
                        {formatOutcomeText(task().state)}
                      </Text>
                    </View>
                  </If>
                )}
              </If>
            </View>
          </Scroll>
        </View>
      </View>
    </View>
  );
}
