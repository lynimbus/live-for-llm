import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  type ActionRiskTier,
  type ApprovalDecision,
  type BrowserProfileId,
  evaluatePolicyDecision,
  type PolicyConfig,
} from "@live-for-llm/protocol";
import { type BrowserContext, chromium, type Page } from "playwright-core";

export interface BrowserSnapshot {
  readonly url: string;
  readonly title: string;
  readonly textExcerpt: string;
  readonly interactiveElements: readonly {
    readonly tag: string;
    readonly text: string;
    readonly selectorHint: string;
  }[];
  readonly screenshotBase64: string;
  readonly mimeType: "image/jpeg";
  readonly capturedAt: string;
}

export interface PersistentBrowserManagerOptions {
  readonly profilesRootDir: string;
  readonly executablePath?: string;
  readonly defaultHeadless?: boolean;
}

interface ActiveSession {
  context: BrowserContext;
  page: Page;
  headless: boolean;
}

/** Manages persistent Chromium profiles via Playwright for logged-in account automation. */
export class PersistentBrowserManager {
  private readonly profilesRootDir: string;
  private readonly executablePath: string | undefined;
  private readonly defaultHeadless: boolean;
  private readonly sessions = new Map<BrowserProfileId, ActiveSession>();

  constructor(options: PersistentBrowserManagerOptions) {
    this.profilesRootDir = options.profilesRootDir;
    this.executablePath =
      options.executablePath ?? process.env["PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH"];
    this.defaultHeadless = options.defaultHeadless ?? true;
    mkdirSync(this.profilesRootDir, { recursive: true });
  }

  private getProfileDir(profileId: BrowserProfileId): string {
    const dir = join(this.profilesRootDir, profileId);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  async openSession(params: {
    readonly profileId: BrowserProfileId;
    readonly headless?: boolean;
  }): Promise<Page> {
    const desiredHeadless = params.headless ?? this.defaultHeadless;
    const existing = this.sessions.get(params.profileId);
    if (existing) {
      if (existing.headless === desiredHeadless) {
        return existing.page;
      }
      await existing.context.close();
      this.sessions.delete(params.profileId);
    }

    const userDataDir = this.getProfileDir(params.profileId);
    const context = await chromium.launchPersistentContext(userDataDir, {
      ...(this.executablePath ? { executablePath: this.executablePath } : {}),
      headless: desiredHeadless,
      viewport: { width: 1280, height: 800 },
    });

    const page = context.pages()[0] ?? (await context.newPage());
    this.sessions.set(params.profileId, { context, page, headless: desiredHeadless });
    return page;
  }

  async captureSnapshot(params: {
    readonly profileId: BrowserProfileId;
    readonly maxTextLength?: number;
  }): Promise<BrowserSnapshot> {
    const page = await this.openSession({ profileId: params.profileId });
    const maxLen = params.maxTextLength ?? 4000;
    const title = await page.title();
    const url = page.url();

    const extracted = await page.evaluate((limit: number) => {
      const bodyText = (document.body?.innerText ?? "").replace(/\s+/g, " ").trim();
      const candidates = Array.from(
        document.querySelectorAll("a, button, input, textarea, select, [role='button']"),
      ).slice(0, 40);

      const interactiveElements = candidates.map((el, idx) => {
        const htmlEl = el as HTMLElement;
        const idAttr = htmlEl.id ? `#${htmlEl.id}` : "";
        const aria = htmlEl.getAttribute("aria-label") ?? "";
        const placeholder = htmlEl.getAttribute("placeholder") ?? "";
        const text = (htmlEl.innerText || aria || placeholder || "").trim().slice(0, 80);
        const selectorHint = idAttr || `${el.tagName.toLowerCase()}:nth-of-type(${idx + 1})`;
        return {
          tag: el.tagName.toLowerCase(),
          text,
          selectorHint,
        };
      });

      return {
        textExcerpt: bodyText.slice(0, limit),
        interactiveElements,
      };
    }, maxLen);

    const buffer = await page.screenshot({ type: "jpeg", quality: 72 });
    return {
      url,
      title,
      textExcerpt: extracted.textExcerpt,
      interactiveElements: extracted.interactiveElements,
      screenshotBase64: buffer.toString("base64"),
      mimeType: "image/jpeg",
      capturedAt: new Date().toISOString(),
    };
  }

  async navigate(params: {
    readonly profileId: BrowserProfileId;
    readonly url: string;
    readonly headless?: boolean;
  }): Promise<BrowserSnapshot> {
    const page = await this.openSession({
      profileId: params.profileId,
      ...(params.headless !== undefined ? { headless: params.headless } : {}),
    });
    await page.goto(params.url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    return this.captureSnapshot({ profileId: params.profileId });
  }

  async performGuardedAction<T>(params: {
    readonly profileId: BrowserProfileId;
    readonly policy: PolicyConfig;
    readonly riskTier: ActionRiskTier;
    readonly actionSummary: string;
    readonly draftPreview?: string;
    readonly requestApproval: (req: {
      readonly actionSummary: string;
      readonly riskTier: ActionRiskTier;
      readonly domain?: string;
      readonly draftPreview?: string;
    }) => Promise<ApprovalDecision>;
    readonly run: (page: Page) => Promise<T>;
  }): Promise<T> {
    const page = await this.openSession({ profileId: params.profileId });
    let domain: string | undefined;
    try {
      domain = new URL(page.url()).hostname || undefined;
    } catch {
      domain = undefined;
    }

    const decision = evaluatePolicyDecision({
      policy: params.policy,
      riskTier: params.riskTier,
      ...(domain ? { domain } : {}),
    });

    if (decision === "require_approval") {
      const verdict = await params.requestApproval({
        actionSummary: params.actionSummary,
        riskTier: params.riskTier,
        ...(domain ? { domain } : {}),
        ...(params.draftPreview ? { draftPreview: params.draftPreview } : {}),
      });
      if (verdict === "denied") {
        throw new Error(`Browser action denied by user: ${params.actionSummary}`);
      }
    }

    return params.run(page);
  }

  async closeSession(profileId: BrowserProfileId): Promise<void> {
    const session = this.sessions.get(profileId);
    if (!session) return;
    await session.context.close();
    this.sessions.delete(profileId);
  }

  async closeAll(): Promise<void> {
    for (const [id, session] of this.sessions.entries()) {
      await session.context.close();
      this.sessions.delete(id);
    }
  }
}
