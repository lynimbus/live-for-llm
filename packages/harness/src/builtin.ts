import type { ChatTurnMessage, ModelRouter, ToolSpec } from "@live-for-llm/ai";
import {
  type ActionRiskTier,
  type PolicyConfig,
  type TaskKind,
  evaluatePolicyDecision,
} from "@live-for-llm/protocol";
import type { TaskRunContext, TaskRunOutcome, TaskRunner } from "./runner.ts";

export interface HarnessTool {
  readonly spec: ToolSpec;
  readonly riskTier: ActionRiskTier;
  readonly domain?: string;
  readonly handlesOwnPolicy?: boolean;
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
  readonly getPolicy?: () => PolicyConfig;
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
  private readonly getPolicy?: () => PolicyConfig;

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
    this.maxTurns = options.maxTurns ?? 24;
    this.systemPrompt =
      options.systemPrompt ??
      "You are the background execution harness. Complete the assigned goal accurately using the available tools, then return a concise factual summary.";
    if (options.getPolicy !== undefined) {
      this.getPolicy = options.getPolicy;
    }
  }

  async run(ctx: TaskRunContext): Promise<TaskRunOutcome> {
    const messages: ChatTurnMessage[] = [
      { role: "system", content: this.systemPrompt },
      { role: "user", content: ctx.goal },
    ];
    const toolSpecs = Array.from(this.toolsByName.values()).map((t) => t.spec);
    let collectedToolOutput = false;
    let lastErrorText = "";
    let repeatedErrorCount = 0;

    for (let turn = 0; turn < this.maxTurns; turn++) {
      if (ctx.signal.aborted) return { kind: "cancelled" };

      const planLabel = `Planning step ${turn + 1}/${this.maxTurns}`;
      ctx.reportProgress(planLabel);
      ctx.reportTrace?.({
        kind: "planning",
        title: planLabel,
      });

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
          const msg = `Error: unknown tool "${call.name}"`;
          ctx.reportTrace?.({
            kind: "error",
            title: msg,
            toolName: call.name,
            isError: true,
          });
          messages.push({
            role: "tool",
            toolCallId: call.id,
            toolName: call.name,
            content: msg,
          });
          continue;
        }

        const needsApproval = tool.handlesOwnPolicy
          ? false
          : this.getPolicy
            ? evaluatePolicyDecision({
                policy: this.getPolicy(),
                riskTier: tool.riskTier,
                ...(tool.domain ? { domain: tool.domain } : {}),
              }) === "require_approval"
            : tool.riskTier === "external_send" || tool.riskTier === "destructive";

        if (needsApproval) {
          ctx.reportTrace?.({
            kind: "approval",
            title: `Waiting for approval: ${call.name}`,
            detail: JSON.stringify(call.arguments).slice(0, 300),
            toolName: call.name,
          });
          const decision = await ctx.requestApproval({
            actionSummary: `Run tool ${call.name}`,
            riskTier: tool.riskTier,
            ...(tool.domain ? { domain: tool.domain } : {}),
            draftPreview: JSON.stringify(call.arguments),
          });
          if (decision === "denied") {
            ctx.reportTrace?.({
              kind: "approval",
              title: `Denied tool ${call.name}`,
              toolName: call.name,
              isError: true,
            });
            messages.push({
              role: "tool",
              toolCallId: call.id,
              toolName: call.name,
              content: "Action denied by user policy/approval gate.",
            });
            continue;
          }
        }

        const argsPreview = JSON.stringify(call.arguments).slice(0, 320);
        ctx.reportProgress(`Running tool ${call.name}`);
        ctx.reportTrace?.({
          kind: "tool_call",
          title: `Call ${call.name}`,
          detail: argsPreview,
          toolName: call.name,
        });

        try {
          const output = await tool.execute(call.arguments, ctx);
          collectedToolOutput = true;
          lastErrorText = "";
          repeatedErrorCount = 0;
          ctx.reportTrace?.({
            kind: "tool_result",
            title: `Result ${call.name}`,
            detail: output.slice(0, 500),
            toolName: call.name,
          });
          messages.push({
            role: "tool",
            toolCallId: call.id,
            toolName: call.name,
            content: output,
          });
        } catch (err) {
          const errText = err instanceof Error ? err.message : String(err);
          const content = `Tool error: ${errText}`;
          if (errText === lastErrorText) {
            repeatedErrorCount += 1;
          } else {
            lastErrorText = errText;
            repeatedErrorCount = 1;
          }
          ctx.reportTrace?.({
            kind: "error",
            title: `Tool error (${call.name})`,
            detail: errText.slice(0, 500),
            toolName: call.name,
            isError: true,
          });
          messages.push({
            role: "tool",
            toolCallId: call.id,
            toolName: call.name,
            content,
          });
          if (repeatedErrorCount >= 4 && !collectedToolOutput) {
            return {
              kind: "failed",
              error: `Aborted after repeated fatal tool error: ${errText}`,
            };
          }
        }
      }
    }

    if (collectedToolOutput && !ctx.signal.aborted) {
      ctx.reportProgress("Synthesizing collected findings");
      ctx.reportTrace?.({
        kind: "planning",
        title: "Reached step budget; synthesizing findings",
      });
      const wrapUp = await this.router.generate({
        role: "task_planner",
        messages: [
          ...messages,
          {
            role: "user",
            content:
              "You have reached the tool step budget. Stop calling tools and write a concise, accurate summary based only on the evidence already gathered above.",
          },
        ],
        signal: ctx.signal,
      });
      if (wrapUp.text.trim()) {
        return { kind: "completed", summary: wrapUp.text.trim() };
      }
    }

    return {
      kind: "failed",
      error: `Exceeded maxTurns (${this.maxTurns}) without completion`,
    };
  }
}
