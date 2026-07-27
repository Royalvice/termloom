import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { PtyBackend } from "../../src/terminal/pty-backend.js";
import { TerminalRenderable } from "../../src/terminal/terminal-renderable.js";

const resources: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const dispose of resources.splice(0).reverse()) await dispose();
});

describe("real PTY application compatibility", () => {
  test("runs an interactive shell", async () => {
    const fixture = await openApplication(requireBinary("zsh"), ["-f"], {
      PS1: "termloom> ",
    });
    fixture.backend.write("printf 'shell-smoke:%s\\n' \"$TERM\"; exit\r");
    await waitForText(fixture.terminal, "shell-smoke:xterm-256color");
    await waitForExit(fixture.backend);
  });

  test("runs Vim on the alternate screen and accepts commands", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "vim-smoke.txt");
    await writeFile(path, "termloom-vim-smoke\n", "utf8");
    const fixture = await openApplication(requireBinary("vim"), [
      "-Nu",
      "NONE",
      "-n",
      "-i",
      "NONE",
      path,
    ]);
    await waitForText(fixture.terminal, "termloom-vim-smoke");
    expect(fixture.terminal.cursor.buffer).toBe("alternate");
    fixture.backend.write(":q!\r");
    await waitForExit(fixture.backend);
  });

  test("runs less and returns after q", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "less-smoke.txt");
    const lines = Array.from({ length: 120 }, (_, index) => `termloom-less-${index + 1}`);
    await writeFile(path, `${lines.join("\n")}\n`, "utf8");
    const fixture = await openApplication(requireBinary("less"), ["-R", path]);
    await waitForText(fixture.terminal, "termloom-less-1");
    fixture.backend.write("q");
    await waitForExit(fixture.backend);
  });

  test("runs htop as an embedded full-screen application", async () => {
    const fixture = await openApplication(requireBinary("htop"), [
      "--readonly",
      "--no-mouse",
      "--no-color",
    ]);
    await waitForText(fixture.terminal, "PID");
    expect(fixture.terminal.cursor.buffer).toBe("alternate");
    fixture.backend.write("q");
    await waitForExit(fixture.backend);
  });

  test("runs and detaches a tmux client inside the pane", async () => {
    const tmux = requireBinary("tmux");
    const socketName = `termloom-smoke-${process.pid}-${crypto.randomUUID()}`;
    resources.push(async () => {
      await Bun.spawn([tmux, "-L", socketName, "kill-server"], {
        stdout: "ignore",
        stderr: "ignore",
      }).exited;
    });
    const fixture = await openApplication(tmux, [
      "-L",
      socketName,
      "-f",
      "/dev/null",
      "new-session",
      "-s",
      "smoke",
    ]);
    await waitForText(fixture.terminal, "smoke");
    expect(fixture.terminal.cursor.buffer).toBe("alternate");
    fixture.backend.write("printf 'termloom-tmux-smoke\\n'\r");
    await waitForText(fixture.terminal, "termloom-tmux-smoke");
    fixture.backend.write("\u0002d");
    await waitForExit(fixture.backend);
  });
});

async function openApplication(
  command: string,
  args: readonly string[],
  environment: Readonly<Record<string, string>> = {},
): Promise<{
  setup: TestRendererSetup;
  terminal: TerminalRenderable;
  backend: PtyBackend;
}> {
  const setup = await createTestRenderer({ width: 100, height: 30 });
  const backend = PtyBackend.spawn(command, args, {
    cols: 100,
    rows: 30,
    env: { ...environment, LANG: "C.UTF-8", LC_ALL: "C.UTF-8" },
  });
  const terminal = new TerminalRenderable(setup.renderer, {
    id: `pty-app-${crypto.randomUUID()}`,
    backend,
    width: "100%",
    height: "100%",
  });
  setup.renderer.root.add(terminal);
  terminal.focus();
  await setup.renderOnce();
  resources.push(() => setup.renderer.destroy());
  return { setup, terminal, backend };
}

function requireBinary(name: string): string {
  const path = Bun.which(name);
  if (!path) throw new Error(`Missing PTY smoke-test dependency: ${name}`);
  return path;
}

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "termloom-pty-"));
  resources.push(() => rm(path, { recursive: true, force: true }));
  return path;
}

async function waitForText(
  terminal: TerminalRenderable,
  expected: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (terminalText(terminal).includes(expected)) return;
    await Bun.sleep(20);
  }
  throw new Error(
    `Timed out waiting for ${JSON.stringify(expected)}. Screen:\n${terminalText(terminal)}`,
  );
}

async function waitForExit(backend: PtyBackend, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (backend.closed) return;
    await Bun.sleep(20);
  }
  throw new Error(`Timed out waiting for PTY ${backend.pid} to exit`);
}

function terminalText(renderable: TerminalRenderable): string {
  const buffer = renderable.terminal.buffer.active;
  const lines: string[] = [];
  for (let index = 0; index < buffer.length; index += 1) {
    lines.push(buffer.getLine(index)?.translateToString(true) ?? "");
  }
  return lines.join("\n");
}
