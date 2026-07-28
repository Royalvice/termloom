import { afterEach, describe, expect, test } from "bun:test";
import type { InputRenderable, KeyEvent, SelectRenderable } from "@opentui/core";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { defaultConfig, type TermLoomConfig } from "../../../src/config/schema.js";
import { TermLoomError } from "../../../src/core/errors.js";
import { I18n } from "../../../src/i18n/i18n.js";
import { TransferQueue } from "../../../src/sftp/transfer-queue.js";
import { SettingsRenderable } from "../../../src/ui/settings-renderable.js";
import { TransferManagerRenderable } from "../../../src/ui/transfer-manager-renderable.js";

let setup: TestRendererSetup | undefined;
let renderable: SettingsRenderable | TransferManagerRenderable | undefined;

afterEach(() => {
  renderable?.destroyRecursively();
  setup?.renderer.destroy();
  renderable = undefined;
  setup = undefined;
});

describe("settings and transfer overlays", () => {
  test("edits, validates, and persists every-schema settings UI values", async () => {
    setup = await createTestRenderer({ width: 100, height: 35 });
    const saved: TermLoomConfig[] = [];
    let closed = false;
    const settings = new SettingsRenderable(setup.renderer, {
      id: "settings",
      config: defaultConfig(),
      i18n: new I18n("en"),
      save: async (config) => {
        saved.push(structuredClone(config));
        return config;
      },
      onClose: () => {
        closed = true;
      },
    });
    renderable = settings;
    setup.renderer.root.add(settings);
    settings.focus();
    await setup.renderOnce();
    const list = settings.findDescendantById("settings-list") as SelectRenderable;
    expect(list.options.map((option) => option.name)).toEqual([
      "ui.locale",
      "ui.theme",
      "ui.sidebarWidth",
      "ui.leader",
      "ssh.controlPersistSeconds",
      "ssh.connectTimeoutSeconds",
      "ssh.serverAliveInterval",
      "ssh.serverAliveCountMax",
      "reconnect.enabled",
      "reconnect.initialDelayMs",
      "reconnect.maxDelayMs",
      "reconnect.multiplier",
      "reconnect.jitter",
      "media.adapter",
      "media.videoFps",
      "media.maxCacheBytes",
      "media.autoplayGif",
      "permissions.allowedHttpDomains",
    ]);

    list.setSelectedIndex(2);
    settings.handleKeyPress(key("return"));
    const input = settings.findDescendantById("settings-input") as InputRenderable;
    input.value = "44";
    input.submit();
    await setup.waitFor(() => saved.length === 1);
    expect(saved[0]?.ui.sidebarWidth).toBe(44);
    expect(settings.inspectConfig().ui.sidebarWidth).toBe(44);

    settings.handleKeyPress(key("escape"));
    expect(closed).toBe(true);
  });

  test("shows the global queue and cancels the selected running transfer", async () => {
    setup = await createTestRenderer({ width: 100, height: 30 });
    const queue = new TransferQueue(1);
    const handle = queue.enqueue(
      { direction: "upload", source: "/tmp/source.bin", destination: "/remote/source.bin" },
      ({ signal, report }) =>
        new Promise((_resolve, reject) => {
          report({ bytes: 512, totalBytes: 1024 });
          signal.addEventListener(
            "abort",
            () =>
              reject(
                new TermLoomError({ code: "PROCESS_CANCELLED", message: "fixture cancelled" }),
              ),
            { once: true },
          );
        }),
    );
    void handle.completion.catch(() => undefined);
    await setup.waitFor(() => queue.get(handle.id)?.status === "running");
    let closed = false;
    const transfers = new TransferManagerRenderable(setup.renderer, {
      id: "transfers",
      queue,
      i18n: new I18n("en"),
      onClose: () => {
        closed = true;
      },
    });
    renderable = transfers;
    setup.renderer.root.add(transfers);
    transfers.focus();
    await setup.waitForFrame((frame) => frame.includes("source.bin"));
    expect(transfers.inspectJobs()[0]?.status).toBe("running");
    transfers.handleKeyPress(key("x"));
    await setup.waitFor(() => queue.get(handle.id)?.status === "cancelled");
    expect(transfers.inspectJobs()[0]?.status).toBe("cancelled");
    transfers.handleKeyPress(key("escape"));
    expect(closed).toBe(true);
  });
});

function key(name: string): KeyEvent {
  return {
    name,
    sequence: name,
    raw: name,
    eventType: "press",
    ctrl: false,
    meta: false,
    shift: false,
    super: false,
    hyper: false,
    option: false,
    number: false,
  } as unknown as KeyEvent;
}
