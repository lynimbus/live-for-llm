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
  type RelationshipState,
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
  readonly recalled?: boolean;
  readonly recalledAt?: string;
  readonly recalledBy?: "user" | "companion";
}

export interface ModelFetchRequest {
  readonly provider: LlmProviderKind;
  readonly baseUrl: string;
  readonly apiKey?: string;
}

export interface ModelFetchResult {
  readonly models: readonly string[];
}

export const LLM_PROVIDER_KINDS = ["openai_compatible", "anthropic", "gemini"] as const;
export type LlmProviderKind = (typeof LLM_PROVIDER_KINDS)[number];

export interface ModelSettingsSummary {
  readonly provider: LlmProviderKind;
  readonly baseUrl: string;
  readonly companionModel: string;
  readonly taskModel: string;
  readonly memoryModel: string;
  readonly visionModel: string;
  readonly embeddingModel: string;
  readonly hasApiKey: boolean;
  readonly apiKeyMasked?: string;
  readonly apiKeyEnv?: string;
}

export interface ModelSettingsUpdate {
  readonly provider: LlmProviderKind;
  readonly baseUrl: string;
  readonly companionModel: string;
  readonly taskModel: string;
  readonly memoryModel?: string;
  readonly visionModel?: string;
  readonly embeddingModel?: string;
  readonly apiKey?: string;
  readonly clearApiKey?: boolean;
  readonly apiKeyEnv?: string;
}

