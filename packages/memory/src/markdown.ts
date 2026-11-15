import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  MEMORY_KINDS,
  type MemoryKind,
  type MemoryRecord,
  type RelationshipState,
  parseMemoryId,
} from "@live-for-llm/protocol";
import type { MemoryStore } from "./store.ts";

const KIND_TO_FILE: Record<MemoryKind, string> = {
  fact: "facts.md",
  episode: "episodes.md",
  preference: "preferences.md",
  relationship: "relationship.md",
};

const KIND_HEADING: Record<MemoryKind, string> = {
  fact: "Facts and profile",
  episode: "Timeline and emotional episodes",
  preference: "Preferences and workflows",
  relationship: "Relationship milestones",
};

function formatMemorySection(record: MemoryRecord): string {
  const tagsLine = record.tags.length > 0 ? record.tags.join(", ") : "none";
  const extras: string[] = [
    `importance: ${record.importance.toFixed(2)}`,
    `source: ${record.source}`,
    `tags: ${tagsLine}`,
  ];
  if (record.emotionalTone) extras.push(`tone: ${record.emotionalTone}`);
  if (record.eventDate) extras.push(`date: ${record.eventDate}`);
  if (record.sourceMessageIds && record.sourceMessageIds.length > 0) {
    extras.push(`evidence: ${record.sourceMessageIds.join(",")}`);
  }

  return [
    `<!-- memory:id=${record.id} kind=${record.kind} -->`,
    `## ${record.title}`,
    `_${extras.join(" | ")}_`,
    "",
    record.content.trim(),
    "",
  ].join("\n");
}

/** Exports all memories and relationship state into human-readable Markdown files. */
export function exportMemoriesToMarkdown(params: {
  readonly store: MemoryStore;
  readonly outputDir: string;
}): string[] {
  mkdirSync(params.outputDir, { recursive: true });
  const writtenFiles: string[] = [];
  const all = params.store.listMemories({ limit: 5000 });

  for (const kind of MEMORY_KINDS) {
    const items = all.filter((m) => m.kind === kind);
    const lines = [`# ${KIND_HEADING[kind]}`, ""];
    for (const item of items) {
      lines.push(formatMemorySection(item));
    }
    const targetPath = join(params.outputDir, KIND_TO_FILE[kind]);
    writeFileSync(targetPath, lines.join("\n"), "utf8");
    writtenFiles.push(targetPath);
  }

  const rel = params.store.getRelationshipState();
  const profilePath = join(params.outputDir, "companion-profile.md");
  const profileMd = [
    "# Companion relationship state",
    "",
    `- Companion name: ${rel.companionName}`,
    `- User name: ${rel.userName}`,
    `- Affinity score: ${rel.affinityScore.toFixed(2)}`,
    `- Current mood: ${rel.currentMood}`,
    `- Updated at: ${rel.updatedAt}`,
    "",
    "## Inside jokes",
    ...(rel.insideJokes.length > 0 ? rel.insideJokes.map((j) => `- ${j}`) : ["- (none)"]),
    "",
    "## Anniversaries",
    ...(rel.anniversaries.length > 0
      ? rel.anniversaries.map((a) => `- ${a.date}: ${a.label}`)
      : ["- (none)"]),
    "",
  ].join("\n");
  writeFileSync(profilePath, profileMd, "utf8");
  writtenFiles.push(profilePath);

  return writtenFiles;
}

const SECTION_HEADER_RE = /^<!--\s*memory:id=([^\s]+)\s+kind=([^\s]+)\s*-->\s*$/m;

/** Imports user edits from exported Markdown files back into MemoryStore. */
export function importMarkdownEdits(params: {
  readonly inputDir: string;
  readonly store: MemoryStore;
}): number {
  if (!existsSync(params.inputDir)) return 0;
  let updatedCount = 0;

  for (const fileName of readdirSync(params.inputDir)) {
    if (!fileName.endsWith(".md") || fileName === "companion-profile.md") continue;
    const raw = readFileSync(join(params.inputDir, fileName), "utf8");
    const chunks = raw.split(/(?=<!--\s*memory:id=)/);

    for (const chunk of chunks) {
      const headerMatch = SECTION_HEADER_RE.exec(chunk);
      if (!headerMatch) continue;
      const rawId = headerMatch[1];
      const rawKind = headerMatch[2];
      if (!rawId || !rawKind || !MEMORY_KINDS.includes(rawKind as MemoryKind)) continue;

      const id = parseMemoryId(rawId);
      const existing = params.store.getMemory(id);
      const lines = chunk.split(/\r?\n/).slice(1);
      const titleLine = lines.find((line) => line.startsWith("## "));
      if (!titleLine) continue;

      const title = titleLine.slice(3).trim();
      const metaIndex = lines.findIndex((line) => line.startsWith("_") && line.endsWith("_"));
      const bodyStart = metaIndex !== -1 ? metaIndex + 1 : lines.indexOf(titleLine) + 1;
      const content = lines.slice(bodyStart).join("\n").trim();
      if (!title || !content) continue;

      params.store.upsertMemory({
        id,
        kind: rawKind as MemoryKind,
        title,
        content,
        tags: existing?.tags ?? [],
        importance: existing?.importance ?? 0.5,
        source: "user_edit",
        ...(existing?.emotionalTone ? { emotionalTone: existing.emotionalTone } : {}),
        ...(existing?.eventDate ? { eventDate: existing.eventDate } : {}),
        ...(existing?.sourceMessageIds ? { sourceMessageIds: existing.sourceMessageIds } : {}),
      });
      updatedCount += 1;
    }
  }

  return updatedCount;
}
