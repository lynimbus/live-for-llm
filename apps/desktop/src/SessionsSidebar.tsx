import type { ConversationId, ConversationSummary } from "@live-for-llm/protocol";
import { Scroll, signal, Text, View } from "nsh";
import { Button, Input } from "nsh/base";
import { Menu } from "nsh/desktop";
import { t } from "./i18n.ts";
import { NewChatIcon, SidebarIcon } from "./icons.tsx";
import {
  animateLayout,
  BUTTON_ACTIVE_STYLE,
  BUTTON_MOTION_STYLE,
  createEnterMotion,
} from "./motion.ts";
import type { CompanionUiStore } from "./state.ts";
import { CompanionAvatar } from "./ui.tsx";

export interface SessionsSidebarProps {
  readonly store: CompanionUiStore;
  readonly isBusy: () => boolean;
}

/** ChatGPT-style left conversations sidebar with profile/avatar Settings entry at bottom. */
export function SessionsSidebar(props: SessionsSidebarProps) {
  const { store } = props;
  const sidebarMotion = createEnterMotion("fadeInLeft", 180);
  const renamingId = signal<ConversationId | null>(null);
  const renameDraft = signal("");

  const startRename = (conv: ConversationSummary) => {
    renamingId.set(conv.id);
    renameDraft.set(conv.title);
  };

  const commitRename = async () => {
    const target = renamingId();
    if (!target) return;
    const ok = await store.renameConversation(target, renameDraft());
    if (ok) {
      renamingId.set(null);
    }
  };

  const companionInitial = () => {
    const name = store.relationship().companionName.trim();
    return name ? name.slice(0, 1).toUpperCase() : "L";
  };

  return (
    <View
      testID="sessions-sidebar"
      class="bg-card border-r border-border"
      style={[
        sidebarMotion.style,
        {
          width: 224,
          minWidth: 196,
          maxWidth: 256,
          flexShrink: 0,
          padding: 10,
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
          gap: 6,
        }}
      >
        <Button
          testID="collapse-sidebar-btn"
          tooltip={t("navHideSidebar")}
          onPress={() => {
            animateLayout("ease");
            store.sidebarOpen.set(false);
          }}
          class="p-2 rounded-lg"
          style={BUTTON_MOTION_STYLE}
          hoverStyle={{ backgroundColor: "rgba(255,255,255,0.06)" }}
          activeStyle={BUTTON_ACTIVE_STYLE}
        >
          <SidebarIcon size={17} colorToken="muted-foreground" />
        </Button>

        <Button
          testID="new-chat-btn"
          onPress={() => {
            animateLayout("ease");
            void store.createConversation();
          }}
          class="flex-1 px-2.5 py-2 rounded-lg"
          style={[
            BUTTON_MOTION_STYLE,
            { flexDirection: "row", alignItems: "center", justifyContent: "flex-start", gap: 8 },
          ]}
          hoverStyle={{ backgroundColor: "rgba(255,255,255,0.06)" }}
          activeStyle={BUTTON_ACTIVE_STYLE}
        >
          <NewChatIcon size={16} colorToken="foreground" />
          <Text class="text-xs font-medium text-foreground">{t("navNewChat")}</Text>
        </Button>
      </View>

      <Text class="text-[11px] font-medium text-muted-foreground px-2">
        {t("conversationsTitle")}
      </Text>

      <Scroll style={{ flex: 1, minWidth: 0 }} contentStyle={{ gap: 2 }}>
        <Each of={store.conversations()}>
          {(conv) => {
            const isActive = () => conv().id === store.conversationId();
            const isRenaming = () => renamingId() === conv().id;
            const openConvMenu = (pagePosition: { x: number; y: number }) => {
              void Menu.popup(
                [
                  { label: t("navRename"), onSelect: () => startRename(conv()) },
                  { type: "separator" },
                  {
                    label: t("navDeleteChat"),
                    onSelect: () => void store.deleteConversation(conv().id),
                  },
                ],
                pagePosition,
              );
            };

            return (
              <If
                when={isRenaming()}
                else={
                  <View onContextMenu={(e) => openConvMenu(e.pagePosition)}>
                    <Button
                      testID={`conv-item-${conv().id}`}
                      onPress={() => {
                        animateLayout("ease");
                        void store.switchConversation(conv().id);
                      }}
                      class={isActive() ? "px-2.5 py-2 rounded-lg bg-muted" : "px-2.5 py-2 rounded-lg"}
                      style={[
                        BUTTON_MOTION_STYLE,
                        { alignItems: "flex-start", justifyContent: "center", gap: 2, width: "100%" },
                      ]}
                      hoverStyle={{ backgroundColor: "rgba(255,255,255,0.05)" }}
                      activeStyle={BUTTON_ACTIVE_STYLE}
                    >
                      <Text
                        class={
                          isActive()
                            ? "text-xs font-medium text-foreground truncate"
                            : "text-xs text-muted-foreground truncate"
                        }
                        style={{ width: "100%" }}
                      >
                        {conv().title}
                      </Text>
                    </Button>
                  </View>
                }
              >
                <View class="p-1.5 rounded-lg bg-muted" style={{ gap: 6 }}>
                  <Input
                    testID={`conv-rename-input-${conv().id}`}
                    value={renameDraft()}
                    placeholder={t("renamePlaceholder")}
                    submitBehavior="submit"
                    onChange={(e) => renameDraft.set(e.value)}
                    onSubmit={() => void commitRename()}
                    class="px-2 py-1 rounded bg-background border border-border text-xs text-foreground"
                  />
                  <View style={{ flexDirection: "row", gap: 4 }}>
                    <Button
                      onPress={() => void commitRename()}
                      class="px-2 py-0.5 rounded bg-primary"
                      style={BUTTON_MOTION_STYLE}
                    >
                      <Text class="text-[11px] font-medium text-primary-foreground">
                        {t("btnSave")}
                      </Text>
                    </Button>
                    <Button
                      onPress={() => renamingId.set(null)}
                      class="px-2 py-0.5 rounded bg-secondary"
                      style={BUTTON_MOTION_STYLE}
                    >
                      <Text class="text-[11px] text-secondary-foreground">{t("btnCancel")}</Text>
                    </Button>
                  </View>
                </View>
              </If>
            );
          }}
        </Each>
      </Scroll>

      <Button
        testID="sidebar-avatar-btn"
        tooltip={t("sidebarProfileHint")}
        onPress={() => {
          animateLayout("ease");
          store.settingsSection.set("general");
          store.activePage.set("settings");
        }}
        class="p-2 rounded-xl border border-border bg-secondary"
        style={[
          BUTTON_MOTION_STYLE,
          { flexDirection: "row", alignItems: "center", justifyContent: "flex-start", gap: 10 },
        ]}
        hoverStyle={{ opacity: 0.92 }}
        activeStyle={BUTTON_ACTIVE_STYLE}
      >
        <View style={{ width: 30, height: 30, position: "relative", flexShrink: 0 }}>
          <CompanionAvatar
            avatarSrc={() => store.relationship().companionAvatar}
            initial={companionInitial}
            size={30}
          />
          <View
            class={
              props.isBusy()
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
              borderColor: "#171717",
            }}
          />
        </View>
        <View style={{ flex: 1, minWidth: 0, alignItems: "flex-start", gap: 1 }}>
          <Text class="text-xs font-semibold text-foreground truncate">
            {`${store.relationship().companionName} · ${store.relationship().userName}`}
          </Text>
          <Text class="text-[10px] text-muted-foreground truncate">
            {t("sidebarProfileHint")}
          </Text>
        </View>
      </Button>
    </View>
  );
}
