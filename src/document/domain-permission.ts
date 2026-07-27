import { TermLoomError } from "../core/errors.js";

export type DomainPermissionScope = "once" | "persist";

export interface DomainPermissionOptions {
  persistedDomains?: readonly string[];
  persist?: (domains: readonly string[]) => Promise<void>;
}

export class DomainPermissionGate {
  private readonly once = new Set<string>();
  private readonly persisted = new Set<string>();
  private readonly persist: ((domains: readonly string[]) => Promise<void>) | undefined;

  public constructor(options: DomainPermissionOptions = {}) {
    for (const domain of options.persistedDomains ?? [])
      this.persisted.add(normalizeDomain(domain));
    this.persist = options.persist;
  }

  public isAllowed(url: string | URL): boolean {
    const domain = domainFromUrl(url);
    return this.once.has(domain) || this.persisted.has(domain);
  }

  public require(url: string | URL): void {
    const domain = domainFromUrl(url);
    if (this.once.has(domain) || this.persisted.has(domain)) return;
    throw new TermLoomError({
      code: "HTTP_PERMISSION_REQUIRED",
      message: `Network access requires permission for ${domain}`,
      hint: "Allow this domain once or persistently in the preview pane.",
      details: { domain },
    });
  }

  public async allow(domainOrUrl: string, scope: DomainPermissionScope): Promise<string> {
    const domain = normalizeDomainOrUrl(domainOrUrl);
    if (scope === "once") {
      this.once.add(domain);
      return domain;
    }
    const next = new Set(this.persisted);
    next.add(domain);
    const domains = [...next].sort();
    await this.persist?.(domains);
    this.persisted.clear();
    for (const value of domains) this.persisted.add(value);
    return domain;
  }

  public persistedDomains(): readonly string[] {
    return [...this.persisted].sort();
  }
}

function domainFromUrl(url: string | URL): string {
  const parsed = url instanceof URL ? url : new URL(url);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new TermLoomError({
      code: "RESOURCE_INVALID",
      message: `Unsupported network protocol: ${parsed.protocol}`,
    });
  }
  return normalizeDomain(parsed.hostname);
}

function normalizeDomainOrUrl(value: string): string {
  try {
    return domainFromUrl(value);
  } catch (error) {
    if (error instanceof TypeError) return normalizeDomain(value);
    throw error;
  }
}

function normalizeDomain(value: string): string {
  const trimmed = value.trim().toLocaleLowerCase().replace(/\.$/, "");
  if (!trimmed || /[\s/@]/.test(trimmed)) {
    throw new TermLoomError({
      code: "RESOURCE_INVALID",
      message: "Invalid HTTP permission domain",
    });
  }
  const parsed = new URL(`https://${trimmed}`);
  if (parsed.port || parsed.pathname !== "/" || parsed.username || parsed.password) {
    throw new TermLoomError({
      code: "RESOURCE_INVALID",
      message: "HTTP permission must name a domain without a port or path",
    });
  }
  return parsed.hostname.toLocaleLowerCase();
}
