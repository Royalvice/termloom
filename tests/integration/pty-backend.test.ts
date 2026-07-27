import { expect, test } from "bun:test";
import { PtyBackend } from "../../src/terminal/pty-backend.js";

test("PtyBackend spawns a real PTY and preserves resize", async () => {
  const backend = PtyBackend.spawn(
    "/bin/sh",
    ["-c", 'printf \'pty-ready:%s:%s\\n\' "$TERM" "$COLORTERM"; sleep 0.1'],
    {
      cols: 41,
      rows: 9,
    },
  );
  let output = "";
  const data = backend.onData((chunk) => {
    output += chunk;
  });
  const exited = new Promise<number>((resolve) => {
    backend.onExit((event) => resolve(event.exitCode));
  });
  backend.resize(52, 11);
  expect(await exited).toBe(0);
  data.dispose();
  expect(output).toContain("pty-ready:xterm-256color:truecolor");
  expect(backend.cols).toBe(52);
  expect(backend.rows).toBe(11);
});
