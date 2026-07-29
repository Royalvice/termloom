import { afterEach, describe, expect, test } from "bun:test";
import { createMockMouse, createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { defaultConfig } from "../../../src/config/schema.js";
import { PtyBackend } from "../../../src/terminal/pty-backend.js";
import { TerminalRenderable } from "../../../src/terminal/terminal-renderable.js";
import { SshAuthenticationRenderable } from "../../../src/ui/ssh-authentication-renderable.js";
import { createDefaultWorkspace } from "../../../src/workspace/schema.js";

let setup: TestRendererSetup | undefined;
let authentication: SshAuthenticationRenderable | undefined;
let backend: PtyBackend | undefined;

afterEach(async () => {
  authentication?.destroyRecursively();
  setup?.renderer.destroy();
  backend?.kill("SIGTERM");
  const deadline = Date.now() + 2_000;
  while (backend && !backend.closed && Date.now() < deadline) await Bun.sleep(10);
  authentication = undefined;
  setup = undefined;
  backend = undefined;
});

describe("SshAuthenticationRenderable", () => {
  test("accepts PTY input and exposes mouse Retry/Cancel without persisting credentials", async () => {
    setup = await createTestRenderer({ width: 80, height: 24 });
    backend = PtyBackend.spawn("/bin/cat", [], { cols: 80, rows: 20 });
    let retries = 0;
    let cancels = 0;
    authentication = new SshAuthenticationRenderable(setup.renderer, {
      id: "ssh-auth",
      hostLabel: "Fixture host",
      backend,
      onRetry: () => (retries += 1),
      onCancel: () => (cancels += 1),
    });
    setup.renderer.root.add(authentication);
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("Credentials are never saved");

    const terminal = authentication.findDescendantById("ssh-auth-terminal");
    if (!(terminal instanceof TerminalRenderable))
      throw new Error("Expected authentication terminal");
    const secret = `credential-${crypto.randomUUID()}`;
    let ptyOutput = "";
    const outputSubscription = backend.onData((data) => {
      ptyOutput += data;
    });
    terminal.sendInput(`${secret}\r`);
    const inputDeadline = Date.now() + 2_000;
    while (!ptyOutput.includes(secret) && Date.now() < inputDeadline) await Bun.sleep(10);
    expect(ptyOutput).toContain(secret);
    outputSubscription.dispose();

    const retry = authentication.findDescendantById("ssh-auth-retry");
    const cancel = authentication.findDescendantById("ssh-auth-cancel");
    if (!retry || !cancel) throw new Error("Expected authentication buttons");
    const mouse = createMockMouse(setup.renderer);
    await mouse.click(retry.screenX + 1, retry.screenY);
    await mouse.click(cancel.screenX + 1, cancel.screenY);
    expect(retries).toBe(1);
    expect(cancels).toBe(1);

    authentication.setError("Authentication failed");
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("Authentication failed · Retry or Cancel");

    const persisted = JSON.stringify({
      config: defaultConfig(),
      workspace: createDefaultWorkspace(),
    });
    expect(persisted).not.toContain(secret);
    expect(persisted).not.toContain("ssh-auth");
  });
});
