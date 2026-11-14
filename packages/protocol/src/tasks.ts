import {
  type ApprovalId,
  type BrowserProfileId,
  type ConversationId,
  type TaskId,
  parseApprovalId,
  parseBrowserProfileId,
  parseConversationId,
  parseTaskId,
} from "./ids.ts";
import {
  expectBoolean,
  expectEnum,
  expectNonEmptyString,
  expectNumber,
  expectObject,
  expectOptionalString,
  expectString,
} from "./parse.ts";

export const TASK_KINDS = ["browser_research", "browser_post", "harness_coding", "shell_utility"] as const;
export type TaskKind = (typeof TASK_KINDS)[number];

export const ACTION_RISK_TIERS = [
  "read_only",
  "local_write",
  "external_send",
  "destructive",
] as const;
export type ActionRiskTier = (typeof ACTION_RISK_TIERS)[number];

export const TRUST_POLICY_MODES = ["yolo", "trust_auto", "confirm_external", "allowlist"] as const;
export type TrustPolicyMode = (typeof TRUST_POLICY_MODES)[number];

export interface PolicyConfig {
  readonly mode: TrustPolicyMode;
  readonly autoApproveDomains: readonly string[];
  readonly alwaysConfirmTiers: readonly ActionRiskTier[];
}

export const DEFAULT_POLICY_CONFIG: PolicyConfig = {
  mode: "trust_auto",
  autoApproveDomains: [],
  alwaysConfirmTiers: ["destructive"],
};

export type TaskState =
  | {
      readonly kind: "queued";
      readonly queuedAt: string;
    }
  | {
      readonly kind: "running";
      readonly startedAt: string;
      readonly stepSummary: string;
      readonly latestScreenshotBase64?: string;
      readonly latestUrl?: string;
    }
  | {
      readonly kind: "awaiting_approval";
      readonly approvalId: ApprovalId;
      readonly actionSummary: string;
      readonly riskTier: ActionRiskTier;
      readonly domain?: string;
      readonly draftPreview?: string;
      readonly requestedAt: string;
    }
  | {
      readonly kind: "paused_for_user";
      readonly reason: "login_required" | "captcha_or_2fa" | "manual_intervention";
      readonly instructions: string;
      readonly pausedAt: string;
    }
  | {
      readonly kind: "completed";
      readonly summary: string;
      readonly completedAt: string;
    }
  | {
      readonly kind: "failed";
      readonly error: string;
      readonly failedAt: string;
    }
  | {
      readonly kind: "cancelled";
      readonly cancelledAt: string;
    };

