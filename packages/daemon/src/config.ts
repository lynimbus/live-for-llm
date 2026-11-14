import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { TieredModelConfig } from "@live-for-llm/ai";

export interface DaemonConfig {
  readonly host: string;
  readonly port: number;
  readonly authToken?: string;
  readonly dataDir: string;
  readonly markdownExportDir: string;
  readonly enableEmbeddings: boolean;
  readonly models: TieredModelConfig;
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
  };
}

/** Loads daemon config from JSON file if present, falling back to environment defaults. */
export function loadDaemonConfig(configPath?: string): DaemonConfig {
  const path =
    configPath ??
    process.env["LIVE_FOR_LLM_CONFIG"] ??
    join(homedir(), ".config", "live-for-llm", "config.json");

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
