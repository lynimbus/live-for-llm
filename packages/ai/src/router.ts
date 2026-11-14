import {
  type FetchLike,
  generateCompletion,
  generateEmbeddings,
  streamCompletion,
} from "./providers.ts";
import type {
  CompletionResponse,
  GenerateOptions,
  ModelProfile,
  ModelRole,
  ModelRouter,
  StreamChunk,
  TieredModelConfig,
} from "./types.ts";

/** Creates a role-tiered ModelRouter using the configured provider profiles. */
export function createModelRouter(params: {
  readonly config: TieredModelConfig;
  readonly fetchImpl?: FetchLike;
}): ModelRouter {
  return {
    getProfile(role: ModelRole): ModelProfile {
      return params.config[role];
    },

    generate(options: GenerateOptions): Promise<CompletionResponse> {
      const profile = params.config[options.role];
      return generateCompletion({
        profile,
        messages: options.messages,
        ...(options.tools ? { tools: options.tools } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
        ...(params.fetchImpl ? { fetchImpl: params.fetchImpl } : {}),
      });
    },

    stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      const profile = params.config[options.role];
      return streamCompletion({
        profile,
        messages: options.messages,
        ...(options.tools ? { tools: options.tools } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
        ...(params.fetchImpl ? { fetchImpl: params.fetchImpl } : {}),
      });
    },

    embed(texts: readonly string[], signal?: AbortSignal): Promise<Float32Array[]> {
      const profile = params.config.embedding;
      return generateEmbeddings({
        profile,
        texts,
        ...(signal ? { signal } : {}),
        ...(params.fetchImpl ? { fetchImpl: params.fetchImpl } : {}),
      });
    },
  };
}
