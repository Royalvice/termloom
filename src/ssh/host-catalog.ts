import { createHash } from "node:crypto";
import { type FSWatcher, watch } from "node:fs";
import { dirname } from "node:path";
import type { HostConfig, TermLoomConfig } from "../config/schema.js";
import { TermLoomError } from "../core/errors.js";
import {
  discoverSshHosts,
  type HostDiscoveryError,
  type HostDiscoveryOptions,
  type HostDiscoveryResult,
} from "./host-discovery.js";

export type HostProfileSource = "ssh-config" | "manual" | "missing";
export type HostResolutionStatus = "idle" | "resolving" | "resolved" | "error";
export type HostConnectionStatus =
  | "idle"
  | "resolving"
  | "authenticating"
  | "connected"
  | "reconnecting"
  | "error";

export interface HostProfile {
  id: string;
  alias: string;
  label: string;
  defaultPath: string;
  defaultTmuxSession?: string;
  source: HostProfileSource;
  sourcePath?: string;
  hidden: boolean;
  resolutionStatus: HostResolutionStatus;
  connectionStatus: HostConnectionStatus;
  error?: string;
}

export interface HostCatalogSnapshot {
  rootConfigPath: string;
  rootExists: boolean;
  files: readonly string[];
  profiles: readonly HostProfile[];
  errors: readonly HostDiscoveryError[];
}

export class HostCatalog {
  private snapshotValue: HostCatalogSnapshot;

  private constructor(
    private config: TermLoomConfig,
    private readonly discoveryOptions: HostDiscoveryOptions,
    discovery: HostDiscoveryResult,
  ) {
    this.snapshotValue = buildHostCatalog(config, discovery);
  }

  public static async create(
    config: TermLoomConfig,
    options: HostDiscoveryOptions = {},
  ): Promise<HostCatalog> {
    const discovery = await discoverSshHosts(options);
    return new HostCatalog(config, options, discovery);
  }

  public snapshot(): HostCatalogSnapshot {
    return this.snapshotValue;
  }

  public list(options: { includeHidden?: boolean } = {}): readonly HostProfile[] {
    return options.includeHidden
      ? this.snapshotValue.profiles
      : this.snapshotValue.profiles.filter((profile) => !profile.hidden);
  }

  public host(hostId: string): HostProfile {
    const profile = this.snapshotValue.profiles.find((candidate) => candidate.id === hostId);
    if (!profile) {
      throw new TermLoomError({
        code: "SSH_HOST_UNKNOWN",
        message: `Unknown SSH host: ${hostId}`,
        details: { hostId },
      });
    }
    return profile;
  }

  public async refresh(config: TermLoomConfig = this.config): Promise<HostCatalogSnapshot> {
    this.config = config;
    const previousStates = new Map(
      this.snapshotValue.profiles.map((profile) => [
        profile.id,
        {
          alias: profile.alias,
          resolutionStatus: profile.resolutionStatus,
          connectionStatus: profile.connectionStatus,
          error: profile.error,
        },
      ]),
    );
    const next = buildHostCatalog(config, await discoverSshHosts(this.discoveryOptions));
    this.snapshotValue = {
      ...next,
      profiles: next.profiles.map((profile) => {
        const previous = previousStates.get(profile.id);
        if (!previous || normalizeAlias(previous.alias) !== normalizeAlias(profile.alias)) {
          return profile;
        }
        return {
          ...profile,
          resolutionStatus: previous.resolutionStatus,
          connectionStatus: previous.connectionStatus,
          error: previous.error,
        };
      }),
    };
    return this.snapshotValue;
  }

  public updateRuntimeState(
    hostId: string,
    state: Partial<Pick<HostProfile, "resolutionStatus" | "connectionStatus" | "error">>,
  ): void {
    let found = false;
    this.snapshotValue = {
      ...this.snapshotValue,
      profiles: this.snapshotValue.profiles.map((profile) => {
        if (profile.id !== hostId) return profile;
        found = true;
        return { ...profile, ...state };
      }),
    };
    if (!found) this.host(hostId);
  }
}

export interface HostCatalogMonitorOptions {
  debounceMs?: number;
  config: () => TermLoomConfig;
  onRefresh: (snapshot: HostCatalogSnapshot) => void;
}

