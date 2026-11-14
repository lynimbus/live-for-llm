import { randomUUID } from "node:crypto";
import type { ModelRouter } from "@live-for-llm/ai";
import type { MemoryStore } from "@live-for-llm/memory";
import {
  type ConversationId,
  type DaemonEvent,
  type ProactiveRule,
  parseMessageId,
} from "@live-for-llm/protocol";
import { composeCompanionSystemPrompt } from "./prompt.ts";

/** Checks whether local hour falls inside [start, end) quiet hours, including overnight ranges. */
export function isWithinQuietHours(params: {
  readonly hour: number;
  readonly quietHoursStart: number;
  readonly quietHoursEnd: number;
}): boolean {
  const { hour, quietHoursStart, quietHoursEnd } = params;
  if (quietHoursStart === quietHoursEnd) return false;
  if (quietHoursStart < quietHoursEnd) {
    return hour >= quietHoursStart && hour < quietHoursEnd;
  }
  return hour >= quietHoursStart || hour < quietHoursEnd;
}

/** Determines whether a proactive check-in rule is due to fire at nowMs. */
export function isProactiveRuleDue(params: {
  readonly rule: ProactiveRule;
  readonly lastFiredAt?: string;
  readonly now: Date;
}): boolean {
  if (!params.rule.enabled) return false;
  if (
    isWithinQuietHours({
      hour: params.now.getHours(),
      quietHoursStart: params.rule.quietHoursStart,
      quietHoursEnd: params.rule.quietHoursEnd,
    })
  ) {
    return false;
  }
  if (!params.lastFiredAt) return true;
  const elapsedMinutes = (params.now.getTime() - Date.parse(params.lastFiredAt)) / 60_000;
  return elapsedMinutes >= params.rule.cronOrIntervalMinutes;
}

/** Evaluates enabled proactive check-in rules and emits companion check-in messages. */
export class ProactiveScheduler {
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly store: MemoryStore;
  private readonly router: ModelRouter;
  private readonly conversationId: ConversationId;
  private readonly emit: (event: DaemonEvent) => void;

  constructor(params: {
    readonly store: MemoryStore;
    readonly router: ModelRouter;
    readonly conversationId: ConversationId;
    readonly emit: (event: DaemonEvent) => void;
  }) {
    this.store = params.store;
    this.router = params.router;
    this.conversationId = params.conversationId;
    this.emit = params.emit;
  }

  start(intervalMs = 60_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick(new Date());
    }, intervalMs);
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  async tick(now: Date): Promise<number> {
    let fired = 0;
    const entries = this.store.listProactiveRules();
    for (const entry of entries) {
      if (
        !isProactiveRuleDue({
          rule: entry.rule,
          ...(entry.lastFiredAt ? { lastFiredAt: entry.lastFiredAt } : {}),
          now,
        })
      ) {
        continue;
      }

      const relationship = this.store.getRelationshipState();
      const memories = this.store.listMemories({ limit: 8 });
      const activeTasks = this.store.listTasks(5);
      const systemPrompt = composeCompanionSystemPrompt({
        relationship,
        memories,
        activeTasks,
      });

      const response = await this.router.generate({
        role: "companion_chat",
        messages: [
          { role: "system", content: systemPrompt },
          {
            role: "user",
            content: `[Proactive check-in trigger "${entry.rule.label}"] ${entry.rule.promptHint}`,
          },
        ],
      });

      const content = response.text.trim();
      if (!content) continue;

      const message = {
        id: parseMessageId(`msg_${randomUUID().replace(/-/g, "").slice(0, 16)}`),
        conversationId: this.conversationId,
        role: "companion" as const,
        content,
        proactive: true,
        createdAt: now.toISOString(),
      };
      this.store.appendChatMessage(message);
      this.store.markProactiveRuleFired(entry.rule.id, now.toISOString());
      this.emit({ kind: "proactive.message", message, ruleId: entry.rule.id });
      fired += 1;
    }
    return fired;
  }
}
