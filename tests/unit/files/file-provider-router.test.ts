import { describe, expect, test } from "bun:test";
import { FileProviderRouter } from "../../../src/files/file-provider-router.js";
import { LocalFileProvider } from "../../../src/files/local-file-provider.js";

describe("FileProviderRouter", () => {
  test("keeps Local Files available when rclone/SFTP is unavailable", () => {
    const local = new LocalFileProvider();
    const router = new FileProviderRouter(local, undefined, new Error("rclone missing"));

    expect(router.forTarget({ kind: "local" })).toBe(local);
    expect(() => router.forTarget({ kind: "ssh", hostId: "fixture" })).toThrow(
      "Remote files are unavailable because rclone was not found",
    );
  });
});
