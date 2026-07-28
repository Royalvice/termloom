import { describe, expect, test } from "bun:test";
import { TermLoomError } from "../../../src/core/errors.js";
import { redactText, runProcess } from "../../../src/process/process-runner.js";

describe("process runner", () => {
  test("captures stdout and stderr without a shell", async () => {
    const result = await runProcess("/bin/sh", ["-c", "printf out; printf err >&2"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("out");
    expect(result.stderr).toBe("err");
  });

  test("times out and cancels subprocesses with structured errors", async () => {
    const timedOut = runProcess("/bin/sh", ["-c", "sleep 10"], { timeoutMs: 20 });
    await expect(timedOut).rejects.toMatchObject({ code: "PROCESS_TIMEOUT" });

    const controller = new AbortController();
    controller.abort();
    const cancelled = runProcess("/usr/bin/true", [], { signal: controller.signal });
    await expect(cancelled).rejects.toBeInstanceOf(TermLoomError);
    await expect(cancelled).rejects.toMatchObject({ code: "PROCESS_CANCELLED" });
  });

  test("redacts credentials in diagnostic text", () => {
    const ephemeral = crypto.randomUUID();
    const privateKey = [
      "-----BEGIN OPENSSH PRIVATE KEY-----",
      ephemeral,
      "-----END OPENSSH PRIVATE KEY-----",
    ].join("\n");
    const redacted = redactText(
      [
        `https://user:${ephemeral}@example.test`,
        `password=${ephemeral}`,
        `token: "${ephemeral}"`,
        `api_key = '${ephemeral}'`,
        `Bearer ${ephemeral}`,
        privateKey,
      ].join("\n"),
    );

    expect(redacted).not.toContain(ephemeral);
    expect(redacted).toContain("https://user:<redacted>@example.test");
    expect(redacted).toContain("password=<redacted>");
    expect(redacted).toContain("token: <redacted>");
    expect(redacted).toContain("api_key = <redacted>");
    expect(redacted).toContain("Bearer <redacted>");
    expect(redacted).toContain("-----BEGIN OPENSSH PRIVATE KEY-----\n<redacted>");
  });
});