export interface RelationshipUpdate {
  readonly companionName?: string;
  readonly userName?: string;
  readonly currentMood?: string;
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
      readonly kind: "chat.recall";
      readonly conversationId: ConversationId;
      readonly messageId: MessageId;
      readonly by?: "user" | "companion";
    }
  | {
      readonly kind: "chat.delete";
      readonly conversationId: ConversationId;
      readonly messageIds: readonly MessageId[];
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
      readonly kind: "models.update";
      readonly settings: ModelSettingsUpdate;
    }
  | {
      readonly kind: "relationship.update";
      readonly patch: RelationshipUpdate;
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
      readonly kind: "chat.updated";
      readonly conversationId: ConversationId;
      readonly messages: readonly ChatMessage[];
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
      readonly kind: "models.updated";
      readonly settings: ModelSettingsSummary;
    }
  | {
      readonly kind: "relationship.updated";
      readonly relationship: RelationshipState;
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
  const recalled = obj["recalled"] === undefined ? undefined : expectBoolean(obj["recalled"], "ChatMessage.recalled");
  const recalledAt = expectOptionalString(obj["recalledAt"], "ChatMessage.recalledAt");
  const recalledBy =
    obj["recalledBy"] === undefined
      ? undefined
      : expectEnum(obj["recalledBy"], ["user", "companion"], "ChatMessage.recalledBy");
  return {
    id: parseMessageId(obj["id"]),
    conversationId: parseConversationId(obj["conversationId"]),
    role: expectEnum(obj["role"], ["user", "companion", "system"], "ChatMessage.role"),
    content: expectString(obj["content"], "ChatMessage.content"),
    createdAt: expectString(obj["createdAt"], "ChatMessage.createdAt"),
    ...(proactive !== undefined ? { proactive } : {}),
    ...(linkedTaskId !== undefined ? { linkedTaskId } : {}),
    ...(recalled !== undefined ? { recalled } : {}),
    ...(recalledAt !== undefined ? { recalledAt } : {}),
    ...(recalledBy !== undefined ? { recalledBy } : {}),
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

function parseModelSettingsUpdate(raw: unknown): ModelSettingsUpdate {
  const obj = expectObject(raw, "ModelSettingsUpdate");
  const memoryModel = expectOptionalString(obj["memoryModel"], "ModelSettingsUpdate.memoryModel");
  const visionModel = expectOptionalString(obj["visionModel"], "ModelSettingsUpdate.visionModel");
  const embeddingModel = expectOptionalString(
    obj["embeddingModel"],
    "ModelSettingsUpdate.embeddingModel",
  );
  const apiKey = expectOptionalString(obj["apiKey"], "ModelSettingsUpdate.apiKey");
  const apiKeyEnv = expectOptionalString(obj["apiKeyEnv"], "ModelSettingsUpdate.apiKeyEnv");
  const clearApiKey =
    obj["clearApiKey"] === undefined
      ? undefined
      : expectBoolean(obj["clearApiKey"], "ModelSettingsUpdate.clearApiKey");

  return {
    provider: expectEnum(obj["provider"], LLM_PROVIDER_KINDS, "ModelSettingsUpdate.provider"),
    baseUrl: expectNonEmptyString(obj["baseUrl"], "ModelSettingsUpdate.baseUrl").trim(),
    companionModel: expectNonEmptyString(
      obj["companionModel"],
      "ModelSettingsUpdate.companionModel",
    ).trim(),
    taskModel: expectNonEmptyString(obj["taskModel"], "ModelSettingsUpdate.taskModel").trim(),
    ...(memoryModel !== undefined && memoryModel.trim() ? { memoryModel: memoryModel.trim() } : {}),
    ...(visionModel !== undefined && visionModel.trim() ? { visionModel: visionModel.trim() } : {}),
    ...(embeddingModel !== undefined && embeddingModel.trim()
      ? { embeddingModel: embeddingModel.trim() }
      : {}),
    ...(apiKey !== undefined ? { apiKey: apiKey.trim() } : {}),
    ...(clearApiKey !== undefined ? { clearApiKey } : {}),
    ...(apiKeyEnv !== undefined && apiKeyEnv.trim() ? { apiKeyEnv: apiKeyEnv.trim() } : {}),
  };
}

function parseModelSettingsSummary(raw: unknown): ModelSettingsSummary {
  const obj = expectObject(raw, "ModelSettingsSummary");
  const apiKeyMasked = expectOptionalString(obj["apiKeyMasked"], "ModelSettingsSummary.apiKeyMasked");
  const apiKeyEnv = expectOptionalString(obj["apiKeyEnv"], "ModelSettingsSummary.apiKeyEnv");
  return {
    provider: expectEnum(obj["provider"], LLM_PROVIDER_KINDS, "ModelSettingsSummary.provider"),
    baseUrl: expectNonEmptyString(obj["baseUrl"], "ModelSettingsSummary.baseUrl"),
    companionModel: expectNonEmptyString(
      obj["companionModel"],
      "ModelSettingsSummary.companionModel",
    ),
    taskModel: expectNonEmptyString(obj["taskModel"], "ModelSettingsSummary.taskModel"),
    memoryModel: expectNonEmptyString(obj["memoryModel"], "ModelSettingsSummary.memoryModel"),
    visionModel: expectNonEmptyString(obj["visionModel"], "ModelSettingsSummary.visionModel"),
    embeddingModel: expectNonEmptyString(
      obj["embeddingModel"],
      "ModelSettingsSummary.embeddingModel",
    ),
    hasApiKey: expectBoolean(obj["hasApiKey"], "ModelSettingsSummary.hasApiKey"),
    ...(apiKeyMasked !== undefined ? { apiKeyMasked } : {}),
    ...(apiKeyEnv !== undefined ? { apiKeyEnv } : {}),
  };
}

function parseRelationshipUpdate(raw: unknown): RelationshipUpdate {
  const obj = expectObject(raw, "RelationshipUpdate");
  const companionName = expectOptionalString(
    obj["companionName"],
    "RelationshipUpdate.companionName",
  );
  const userName = expectOptionalString(obj["userName"], "RelationshipUpdate.userName");
  const currentMood = expectOptionalString(obj["currentMood"], "RelationshipUpdate.currentMood");
  return {
    ...(companionName !== undefined && companionName.trim()
      ? { companionName: companionName.trim() }
      : {}),
    ...(userName !== undefined && userName.trim() ? { userName: userName.trim() } : {}),
    ...(currentMood !== undefined && currentMood.trim()
      ? { currentMood: currentMood.trim() }
      : {}),
  };
}

function parseRelationshipState(raw: unknown): RelationshipState {
  const obj = expectObject(raw, "RelationshipState");
  const rawAnniv = obj["anniversaries"];
  if (!Array.isArray(rawAnniv)) {
    throw new Error("Invalid RelationshipState.anniversaries: expected array");
  }
  const anniversaries = rawAnniv.map((item, idx) => {
    const entry = expectObject(item, `RelationshipState.anniversaries[${idx}]`);
    return {
      label: expectString(entry["label"], "anniversary.label"),
      date: expectString(entry["date"], "anniversary.date"),
    };
  });
  return {
    companionName: expectNonEmptyString(obj["companionName"], "RelationshipState.companionName"),
    userName: expectNonEmptyString(obj["userName"], "RelationshipState.userName"),
    affinityScore: expectNumber(obj["affinityScore"], "RelationshipState.affinityScore"),
    currentMood: expectNonEmptyString(obj["currentMood"], "RelationshipState.currentMood"),
    insideJokes: expectStringArray(obj["insideJokes"], "RelationshipState.insideJokes"),
    anniversaries,
    updatedAt: expectString(obj["updatedAt"], "RelationshipState.updatedAt"),
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
    case "chat.recall": {
      const by =
        obj["by"] === undefined
          ? undefined
          : expectEnum(obj["by"], ["user", "companion"], "chat.recall.by");
      return {
        kind: "chat.recall",
        conversationId: parseConversationId(obj["conversationId"]),
        messageId: parseMessageId(obj["messageId"]),
        ...(by !== undefined ? { by } : {}),
      };
    }
    case "chat.delete": {
      const rawIds = obj["messageIds"];
      if (!Array.isArray(rawIds)) {
        throw new Error("Invalid chat.delete.messageIds: expected array");
      }
      return {
        kind: "chat.delete",
        conversationId: parseConversationId(obj["conversationId"]),
        messageIds: rawIds.map((item) => parseMessageId(item)),
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
    case "models.update":
      return { kind: "models.update", settings: parseModelSettingsUpdate(obj["settings"]) };
    case "relationship.update":
      return { kind: "relationship.update", patch: parseRelationshipUpdate(obj["patch"]) };
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
    case "chat.updated": {
      if (!Array.isArray(obj["messages"])) {
        throw new Error("Invalid chat.updated.messages: expected array");
      }
      return {
        kind: "chat.updated",
        conversationId: parseConversationId(obj["conversationId"]),
        messages: obj["messages"].map((item) => parseChatMessage(item)),
      };
    }
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
    case "models.updated":
      return { kind: "models.updated", settings: parseModelSettingsSummary(obj["settings"]) };
    case "relationship.updated":
      return {
        kind: "relationship.updated",
        relationship: parseRelationshipState(obj["relationship"]),
      };
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
