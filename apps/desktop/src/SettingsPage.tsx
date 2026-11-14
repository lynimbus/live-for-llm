import {
  LLM_PROVIDER_KINDS,
  type LlmProviderKind,
  MEMORY_KINDS,
  TRUST_POLICY_MODES,
  type MemoryKind,
  type TrustPolicyMode,
} from "@live-for-llm/protocol";
import { effect, Scroll, signal, Text, View } from "nsh";
import { Button, Input } from "nsh/base";
import { currentLocale, setLocale, t } from "./i18n.ts";
import {
  animateLayout,
  BUTTON_ACTIVE_STYLE,
  BUTTON_MOTION_STYLE,
  CARD_ELEVATION_STYLE,
  createEnterMotion,
} from "./motion.ts";
import type { CompanionUiStore, SettingsSection } from "./state.ts";
import { SelectablePill } from "./ui.tsx";

export interface SettingsPageProps {
  readonly store: CompanionUiStore;
}

const PROVIDER_LABELS: Record<LlmProviderKind, string> = {
  openai_compatible: "OpenAI / Compatible",
  anthropic: "Anthropic",
  gemini: "Gemini",
};

type AssignRole = "chat" | "task" | "memory";

function getMemoryKindLabel(kind: MemoryKind): string {
  switch (kind) {
    case "fact":
      return t("memoryKindFact");
    case "episode":
      return t("memoryKindEpisode");
    case "preference":
      return t("memoryKindPreference");
    case "relationship":
      return t("memoryKindRelationship");
  }
}

function getPolicyLabel(mode: TrustPolicyMode): string {
  switch (mode) {
    case "trust_auto":
      return t("policyTrustAuto");
    case "confirm_external":
      return t("policyConfirmExternal");
    case "allowlist":
      return t("policyAllowlist");
  }
}

function getPolicyDescription(mode: TrustPolicyMode): string {
  const isZh = currentLocale() === "zh-CN";
  switch (mode) {
    case "trust_auto":
      return isZh
        ? "常规任务与网页操作自动执行，仅高危破坏性指令暂停确认。"
        : "Runs standard browser and utility actions automatically; confirms destructive commands.";
    case "confirm_external":
      return isZh
        ? "对外发帖、发送消息或敏感操作前暂停并弹窗请求确认。"
        : "Pauses and asks for approval before posting or sending externally.";
    case "allowlist":
      return isZh
        ? "仅白名单域名上的外部操作自动放行，其余均需手动确认。"
        : "Auto-approves only allowlisted domains; all other external sends require approval.";
  }
}

