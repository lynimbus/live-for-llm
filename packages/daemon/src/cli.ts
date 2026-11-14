import { exportMemoriesToMarkdown, importMarkdownEdits, MemoryStore } from "@live-for-llm/memory";
import { join } from "node:path";
import { loadDaemonConfig } from "./config.ts";
import { CompanionDaemon } from "./server.ts";

async function main(): Promise<void> {
  const command = process.argv[2] ?? "start";
  const config = loadDaemonConfig();

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

  const daemon = new CompanionDaemon({ config });
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