export class HostCatalogMonitor {
  private readonly watchers: FSWatcher[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private refreshing: Promise<HostCatalogSnapshot> | undefined;
  private disposed = false;

  public constructor(
    private readonly catalog: HostCatalog,
    private readonly options: HostCatalogMonitorOptions,
  ) {
    this.rebuildWatchers();
  }

  public schedule(): void {
    if (this.disposed) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.refresh();
    }, this.options.debounceMs ?? 150);
  }

  public refresh(): Promise<HostCatalogSnapshot> {
    if (this.disposed) return Promise.resolve(this.catalog.snapshot());
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.catalog
      .refresh(this.options.config())
      .then((snapshot) => {
        if (!this.disposed) {
          this.rebuildWatchers();
          this.options.onRefresh(snapshot);
        }
        return snapshot;
      })
      .finally(() => {
        this.refreshing = undefined;
      });
    return this.refreshing;
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.closeWatchers();
  }

  private rebuildWatchers(): void {
    this.closeWatchers();
    const snapshot = this.catalog.snapshot();
    const directories = new Set([
      dirname(snapshot.rootConfigPath),
      ...snapshot.files.map((path) => dirname(path)),
    ]);
    const targets = new Set([...snapshot.files, ...directories]);
    for (const target of targets) {
      try {
        const watcher = watch(target, { persistent: false }, () => this.schedule());
        watcher.on("error", () => undefined);
        this.watchers.push(watcher);
      } catch {
        // Discovery reports actionable filesystem errors. A missing optional watch target
        // must not make the otherwise usable catalog fail.
      }
    }
  }

  private closeWatchers(): void {
    for (const watcher of this.watchers.splice(0)) watcher.close();
  }
}

export function buildHostCatalog(
  config: TermLoomConfig,
  discovery: HostDiscoveryResult,
): HostCatalogSnapshot {
  const metadataByAlias = new Map<string, HostConfig>();
  const errors = [...discovery.errors];
  for (const host of config.hosts) {
    const key = normalizeAlias(host.alias);
    if (metadataByAlias.has(key)) {
      errors.push({
        path: "TermLoom config",
        kind: "parse",
        message: `Duplicate TermLoom SSH alias metadata: ${host.alias}`,
      });
      continue;
    }
    metadataByAlias.set(key, host);
  }

  const consumed = new Set<string>();
  const profiles: HostProfile[] = discovery.hosts.map((host) => {
    const key = normalizeAlias(host.alias);
    consumed.add(key);
    const metadata = metadataByAlias.get(key);
    return profileFrom(metadata, {
      id: metadata?.id ?? stableHostId(host.alias),
      alias: host.alias,
      source: "ssh-config",
      sourcePath: host.sourcePath,
    });
  });

  for (const host of config.hosts) {
    const key = normalizeAlias(host.alias);
    if (consumed.has(key) || metadataByAlias.get(key) !== host) continue;
    profiles.push(
      profileFrom(host, {
        id: host.id,
        alias: host.alias,
        source: host.source === "discovered" ? "missing" : "manual",
      }),
    );
  }

  return {
    rootConfigPath: discovery.rootConfigPath,
    rootExists: discovery.rootExists,
    files: discovery.files,
    profiles,
    errors,
  };
}

export function stableHostId(alias: string): string {
  const digest = createHash("sha256").update(normalizeAlias(alias)).digest("hex").slice(0, 20);
  return `ssh-${digest}`;
}

export function metadataForProfile(profile: HostProfile): HostConfig {
  return {
    id: profile.id,
    alias: profile.alias,
    ...(profile.label !== profile.alias ? { label: profile.label } : {}),
    defaultPath: profile.defaultPath,
    ...(profile.defaultTmuxSession ? { defaultTmuxSession: profile.defaultTmuxSession } : {}),
    hidden: profile.hidden,
    source: profile.source === "manual" ? "manual" : "discovered",
  };
}

function profileFrom(
  metadata: HostConfig | undefined,
  discovered: Pick<HostProfile, "id" | "alias" | "source" | "sourcePath">,
): HostProfile {
  return {
    ...discovered,
    label: metadata?.label ?? discovered.alias,
    defaultPath: metadata?.defaultPath ?? ".",
    ...(metadata?.defaultTmuxSession ? { defaultTmuxSession: metadata.defaultTmuxSession } : {}),
    hidden: metadata?.hidden ?? false,
    resolutionStatus: "idle",
    connectionStatus: "idle",
  };
}

function normalizeAlias(alias: string): string {
  return alias.trim().toLocaleLowerCase("en-US");
}
