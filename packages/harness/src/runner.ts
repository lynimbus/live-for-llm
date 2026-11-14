import type {
  ActionRiskTier,
  ApprovalDecision,
  ConversationId,
  TaskId,
  TaskKind,
} from "@live-for-llm/protocol";

export interface ApprovalPromptInput {
  readonly actionSummary: string;
  readonly riskTier: ActionRiskTier;
  readonly domain?: string;
  readonly draftPreview?: string;
}

export interface UserPauseInput {
  readonly reason: "login_required" | "captcha_or_2fa" | "manual_intervention";
  readonly instructions: string;
}

export interface TaskRunContext {
  readonly taskId: TaskId;
  readonly conversationId: ConversationId;
  readonly taskKind: TaskKind;
  readonly goal: string;
  readonly metadata?: Record<string, unknown>;
  readonly signal: AbortSignal;
  reportProgress(stepSummary: string, screenshotBase64?: string): void;
  requestApproval(input: ApprovalPromptInput): Promise<ApprovalDecision>;
  requestUserPause(input: UserPauseInput): Promise<void>;
}

export type TaskRunOutcome =
  | { readonly kind: "completed"; readonly summary: string }
  | { readonly kind: "failed"; readonly error: string }
  | { readonly kind: "cancelled" };

export interface TaskRunner {
  readonly id: string;
  readonly label: string;
  readonly supportedKinds: readonly TaskKind[];
  run(ctx: TaskRunContext): Promise<TaskRunOutcome>;
}

/** Registry mapping runner IDs and TaskKinds to TaskRunner implementations. */
export class TaskRunnerRegistry {
  private readonly runners = new Map<string, TaskRunner>();

  register(runner: TaskRunner): this {
    this.runners.set(runner.id, runner);
    return this;
  }

  get(id: string): TaskRunner | undefined {
    return this.runners.get(id);
  }

  resolve(params: { readonly runnerId?: string; readonly taskKind: TaskKind }): TaskRunner {
    if (params.runnerId) {
      const explicit = this.runners.get(params.runnerId);
      if (!explicit) {
        throw new Error(`Unknown TaskRunner: ${params.runnerId}`);
      }
      return explicit;
    }
    for (const runner of this.runners.values()) {
      if (runner.supportedKinds.includes(params.taskKind)) {
        return runner;
      }
    }
    throw new Error(`No TaskRunner registered for kind: ${params.taskKind}`);
  }

  list(): TaskRunner[] {
    return Array.from(this.runners.values());
  }
}
