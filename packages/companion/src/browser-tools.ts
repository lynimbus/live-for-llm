import type { PersistentBrowserManager } from "@live-for-llm/browser";
import type { HarnessTool } from "@live-for-llm/harness";
import { ACTION_RISK_TIERS, type ActionRiskTier, type BrowserProfileId, type PolicyConfig } from "@live-for-llm/protocol";

const AUTH_URL_RE = /(\/login|\/signin|\/auth|\/sso|\/oauth|\/challenge|\/captcha|\/verify)/i;
const AUTH_TEXT_RE = /(sign in to|log in to|two-factor|2fa|verification code|verify you are human|captcha|cloudflare|turnstile|recaptcha|hcaptcha|请登录|账号登录|扫码登录|安全验证|人机验证|验证码)/i;

/** Passively detects login walls, 2FA, or CAPTCHA gates so the planner hands off to the user via `browser_request_human_login`. */
export function detectAuthOrChallengeHint(snap: {
  readonly url: string;
  readonly title?: string;
  readonly textExcerpt?: string;
}): string | undefined {
  const urlMatch = AUTH_URL_RE.test(snap.url);
  const body = `${snap.title ?? ""}\n${snap.textExcerpt ?? ""}`;
  const textMatch = AUTH_TEXT_RE.test(body);
  if (!urlMatch && !textMatch) return undefined;
  return "Login wall, 2FA, or anti-bot verification detected. Do NOT attempt to bypass it; call `browser_request_human_login` so the user can complete it interactively.";
}

function parseRiskTier(raw: unknown, fallback: ActionRiskTier): ActionRiskTier {
  if (typeof raw === "string" && (ACTION_RISK_TIERS as readonly string[]).includes(raw)) {
    return raw as ActionRiskTier;
  }
  return fallback;
}

