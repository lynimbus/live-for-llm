import { randomUUID } from "node:crypto";
import type { ModelRouter } from "@live-for-llm/ai";
import type { MemoryStore } from "@live-for-llm/memory";
import {
  type ChatMessage,
  type ConversationId,
  type DaemonEvent,
  type ProactiveRule,
  parseMessageId,
} from "@live-for-llm/protocol";
import { decayRelationshipState } from "./extractor.ts";
import { composeCompanionSystemPrompt } from "./prompt.ts";

export const MAX_UNANSWERED_PROACTIVE = 4;

/** Counts consecutive unanswered proactive companion messages at the tail of chat history. */
export function countTrailingUnansweredProactive(messages: readonly ChatMessage[]): number {
  let streak = 0;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i]!;
    if (msg.recalled) continue;
    if (msg.role === "user") break;
    if (msg.role === "companion" && msg.proactive) {
      streak += 1;
    }
  }
  return streak;
}

/** Applies exponential backoff (2^n) to proactive intervals based on unanswered check-in streak. */
export function computeProactiveCooldownMinutes(
  baseIntervalMinutes: number,
  unansweredStreak: number,
): number {
  const safeBase = Math.max(1, baseIntervalMinutes);
  const exponent = Math.max(0, Math.min(unansweredStreak, MAX_UNANSWERED_PROACTIVE));
  return safeBase * Math.pow(2, exponent);
}

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

/** Determines whether a proactive check-in rule is due to fire at now, honoring quiet hours and unread backoff. */
export function isProactiveRuleDue(params: {
  readonly rule: ProactiveRule;
  readonly lastFiredAt?: string;
  readonly now: Date;
  readonly unansweredStreak?: number;
}): boolean {
  if (!params.rule.enabled) return false;
  const streak = params.unansweredStreak ?? 0;
  if (streak >= MAX_UNANSWERED_PROACTIVE) return false;
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
  const requiredMinutes = computeProactiveCooldownMinutes(
    params.rule.cronOrIntervalMinutes,
    streak,
  );
  return elapsedMinutes >= requiredMinutes;
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
    const recentHistory = this.store.listChatMessages(this.conversationId, 30);
    let unansweredStreak = countTrailingUnansweredProactive(recentHistory);
    const lastUserMessage = [...recentHistory]
      .reverse()
      .find((m) => m.role === "user" && !m.recalled);

    for (const entry of entries) {
      if (
        !isProactiveRuleDue({
          rule: entry.rule,
          ...(entry.lastFiredAt ? { lastFiredAt: entry.lastFiredAt } : {}),
          now,
          unansweredStreak,
        })
      ) {
        continue;
      }

      const relationship = decayRelationshipState(this.store.getRelationshipState(), now);
      const memories = this.store.listMemories({ limit: 8 });
      const activeTasks = this.store.listTasks(5);
      const systemPrompt = composeCompanionSystemPrompt({
        relationship,
        memories,
        activeTasks,
        temporal: {
          now,
          ...(lastUserMessage ? { lastUserMessageAt: lastUserMessage.createdAt } : {}),
        },
      });

      const response = await this.router.generate({
        role: "companion_chat",
        messages: [
          { role: "system", content: systemPrompt },
          {
            role: "user",
            content: `[Proactive check-in trigger "${entry.rule.label}"] ${entry.rule.promptHint}
(If reaching out right now would feel repetitive, unprompted, or you have nothing genuinely worth saying, output EXACTLY [SKIP] and nothing else.)`,
          },
        ],
      });

      const content = response.text.trim();
      if (!content || /^\[?SKIP\]?$/i.test(content)) {
        this.store.markProactiveRuleFired(entry.rule.id, now.toISOString());
        continue;
      }

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
      unansweredStreak += 1;
      fired += 1;
    }
    return fired;
  }
}
