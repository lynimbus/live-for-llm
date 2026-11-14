import type { ChatTurnMessage, ModelRouter, ToolSpec } from "@live-for-llm/ai";
import type { ActionRiskTier, TaskKind } from "@live-for-llm/protocol";
import type { TaskRunContext, TaskRunOutcome, TaskRunner } from "./runner.ts";

export interface HarnessTool {
  readonly spec: ToolSpec;
  readonly riskTier: ActionRiskTier;
  readonly domain?: string;
  execute(args: Record<string, unknown>, ctx: TaskRunContext): Promise<string>;
}

export interface BuiltinAgentRunnerOptions {
  readonly id?: string;
  readonly label?: string;
  readonly router: ModelRouter;
  readonly tools: readonly HarnessTool[];
  readonly maxTurns?: number;
  readonly systemPrompt?: string;
  readonly supportedKinds?: readonly TaskKind[];
}

/** In-process tool-calling agent runner backed by ModelRouter. */
export class BuiltinAgentRunner implements TaskRunner {
  readonly id: string;
  readonly label: string;
  readonly supportedKinds: readonly TaskKind[];
  private readonly router: ModelRouter;
  private readonly toolsByName: Map<string, HarnessTool>;
  private readonly maxTurns: number;
  private readonly systemPrompt: string;

  constructor(options: BuiltinAgentRunnerOptions) {
    this.id = options.id ?? "builtin-agent";
    this.label = options.label ?? "Built-in Task Agent";
    this.supportedKinds = options.supportedKinds ?? [
      "browser_research",
      "browser_post",
      "shell_utility",
      "harness_coding",
    ];
    this.router = options.router;
    this.toolsByName = new Map(options.tools.map((tool) => [tool.spec.name, tool]));
    this.maxTurns = options.maxTurns ?? 12;
    this.systemPrompt =
      options.systemPrompt ??
      "You are the background execution harness. Complete the assigned goal accurately using the available tools, then return a concise factual summary.";
  }

  async run(ctx: TaskRunContext): Promise<TaskRunOutcome> {
    const messages: ChatTurnMessage[] = [
      { role: "system", content: this.systemPrompt },
      { role: "user", content: ctx.goal },
    ];
    const toolSpecs = Array.from(this.toolsByName.values()).map((t) => t.spec);

    for (let turn = 0; turn < this.maxTurns; turn++) {
      if (ctx.signal.aborted) return { kind: "cancelled" };

      ctx.reportProgress(`Planning step ${turn + 1}`);
      const response = await this.router.generate({
        role: "task_planner",
        messages,
        ...(toolSpecs.length > 0 ? { tools: toolSpecs } : {}),
        signal: ctx.signal,
      });

      if (response.toolCalls.length === 0) {
        return {
          kind: "completed",
          summary: response.text || "Task finished with no output.",
        };
      }

      messages.push({
        role: "assistant",
        content: response.text,
        toolCalls: response.toolCalls,
      });

      for (const call of response.toolCalls) {
        if (ctx.signal.aborted) return { kind: "cancelled" };
        const tool = this.toolsByName.get(call.name);
        if (!tool) {
          messages.push({
            role: "tool",
            toolCallId: call.id,
            toolName: call.name,
            content: `Error: unknown tool "${call.name}"`,
          });
          continue;
        }

        if (tool.riskTier === "external_send" || tool.riskTier === "destructive") {
          const decision = await ctx.requestApproval({
            actionSummary: `Run tool ${call.name}`,
            riskTier: tool.riskTier,
            ...(tool.domain ? { domain: tool.domain } : {}),
            draftPreview: JSON.stringify(call.arguments),
          });
          if (decision === "denied") {
            messages.push({
              role: "tool",
              toolCallId: call.id,
              toolName: call.name,
              content: "Action denied by user policy/approval gate.",
            });
            continue;
          }
        }

        ctx.reportProgress(`Running tool ${call.name}`);
        try {
          const output = await tool.execute(call.arguments, ctx);
          messages.push({
            role: "tool",
            toolCallId: call.id,
            toolName: call.name,
            content: output,
          });
        } catch (err) {
          messages.push({
            role: "tool",
            toolCallId: call.id,
            toolName: call.name,
            content: `Tool error: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
      }
    }

    return {
      kind: "failed",
      error: `Exceeded maxTurns (${this.maxTurns}) without completion`,
    };
  }
}
