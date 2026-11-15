import {
  type ChatMessage,
  type ClientCommand,
  type ConversationId,
  type ConversationSummary,
  type DaemonEvent,
  DEFAULT_POLICY_CONFIG,
  type HarnessSettings,
  type MemoryRecord,
  type ModelFetchRequest,
  type ModelFetchResult,
  type ModelSettingsSummary,
  type PolicyConfig,
  type ProactiveRule,
  type RelationshipState,
  type TaskRecord,
  type TaskTraceEntry,
  parseDaemonEvent,
} from "@live-for-llm/protocol";

export interface DaemonStateSnapshot {
  readonly conversationId: ConversationId;
  readonly conversations?: readonly ConversationSummary[];
  readonly messages: readonly ChatMessage[];
  readonly memories: readonly MemoryRecord[];
  readonly relationship: RelationshipState;
  readonly tasks: readonly TaskRecord[];
  readonly taskTraces?: Record<string, readonly TaskTraceEntry[]>;
  readonly policy: PolicyConfig;
  readonly proactiveRules: readonly ProactiveRule[];
  readonly modelSettings?: ModelSettingsSummary;
  readonly harnessSettings?: HarnessSettings;
}

export interface BrowserControlResult {
  readonly url: string;
  readonly title: string;
  readonly screenshotBase64?: string;
  readonly mimeType?: string;
  readonly capturedAt?: string;
  readonly headless?: boolean;
}

export type BrowserInteractPayload =
  | { readonly taskId?: string; readonly mode: "click_at"; readonly x: number; readonly y: number }
  | { readonly taskId?: string; readonly mode: "type"; readonly text: string; readonly pressEnter?: boolean }
  | { readonly taskId?: string; readonly mode: "back" | "reload" }
  | { readonly taskId?: string; readonly mode: "scroll"; readonly direction: "up" | "down" }
  | { readonly taskId?: string; readonly mode: "navigate"; readonly url: string };

export interface DaemonTransport {
  fetchState(conversationId: ConversationId): Promise<DaemonStateSnapshot>;
  sendCommand(command: ClientCommand): Promise<void>;
  fetchModels(req: ModelFetchRequest): Promise<ModelFetchResult>;
  interactBrowser(req: BrowserInteractPayload): Promise<BrowserControlResult>;
  openBrowserWindow(req: {
    readonly taskId?: string;
    readonly url?: string;
    readonly headless?: boolean;
  }): Promise<BrowserControlResult>;
  exportMemories(): Promise<{ readonly files: readonly string[] }>;
  importMemories(): Promise<{ readonly imported: number }>;
  connectEvents(onEvent: (event: DaemonEvent) => void, onStatus: (connected: boolean) => void): () => void;
}

function toWsUrl(httpUrl: string, token?: string): string {
  const normalized = httpUrl.replace(/\/+$/, "");
  const wsBase = normalized.startsWith("https://")
    ? `wss://${normalized.slice(8)}`
    : normalized.startsWith("http://")
      ? `ws://${normalized.slice(7)}`
      : `ws://${normalized}`;
  return token ? `${wsBase}/ws?token=${encodeURIComponent(token)}` : `${wsBase}/ws`;
}

