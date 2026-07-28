#!/usr/bin/env bun

import { runTermLoom } from "./runtime/run.js";
import { TermLoomError } from "./core/errors.js";
import { redactText } from "./process/process-runner.js";

try {
  const exitCode = await runTermLoom(process.argv.slice(2));
  if (exitCode !== 0) process.exitCode = exitCode;
} catch (error) {
  const message = redactText(error instanceof Error ? error.message : String(error));
  if (error instanceof TermLoomError) {
    console.error(`[${error.code}] ${message}${error.hint ? `\nHint: ${error.hint}` : ""}`);
  } else {
    console.error(`TermLoom failed: ${message}`);
  }
  process.exitCode = 1;
}
