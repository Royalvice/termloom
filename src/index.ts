#!/usr/bin/env bun

import { runTermLoom } from "./runtime/run.js";

try {
  await runTermLoom(process.argv.slice(2));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`TermLoom failed: ${message}`);
  process.exitCode = 1;
}
