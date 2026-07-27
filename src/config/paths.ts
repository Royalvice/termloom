import { join } from "node:path";

export interface TermLoomPaths {
  configFile: string;
  stateFile: string;
  cacheDirectory: string;
  controlDirectory: string;
  logDirectory: string;
}

function environmentPath(name: string, fallback: string): string {
  const value = process.env[name];
  return value && value.length > 0 ? value : fallback;
}

export function resolveTermLoomPaths(environment = process.env): TermLoomPaths {
  const {
    HOME: home,
    XDG_CONFIG_HOME: configuredConfigHome,
    XDG_STATE_HOME: configuredStateHome,
    XDG_CACHE_HOME: configuredCacheHome,
  } = environment;
  if (!home) {
    throw new Error("HOME is required to resolve TermLoom paths");
  }
  const configHome = configuredConfigHome ?? join(home, ".config");
  const stateHome = configuredStateHome ?? join(home, ".local", "state");
  const cacheHome = configuredCacheHome ?? join(home, ".cache");
  const configDirectory = join(configHome, "termloom");
  const stateDirectory = join(stateHome, "termloom");
  const cacheDirectory = join(cacheHome, "termloom");
  return {
    configFile: join(configDirectory, "config.toml"),
    stateFile: join(stateDirectory, "workspaces.json"),
    cacheDirectory,
    controlDirectory: join(cacheDirectory, "ssh-control"),
    logDirectory: join(stateDirectory, "logs"),
  };
}

export function resolvePathsFromProcess(): TermLoomPaths {
  const { HOME: userHome } = process.env;
  if (!userHome) throw new Error("HOME is required to resolve TermLoom paths");
  return resolveTermLoomPaths({
    HOME: userHome,
    XDG_CONFIG_HOME: environmentPath("XDG_CONFIG_HOME", join(userHome, ".config")),
    XDG_STATE_HOME: environmentPath("XDG_STATE_HOME", join(userHome, ".local", "state")),
    XDG_CACHE_HOME: environmentPath("XDG_CACHE_HOME", join(userHome, ".cache")),
  });
}
