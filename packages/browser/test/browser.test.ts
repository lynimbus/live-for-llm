import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseBrowserProfileId } from "@live-for-llm/protocol";
import { PersistentBrowserManager } from "../src/index.ts";

test("PersistentBrowserManager persists login cookies across restarts and enforces PolicyGuard", async () => {
  const server = http.createServer((req, res) => {
    if (req.url === "/login") {
      res.writeHead(200, {
        "content-type": "text/html",
        "set-cookie": "session_token=secret_user_123; Path=/; Max-Age=3600",
      });
      res.end(
        "<html><title>Logged In</title><body><h1>Welcome</h1><button id='post-btn'>Post</button><script>localStorage.setItem('user_handle','lynimbus');</script></body></html>",
      );
      return;
    }
    const cookie = req.headers.cookie ?? "";
    res.writeHead(200, { "content-type": "text/html" });
    res.end(
      `<html><title>Dashboard</title><body><p>cookie=${cookie}</p><p id='ls'></p><button id='send-btn'>Send</button><script>document.getElementById('ls').textContent='handle='+(localStorage.getItem('user_handle')||'none');</script></body></html>`,
    );
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  assert.ok(addr && typeof addr !== "string");
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  const profilesDir = mkdtempSync(join(tmpdir(), "lfl-browser-"));
  const profileId = parseBrowserProfileId("main_profile");

  const manager1 = new PersistentBrowserManager({ profilesRootDir: profilesDir });
  try {
    const loginSnap = await manager1.navigate({ profileId, url: `${baseUrl}/login` });
    assert.equal(loginSnap.title, "Logged In");
    assert.ok(loginSnap.screenshotBase64.length > 100);
    assert.ok(loginSnap.interactiveElements.some((el) => el.selectorHint === "#post-btn"));
  } finally {
    await manager1.closeAll();
  }

  const manager2 = new PersistentBrowserManager({ profilesRootDir: profilesDir });
  try {
    const dashSnap = await manager2.navigate({ profileId, url: `${baseUrl}/dashboard` });
    assert.match(dashSnap.textExcerpt, /cookie=session_token=secret_user_123/);
    assert.match(dashSnap.textExcerpt, /handle=lynimbus/);

    await assert.rejects(
      () =>
        manager2.performGuardedAction({
          profileId,
          policy: {
            mode: "confirm_external",
            autoApproveDomains: [],
            alwaysConfirmTiers: ["destructive"],
          },
          riskTier: "external_send",
          actionSummary: "Click Send button",
          requestApproval: async () => "denied",
          run: async (page) => page.click("#send-btn"),
        }),
      /denied by user/,
    );

    await manager2.performGuardedAction({
      profileId,
      policy: {
        mode: "trust_auto",
        autoApproveDomains: [],
        alwaysConfirmTiers: ["destructive"],
      },
      riskTier: "external_send",
      actionSummary: "Click Send button",
      requestApproval: async () => {
        throw new Error("Should not prompt in trust_auto");
      },
      run: async (page) => page.click("#send-btn"),
    });
  } finally {
    await manager2.closeAll();
    rmSync(profilesDir, { recursive: true, force: true });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
