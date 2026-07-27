import { z } from "zod";

export const CONFIG_SCHEMA_VERSION = 1;

const UI_DEFAULTS = {
  locale: "auto",
  theme: "system",
  sidebarWidth: 28,
  leader: "ctrl+space",
} as const;
const SSH_DEFAULTS = {
  controlPersistSeconds: 600,
  connectTimeoutSeconds: 15,
  serverAliveInterval: 15,
  serverAliveCountMax: 3,
} as const;
const RECONNECT_DEFAULTS = {
  enabled: true,
  initialDelayMs: 500,
  maxDelayMs: 15_000,
  multiplier: 1.8,
  jitter: 0.2,
} as const;
const MEDIA_DEFAULTS = {
  adapter: "auto",
  videoFps: 24,
  maxCacheBytes: 536_870_912,
  autoplayGif: true,
} as const;

const HostSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .regex(/^[a-zA-Z0-9._-]+$/),
    alias: z.string().min(1),
    label: z.string().min(1).optional(),
    defaultPath: z.string().min(1).default("."),
    defaultTmuxSession: z.string().min(1).optional(),
  })
  .strict();

export const TermLoomConfigSchema = z
  .object({
    schemaVersion: z.literal(CONFIG_SCHEMA_VERSION).default(CONFIG_SCHEMA_VERSION),
    ui: z
      .object({
        locale: z.enum(["auto", "en", "zh-CN"]).default("auto"),
        theme: z.enum(["dark", "light", "system"]).default("system"),
        sidebarWidth: z.number().int().min(18).max(60).default(28),
        leader: z.string().min(1).default("ctrl+space"),
      })
      .strict()
      .default(UI_DEFAULTS),
    ssh: z
      .object({
        controlPersistSeconds: z.number().int().min(30).max(86_400).default(600),
        connectTimeoutSeconds: z.number().int().min(1).max(120).default(15),
        serverAliveInterval: z.number().int().min(1).max(600).default(15),
        serverAliveCountMax: z.number().int().min(1).max(20).default(3),
      })
      .strict()
      .default(SSH_DEFAULTS),
    reconnect: z
      .object({
        enabled: z.boolean().default(true),
        initialDelayMs: z.number().int().min(100).max(60_000).default(500),
        maxDelayMs: z.number().int().min(500).max(300_000).default(15_000),
        multiplier: z.number().min(1).max(5).default(1.8),
        jitter: z.number().min(0).max(1).default(0.2),
      })
      .strict()
      .default(RECONNECT_DEFAULTS),
    media: z
      .object({
        adapter: z.enum(["auto", "kitty", "iterm2", "truecolor-cells"]).default("auto"),
        videoFps: z.number().int().min(1).max(60).default(24),
        maxCacheBytes: z.number().int().min(1_048_576).default(536_870_912),
        autoplayGif: z.boolean().default(true),
      })
      .strict()
      .default(MEDIA_DEFAULTS),
    permissions: z
      .object({
        allowedHttpDomains: z.array(z.string().min(1)).default([]),
      })
      .strict()
      .default({ allowedHttpDomains: [] }),
    hosts: z.array(HostSchema).default([]),
  })
  .strict();

export type TermLoomConfig = z.infer<typeof TermLoomConfigSchema>;
export type HostConfig = z.infer<typeof HostSchema>;

export function defaultConfig(): TermLoomConfig {
  return TermLoomConfigSchema.parse({});
}
