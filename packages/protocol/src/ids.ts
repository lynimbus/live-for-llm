declare const brandTag: unique symbol;

export type Brand<T extends string, Name extends string> = T & {
  readonly [brandTag]: Name;
};

export type ConversationId = Brand<string, "ConversationId">;
export type MessageId = Brand<string, "MessageId">;
export type MemoryId = Brand<string, "MemoryId">;
export type TaskId = Brand<string, "TaskId">;
export type ApprovalId = Brand<string, "ApprovalId">;
export type BrowserProfileId = Brand<string, "BrowserProfileId">;
export type DeviceId = Brand<string, "DeviceId">;
export type ScheduleId = Brand<string, "ScheduleId">;

const SAFE_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;

function isSafeIdString(value: unknown): value is string {
  return typeof value === "string" && SAFE_ID_PATTERN.test(value);
}

function parseBrandedId<Name extends string>(
  value: unknown,
  label: Name,
): Brand<string, Name> {
  if (!isSafeIdString(value)) {
    throw new Error(`Invalid ${label}: expected 1..128 alphanumeric/dash/underscore characters`);
  }
  return value as Brand<string, Name>;
}

export function isConversationId(value: unknown): value is ConversationId {
  return isSafeIdString(value);
}
export function parseConversationId(value: unknown): ConversationId {
  return parseBrandedId(value, "ConversationId");
}

export function isMessageId(value: unknown): value is MessageId {
  return isSafeIdString(value);
}
export function parseMessageId(value: unknown): MessageId {
  return parseBrandedId(value, "MessageId");
}

export function isMemoryId(value: unknown): value is MemoryId {
  return isSafeIdString(value);
}
export function parseMemoryId(value: unknown): MemoryId {
  return parseBrandedId(value, "MemoryId");
}

export function isTaskId(value: unknown): value is TaskId {
  return isSafeIdString(value);
}
export function parseTaskId(value: unknown): TaskId {
  return parseBrandedId(value, "TaskId");
}

export function isApprovalId(value: unknown): value is ApprovalId {
  return isSafeIdString(value);
}
export function parseApprovalId(value: unknown): ApprovalId {
  return parseBrandedId(value, "ApprovalId");
}

export function isBrowserProfileId(value: unknown): value is BrowserProfileId {
  return isSafeIdString(value);
}
export function parseBrowserProfileId(value: unknown): BrowserProfileId {
  return parseBrandedId(value, "BrowserProfileId");
}

export function isDeviceId(value: unknown): value is DeviceId {
  return isSafeIdString(value);
}
export function parseDeviceId(value: unknown): DeviceId {
  return parseBrandedId(value, "DeviceId");
}

export function isScheduleId(value: unknown): value is ScheduleId {
  return isSafeIdString(value);
}
export function parseScheduleId(value: unknown): ScheduleId {
  return parseBrandedId(value, "ScheduleId");
}
