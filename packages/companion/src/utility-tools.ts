import { exec } from "node:child_process";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import type { HarnessTool } from "@live-for-llm/harness";
import {
  type ActionRiskTier,
  type PolicyConfig,
  evaluatePolicyDecision,
} from "@live-for-llm/protocol";

const execAsync = promisify(exec);

function resolveSafePath(workspaceRoot: string, rawPath: unknown): string {
  const target = typeof rawPath === "string" && rawPath.trim() ? rawPath.trim() : ".";
  return resolve(workspaceRoot, target);
}

async function ensureGuarded(params: {
  readonly policy: PolicyConfig;
  readonly riskTier: ActionRiskTier;
  readonly actionSummary: string;
  readonly draftPreview?: string;
  readonly requestApproval: (req: {
    readonly actionSummary: string;
    readonly riskTier: ActionRiskTier;
    readonly draftPreview?: string;
  }) => Promise<"approved" | "denied">;
}): Promise<void> {
  const decision = evaluatePolicyDecision({
    policy: params.policy,
    riskTier: params.riskTier,
  });
  if (decision === "require_approval") {
    const res = await params.requestApproval({
      actionSummary: params.actionSummary,
      riskTier: params.riskTier,
      ...(params.draftPreview ? { draftPreview: params.draftPreview } : {}),
    });
    if (res === "denied") {
      throw new Error("Action denied by user approval policy");
    }
  }
}

/** Builds non-browser local workspace & utility HarnessTools for BuiltinAgentRunner. */
export function createUtilityTools(params: {
  readonly workspaceRoot: string;
  readonly getPolicy: () => PolicyConfig;
}): HarnessTool[] {
  const timeTool: HarnessTool = {
    spec: {
      name: "get_current_time",
      description: "Get current local and ISO date/time on the user's machine.",
      parameters: { type: "object", properties: {} },
    },
    riskTier: "read_only",
    async execute() {
      const now = new Date();
      return JSON.stringify({
        iso: now.toISOString(),
        local: now.toLocaleString(),
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      });
    },
  };

  const listDirTool: HarnessTool = {
    spec: {
      name: "list_directory",
      description: "List files and directories under a path (defaults to workspace root).",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
        },
      },
    },
    riskTier: "read_only",
    async execute(args) {
      const target = resolveSafePath(params.workspaceRoot, args["path"]);
      const entries = await readdir(target, { withFileTypes: true });
      return JSON.stringify({
        path: target,
        entries: entries.slice(0, 100).map((entry) => ({
          name: entry.name,
          kind: entry.isDirectory() ? "dir" : "file",
        })),
      });
    },
  };

  const readFileTool: HarnessTool = {
    spec: {
      name: "read_local_file",
      description: "Read a UTF-8 text file (up to 32 KB excerpt).",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
        },
        required: ["path"],
      },
    },
    riskTier: "read_only",
    async execute(args) {
      const target = resolveSafePath(params.workspaceRoot, args["path"]);
      const content = await readFile(target, "utf8");
      const maxChars = 32_000;
      return content.length > maxChars
        ? `${content.slice(0, maxChars)}\n... (truncated ${content.length - maxChars} chars)`
        : content;
    },
  };

  const writeFileTool: HarnessTool = {
    spec: {
      name: "write_local_file",
      description: "Write UTF-8 text content to a local file.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" },
        },
        required: ["path", "content"],
      },
    },
    riskTier: "local_write",
    async execute(args, ctx) {
      const target = resolveSafePath(params.workspaceRoot, args["path"]);
      const content = typeof args["content"] === "string" ? args["content"] : "";
      await ensureGuarded({
        policy: params.getPolicy(),
        riskTier: "local_write",
        actionSummary: `Write file ${target}`,
        draftPreview: content.slice(0, 240),
        requestApproval: (req) => ctx.requestApproval(req),
      });
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content, "utf8");
      return `Wrote ${content.length} chars to ${target}`;
    },
  };

  const shellTool: HarnessTool = {
    spec: {
      name: "run_shell_command",
      description: "Execute a non-interactive shell command on the host machine and capture stdout/stderr.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string" },
          cwd: { type: "string" },
        },
        required: ["command"],
      },
    },
    riskTier: "destructive",
    async execute(args, ctx) {
      const command = typeof args["command"] === "string" ? args["command"].trim() : "";
      if (!command) throw new Error("run_shell_command requires command");
      const cwd = resolveSafePath(params.workspaceRoot, args["cwd"]);
      await ensureGuarded({
        policy: params.getPolicy(),
        riskTier: "destructive",
        actionSummary: `Run shell command: ${command}`,
        draftPreview: `cwd: ${cwd}\n${command}`,
        requestApproval: (req) => ctx.requestApproval(req),
      });
      ctx.reportProgress(`Running command: ${command}`);
      const { stdout, stderr } = await execAsync(command, {
        cwd,
        timeout: 30_000,
        maxBuffer: 512 * 1024,
      });
      return JSON.stringify({
        cwd,
        stdout: stdout.slice(0, 8000),
        stderr: stderr.slice(0, 4000),
      });
    },
  };

  return [timeTool, listDirTool, readFileTool, writeFileTool, shellTool];
}
