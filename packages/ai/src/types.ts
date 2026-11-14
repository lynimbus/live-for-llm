export const MODEL_ROLES = [
  "companion_chat",
  "memory_extract",
  "task_planner",
  "vision_browser",
  "embedding",
] as const;

export type ModelRole = (typeof MODEL_ROLES)[number];

export const PROVIDER_KINDS = ["openai_compatible", "anthropic", "gemini"] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];

export interface ModelProfile {
  readonly id: string;
  readonly provider: ProviderKind;
  readonly baseUrl: string;
  readonly model: string;
  readonly apiKey?: string;
  readonly apiKeyEnv?: string;
  readonly temperature?: number;
  readonly maxTokens?: number;
}

export type TieredModelConfig = Record<ModelRole, ModelProfile>;

export interface ToolCallRequest {
  readonly id: string;
  readonly name: string;
  readonly arguments: Record<string, unknown>;
}

export interface ToolSpec {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
}

export interface ChatTurnMessage {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content: string;
  readonly toolCallId?: string;
  readonly toolName?: string;
  readonly toolCalls?: readonly ToolCallRequest[];
  readonly imageBase64?: string;
  readonly imageMimeType?: "image/png" | "image/jpeg";
}

export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface CompletionResponse {
  readonly text: string;
  readonly toolCalls: readonly ToolCallRequest[];
  readonly usage?: TokenUsage;
}

export type StreamChunk =
  | { readonly kind: "text_delta"; readonly delta: string }
  | { readonly kind: "tool_call"; readonly call: ToolCallRequest }
  | { readonly kind: "done"; readonly response: CompletionResponse };

export interface GenerateOptions {
  readonly role: ModelRole;
  readonly messages: readonly ChatTurnMessage[];
  readonly tools?: readonly ToolSpec[];
  readonly signal?: AbortSignal;
}

export interface ModelRouter {
  getProfile(role: ModelRole): ModelProfile;
  updateConfig(config: TieredModelConfig): void;
  generate(options: GenerateOptions): Promise<CompletionResponse>;
  stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
  embed(texts: readonly string[], signal?: AbortSignal): Promise<Float32Array[]>;
}
