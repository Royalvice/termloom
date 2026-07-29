import { dirname, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TermLoomError } from "../core/errors.js";
import type { DocumentLocation, ResourceLocation } from "./model.js";

export function resolveResourceLocation(
  reference: string,
  document: DocumentLocation,
): ResourceLocation {
  if (/\0|\r|\n/.test(reference)) return invalid(reference, "control character");
  const trimmed = reference.trim();
  if (!trimmed) return invalid(reference, "empty reference");

  let parsed: URL | undefined;
  try {
    parsed = new URL(trimmed);
  } catch {
    parsed = undefined;
  }
  if (parsed) {
    if (parsed.protocol === "file:") {
      if (document.scheme !== "file") {
        return invalid(reference, "file URLs are only valid in local documents");
      }
      if (parsed.hostname && parsed.hostname !== "localhost") {
        return invalid(reference, "file URL hostnames are not supported");
      }
      return { scheme: "file", path: fileURLToPath(parsed) };
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return invalid(reference, `unsupported protocol ${parsed.protocol}`);
    }
    if (parsed.username || parsed.password) {
      return invalid(reference, "embedded HTTP credentials are not allowed");
    }
    parsed.hash = "";
    return {
      scheme: parsed.protocol === "https:" ? "https" : "http",
      url: parsed.toString(),
      domain: parsed.hostname.toLocaleLowerCase(),
    };
  }

  const withoutFragment = trimmed.split("#", 1)[0] ?? "";
  if (!withoutFragment || withoutFragment.includes("?")) {
    return invalid(reference, "paths must not contain an empty target or query");
  }
  if (document.scheme === "file") {
    const path = withoutFragment.startsWith("/")
      ? resolve(withoutFragment)
      : resolve(dirname(document.path), withoutFragment);
    return { scheme: "file", path };
  }
  const path = withoutFragment.startsWith("/")
    ? posix.normalize(withoutFragment)
    : posix.normalize(posix.join(posix.dirname(document.path), withoutFragment));
  return { scheme: "sftp", hostId: document.hostId, path };
}

function invalid(reference: string, reason: string): never {
  throw new TermLoomError({
    code: "RESOURCE_INVALID",
    message: `Invalid document resource: ${reason}`,
    details: { referenceType: classifyReference(reference) },
  });
}

function classifyReference(reference: string): string {
  const colon = reference.indexOf(":");
  return colon > 0 ? reference.slice(0, colon).toLocaleLowerCase() : "path";
}
