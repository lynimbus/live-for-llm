import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ModelProfile, TieredModelConfig } from "@live-for-llm/ai";
import type {
  HarnessSettings,
  ModelSettingsSummary,
  ModelSettingsUpdate,
  TaskKind,
} from "@live-for-llm/protocol";

export interface DaemonConfig {
  readonly host: string;
  readonly port: number;
  readonly authToken?: string;
  readonly dataDir: string;
  readonly markdownExportDir: string;
  readonly enableEmbeddings: boolean;
  readonly models: TieredModelConfig;
  readonly harness: HarnessSettings;
}

export const DEFAULT_HARNESS_SETTINGS: HarnessSettings = {
  defaultBackend: "builtin",
  browserBackend: "daemon",
};

function mapBackendToRunnerId(backend: HarnessSettings["defaultBackend"]): string {
  switch (backend) {
    case "auto":
    case "builtin":
      return "builtin-agent";
    case "codex":
      return "codex-cli";
    case "claude_code":
      return "claude-cli";
    case "pi":
      return "pi-cli";
    case "opencode":
      return "opencode-cli";
    case "custom":
      return "custom-cli";
  }
}

/** Maps configured harness + browser backend + taskKind to a registered TaskRunner id. */
export function resolveConfiguredRunnerId(
  harness: HarnessSettings,
  taskKind: TaskKind,
): string {
  if (taskKind === "browser_research" || taskKind === "browser_post") {
    const browserBackend = harness.browserBackend ?? "daemon";
    if (browserBackend === "daemon") {
      return "browser-runner";
    }
    if (browserBackend === "follow_harness") {
      const mapped = mapBackendToRunnerId(harness.defaultBackend);
      return mapped === "builtin-agent" ? "browser-runner" : mapped;
    }
    return mapBackendToRunnerId(browserBackend);
  }
  return mapBackendToRunnerId(harness.defaultBackend);
}

export function createDefaultDaemonConfig(overrides?: Partial<DaemonConfig>): DaemonConfig {
  const dataDir =
    overrides?.dataDir ??
    process.env["LIVE_FOR_LLM_DATA_DIR"] ??
    join(homedir(), ".local", "share", "live-for-llm");

  const defaultModels: TieredModelConfig = {
    companion_chat: {
      id: "companion-default",
      provider: "openai_compatible",
      baseUrl: process.env["LLM_BASE_URL"] ?? "https://api.openai.com/v1",
      model: process.env["COMPANION_MODEL"] ?? "gpt-4o-mini",
      apiKeyEnv: "OPENAI_API_KEY",
      temperature: 0.8,
    },
    memory_extract: {
      id: "memory-default",
      provider: "openai_compatible",
      baseUrl: process.env["LLM_BASE_URL"] ?? "https://api.openai.com/v1",
      model: process.env["MEMORY_MODEL"] ?? "gpt-4o-mini",
      apiKeyEnv: "OPENAI_API_KEY",
      temperature: 0.2,
    },
    task_planner: {
      id: "task-default",
      provider: "openai_compatible",
      baseUrl: process.env["LLM_BASE_URL"] ?? "https://api.openai.com/v1",
      model: process.env["TASK_MODEL"] ?? "gpt-4o",
      apiKeyEnv: "OPENAI_API_KEY",
      temperature: 0.2,
    },
    vision_browser: {
      id: "vision-default",
      provider: "openai_compatible",
      baseUrl: process.env["LLM_BASE_URL"] ?? "https://api.openai.com/v1",
      model: process.env["VISION_MODEL"] ?? "gpt-4o",
      apiKeyEnv: "OPENAI_API_KEY",
      temperature: 0.2,
    },
    embedding: {
      id: "embedding-default",
      provider: "openai_compatible",
      baseUrl: process.env["LLM_BASE_URL"] ?? "https://api.openai.com/v1",
      model: process.env["EMBEDDING_MODEL"] ?? "text-embedding-3-small",
      apiKeyEnv: "OPENAI_API_KEY",
    },
  };

  const authToken = overrides?.authToken ?? process.env["LIVE_FOR_LLM_TOKEN"];
  return {
    host: overrides?.host ?? process.env["LIVE_FOR_LLM_HOST"] ?? "127.0.0.1",
    port: overrides?.port ?? Number(process.env["LIVE_FOR_LLM_PORT"] ?? 4777),
    ...(authToken !== undefined ? { authToken } : {}),
    dataDir,
    markdownExportDir: overrides?.markdownExportDir ?? join(dataDir, "memories-md"),
    enableEmbeddings: overrides?.enableEmbeddings ?? false,
    models: overrides?.models ?? defaultModels,
    harness: overrides?.harness ?? DEFAULT_HARNESS_SETTINGS,
  };
}