/** Dedicated full-width Settings & Memories page separated from chat and task sidebar. */
export function SettingsPage(props: SettingsPageProps) {
  const { store } = props;
  const pageMotion = createEnterMotion("fadeInUp", 180);

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

  const assignRole = signal<AssignRole>("chat");
  const modelSearch = signal("");

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

  const filteredModels = () => {
    const query = modelSearch().trim().toLowerCase();
    const list = store.fetchedModels();
    const filtered = query
      ? list.filter((id) => id.toLowerCase().includes(query))
      : list;
    return filtered.slice(0, 60);
  };

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

  async function handleFetchModels() {
    const baseUrl = apiBaseUrl().trim();
    if (!baseUrl) {
      store.statusBanner.set(t("errNeedBaseUrl"));
      return;
    }
    const keyVal = apiKey().trim();
    await store.fetchModels({
      provider: apiProvider(),
      baseUrl,
      ...(keyVal ? { apiKey: keyVal } : {}),
    });
  }

  function applyFetchedModel(modelId: string) {
    modelsDirty.set(true);
    const target = assignRole();
    if (target === "chat") {
      chatModel.set(modelId);
    } else if (target === "task") {
      taskModel.set(modelId);
    } else {
      memoryModel.set(modelId);
    }
  }

  function isModelSelectedForRole(modelId: string): boolean {
    const target = assignRole();
    if (target === "chat") return chatModel() === modelId;
    if (target === "task") return taskModel() === modelId;
    return memoryModel() === modelId;
  }

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
      store.statusBanner.set(t("errNeedUrlAndModel"));
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

  const switchSection = (section: SettingsSection) => {
    animateLayout("ease");
    store.settingsSection.set(section);
  };

  return (
    <View
      testID="settings-page"
      class="bg-background"
      style={[pageMotion.style, { flex: 1, minWidth: 0, overflow: "hidden" }]}
    >
      <View
        class="px-5 py-3 border-b border-border bg-card"
        style={{
          flexDirection: "row",
          flexWrap: "wrap",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 10,
        }}
      >
        <View style={{ gap: 2 }}>
          <Text class="text-base font-semibold text-foreground">{t("settingsTitle")}</Text>
          <Text class="text-xs text-muted-foreground">{t("settingsSubtitle")}</Text>
        </View>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
          <SelectablePill
            testID="settings-tab-models"
            label={() => t("settingsTabModels")}
            selected={() => store.settingsSection() === "models"}
            onPress={() => switchSection("models")}
          />
          <SelectablePill
            testID="settings-tab-memories"
            label={() => t("settingsTabMemories")}
            selected={() => store.settingsSection() === "memories"}
            onPress={() => switchSection("memories")}
          />
          <SelectablePill
            testID="settings-tab-general"
            label={() => t("settingsTabGeneral")}
            selected={() => store.settingsSection() === "general"}
            onPress={() => switchSection("general")}
          />
        </View>
      </View>

      <Scroll
        style={{ flex: 1, minWidth: 0 }}
        contentStyle={{ padding: 20, gap: 14, alignItems: "center" }}
      >
        <View style={{ width: "100%", maxWidth: 780, gap: 14, minWidth: 0 }}>
          <If when={store.settingsSection() === "models"}>
            <View
              class="p-4 rounded-2xl border border-border bg-card"
              style={[CARD_ELEVATION_STYLE, { gap: 10 }]}
            >
              <View
                style={{
                  flexDirection: "row",
                  justifyContent: "space-between",
                  alignItems: "center",
                  flexWrap: "wrap",
                  gap: 8,
                }}
              >
                <Text class="text-sm font-semibold text-foreground">
                  {t("apiSectionTitle")}
                </Text>
                <Text class="text-xs text-muted-foreground">
                  {store.modelSettings().hasApiKey
                    ? t("apiKeyConfigured", {
                        masked: store.modelSettings().apiKeyMasked ?? "configured",
                      })
                    : t("apiKeyUnset")}
                </Text>
              </View>

              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
                <Each of={LLM_PROVIDER_KINDS}>
                  {(provider) => {
                    const typed = (): LlmProviderKind => provider();
                    return (
                      <SelectablePill
                        testID={`provider-${typed()}`}
                        label={PROVIDER_LABELS[typed()]}
                        compact
                        selected={() => apiProvider() === typed()}
                        onPress={() => {
                          modelsDirty.set(true);
                          apiProvider.set(typed());
                        }}
                      />
                    );
                  }}
                </Each>
              </View>

              <Input
                testID="api-base-url-input"
                value={apiBaseUrl()}
                placeholder={t("apiBaseUrlPlaceholder")}
                onChange={(e) => {
                  modelsDirty.set(true);
                  apiBaseUrl.set(e.value);
                }}
                class="px-3 py-2 rounded-lg border border-border bg-background text-xs text-foreground"
              />

              <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
                <Input
                  testID="api-key-input"
                  value={apiKey()}
                  placeholder={t("apiKeyPlaceholder")}
                  onChange={(e) => apiKey.set(e.value)}
                  class="flex-1 px-3 py-2 rounded-lg border border-border bg-background text-xs text-foreground"
                  style={{ minWidth: 0 }}
                />
                <Button
                  testID="fetch-models-btn"
                  disabled={store.fetchingModels()}
                  onPress={() => void handleFetchModels()}
                  class="px-3.5 py-2 rounded-lg bg-secondary border border-border disabled:opacity-60"
                  style={BUTTON_MOTION_STYLE}
                  hoverStyle={{ opacity: 0.9 }}
                  activeStyle={BUTTON_ACTIVE_STYLE}
                >
                  <Text class="text-xs font-semibold text-secondary-foreground">
                    {store.fetchingModels() ? t("btnFetchingModels") : t("btnFetchModels")}
                  </Text>
                </Button>
              </View>

              <If when={store.fetchedModels().length > 0}>
                <View
                  testID="fetched-models-panel"
                  class="p-3 rounded-xl border border-border bg-background"
                  style={{ gap: 8 }}
                >
                  <View
                    style={{
                      flexDirection: "row",
                      flexWrap: "wrap",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: 8,
                    }}
                  >
                    <Text class="text-xs font-medium text-muted-foreground">
                      {t("applyToRoleLabel")}
                    </Text>
                    <View style={{ flexDirection: "row", gap: 4 }}>
                      <SelectablePill
                        testID="assign-role-chat"
                        label={() => t("roleChat")}
                        compact
                        selected={() => assignRole() === "chat"}
                        onPress={() => assignRole.set("chat")}
                      />
                      <SelectablePill
                        testID="assign-role-task"
                        label={() => t("roleTask")}
                        compact
                        selected={() => assignRole() === "task"}
                        onPress={() => assignRole.set("task")}
                      />
                      <SelectablePill
                        testID="assign-role-memory"
                        label={() => t("roleMemory")}
                        compact
                        selected={() => assignRole() === "memory"}
                        onPress={() => assignRole.set("memory")}
                      />
                    </View>
                  </View>

                  <Input
                    testID="model-filter-input"
                    value={modelSearch()}
                    placeholder={t("modelFilterPlaceholder")}
                    onChange={(e) => modelSearch.set(e.value)}
                    class="px-2.5 py-1.5 rounded-md border border-border bg-card text-xs text-foreground"
                  />

                  <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
                    <Each of={filteredModels()}>
                      {(modelId) => (
                        <SelectablePill
                          testID={`fetched-model-${modelId()}`}
                          label={modelId()}
                          compact
                          selected={() => isModelSelectedForRole(modelId())}
                          onPress={() => applyFetchedModel(modelId())}
                        />
                      )}
                    </Each>
                  </View>
                </View>
              </If>

              <View style={{ gap: 6 }}>
                <Text class="text-xs text-muted-foreground">{t("chatModelLabel")}</Text>
                <Input
                  testID="chat-model-input"
                  value={chatModel()}
                  placeholder={t("chatModelLabel")}
                  onChange={(e) => {
                    modelsDirty.set(true);
                    chatModel.set(e.value);
                  }}
                  class="px-3 py-2 rounded-lg border border-border bg-background text-xs text-foreground"
                />
              </View>

              <View style={{ flexDirection: "row", gap: 8 }}>
                <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
                  <Text class="text-xs text-muted-foreground">{t("taskModelLabel")}</Text>
                  <Input
                    testID="task-model-input"
                    value={taskModel()}
                    placeholder={t("taskModelLabel")}
                    onChange={(e) => {
                      modelsDirty.set(true);
                      taskModel.set(e.value);
                    }}
                    class="px-3 py-2 rounded-lg border border-border bg-background text-xs text-foreground"
                  />
                </View>
                <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
                  <Text class="text-xs text-muted-foreground">{t("memoryModelLabel")}</Text>
                  <Input
                    testID="memory-model-input"
                    value={memoryModel()}
                    placeholder={t("memoryModelLabel")}
                    onChange={(e) => {
                      modelsDirty.set(true);
                      memoryModel.set(e.value);
                    }}
                    class="px-3 py-2 rounded-lg border border-border bg-background text-xs text-foreground"
                  />
                </View>
              </View>

              <Button
                testID="save-models-btn"
                onPress={() => void saveModelSettings()}
                class="self-start px-4 py-2 rounded-lg bg-primary"
                style={[BUTTON_MOTION_STYLE, { marginTop: 4 }]}
                activeStyle={BUTTON_ACTIVE_STYLE}
              >
                <Text class="text-xs font-semibold text-primary-foreground">
                  {t("btnSaveModels")}
                </Text>
              </Button>
            </View>
          </If>

          <If when={store.settingsSection() === "memories"}>
            <View
              class="p-4 rounded-2xl border border-border bg-card"
              style={[CARD_ELEVATION_STYLE, { gap: 10 }]}
            >
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
                <SelectablePill
                  testID="filter-all"
                  label={() => t("memoryFilterAll")}
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
                      label={() => getMemoryKindLabel(kind())}
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
                placeholder={t("memorySearchPlaceholder")}
                onChange={(e) => memorySearch.set(e.value)}
                class="px-3 py-2 rounded-lg border border-border bg-background text-sm text-foreground"
              />

              <View
                class="p-3 rounded-xl border border-border bg-background"
                style={{ gap: 8 }}
              >
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 4 }}>
                  <Each of={MEMORY_KINDS}>
                    {(kind) => (
                      <SelectablePill
                        label={() => getMemoryKindLabel(kind())}
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
                  placeholder={t("memoryTitlePlaceholder")}
                  onChange={(e) => newTitle.set(e.value)}
                  class="px-3 py-1.5 rounded-md border border-border bg-card text-sm text-foreground"
                />
                <Input
                  testID="memory-new-content"
                  value={newContent()}
                  placeholder={t("memoryContentPlaceholder")}
                  onChange={(e) => newContent.set(e.value)}
                  class="px-3 py-1.5 rounded-md border border-border bg-card text-sm text-foreground"
                />
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
                  <Button
                    testID="memory-add-btn"
                    onPress={() => void submitNewMemory()}
                    class="px-3 py-1.5 rounded-md bg-primary"
                    style={BUTTON_MOTION_STYLE}
                    activeStyle={BUTTON_ACTIVE_STYLE}
                  >
                    <Text class="text-xs font-semibold text-primary-foreground">
                      {t("btnAddMemory")}
                    </Text>
                  </Button>
                  <Button
                    testID="memory-export-btn"
                    onPress={() => void store.exportMarkdown()}
                    class="px-3 py-1.5 rounded-md bg-secondary"
                    style={BUTTON_MOTION_STYLE}
                    activeStyle={BUTTON_ACTIVE_STYLE}
                  >
                    <Text class="text-xs font-medium text-secondary-foreground">
                      {t("btnExportMd")}
                    </Text>
                  </Button>
                  <Button
                    testID="memory-import-btn"
                    onPress={() => void store.importMarkdown()}
                    class="px-3 py-1.5 rounded-md bg-secondary"
                    style={BUTTON_MOTION_STYLE}
                    activeStyle={BUTTON_ACTIVE_STYLE}
                  >
                    <Text class="text-xs font-medium text-secondary-foreground">
                      {t("btnImportMd")}
                    </Text>
                  </Button>
                </View>
              </View>

              <View style={{ gap: 8 }}>
                <Each of={filteredMemories()}>
                  {(mem) => (
                    <View
                      class="p-3 rounded-xl border border-border bg-background"
                      style={{ gap: 4 }}
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
                          class="text-sm font-medium text-foreground"
                          style={{ flex: 1, minWidth: 0 }}
                        >
                          {`[${getMemoryKindLabel(mem().kind)}] ${mem().title}`}
                        </Text>
                        <Button
                          testID={`delete-memory-${mem().id}`}
                          onPress={() => {
                            animateLayout("ease");
                            void store.deleteMemory(mem().id);
                          }}
                          class="px-2.5 py-1 rounded bg-muted"
                          style={BUTTON_MOTION_STYLE}
                          activeStyle={BUTTON_ACTIVE_STYLE}
                        >
                          <Text class="text-xs text-muted-foreground">{t("btnDelete")}</Text>
                        </Button>
                      </View>
                      <Text class="text-xs text-muted-foreground" style={{ lineHeight: 17 }}>
                        {mem().content}
                      </Text>
                    </View>
                  )}
                </Each>
              </View>
            </View>
          </If>

          <If when={store.settingsSection() === "general"}>
            <View
              class="p-4 rounded-2xl border border-border bg-card"
              style={[CARD_ELEVATION_STYLE, { gap: 10 }]}
            >
              <Text class="text-sm font-semibold text-foreground">
                {t("languageSectionTitle")}
              </Text>
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
                <SelectablePill
                  testID="lang-zh"
                  label={t("languageZh")}
                  selected={() => currentLocale() === "zh-CN"}
                  onPress={() => setLocale("zh-CN")}
                />
                <SelectablePill
                  testID="lang-en"
                  label={t("languageEn")}
                  selected={() => currentLocale() === "en-US"}
                  onPress={() => setLocale("en-US")}
                />
              </View>
            </View>

            <View
              class="p-4 rounded-2xl border border-border bg-card"
              style={[CARD_ELEVATION_STYLE, { gap: 10 }]}
            >
              <Text class="text-sm font-semibold text-foreground">
                {t("profileSectionTitle")}
              </Text>
              <View style={{ flexDirection: "row", gap: 8 }}>
                <Input
                  testID="persona-companion-input"
                  value={personaName()}
                  placeholder={t("companionNamePlaceholder")}
                  onChange={(e) => {
                    personaDirty.set(true);
                    personaName.set(e.value);
                  }}
                  class="flex-1 px-3 py-2 rounded-lg border border-border bg-background text-xs text-foreground"
                  style={{ minWidth: 0 }}
                />
                <Input
                  testID="persona-user-input"
                  value={userName()}
                  placeholder={t("userNamePlaceholder")}
                  onChange={(e) => {
                    personaDirty.set(true);
                    userName.set(e.value);
                  }}
                  class="flex-1 px-3 py-2 rounded-lg border border-border bg-background text-xs text-foreground"
                  style={{ minWidth: 0 }}
                />
              </View>
              <Button
                testID="save-persona-btn"
                onPress={() => void savePersonaSettings()}
                class="self-start px-4 py-2 rounded-lg bg-secondary"
                style={BUTTON_MOTION_STYLE}
                activeStyle={BUTTON_ACTIVE_STYLE}
              >
                <Text class="text-xs font-semibold text-secondary-foreground">
                  {t("btnSaveProfile")}
                </Text>
              </Button>
            </View>

            <View
              class="p-4 rounded-2xl border border-border bg-card"
              style={[CARD_ELEVATION_STYLE, { gap: 10 }]}
            >
              <Text class="text-sm font-semibold text-foreground">
                {t("policySectionTitle")}
              </Text>
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
                <Each of={TRUST_POLICY_MODES}>
                  {(mode) => {
                    const typedMode = (): TrustPolicyMode => mode();
                    return (
                      <SelectablePill
                        testID={`policy-${typedMode()}`}
                        label={() => getPolicyLabel(typedMode())}
                        selected={() => store.policy().mode === typedMode()}
                        onPress={() => void store.setPolicyMode(typedMode())}
                      />
                    );
                  }}
                </Each>
              </View>
              <Text class="text-xs text-muted-foreground" style={{ lineHeight: 17 }}>
                {getPolicyDescription(store.policy().mode)}
              </Text>
            </View>
          </If>
        </View>
      </Scroll>
    </View>
  );
}