/** Creates an HTTP + WebSocket transport targeting a local or Tailscale daemon URL. */
export function createDaemonTransport(params: {
  readonly baseUrl: string;
  readonly authToken?: string;
}): DaemonTransport {
  const baseUrl = params.baseUrl.replace(/\/+$/, "");
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...(params.authToken ? { authorization: `Bearer ${params.authToken}` } : {}),
  };

  const postBrowser = async (path: string, body: Record<string, unknown>): Promise<BrowserControlResult> => {
    const res = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      let message = text;
      try {
        const parsed = JSON.parse(text) as { error?: string };
        if (parsed.error) message = parsed.error;
      } catch {
        // Keep raw text fallback.
      }
      throw new Error(message || `Browser action failed (${res.status})`);
    }
    return (await res.json()) as BrowserControlResult;
  };

  return {
    async fetchState(conversationId: ConversationId): Promise<DaemonStateSnapshot> {
      const res = await fetch(
        `${baseUrl}/api/state?conversationId=${encodeURIComponent(conversationId)}`,
        { headers },
      );
      if (!res.ok) {
        throw new Error(`Daemon /api/state failed (${res.status})`);
      }
      return (await res.json()) as DaemonStateSnapshot;
    },

    async sendCommand(command: ClientCommand): Promise<void> {
      const res = await fetch(`${baseUrl}/api/command`, {
        method: "POST",
        headers,
        body: JSON.stringify(command),
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`Command failed (${res.status}): ${body}`);
      }
    },

    async fetchModels(req: ModelFetchRequest): Promise<ModelFetchResult> {
      const res = await fetch(`${baseUrl}/api/models/fetch`, {
        method: "POST",
        headers,
        body: JSON.stringify(req),
      });
      if (!res.ok) {
        const text = await res.text();
        let message = text;
        try {
          const parsed = JSON.parse(text) as { error?: string };
          if (parsed.error) message = parsed.error;
        } catch {
          // Keep raw text fallback.
        }
        throw new Error(message || `Fetch models failed (${res.status})`);
      }
      return (await res.json()) as ModelFetchResult;
    },

    async interactBrowser(req: BrowserInteractPayload): Promise<BrowserControlResult> {
      if (req.mode === "navigate") {
        return postBrowser("/api/browser/navigate", {
          url: req.url,
          ...(req.taskId ? { taskId: req.taskId } : {}),
        });
      }
      if (req.mode === "scroll") {
        return postBrowser("/api/browser/scroll", {
          direction: req.direction,
          ...(req.taskId ? { taskId: req.taskId } : {}),
        });
      }
      return postBrowser("/api/browser/interact", req);
    },

    async openBrowserWindow(req: {
      readonly taskId?: string;
      readonly url?: string;
      readonly headless?: boolean;
    }): Promise<BrowserControlResult> {
      return postBrowser("/api/browser/open_window", req);
    },

    async exportMemories(): Promise<{ readonly files: readonly string[] }> {
      const res = await fetch(`${baseUrl}/api/memories/export`, {
        method: "POST",
        headers,
      });
      if (!res.ok) {
        throw new Error(`Export failed (${res.status})`);
      }
      return (await res.json()) as { readonly files: readonly string[] };
    },

    async importMemories(): Promise<{ readonly imported: number }> {
      const res = await fetch(`${baseUrl}/api/memories/import`, {
        method: "POST",
        headers,
      });
      if (!res.ok) {
        throw new Error(`Import failed (${res.status})`);
      }
      return (await res.json()) as { readonly imported: number };
    },

    connectEvents(
      onEvent: (event: DaemonEvent) => void,
      onStatus: (connected: boolean) => void,
    ): () => void {
      let closed = false;
      let socket: WebSocket | undefined;
      let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
      let retryAttempt = 0;

      const scheduleReconnect = () => {
        if (closed || reconnectTimer !== undefined) return;
        const delayMs = retryAttempt === 0 ? 250 : 2000;
        retryAttempt += 1;
        reconnectTimer = setTimeout(() => {
          reconnectTimer = undefined;
          openSocket();
        }, delayMs);
      };

      const openSocket = () => {
        if (closed) return;
        try {
          socket = new WebSocket(toWsUrl(baseUrl, params.authToken));
        } catch {
          onStatus(false);
          scheduleReconnect();
          return;
        }
        socket.onopen = () => {
          retryAttempt = 0;
          onStatus(true);
        };
        socket.onclose = () => {
          onStatus(false);
          scheduleReconnect();
        };
        socket.onerror = () => onStatus(false);
        socket.onmessage = (msg) => {
          try {
            const raw: unknown = JSON.parse(String(msg.data));
            onEvent(parseDaemonEvent(raw));
          } catch {
            // Ignore malformed frame so UI stream stays alive.
          }
        };
      };

      openSocket();
      return () => {
        closed = true;
        if (reconnectTimer !== undefined) {
          clearTimeout(reconnectTimer);
          reconnectTimer = undefined;
        }
        socket?.close();
      };
    },
  };
}

export const DEFAULT_MODEL_SETTINGS: ModelSettingsSummary = {
  provider: "openai_compatible",
  baseUrl: "https://api.openai.com/v1",
  companionModel: "gpt-4o-mini",
  taskModel: "gpt-4o",
  memoryModel: "gpt-4o-mini",
  visionModel: "gpt-4o",
  embeddingModel: "text-embedding-3-small",
  hasApiKey: false,
};

export const DEFAULT_HARNESS_SETTINGS: HarnessSettings = {
  defaultBackend: "builtin",
  browserBackend: "daemon",
};

export const EMPTY_SNAPSHOT: Omit<DaemonStateSnapshot, "conversationId"> = {
  conversations: [],
  messages: [],
  memories: [],
  relationship: {
    companionName: "Livia",
    userName: "你",
    affinityScore: 0.5,
    currentMood: "calm",
    insideJokes: [],
    anniversaries: [],
    updatedAt: "",
  },
  tasks: [],
  policy: DEFAULT_POLICY_CONFIG,
  proactiveRules: [],
  modelSettings: DEFAULT_MODEL_SETTINGS,
  harnessSettings: DEFAULT_HARNESS_SETTINGS,
};
