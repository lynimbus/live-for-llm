import { spawn } from "node:child_process";
import type { TaskKind } from "@live-for-llm/protocol";
import type { TaskRunContext, TaskRunOutcome, TaskRunner } from "./runner.ts";

export interface ExternalCliRunnerOptions {
  readonly id: string;
  readonly label: string;
  readonly command: string | ((ctx: TaskRunContext) => string);
  readonly buildArgs: (goal: string, ctx: TaskRunContext) => readonly string[];
  readonly cwd?: string | ((ctx: TaskRunContext) => string | undefined);
  readonly env?:
    | Record<string, string | undefined>
    | ((ctx: TaskRunContext) => Record<string, string | undefined>);
  readonly supportedKinds?: readonly TaskKind[];
}

/** Pluggable adapter that delegates execution to an external harness CLI such as pi or Claude Code. */
export class ExternalCliRunner implements TaskRunner {
  readonly id: string;
  readonly label: string;
  readonly supportedKinds: readonly TaskKind[];
  private readonly command: ExternalCliRunnerOptions["command"];
  private readonly buildArgs: ExternalCliRunnerOptions["buildArgs"];
  private readonly cwd?: ExternalCliRunnerOptions["cwd"];
  private readonly env?: ExternalCliRunnerOptions["env"];

  constructor(options: ExternalCliRunnerOptions) {
    this.id = options.id;
    this.label = options.label;
    this.command = options.command;
    this.buildArgs = options.buildArgs;
    if (options.cwd !== undefined) {
      this.cwd = options.cwd;
    }
    if (options.env !== undefined) {
      this.env = options.env;
    }
    this.supportedKinds = options.supportedKinds ?? ["harness_coding", "shell_utility"];
  }

  run(ctx: TaskRunContext): Promise<TaskRunOutcome> {
    return new Promise((resolve) => {
      if (ctx.signal.aborted) {
        resolve({ kind: "cancelled" });
        return;
      }

      let cmdName: string;
      let args: string[];
      let resolvedCwd: string | undefined;
      let extraEnv: Record<string, string | undefined> | undefined;
      try {
        cmdName = typeof this.command === "function" ? this.command(ctx) : this.command;
        args = [...this.buildArgs(ctx.goal, ctx)];
        resolvedCwd = typeof this.cwd === "function" ? this.cwd(ctx) : this.cwd;
        extraEnv = typeof this.env === "function" ? this.env(ctx) : this.env;
      } catch (err) {
        resolve({
          kind: "failed",
          error: err instanceof Error ? err.message : String(err),
        });
        return;
      }
      if (!cmdName.trim()) {
        resolve({ kind: "failed", error: `No executable configured for ${this.label}` });
        return;
      }

      ctx.reportTrace?.({
        kind: "status",
        title: `Spawn ${cmdName}`,
        detail: args.join(" ").slice(0, 320),
      });

      const child = spawn(cmdName, args, {
        ...(resolvedCwd !== undefined ? { cwd: resolvedCwd } : {}),
        ...(extraEnv ? { env: { ...process.env, ...extraEnv } } : {}),
        stdio: ["ignore", "pipe", "pipe"],
      });

      const stdoutLines: string[] = [];
      const stderrLines: string[] = [];
      let stdoutBuf = "";

      const onAbort = () => {
        child.kill("SIGTERM");
      };
      ctx.signal.addEventListener("abort", onAbort, { once: true });

      child.stdout.on("data", (chunk: Buffer) => {
        stdoutBuf += chunk.toString("utf8");
        let idx = stdoutBuf.indexOf("\n");
        while (idx !== -1) {
          const line = stdoutBuf.slice(0, idx).trim();
          stdoutBuf = stdoutBuf.slice(idx + 1);
          if (line) {
            stdoutLines.push(line);
            ctx.reportProgress(line.slice(0, 140));
            ctx.reportTrace?.({
              kind: "cli_output",
              title: line.slice(0, 140),
              ...(line.length > 140 ? { detail: line.slice(0, 600) } : {}),
            });
          }
          idx = stdoutBuf.indexOf("\n");
        }
      });

      child.stderr.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf8").trim();
        if (text) {
          stderrLines.push(text);
          ctx.reportTrace?.({
            kind: "cli_output",
            title: text.slice(0, 140),
            ...(text.length > 140 ? { detail: text.slice(0, 600) } : {}),
            isError: true,
          });
        }
      });

      child.on("error", (err) => {
        ctx.signal.removeEventListener("abort", onAbort);
        resolve({ kind: "failed", error: `Failed to spawn ${cmdName}: ${err.message}` });
      });

      child.on("close", (code) => {
        ctx.signal.removeEventListener("abort", onAbort);
        if (stdoutBuf.trim()) stdoutLines.push(stdoutBuf.trim());
        if (ctx.signal.aborted) {
          resolve({ kind: "cancelled" });
          return;
        }
        if (code === 0) {
          resolve({
            kind: "completed",
            summary: stdoutLines.join("\n") || `${this.label} completed.`,
          });
          return;
        }
        resolve({
          kind: "failed",
          error: stderrLines.join("\n") || `${cmdName} exited with code ${String(code)}`,
        });
      });
    });
  }
}
