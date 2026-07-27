import { expect, test } from "bun:test";
import { resolveResourceLocation } from "../../../src/document/resource-location.js";

const document = { hostId: "fixture", path: "/srv/project/docs/README.md" };

test("resolves relative, parent, absolute, and HTTP document resources", () => {
  expect(resolveResourceLocation("./images/a.png", document)).toEqual({
    scheme: "sftp",
    hostId: "fixture",
    path: "/srv/project/docs/images/a.png",
  });
  expect(resolveResourceLocation("../video/demo.mp4#t=2", document)).toEqual({
    scheme: "sftp",
    hostId: "fixture",
    path: "/srv/project/video/demo.mp4",
  });
  expect(resolveResourceLocation("/shared/formula.svg", document)).toEqual({
    scheme: "sftp",
    hostId: "fixture",
    path: "/shared/formula.svg",
  });
  expect(resolveResourceLocation("https://EXAMPLE.com/a.gif#frame", document)).toEqual({
    scheme: "https",
    url: "https://example.com/a.gif",
    domain: "example.com",
  });
  expect(
    resolveResourceLocation("image.png", { hostId: "fixture", path: "docs/README.md" }),
  ).toEqual({ scheme: "sftp", hostId: "fixture", path: "docs/image.png" });
});

test("rejects executable and malformed document resource schemes", () => {
  expect(() => resolveResourceLocation("javascript:alert(1)", document)).toThrow(
    "unsupported protocol javascript:",
  );
  expect(() => resolveResourceLocation("data:image/png;base64,AAAA", document)).toThrow(
    "unsupported protocol data:",
  );
  expect(() => resolveResourceLocation("image.png?token=secret", document)).toThrow(
    "remote paths must not contain",
  );
  expect(() => resolveResourceLocation("https://user:secret@example.com/a.png", document)).toThrow(
    "embedded HTTP credentials",
  );
});
