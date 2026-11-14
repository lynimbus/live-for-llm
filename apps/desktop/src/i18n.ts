import { signal, Storage } from "nsh";

export type AppLocale = "zh-CN" | "en-US";

const LOCALE_STORAGE_KEY = "live-for-llm:locale";

const localeSignal = signal<AppLocale>("zh-CN");

export function currentLocale(): AppLocale {
  return localeSignal();
}

export function loadPersistedLocale(): void {
  try {
    void Storage.getItem(LOCALE_STORAGE_KEY)
      .then((value) => {
        if (value === "zh-CN" || value === "en-US") {
          localeSignal.set(value);
        }
      })
      .catch(() => {
        // Ignore storage unavailability in tests.
      });
  } catch {
    // Ignore synchronous host errors in tests.
  }
}

export function setLocale(next: AppLocale): void {
  localeSignal.set(next);
  try {
    void Storage.setItem(LOCALE_STORAGE_KEY, next).catch(() => {
      // Ignore persistence failures.
    });
  } catch {
    // Ignore synchronous host errors.
  }
}

const DICT = {
  "zh-CN": {
    appTag: "live-for-llm",
    headerForUser: "与 {user}",
    turnsLabel: "{count} 轮",
    statusConnected: "已连接",
    statusOffline: "离线",
    statusWaking: "正在唤醒后台服务…",
    statusUnreachable: "无法连接后台服务: {err}",
    statusOpFailed: "操作失败: {err}",
    statusModelsSaved: "API 与模型配置已保存并生效",
    statusPersonaSaved: "称呼配置已更新",
    statusExported: "已导出 {count} 个 Markdown 文件",
    statusImported: "已同步 {count} 条 Markdown 修改",
    statusCopied: "已复制到剪贴板",
    statusModelsFetched: "已拉取 {count} 个可用模型",
    statusModelsFetchEmpty: "接口连接成功，但未返回模型列表",
    navShowTasks: "任务",
    navHideTasks: "收起任务",
    navSettings: "设置",
    navBackToChat: "返回对话",
    attentionApproval: "需要确认：{summary}",
    attentionPaused: "等待手动处理：{instructions}",
    btnApprove: "允许",
    btnDeny: "拒绝",
    btnResumeBrowser: "继续浏览器任务",
    btnResumeLogin: "登录后继续",
    btnCancel: "取消",
    btnClose: "关闭",
    btnDelete: "删除",
    btnCopy: "复制",
    btnRecall: "撤回",
    btnMultiSelect: "多选",
    btnSelectAll: "全选",
    btnDeleteSelected: "删除所选 ({count})",
    btnCopySelected: "复制所选",
    selectionCount: "已选 {count} 条消息",
    recalledByUser: "你撤回了一条消息",
    recalledByCompanion: "{name} 撤回了一条消息",
    proactiveBadge: "{name} · 主动消息",
    systemSender: "系统",
    typingLabel: "{name} 正在输入...",
    welcomeTitle: "{name} · live-for-llm",
    welcomeDesc:
      "直接打字就能聊。需要浏览网页、查本地文件、跑命令或写代码时，随时交给我后台处理。若还未填模型密钥，点击右上角「设置」即可配置并一键拉取模型。",
    inputPlaceholder: "和 {name} 聊聊，或交代一件事…",
    btnSend: "发送",
    tasksTitle: "后台任务",
    tasksEmptyTitle: "暂无后台任务",
    tasksEmptyDesc: "在聊天里提出需求后，浏览器自动化、文件或命令行任务会在这里实时更新。",
    tasksOpenSettingsHint: "前往设置与记忆库",
    settingsTitle: "设置",
    settingsSubtitle: "模型接入、界面语言、本地记忆与执行权限",
    settingsTabModels: "API 与模型",
    settingsTabMemories: "记忆库",
    settingsTabGeneral: "档案与权限",
    apiSectionTitle: "模型与自定义 API（支持拉取模型列表）",
    apiKeyConfigured: "密钥：{masked}",
    apiKeyUnset: "密钥：未配置",
    apiBaseUrlPlaceholder: "接口 Base URL，例如 https://api.openai.com/v1",
    apiKeyPlaceholder: "API Key（留空则沿用已保存密钥）",
    btnFetchModels: "拉取模型",
    btnFetchingModels: "拉取中…",
    modelFilterPlaceholder: "筛选模型名称…",
    applyToRoleLabel: "点击下方模型快速填入：",
    roleChat: "日常对话",
    roleTask: "后台执行",
    roleMemory: "记忆整理",
    chatModelLabel: "日常对话模型",
    taskModelLabel: "后台任务模型",
    memoryModelLabel: "记忆整理模型",
    btnSaveModels: "保存并应用 API",
    errNeedUrlAndModel: "请先填写有效的 Base URL 与对话模型",
    errNeedBaseUrl: "请先填写有效的 Base URL",
    profileSectionTitle: "称呼",
    companionNamePlaceholder: "对方称呼（例如 Livia）",
    userNamePlaceholder: "你的称呼",
    btnSaveProfile: "保存称呼",
    languageSectionTitle: "界面语言",
    languageZh: "简体中文",
    languageEn: "English",
    policySectionTitle: "安全与执行权限",
    policyTrustAuto: "信任自动（破坏性操作除外）",
    policyConfirmExternal: "外发需确认",
    policyAllowlist: "仅白名单域名自动",
    memorySearchPlaceholder: "搜索记忆…",
    memoryTitlePlaceholder: "记忆标题",
    memoryContentPlaceholder: "详细内容",
    btnAddMemory: "添加记忆",
    btnExportMd: "导出 Markdown",
    btnImportMd: "同步 Markdown 修改",
    memoryFilterAll: "全部",
    memoryKindFact: "事实",
    memoryKindEpisode: "经历",
    memoryKindPreference: "偏好",
    memoryKindRelationship: "关系",
  },
  "en-US": {
    appTag: "live-for-llm",
    headerForUser: "with {user}",
    turnsLabel: "turns {count}",
    statusConnected: "Online",
    statusOffline: "Offline",
    statusWaking: "Waking local daemon…",
    statusUnreachable: "Daemon unreachable: {err}",
    statusOpFailed: "Action failed: {err}",
    statusModelsSaved: "API & model settings saved",
    statusPersonaSaved: "Profile updated",
    statusExported: "Exported {count} Markdown files",
    statusImported: "Imported {count} Markdown edits",
    statusCopied: "Copied to clipboard",
    statusModelsFetched: "Fetched {count} models",
    statusModelsFetchEmpty: "Endpoint reachable, no models returned",
    navShowTasks: "Tasks",
    navHideTasks: "Hide Tasks",
    navSettings: "Settings",
    navBackToChat: "Back to Chat",
    attentionApproval: "Approval needed: {summary}",
    attentionPaused: "Paused for user: {instructions}",
    btnApprove: "Approve",
    btnDeny: "Deny",
    btnResumeBrowser: "Resume Browser",
    btnResumeLogin: "Resume After Login",
    btnCancel: "Cancel",
    btnClose: "Close",
    btnDelete: "Delete",
    btnCopy: "Copy",
    btnRecall: "Recall",
    btnMultiSelect: "Select",
    btnSelectAll: "Select All",
    btnDeleteSelected: "Delete ({count})",
    btnCopySelected: "Copy",
    selectionCount: "{count} selected",
    recalledByUser: "You recalled a message",
    recalledByCompanion: "{name} recalled a message",
    proactiveBadge: "{name} · Check-in",
    systemSender: "System",
    typingLabel: "{name} is typing...",
    welcomeTitle: "{name} · live-for-llm",
    welcomeDesc:
      "Start chatting naturally, or ask me to browse the web, check local files, or run commands in the background. Open Settings to configure your API key and fetch models.",
    inputPlaceholder: "Message {name}…",
    btnSend: "Send",
    tasksTitle: "Background Tasks",
    tasksEmptyTitle: "No background tasks yet",
    tasksEmptyDesc: "Browser workflows, file tasks, and command runners will show progress here.",
    tasksOpenSettingsHint: "Open Settings & Memories",
    settingsTitle: "Settings",
    settingsSubtitle: "Models & API, language, memory store, and execution safety",
    settingsTabModels: "API & Models",
    settingsTabMemories: "Memories",
    settingsTabGeneral: "Profile & Safety",
    apiSectionTitle: "Model & Custom API",
    apiKeyConfigured: "Key: {masked}",
    apiKeyUnset: "Key: Not configured",
    apiBaseUrlPlaceholder: "Base URL (e.g. https://api.openai.com/v1)",
    apiKeyPlaceholder: "API Key (leave empty to keep existing)",
    btnFetchModels: "Fetch Models",
    btnFetchingModels: "Fetching…",
    modelFilterPlaceholder: "Filter fetched models…",
    applyToRoleLabel: "Click a model below to assign to:",
    roleChat: "Chat",
    roleTask: "Task",
    roleMemory: "Memory",
    chatModelLabel: "Chat Model",
    taskModelLabel: "Task Model",
    memoryModelLabel: "Memory Model",
    btnSaveModels: "Save & Apply API",
    errNeedUrlAndModel: "Please provide a valid Base URL and Chat Model",
    errNeedBaseUrl: "Please provide a valid Base URL",
    profileSectionTitle: "Display Names",
    companionNamePlaceholder: "Companion name (e.g. Livia)",
    userNamePlaceholder: "Your name",
    btnSaveProfile: "Save Names",
    languageSectionTitle: "Language",
    languageZh: "简体中文",
    languageEn: "English",
    policySectionTitle: "Trust & Safety Mode",
    policyTrustAuto: "trust_auto",
    policyConfirmExternal: "confirm_external",
    policyAllowlist: "allowlist",
    memorySearchPlaceholder: "Search memories...",
    memoryTitlePlaceholder: "Memory title",
    memoryContentPlaceholder: "Memory details",
    btnAddMemory: "Add Memory",
    btnExportMd: "Export MD",
    btnImportMd: "Import MD",
    memoryFilterAll: "All",
    memoryKindFact: "fact",
    memoryKindEpisode: "episode",
    memoryKindPreference: "preference",
    memoryKindRelationship: "relationship",
  },
} as const;

export type I18nKey = keyof (typeof DICT)["zh-CN"];

export function t(key: I18nKey, vars?: Record<string, string | number>): string {
  const table = DICT[localeSignal()];
  let text: string = table[key];
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      text = text.replaceAll(`{${k}}`, String(v));
    }
  }
  return text;
}
