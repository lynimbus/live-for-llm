import { spawn } from "node:child_process";
import type { TaskKind } from "@live-for-llm/protocol";
import type { TaskRunContext, TaskRunOutcome, TaskRunner } from "./runner.ts";

export interface ExternalCliRunnerOptions {
  readonly id: string;
  readonly label: string;
  readonly command: string;
  readonly buildArgs: (goal: string, ctx: TaskRunContext) => readonly string[];
  readonly cwd?: string;
  readonly supportedKinds?: readonly TaskKind[];
}

/** Pluggable adapter that delegates execution to an external harness CLI such as pi or Claude Code. */
export class ExternalCliRunner implements TaskRunner {
  readonly id: string;
  readonly label: string;
  readonly supportedKinds: readonly TaskKind[];
  private readonly command: string;
  private readonly buildArgs: ExternalCliRunnerOptions["buildArgs"];
  private readonly cwd?: string;

  constructor(options: ExternalCliRunnerOptions) {
    this.id = options.id;
    this.label = options.label;
    this.command = options.command;
    this.buildArgs = options.buildArgs;
    if (options.cwd !== undefined) {
      this.cwd = options.cwd;
    }
    this.supportedKinds = options.supportedKinds ?? ["harness_coding", "shell_utility"];
  }

  run(ctx: TaskRunContext): Promise<TaskRunOutcome> {
    return new Promise((resolve) => {
      if (ctx.signal.aborted) {
        resolve({ kind: "cancelled" });
        return;
      }

      const args = [...this.buildArgs(ctx.goal, ctx)];
      const child = spawn(this.command, args, {
        ...(this.cwd !== undefined ? { cwd: this.cwd } : {}),
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
          }
          idx = stdoutBuf.indexOf("\n");
        }
      });

      child.stderr.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf8").trim();
        if (text) stderrLines.push(text);
      });

      child.on("error", (err) => {
        ctx.signal.removeEventListener("abort", onAbort);
        resolve({ kind: "failed", error: `Failed to spawn ${this.command}: ${err.message}` });
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
          error: stderrLines.join("\n") || `${this.command} exited with code ${String(code)}`,
        });
      });
    });
  }
}
