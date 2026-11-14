export type JsonObject = Record<string, unknown>;

export function expectObject(value: unknown, label: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Invalid ${label}: expected object`);
  }
  return value as JsonObject;
}

export function expectNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Invalid ${label}: expected non-empty string`);
  }
  return value;
}

export function expectString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`Invalid ${label}: expected string`);
  }
  return value;
}

export function expectOptionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  return expectString(value, label);
}

export function expectNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Invalid ${label}: expected finite number`);
  }
  return value;
}

export function expectBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`Invalid ${label}: expected boolean`);
  }
  return value;
}

export function expectStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`Invalid ${label}: expected string array`);
  }
  return value as string[];
}

export function expectEnum<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  label: string,
): T[number] {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new Error(`Invalid ${label}: expected one of ${allowed.join(", ")}`);
  }
  return value as T[number];
}
