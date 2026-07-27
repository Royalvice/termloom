import { expect, test } from "bun:test";
import { resolveTermLoomPaths } from "../../../src/config/paths.js";

test("resolves XDG paths without mixing config, state, and cache", () => {
  expect(
    resolveTermLoomPaths({
      HOME: "/home/test",
      XDG_CONFIG_HOME: "/cfg",
      XDG_STATE_HOME: "/state",
      XDG_CACHE_HOME: "/cache",
    }),
  ).toEqual({
    configFile: "/cfg/termloom/config.toml",
    stateFile: "/state/termloom/workspaces.json",
    cacheDirectory: "/cache/termloom",
    controlDirectory: "/cache/termloom/ssh-control",
    logDirectory: "/state/termloom/logs",
  });
});
