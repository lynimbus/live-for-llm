import {
  type ApprovalId,
  type ConversationId,
  type DeviceId,
  type MemoryId,
  type MessageId,
  type ScheduleId,
  type TaskId,
  parseApprovalId,
  parseConversationId,
  parseDeviceId,
  parseMemoryId,
  parseMessageId,
  parseScheduleId,
  parseTaskId,
} from "./ids.ts";
import {
  type MemoryDraft,
  type MemoryRecord,
  parseMemoryDraft,
  parseMemoryRecord,
} from "./memory.ts";
import {
  expectBoolean,
  expectEnum,
  expectNonEmptyString,
  expectNumber,
  expectObject,
  expectOptionalString,
  expectString,
  expectStringArray,
} from "./parse.ts";
import {
  ACTION_RISK_TIERS,
  type ApprovalDecision,
  type ApprovalRequest,
  type PolicyConfig,
  type TaskRecord,
  TRUST_POLICY_MODES,
  parseTaskRecord,
} from "./tasks.ts";

export interface ChatMessage {
  readonly id: MessageId;
  readonly conversationId: ConversationId;
  readonly role: "user" | "companion" | "system";
  readonly content: string;
  readonly createdAt: string;
  readonly proactive?: boolean;
  readonly linkedTaskId?: TaskId;
}

export interface ProactiveRule {
  readonly id: ScheduleId;
  readonly label: string;
  readonly cronOrIntervalMinutes: number;
  readonly quietHoursStart: number;
  readonly quietHoursEnd: number;
  readonly enabled: boolean;
  readonly promptHint: string;
}

export type ClientCommand =
  | {
      readonly kind: "chat.send";
      readonly conversationId: ConversationId;
      readonly content: string;
      readonly deviceId?: DeviceId;
    }
  | {
      readonly kind: "approval.decide";
      readonly approvalId: ApprovalId;
      readonly decision: ApprovalDecision;
    }
  | {
      readonly kind: "task.cancel";
      readonly taskId: TaskId;
    }
  | {
      readonly kind: "browser.resume_user";
      readonly taskId: TaskId;
    }
  | {
      readonly kind: "memory.upsert";
      readonly draft: MemoryDraft;
    }
  | {
      readonly kind: "memory.delete";
      readonly memoryId: MemoryId;
    }
  | {
      readonly kind: "policy.update";
      readonly policy: PolicyConfig;
    }
  | {
      readonly kind: "schedule.upsert";
      readonly rule: ProactiveRule;
    }
  | {
      readonly kind: "ping";
      readonly sentAt: string;
    };

export type DaemonEvent =
  | {
      readonly kind: "chat.delta";
      readonly conversationId: ConversationId;
      readonly messageId: MessageId;
      readonly delta: string;
    }
  | {
      readonly kind: "chat.message";
      readonly message: ChatMessage;
    }
  | {
      readonly kind: "proactive.message";
      readonly message: ChatMessage;
      readonly ruleId: ScheduleId;
    }
  | {
      readonly kind: "task.updated";
      readonly task: TaskRecord;
    }
  | {
      readonly kind: "browser.screenshot";
      readonly taskId: TaskId;
      readonly mimeType: "image/png" | "image/jpeg";
      readonly base64: string;
      readonly url: string;
      readonly capturedAt: string;
    }
  | {
      readonly kind: "approval.requested";
      readonly approval: ApprovalRequest;
    }
  | {
      readonly kind: "memory.updated";
      readonly records: readonly MemoryRecord[];
      readonly replaced?: boolean;
    }
  | {
      readonly kind: "policy.updated";
      readonly policy: PolicyConfig;
    }
  | {
      readonly kind: "pong";
      readonly receivedAt: string;
    }
  | {
      readonly kind: "error";
      readonly code: string;
      readonly message: string;
    };

