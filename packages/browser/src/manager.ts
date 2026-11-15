import { existsSync, mkdirSync } from "node:fs";
import { delimiter, join } from "node:path";
import {
  type ActionRiskTier,
  type ApprovalDecision,
  type BrowserProfileId,
  evaluatePolicyDecision,
  type PolicyConfig,
} from "@live-for-llm/protocol";
import { type BrowserContext, chromium, type Page } from "playwright-core";

function resolveChromiumExecutablePath(explicit?: string): string | undefined {
  const direct = explicit?.trim() || process.env["PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH"]?.trim();
  if (direct && existsSync(direct)) return direct;

  const names = ["chromium", "chromium-browser", "google-chrome", "google-chrome-stable"];
  const pathEnv = process.env["PATH"] ?? "";
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
  }

  const user = process.env["USER"];
  const fallbackDirs = [
    ...(user ? [`/etc/profiles/per-user/${user}/bin`] : []),
    "/run/current-system/sw/bin",
    "/usr/bin",
    "/usr/local/bin",
  ];
  for (const dir of fallbackDirs) {
    for (const name of names) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return direct || undefined;
}

export interface BrowserSnapshot {
  readonly url: string;
  readonly title: string;
  readonly textExcerpt: string;
  readonly scrollY: number;
  readonly scrollHeight: number;
  readonly interactiveElements: readonly {
    readonly tag: string;
    readonly text: string;
    readonly selectorHint: string;
    readonly href?: string;
    readonly inputType?: string;
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
    this.executablePath = resolveChromiumExecutablePath(options.executablePath);
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
    const existing = this.sessions.get(params.profileId);
    const desiredHeadless = params.headless ?? (existing ? existing.headless : this.defaultHeadless);
    let preserveUrl: string | undefined;
    if (existing) {
      if (existing.headless === desiredHeadless) {
        return existing.page;
      }
      preserveUrl = existing.page.url();
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
    if (preserveUrl && preserveUrl !== "about:blank") {
      await page.goto(preserveUrl, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => {});
    }
    this.sessions.set(params.profileId, { context, page, headless: desiredHeadless });
    return page;
  }

  getSessionMode(profileId: BrowserProfileId): { readonly open: boolean; readonly headless: boolean } {
    const existing = this.sessions.get(profileId);
    if (!existing) {
      return { open: false, headless: this.defaultHeadless };
    }
    return { open: true, headless: existing.headless };
  }

  async clickAt(params: {
    readonly profileId: BrowserProfileId;
    readonly x: number;
    readonly y: number;
  }): Promise<BrowserSnapshot> {
    const page = await this.openSession({ profileId: params.profileId });
    const clampedX = Math.max(0, Math.min(1279, Math.round(params.x)));
    const clampedY = Math.max(0, Math.min(799, Math.round(params.y)));
    await page.mouse.click(clampedX, clampedY);
    await page.waitForLoadState("domcontentloaded", { timeout: 2500 }).catch(() => {});
    await new Promise((r) => setTimeout(r, 120));
    return this.captureSnapshot({ profileId: params.profileId });
  }

  async typeText(params: {
    readonly profileId: BrowserProfileId;
    readonly text: string;
    readonly pressEnter?: boolean;
  }): Promise<BrowserSnapshot> {
    const page = await this.openSession({ profileId: params.profileId });
    if (params.text.length > 0) {
      await page.keyboard.type(params.text, { delay: 12 });
    }
    if (params.pressEnter) {
      await page.keyboard.press("Enter");
      await page.waitForLoadState("domcontentloaded", { timeout: 5000 }).catch(() => {});
    }
    return this.captureSnapshot({ profileId: params.profileId });
  }

  async captureSnapshot(params: {
    readonly profileId: BrowserProfileId;
    readonly maxTextLength?: number;
  }): Promise<BrowserSnapshot> {
    const page = await this.openSession({ profileId: params.profileId });
    const maxLen = params.maxTextLength ?? 6000;
    const title = await page.title();
    const url = page.url();

    const extracted = await page.evaluate((limit: number) => {
      const bodyText = (document.body?.innerText ?? "").replace(/\s+/g, " ").trim();
      const candidates = Array.from(
        document.querySelectorAll("a, button, input, textarea, select, [role='button']"),
      );

      const interactiveElements: Array<{
        tag: string;
        text: string;
        selectorHint: string;
        href?: string;
        inputType?: string;
      }> = [];

      let refSeq = 0;
      for (const el of candidates) {
        if (interactiveElements.length >= 40) break;
        const htmlEl = el as HTMLElement;
        const rect = htmlEl.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) continue;

        const refId = `e${refSeq++}`;
        htmlEl.setAttribute("data-livia-ref", refId);

        const aria = htmlEl.getAttribute("aria-label") ?? "";
        const placeholder = htmlEl.getAttribute("placeholder") ?? "";
        const titleAttr = htmlEl.getAttribute("title") ?? "";
        const text = (htmlEl.innerText || aria || placeholder || titleAttr || "").trim().slice(0, 80);

        let selectorHint = `[data-livia-ref="${refId}"]`;
        if (htmlEl.id && /^[A-Za-z_][A-Za-z0-9_-]*$/.test(htmlEl.id)) {
          selectorHint = `#${htmlEl.id}`;
        }

        const anchorHref =
          htmlEl instanceof HTMLAnchorElement && htmlEl.href ? htmlEl.href : undefined;
        const inputType =
          htmlEl instanceof HTMLInputElement ? htmlEl.type || "text" : undefined;

        interactiveElements.push({
          tag: el.tagName.toLowerCase(),
          text,
          selectorHint,
          ...(anchorHref ? { href: anchorHref } : {}),
          ...(inputType ? { inputType } : {}),
        });
      }

      const scrollY = Math.round(window.scrollY ?? 0);
      const scrollHeight = Math.round(document.documentElement?.scrollHeight ?? 0);

      return {
        textExcerpt: bodyText.slice(0, limit),
        scrollY,
        scrollHeight,
        interactiveElements,
      };
    }, maxLen);

    const buffer = await page.screenshot({ type: "jpeg", quality: 72 });
    return {
      url,
      title,
      textExcerpt: extracted.textExcerpt,
      scrollY: extracted.scrollY,
      scrollHeight: extracted.scrollHeight,
      interactiveElements: extracted.interactiveElements,
      screenshotBase64: buffer.toString("base64"),
      mimeType: "image/jpeg",
      capturedAt: new Date().toISOString(),
    };
  }