/** Builds HarnessTool adapters backed by PersistentBrowserManager and PolicyGuard. */
export function createBrowserTools(params: {
  readonly browser: PersistentBrowserManager;
  readonly profileId: BrowserProfileId;
  readonly getPolicy: () => PolicyConfig;
}): HarnessTool[] {
  const emitSnap = (
    ctx: Parameters<HarnessTool["execute"]>[1],
    label: string,
    snap: Awaited<ReturnType<PersistentBrowserManager["captureSnapshot"]>>,
  ) => {
    ctx.reportProgress(label, snap.screenshotBase64, snap.url);
    ctx.reportTrace?.({
      kind: "browser_action",
      title: label,
      url: snap.url,
      ...(snap.title ? { detail: snap.title } : {}),
    });
  };

  const searchTool: HarnessTool = {
    spec: {
      name: "browser_search",
      description:
        "Search the web directly in the persistent browser and return ranked result titles, URLs, and snippet text.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
          engine: { type: "string", enum: ["bing", "duckduckgo"] },
        },
        required: ["query"],
      },
    },
    riskTier: "read_only",
    async execute(args, ctx) {
      const query = typeof args["query"] === "string" ? args["query"].trim() : "";
      if (!query) throw new Error("browser_search requires query");
      const engine = args["engine"] === "duckduckgo" ? "duckduckgo" : "bing";
      const searchUrl =
        engine === "duckduckgo"
          ? `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`
          : `https://cn.bing.com/search?q=${encodeURIComponent(query)}`;

      const snap = await params.browser.navigate({ profileId: params.profileId, url: searchUrl });
      emitSnap(ctx, `Searched "${query}" (${engine})`, snap);

      const links = snap.interactiveElements
        .filter((el) => el.href && el.text && !el.href.includes("bing.com/aclick"))
        .slice(0, 15)
        .map((el) => ({ title: el.text, url: el.href }));

      return JSON.stringify({
        url: snap.url,
        title: snap.title,
        results: links,
        textExcerpt: snap.textExcerpt,
      });
    },
  };

  const navigateTool: HarnessTool = {
    spec: {
      name: "browser_navigate",
      description:
        "Open a URL in the persistent logged-in Chromium profile and return page text, links/selectors, scroll info, and screenshot.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string" },
        },
        required: ["url"],
      },
    },
    riskTier: "read_only",
    async execute(args, ctx) {
      const url = typeof args["url"] === "string" ? args["url"] : "";
      if (!url) throw new Error("browser_navigate requires url");
      const snap = await params.browser.navigate({ profileId: params.profileId, url });
      emitSnap(ctx, `Loaded ${snap.title || snap.url}`, snap);
      const authHint = detectAuthOrChallengeHint(snap);
      return JSON.stringify({
        url: snap.url,
        title: snap.title,
        scrollY: snap.scrollY,
        scrollHeight: snap.scrollHeight,
        textExcerpt: snap.textExcerpt,
        interactiveElements: snap.interactiveElements,
        ...(authHint
          ? {
              authOrChallengeDetected: true,
              recommendedTool: "browser_request_human_login",
              hint: authHint,
            }
          : {}),
      });
    },
  };

  const clickTool: HarnessTool = {
    spec: {
      name: "browser_click",
      description:
        "Click a CSS selector (or [data-livia-ref]) on the current page. Use riskTier='external_send' for publish/send/post buttons.",
      parameters: {
        type: "object",
        properties: {
          selector: { type: "string" },
          riskTier: { type: "string", enum: [...ACTION_RISK_TIERS] },
          actionSummary: { type: "string" },
        },
        required: ["selector"],
      },
    },
    riskTier: "local_write",
    handlesOwnPolicy: true,
    async execute(args, ctx) {
      const selector = typeof args["selector"] === "string" ? args["selector"] : "";
      if (!selector) throw new Error("browser_click requires selector");
      const riskTier = parseRiskTier(args["riskTier"], "local_write");
      const actionSummary =
        typeof args["actionSummary"] === "string"
          ? args["actionSummary"]
          : `Click ${selector}`;

      await params.browser.performGuardedAction({
        profileId: params.profileId,
        policy: params.getPolicy(),
        riskTier,
        actionSummary,
        requestApproval: (req) => ctx.requestApproval(req),
        run: async (page) => {
          await page.click(selector, { timeout: 10_000 });
          await page.waitForLoadState("domcontentloaded", { timeout: 5000 }).catch(() => {});
        },
      });

      const snap = await params.browser.captureSnapshot({ profileId: params.profileId });
      emitSnap(ctx, `Clicked ${selector}`, snap);
      const authHint = detectAuthOrChallengeHint(snap);
      return JSON.stringify({
        url: snap.url,
        title: snap.title,
        textExcerpt: snap.textExcerpt,
        interactiveElements: snap.interactiveElements.slice(0, 25),
        ...(authHint
          ? {
              authOrChallengeDetected: true,
              recommendedTool: "browser_request_human_login",
              hint: authHint,
            }
          : {}),
      });
    },
  };

  const fillTool: HarnessTool = {
    spec: {
      name: "browser_fill",
      description: "Fill text into an input or textarea matching selector.",
      parameters: {
        type: "object",
        properties: {
          selector: { type: "string" },
          value: { type: "string" },
        },
        required: ["selector", "value"],
      },
    },
    riskTier: "local_write",
    handlesOwnPolicy: true,
    async execute(args, ctx) {
      const selector = typeof args["selector"] === "string" ? args["selector"] : "";
      const value = typeof args["value"] === "string" ? args["value"] : "";
      if (!selector) throw new Error("browser_fill requires selector");

      await params.browser.performGuardedAction({
        profileId: params.profileId,
        policy: params.getPolicy(),
        riskTier: "local_write",
        actionSummary: `Fill ${selector}`,
        draftPreview: value.slice(0, 200),
        requestApproval: (req) => ctx.requestApproval(req),
        run: async (page) => {
          await page.fill(selector, value, { timeout: 10_000 });
        },
      });

      const snap = await params.browser.captureSnapshot({ profileId: params.profileId });
      emitSnap(ctx, `Filled ${selector}`, snap);
      return `Filled ${selector}`;
    },
  };

  const scrollTool: HarnessTool = {
    spec: {
      name: "browser_scroll",
      description: "Scroll the current browser page (down, up, top, bottom) and read updated text.",
      parameters: {
        type: "object",
        properties: {
          direction: { type: "string", enum: ["down", "up", "top", "bottom"] },
        },
      },
    },
    riskTier: "read_only",
    async execute(args, ctx) {
      const raw = args["direction"];
      const direction =
        raw === "up" || raw === "top" || raw === "bottom" ? raw : "down";
      const snap = await params.browser.scroll({ profileId: params.profileId, direction });
      emitSnap(ctx, `Scrolled ${direction}`, snap);
      return JSON.stringify({
        url: snap.url,
        scrollY: snap.scrollY,
        scrollHeight: snap.scrollHeight,
        textExcerpt: snap.textExcerpt,
      });
    },
  };

  const pressKeyTool: HarnessTool = {
    spec: {
      name: "browser_press_key",
      description: "Press a keyboard key in the browser (e.g. Enter, Escape, Tab).",
      parameters: {
        type: "object",
        properties: {
          key: { type: "string" },
        },
        required: ["key"],
      },
    },
    riskTier: "local_write",
    async execute(args, ctx) {
      const key = typeof args["key"] === "string" ? args["key"] : "Enter";
      const snap = await params.browser.pressKey({ profileId: params.profileId, key });
      emitSnap(ctx, `Pressed ${key}`, snap);
      return JSON.stringify({ url: snap.url, title: snap.title, textExcerpt: snap.textExcerpt });
    },
  };

  const backTool: HarnessTool = {
    spec: {
      name: "browser_back",
      description: "Navigate back to the previous page in browser history.",
      parameters: { type: "object", properties: {} },
    },
    riskTier: "read_only",
    async execute(_args, ctx) {
      const snap = await params.browser.goBack({ profileId: params.profileId });
      emitSnap(ctx, `Navigated back`, snap);
      return JSON.stringify({ url: snap.url, title: snap.title, textExcerpt: snap.textExcerpt });
    },
  };

  const humanLoginTool: HarnessTool = {
    spec: {
      name: "browser_request_human_login",
      description:
        "Pause task and ask the user to log in or solve 2FA/CAPTCHA in a visible browser window.",
      parameters: {
        type: "object",
        properties: {
          instructions: { type: "string" },
        },
        required: ["instructions"],
      },
    },
    riskTier: "read_only",
    async execute(args, ctx) {
      const instructions =
        typeof args["instructions"] === "string"
          ? args["instructions"]
          : "Please complete login or verification in the browser window, then click Resume.";
      await params.browser.openSession({ profileId: params.profileId, headless: false });
      await ctx.requestUserPause({ reason: "login_required", instructions });
      await params.browser.openSession({ profileId: params.profileId, headless: true });
      const snap = await params.browser.captureSnapshot({ profileId: params.profileId });
      emitSnap(ctx, "Resumed after user login", snap);
      return `User resumed session on ${snap.url}`;
    },
  };

  return [
    searchTool,
    navigateTool,
    clickTool,
    fillTool,
    scrollTool,
    pressKeyTool,
    backTool,
    humanLoginTool,
  ];
}
