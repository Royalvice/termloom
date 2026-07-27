import { createCliRenderer } from "@opentui/core";
import { PtyBackend } from "../terminal/pty-backend.js";
import { TerminalRenderable } from "../terminal/terminal-renderable.js";

export async function runTermLoom(args: readonly string[]): Promise<void> {
  if (args.includes("--version") || args.includes("-V")) {
    console.log("TermLoom 0.1.0");
    return;
  }

  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    useKittyKeyboard: null,
    useMouse: true,
    enableMouseMovement: true,
    onDestroy: () => undefined,
  });
  const { SHELL: configuredShell } = process.env;
  const shell = configuredShell ?? "/bin/zsh";
  const backend = PtyBackend.spawn(shell, ["-l"], {
    cols: renderer.width,
    rows: renderer.height,
  });
  const terminal = new TerminalRenderable(renderer, {
    id: "terminal-gate",
    backend,
    width: "100%",
    height: "100%",
  });
  renderer.root.add(terminal);
  terminal.focus();

  renderer.keyInput.on("keypress", (key) => {
    if (key.ctrl && key.name === "q") renderer.destroy();
  });
}
