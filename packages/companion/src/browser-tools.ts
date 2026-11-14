import type { PersistentBrowserManager } from "@live-for-llm/browser";
import type { HarnessTool } from "@live-for-llm/harness";
import { ACTION_RISK_TIERS, type ActionRiskTier, type BrowserProfileId, type PolicyConfig } from "@live-for-llm/protocol";

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
  const navigateTool: HarnessTool = {
    spec: {
      name: "browser_navigate",
      description: "Open a URL in the persistent logged-in Chromium profile and return page text, interactive selectors, and screenshot.",
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
      ctx.reportProgress(`Loaded ${snap.title || snap.url}`, snap.screenshotBase64);
      return JSON.stringify({
        url: snap.url,
        title: snap.title,
        textExcerpt: snap.textExcerpt,
        interactiveElements: snap.interactiveElements.slice(0, 20),
      });
    },
  };

  const clickTool: HarnessTool = {
    spec: {
      name: "browser_click",
      description: "Click a CSS selector on the current page. Use riskTier='external_send' for publish/send/post buttons.",
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
        },
      });

      const snap = await params.browser.captureSnapshot({ profileId: params.profileId });
      ctx.reportProgress(`Clicked ${selector}`, snap.screenshotBase64);
      return JSON.stringify({ url: snap.url, title: snap.title, textExcerpt: snap.textExcerpt });
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
      ctx.reportProgress(`Filled ${selector}`, snap.screenshotBase64);
      return `Filled ${selector}`;
    },
  };

  const humanLoginTool: HarnessTool = {
    spec: {
      name: "browser_request_human_login",
      description: "Pause task and ask the user to log in or solve 2FA/CAPTCHA in a visible browser window.",
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
      ctx.reportProgress("Resumed after user login", snap.screenshotBase64);
      return `User resumed session on ${snap.url}`;
    },
  };

  return [navigateTool, clickTool, fillTool, humanLoginTool];
}