function parseChatMessage(raw: unknown): ChatMessage {
  const obj = expectObject(raw, "ChatMessage");
  const proactive = obj["proactive"] === undefined ? undefined : expectBoolean(obj["proactive"], "ChatMessage.proactive");
  const linkedTaskId =
    obj["linkedTaskId"] === undefined ? undefined : parseTaskId(obj["linkedTaskId"]);
  return {
    id: parseMessageId(obj["id"]),
    conversationId: parseConversationId(obj["conversationId"]),
    role: expectEnum(obj["role"], ["user", "companion", "system"], "ChatMessage.role"),
    content: expectString(obj["content"], "ChatMessage.content"),
    createdAt: expectString(obj["createdAt"], "ChatMessage.createdAt"),
    ...(proactive !== undefined ? { proactive } : {}),
    ...(linkedTaskId !== undefined ? { linkedTaskId } : {}),
  };
}

function parsePolicyConfig(raw: unknown): PolicyConfig {
  const obj = expectObject(raw, "PolicyConfig");
  const rawTiers = obj["alwaysConfirmTiers"];
  if (!Array.isArray(rawTiers)) {
    throw new Error("Invalid PolicyConfig.alwaysConfirmTiers: expected array");
  }
  const alwaysConfirmTiers = rawTiers.map((tier) =>
    expectEnum(tier, ACTION_RISK_TIERS, "PolicyConfig.alwaysConfirmTiers[]"),
  );
  return {
    mode: expectEnum(obj["mode"], TRUST_POLICY_MODES, "PolicyConfig.mode"),
    autoApproveDomains: expectStringArray(
      obj["autoApproveDomains"],
      "PolicyConfig.autoApproveDomains",
    ),
    alwaysConfirmTiers,
  };
}

function parseProactiveRule(raw: unknown): ProactiveRule {
  const obj = expectObject(raw, "ProactiveRule");
  return {
    id: parseScheduleId(obj["id"]),
    label: expectNonEmptyString(obj["label"], "ProactiveRule.label"),
    cronOrIntervalMinutes: expectNumber(
      obj["cronOrIntervalMinutes"],
      "ProactiveRule.cronOrIntervalMinutes",
    ),
    quietHoursStart: expectNumber(obj["quietHoursStart"], "ProactiveRule.quietHoursStart"),
    quietHoursEnd: expectNumber(obj["quietHoursEnd"], "ProactiveRule.quietHoursEnd"),
    enabled: expectBoolean(obj["enabled"], "ProactiveRule.enabled"),
    promptHint: expectString(obj["promptHint"], "ProactiveRule.promptHint"),
  };
}

/** Validates an incoming WebSocket or HTTP command from desktop or mobile clients. */
export function parseClientCommand(raw: unknown): ClientCommand {
  const obj = expectObject(raw, "ClientCommand");
  const kind = expectString(obj["kind"], "ClientCommand.kind");
  switch (kind) {
    case "chat.send": {
      const deviceId = obj["deviceId"] === undefined ? undefined : parseDeviceId(obj["deviceId"]);
      return {
        kind: "chat.send",
        conversationId: parseConversationId(obj["conversationId"]),
        content: expectNonEmptyString(obj["content"], "chat.send.content"),
        ...(deviceId !== undefined ? { deviceId } : {}),
      };
    }
    case "approval.decide":
      return {
        kind: "approval.decide",
        approvalId: parseApprovalId(obj["approvalId"]),
        decision: expectEnum(obj["decision"], ["approved", "denied"], "approval.decide.decision"),
      };
    case "task.cancel":
      return { kind: "task.cancel", taskId: parseTaskId(obj["taskId"]) };
    case "browser.resume_user":
      return { kind: "browser.resume_user", taskId: parseTaskId(obj["taskId"]) };
    case "memory.upsert":
      return { kind: "memory.upsert", draft: parseMemoryDraft(obj["draft"]) };
    case "memory.delete":
      return { kind: "memory.delete", memoryId: parseMemoryId(obj["memoryId"]) };
    case "policy.update":
      return { kind: "policy.update", policy: parsePolicyConfig(obj["policy"]) };
    case "schedule.upsert":
      return { kind: "schedule.upsert", rule: parseProactiveRule(obj["rule"]) };
    case "ping":
      return { kind: "ping", sentAt: expectString(obj["sentAt"], "ping.sentAt") };
    default:
      throw new Error(`Invalid ClientCommand.kind: ${kind}`);
  }
}