export interface TaskRecord {
  readonly id: TaskId;
  readonly conversationId: ConversationId;
  readonly taskKind: TaskKind;
  readonly title: string;
  readonly runnerId: string;
  readonly browserProfileId?: BrowserProfileId;
  readonly state: TaskState;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type ApprovalDecision = "approved" | "denied";

export interface ApprovalRequest {
  readonly id: ApprovalId;
  readonly taskId: TaskId;
  readonly actionSummary: string;
  readonly riskTier: ActionRiskTier;
  readonly domain?: string;
  readonly draftPreview?: string;
  readonly requestedAt: string;
}

/** Evaluates whether an action under the active PolicyConfig requires explicit human approval. */
export function evaluatePolicyDecision(params: {
  readonly policy: PolicyConfig;
  readonly riskTier: ActionRiskTier;
  readonly domain?: string;
}): "allow" | "require_approval" {
  if (params.policy.mode === "yolo") {
    return "allow";
  }
  if (params.policy.alwaysConfirmTiers.includes(params.riskTier)) {
    return "require_approval";
  }
  switch (params.policy.mode) {
    case "trust_auto":
      return "allow";
    case "confirm_external":
      return params.riskTier === "external_send" ? "require_approval" : "allow";
    case "allowlist": {
      if (params.riskTier !== "external_send") return "allow";
      if (!params.domain) return "require_approval";
      const normalized = params.domain.toLowerCase();
      const matched = params.policy.autoApproveDomains.some(
        (d) => normalized === d.toLowerCase() || normalized.endsWith(`.${d.toLowerCase()}`),
      );
      return matched ? "allow" : "require_approval";
    }
    default: {
      const _exhaustive: never = params.policy.mode;
      return _exhaustive;
    }
  }
}

/** Parses an external TaskState payload into the discriminated TaskState union. */
export function parseTaskState(raw: unknown): TaskState {
  const obj = expectObject(raw, "TaskState");
  const kind = expectString(obj["kind"], "TaskState.kind");
  switch (kind) {
    case "queued":
      return { kind: "queued", queuedAt: expectString(obj["queuedAt"], "TaskState.queuedAt") };
    case "running": {
      const screenshot = expectOptionalString(
        obj["latestScreenshotBase64"],
        "TaskState.latestScreenshotBase64",
      );
      const latestUrl = expectOptionalString(obj["latestUrl"], "TaskState.latestUrl");
      return {
        kind: "running",
        startedAt: expectString(obj["startedAt"], "TaskState.startedAt"),
        stepSummary: expectString(obj["stepSummary"], "TaskState.stepSummary"),
        ...(screenshot !== undefined ? { latestScreenshotBase64: screenshot } : {}),
        ...(latestUrl !== undefined ? { latestUrl } : {}),
      };
    }
    case "awaiting_approval": {
      const domain = expectOptionalString(obj["domain"], "TaskState.domain");
      const draftPreview = expectOptionalString(obj["draftPreview"], "TaskState.draftPreview");
      return {
        kind: "awaiting_approval",
        approvalId: parseApprovalId(obj["approvalId"]),
        actionSummary: expectNonEmptyString(obj["actionSummary"], "TaskState.actionSummary"),
        riskTier: expectEnum(obj["riskTier"], ACTION_RISK_TIERS, "TaskState.riskTier"),
        ...(domain !== undefined ? { domain } : {}),
        ...(draftPreview !== undefined ? { draftPreview } : {}),
        requestedAt: expectString(obj["requestedAt"], "TaskState.requestedAt"),
      };
    }
    case "paused_for_user":
      return {
        kind: "paused_for_user",
        reason: expectEnum(
          obj["reason"],
          ["login_required", "captcha_or_2fa", "manual_intervention"],
          "TaskState.reason",
        ),
        instructions: expectNonEmptyString(obj["instructions"], "TaskState.instructions"),
        pausedAt: expectString(obj["pausedAt"], "TaskState.pausedAt"),
      };
    case "completed":
      return {
        kind: "completed",
        summary: expectString(obj["summary"], "TaskState.summary"),
        completedAt: expectString(obj["completedAt"], "TaskState.completedAt"),
      };
    case "failed":
      return {
        kind: "failed",
        error: expectString(obj["error"], "TaskState.error"),
        failedAt: expectString(obj["failedAt"], "TaskState.failedAt"),
      };
    case "cancelled":
      return {
        kind: "cancelled",
        cancelledAt: expectString(obj["cancelledAt"], "TaskState.cancelledAt"),
      };
    default:
      throw new Error(`Invalid TaskState.kind: ${kind}`);
  }
}

export const TASK_TRACE_KINDS = [
  "status",
  "planning",
  "tool_call",
  "tool_result",
  "browser_action",
  "cli_output",
  "approval",
  "error",
] as const;
export type TaskTraceKind = (typeof TASK_TRACE_KINDS)[number];

export interface TaskTraceEntry {
  readonly id: string;
  readonly taskId: TaskId;
  readonly seq: number;
  readonly kind: TaskTraceKind;
  readonly title: string;
  readonly detail?: string;
  readonly toolName?: string;
  readonly url?: string;
  readonly isError?: boolean;
  readonly createdAt: string;
}

/** Parses an external TaskTraceEntry payload. */
export function parseTaskTraceEntry(raw: unknown): TaskTraceEntry {
  const obj = expectObject(raw, "TaskTraceEntry");
  const detail = expectOptionalString(obj["detail"], "TaskTraceEntry.detail");
  const toolName = expectOptionalString(obj["toolName"], "TaskTraceEntry.toolName");
  const url = expectOptionalString(obj["url"], "TaskTraceEntry.url");
  const isError =
    obj["isError"] === undefined ? undefined : expectBoolean(obj["isError"], "TaskTraceEntry.isError");
  return {
    id: expectNonEmptyString(obj["id"], "TaskTraceEntry.id"),
    taskId: parseTaskId(obj["taskId"]),
    seq: expectNumber(obj["seq"], "TaskTraceEntry.seq"),
    kind: expectEnum(obj["kind"], TASK_TRACE_KINDS, "TaskTraceEntry.kind"),
    title: expectNonEmptyString(obj["title"], "TaskTraceEntry.title"),
    ...(detail !== undefined ? { detail } : {}),
    ...(toolName !== undefined ? { toolName } : {}),
    ...(url !== undefined ? { url } : {}),
    ...(isError !== undefined ? { isError } : {}),
    createdAt: expectString(obj["createdAt"], "TaskTraceEntry.createdAt"),
  };
}

/** Parses an external TaskRecord payload into a validated TaskRecord. */
export function parseTaskRecord(raw: unknown): TaskRecord {
  const obj = expectObject(raw, "TaskRecord");
  const browserProfileId =
    obj["browserProfileId"] === undefined
      ? undefined
      : parseBrowserProfileId(obj["browserProfileId"]);
  return {
    id: parseTaskId(obj["id"]),
    conversationId: parseConversationId(obj["conversationId"]),
    taskKind: expectEnum(obj["taskKind"], TASK_KINDS, "TaskRecord.taskKind"),
    title: expectNonEmptyString(obj["title"], "TaskRecord.title"),
    runnerId: expectNonEmptyString(obj["runnerId"], "TaskRecord.runnerId"),
    ...(browserProfileId !== undefined ? { browserProfileId } : {}),
    state: parseTaskState(obj["state"]),
    createdAt: expectString(obj["createdAt"], "TaskRecord.createdAt"),
    updatedAt: expectString(obj["updatedAt"], "TaskRecord.updatedAt"),
  };
}