  async scroll(params: {
    readonly profileId: BrowserProfileId;
    readonly direction?: "down" | "up" | "top" | "bottom";
  }): Promise<BrowserSnapshot> {
    const page = await this.openSession({ profileId: params.profileId });
    const dir = params.direction ?? "down";
    await page.evaluate((direction: string) => {
      const step = Math.max(320, Math.round(window.innerHeight * 0.8));
      if (direction === "top") window.scrollTo(0, 0);
      else if (direction === "bottom") window.scrollTo(0, document.documentElement?.scrollHeight ?? 99999);
      else if (direction === "up") window.scrollBy(0, -step);
      else window.scrollBy(0, step);
    }, dir);
    return this.captureSnapshot({ profileId: params.profileId });
  }

  async pressKey(params: {
    readonly profileId: BrowserProfileId;
    readonly key: string;
  }): Promise<BrowserSnapshot> {
    const page = await this.openSession({ profileId: params.profileId });
    await page.keyboard.press(params.key);
    await page.waitForLoadState("domcontentloaded", { timeout: 6000 }).catch(() => {});
    return this.captureSnapshot({ profileId: params.profileId });
  }

  async goBack(params: { readonly profileId: BrowserProfileId }): Promise<BrowserSnapshot> {
    const page = await this.openSession({ profileId: params.profileId });
    await page.goBack({ waitUntil: "domcontentloaded", timeout: 15_000 }).catch(() => {});
    return this.captureSnapshot({ profileId: params.profileId });
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