/** Validates an incoming daemon event on the desktop or mobile client boundary. */
export function parseDaemonEvent(raw: unknown): DaemonEvent {
  const obj = expectObject(raw, "DaemonEvent");
  const kind = expectString(obj["kind"], "DaemonEvent.kind");
  switch (kind) {
    case "chat.delta":
      return {
        kind: "chat.delta",
        conversationId: parseConversationId(obj["conversationId"]),
        messageId: parseMessageId(obj["messageId"]),
        delta: expectString(obj["delta"], "chat.delta.delta"),
      };
    case "chat.message":
      return { kind: "chat.message", message: parseChatMessage(obj["message"]) };
    case "proactive.message":
      return {
        kind: "proactive.message",
        message: parseChatMessage(obj["message"]),
        ruleId: parseScheduleId(obj["ruleId"]),
      };
    case "task.updated":
      return { kind: "task.updated", task: parseTaskRecord(obj["task"]) };
    case "browser.screenshot":
      return {
        kind: "browser.screenshot",
        taskId: parseTaskId(obj["taskId"]),
        mimeType: expectEnum(
          obj["mimeType"],
          ["image/png", "image/jpeg"],
          "browser.screenshot.mimeType",
        ),
        base64: expectNonEmptyString(obj["base64"], "browser.screenshot.base64"),
        url: expectString(obj["url"], "browser.screenshot.url"),
        capturedAt: expectString(obj["capturedAt"], "browser.screenshot.capturedAt"),
      };
    case "approval.requested": {
      const approvalObj = expectObject(obj["approval"], "approval.requested.approval");
      const domain = expectOptionalString(approvalObj["domain"], "approval.domain");
      const draftPreview = expectOptionalString(
        approvalObj["draftPreview"],
        "approval.draftPreview",
      );
      return {
        kind: "approval.requested",
        approval: {
          id: parseApprovalId(approvalObj["id"]),
          taskId: parseTaskId(approvalObj["taskId"]),
          actionSummary: expectNonEmptyString(
            approvalObj["actionSummary"],
            "approval.actionSummary",
          ),
          riskTier: expectEnum(approvalObj["riskTier"], ACTION_RISK_TIERS, "approval.riskTier"),
          ...(domain !== undefined ? { domain } : {}),
          ...(draftPreview !== undefined ? { draftPreview } : {}),
          requestedAt: expectString(approvalObj["requestedAt"], "approval.requestedAt"),
        },
      };
    }
    case "memory.updated": {
      if (!Array.isArray(obj["records"])) {
        throw new Error("Invalid memory.updated.records: expected array");
      }
      const replaced =
        obj["replaced"] === undefined
          ? undefined
          : expectBoolean(obj["replaced"], "memory.updated.replaced");
      return {
        kind: "memory.updated",
        records: obj["records"].map((item) => parseMemoryRecord(item)),
        ...(replaced !== undefined ? { replaced } : {}),
      };
    }
    case "policy.updated":
      return { kind: "policy.updated", policy: parsePolicyConfig(obj["policy"]) };
    case "pong":
      return { kind: "pong", receivedAt: expectString(obj["receivedAt"], "pong.receivedAt") };
    case "error":
      return {
        kind: "error",
        code: expectNonEmptyString(obj["code"], "error.code"),
        message: expectString(obj["message"], "error.message"),
      };
    default:
      throw new Error(`Invalid DaemonEvent.kind: ${kind}`);
  }
}
