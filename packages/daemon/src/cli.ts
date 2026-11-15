import {
  exportMemoriesToMarkdown,
  importChatExportJson,
  importMarkdownEdits,
  MemoryStore,
} from "@live-for-llm/memory";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadDaemonConfig, resolveDaemonConfigPath } from "./config.ts";
import { CompanionDaemon } from "./server.ts";

async function main(): Promise<void> {
  const command = process.argv[2] ?? "start";
  const configPath = resolveDaemonConfigPath();
  const config = loadDaemonConfig(configPath);

  if (command === "export-memories") {
    const store = new MemoryStore(join(config.dataDir, "companion.db"));
    try {
      const files = exportMemoriesToMarkdown({ store, outputDir: config.markdownExportDir });
      process.stdout.write(`${JSON.stringify({ files }, null, 2)}\n`);
    } finally {
      store.close();
    }
    return;
  }

  if (command === "import-memories") {
    const store = new MemoryStore(join(config.dataDir, "companion.db"));
    try {
      const imported = importMarkdownEdits({ inputDir: config.markdownExportDir, store });
      process.stdout.write(`${JSON.stringify({ imported }, null, 2)}\n`);
    } finally {
      store.close();
    }
    return;
  }

  if (command === "import-chat-export") {
    const filePath = process.argv[3];
    if (!filePath || filePath.startsWith("-")) {
      throw new Error(
        "Usage: live-for-llm-daemon import-chat-export <export.json> [--limit N] [--no-memories]",
      );
    }
    const args = process.argv.slice(4);
    const limitIdx = args.indexOf("--limit");
    const limitConversations =
      limitIdx !== -1 && args[limitIdx + 1] ? Number(args[limitIdx + 1]) : undefined;
    const createEpisodeMemories = !args.includes("--no-memories");

    const rawJson = readFileSync(filePath, "utf8");
    const store = new MemoryStore(join(config.dataDir, "companion.db"));
    try {
      const result = importChatExportJson(store, rawJson, {
        ...(limitConversations && Number.isFinite(limitConversations) ? { limitConversations } : {}),
        createEpisodeMemories,
      });
      process.stdout.write(
        `${JSON.stringify(
          {
            format: result.format,
            conversationsImported: result.conversationsImported,
            messagesImported: result.messagesImported,
            memoriesCreated: result.memoriesCreated,
            conversationIds: result.conversationIds,
          },
          null,
          2,
        )}\n`,
      );
    } finally {
      store.close();
    }
    return;
  }

  const daemon = new CompanionDaemon({ config, configPath });
  const addr = await daemon.start();
  process.stdout.write(`live-for-llm daemon listening on http://${addr.host}:${addr.port}\n`);

  const shutdown = () => {
    void daemon.stop().then(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
