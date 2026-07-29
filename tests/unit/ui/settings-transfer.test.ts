import { afterEach, describe, expect, test } from "bun:test";
import type { InputRenderable, KeyEvent, SelectRenderable } from "@opentui/core";
import { createMockMouse, createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
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
    expect(list.options.map((option) => option.value)).toEqual([
      "ui.locale",
      "ui.theme",
      "ui.sidebarWidth",
      "ui.leader",
      "ui.quickSwitch",
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
    expect(saved).toHaveLength(0);
    expect(settings.inspectConfig().ui.sidebarWidth).toBe(44);
    settings.handleKeyPress(key("s", true));
    await setup.waitFor(() => saved.length === 1);
    expect(saved[0]?.ui.sidebarWidth).toBe(44);
    expect(settings.inspectConfig().ui.sidebarWidth).toBe(44);

    const autoplayIndex = list.options.findIndex((option) => option.value === "media.autoplayGif");
    list.setSelectedIndex(autoplayIndex);
    await setup.renderOnce();
    await createMockMouse(setup.renderer).click(list.screenX + 2, list.screenY + 1);

    settings.handleKeyPress(key("escape"));
    expect(closed).toBe(true);
  });

  test("uses mouse enum, slider, Save, Close, and media-reload confirmation controls", async () => {
    setup = await createTestRenderer({ width: 110, height: 38 });
    const saved: TermLoomConfig[] = [];
    let closed = false;
    const settings = new SettingsRenderable(setup.renderer, {
      id: "settings-mouse",
      config: defaultConfig(),
      i18n: new I18n("en"),
      save: async (config) => {
        saved.push(structuredClone(config));
        return config;
      },
      confirmSave: (previous, next) =>
        previous.media.autoplayGif !== next.media.autoplayGif
          ? "Reload playing preview"
          : undefined,
      onClose: () => {
        closed = true;
      },
    });
    renderable = settings;
    setup.renderer.root.add(settings);
    settings.focus();
    await setup.renderOnce();
    const mouse = createMockMouse(setup.renderer);
    const list = settings.findDescendantById("settings-mouse-list") as SelectRenderable;

    list.setSelectedIndex(0);
    settings.handleKeyPress(key("return"));
    await setup.renderOnce();
    const locale = settings.findDescendantById("settings-mouse-editor-select") as SelectRenderable;
    await mouse.doubleClick(locale.screenX + 2, locale.screenY + 2);
    expect(settings.inspectConfig().ui.locale).toBe("zh-CN");

    list.setSelectedIndex(2);
    settings.handleKeyPress(key("return"));
    await setup.renderOnce();
    const slider = settings.findDescendantById("settings-mouse-slider");
    const apply = settings.findDescendantById("settings-mouse-editor-apply");
    if (!slider || !apply) throw new Error("Expected numeric slider editor");
    await mouse.click(slider.screenX + Math.floor(slider.width * 0.75), slider.screenY);
    await mouse.click(apply.screenX + 1, apply.screenY);
    expect(settings.inspectConfig().ui.sidebarWidth).toBeGreaterThan(28);

    const autoplay = list.options.findIndex((option) => option.value === "media.autoplayGif");
    list.setSelectedIndex(autoplay);
    settings.handleKeyPress(key("return"));
    expect(settings.inspectConfig().media.autoplayGif).toBe(false);

    const save = settings.findDescendantById("settings-mouse-save");
    if (!save) throw new Error("Expected Save button");
    await mouse.click(save.screenX + 1, save.screenY);
    await setup.waitFor(() => Boolean(settings.findDescendantById("settings-mouse-confirm")));
    expect(saved).toHaveLength(0);
    const keepEditing = settings.findDescendantById("settings-mouse-confirm-cancel");
    if (!keepEditing) throw new Error("Expected confirmation cancel");
    await mouse.click(keepEditing.screenX + 1, keepEditing.screenY);
    expect(saved).toHaveLength(0);

    await mouse.click(save.screenX + 1, save.screenY);
    await setup.waitFor(() => Boolean(settings.findDescendantById("settings-mouse-confirm")));
    const confirm = settings.findDescendantById("settings-mouse-confirm-apply");
    if (!confirm) throw new Error("Expected confirmation apply");
    await mouse.click(confirm.screenX + 1, confirm.screenY);
    await setup.waitFor(() => saved.length === 1);
    expect(saved[0]?.ui.locale).toBe("zh-CN");
    expect(saved[0]?.media.autoplayGif).toBe(false);

    const close = settings.findDescendantById("settings-mouse-close");
    if (!close) throw new Error("Expected Close button");
    await mouse.click(close.screenX + 1, close.screenY);
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
    await setup.renderOnce();
    const cancel = transfers.findDescendantById("transfers-cancel");
    if (!cancel) throw new Error("Expected cancel button");
    await createMockMouse(setup.renderer).click(cancel.screenX + 1, cancel.screenY);
    await setup.waitFor(() => queue.get(handle.id)?.status === "cancelled");
    expect(transfers.inspectJobs()[0]?.status).toBe("cancelled");
    const close = transfers.findDescendantById("transfers-close");
    if (!close) throw new Error("Expected close button");
    await createMockMouse(setup.renderer).click(close.screenX + 1, close.screenY);
    expect(closed).toBe(true);
  });
});

function key(name: string, ctrl = false): KeyEvent {
  return {
    name,
    sequence: name,
    raw: name,
    eventType: "press",
    ctrl,
    meta: false,
    shift: false,
    super: false,
    hyper: false,
    option: false,
    number: false,
  } as unknown as KeyEvent;
}