export function resolveDaemonConfigPath(configPath?: string): string {
  return (
    configPath ??
    process.env["LIVE_FOR_LLM_CONFIG"] ??
    join(homedir(), ".config", "live-for-llm", "config.json")
  );
}

/** Loads daemon config from JSON file if present, falling back to environment defaults. */
export function loadDaemonConfig(configPath?: string): DaemonConfig {
  const path = resolveDaemonConfigPath(configPath);

  if (!existsSync(path)) {
    const cfg = createDefaultDaemonConfig();
    mkdirSync(cfg.dataDir, { recursive: true });
    return cfg;
  }

  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<DaemonConfig>;
  const cfg = createDefaultDaemonConfig(parsed);
  mkdirSync(cfg.dataDir, { recursive: true });
  return cfg;
}

/** Persists daemon configuration with owner-only file permissions since it may contain API keys. */
export function saveDaemonConfig(config: DaemonConfig, configPath?: string): string {
  const path = resolveDaemonConfigPath(configPath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // Best-effort on filesystems without POSIX chmod.
  }
  return path;
}

function maskKey(secret: string): string {
  const trimmed = secret.trim();
  if (trimmed.length <= 8) return "••••••••";
  return `${trimmed.slice(0, 3)}••••${trimmed.slice(-4)}`;
}

/** Returns a secret-safe summary of the active model configuration for UI clients. */
export function summarizeModelSettings(models: TieredModelConfig): ModelSettingsSummary {
  const primary = models.companion_chat;
  const directKey = primary.apiKey?.trim();
  const envName = primary.apiKeyEnv?.trim();
  const envVal = envName ? process.env[envName]?.trim() : undefined;
  const hasApiKey = Boolean(directKey || envVal);
  const apiKeyMasked = directKey
    ? maskKey(directKey)
    : envVal
      ? `env:${envName}`
      : undefined;

  return {
    provider: primary.provider,
    baseUrl: primary.baseUrl,
    companionModel: primary.model,
    taskModel: models.task_planner.model,
    memoryModel: models.memory_extract.model,
    visionModel: models.vision_browser.model,
    embeddingModel: models.embedding.model,
    hasApiKey,
    ...(apiKeyMasked !== undefined ? { apiKeyMasked } : {}),
    ...(envName ? { apiKeyEnv: envName } : {}),
  };
}

/** Merges a GUI/API model settings update across all tiered roles, preserving existing secrets unless changed. */
export function applyModelSettingsUpdate(
  current: TieredModelConfig,
  update: ModelSettingsUpdate,
): TieredModelConfig {
  const patchRole = (prev: ModelProfile, model: string): ModelProfile => {
    const nextKey = update.clearApiKey
      ? undefined
      : update.apiKey !== undefined && update.apiKey.length > 0
        ? update.apiKey
        : prev.apiKey;
    const nextEnv =
      update.apiKeyEnv !== undefined ? update.apiKeyEnv : prev.apiKeyEnv;

    const base: ModelProfile = {
      id: prev.id,
      provider: update.provider,
      baseUrl: update.baseUrl,
      model,
      ...(nextKey !== undefined ? { apiKey: nextKey } : {}),
      ...(nextEnv !== undefined ? { apiKeyEnv: nextEnv } : {}),
      ...(prev.temperature !== undefined ? { temperature: prev.temperature } : {}),
      ...(prev.maxTokens !== undefined ? { maxTokens: prev.maxTokens } : {}),
    };
    return base;
  };

  return {
    companion_chat: patchRole(current.companion_chat, update.companionModel),
    memory_extract: patchRole(
      current.memory_extract,
      update.memoryModel ?? update.companionModel,
    ),
    task_planner: patchRole(current.task_planner, update.taskModel),
    vision_browser: patchRole(
      current.vision_browser,
      update.visionModel ?? update.taskModel,
    ),
    embedding: patchRole(
      current.embedding,
      update.embeddingModel ?? current.embedding.model,
    ),
  };
}
