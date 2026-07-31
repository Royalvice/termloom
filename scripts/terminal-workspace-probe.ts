import { createServer, type AddressInfo, type Server } from "node:net";
import { mkdir, stat, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  BoxRenderable,
  CliRenderEvents,
  type CliRenderer,
  InputRenderable,
  KeyEvent,
  type Renderable,
  ScrollBoxRenderable,
  SelectRenderable,
  SliderRenderable,
  TextRenderable,
  createCliRenderer,
} from "@opentui/core";
import {
  MouseButtons,
  createMockMouse,
  type MouseButton as MockMouseButton,
} from "@opentui/core/testing";
import { defaultConfig, type TermLoomConfig } from "../src/config/schema.js";
import { ConfigStore } from "../src/config/store.js";
import { atomicWriteUtf8 } from "../src/core/atomic-file.js";
import { DomainPermissionGate } from "../src/document/domain-permission.js";
import { ResourceCache } from "../src/document/resource-cache.js";
import { ResourceLoader } from "../src/document/resource-loader.js";
import { FileProviderRouter } from "../src/files/file-provider-router.js";
import { LocalFileProvider } from "../src/files/local-file-provider.js";
import { I18n } from "../src/i18n/i18n.js";
import { selectMediaAdapter, waitForTerminalCapabilities } from "../src/media/capabilities.js";
import { MediaDecoder } from "../src/media/decoder.js";
import { FormulaRenderer } from "../src/media/formula-renderer.js";
import { SvgRasterizer } from "../src/media/svg-rasterizer.js";
import type { MediaAdapterSelection } from "../src/media/types.js";
import { redactText, runProcess } from "../src/process/process-runner.js";
import { RcloneSftpService } from "../src/sftp/rclone-sftp.js";
import { SshClient } from "../src/ssh/client.js";
import {
  HostConnectionCoordinator,
  type HostConnectionEvent,
} from "../src/ssh/connection-coordinator.js";
import { HostCatalog, stableHostId } from "../src/ssh/host-catalog.js";
import { OpenSshResolver } from "../src/ssh/resolver.js";
import { RemoteTerminalRenderable } from "../src/connection/remote-terminal-renderable.js";
import { TerminalRenderable } from "../src/terminal/terminal-renderable.js";
import { TmuxService } from "../src/tmux/tmux-service.js";
import { FileBrowserRenderable } from "../src/ui/file-browser-renderable.js";
import { FileListRenderable } from "../src/ui/file-list-renderable.js";
import { DocumentMediaBlockRenderable } from "../src/ui/media-block-renderable.js";
import { DefaultPaneViewFactory } from "../src/ui/pane-factory.js";
import {
  RichDocumentRenderable,
  type RichDocumentServices,
} from "../src/ui/rich-document-renderable.js";
import { SessionPickerRenderable } from "../src/ui/session-picker-renderable.js";
import { TerminalLauncherRenderable } from "../src/ui/terminal-launcher-renderable.js";
import { WorkspaceApp } from "../src/ui/workspace-app.js";
import { WorkspaceController } from "../src/workspace/controller.js";
import { activeTab } from "../src/workspace/reducer.js";
import { WorkspaceStore } from "../src/workspace/store.js";
import { SshdFixture } from "../tests/helpers/sshd-fixture.js";

interface ProbeOptions {
  label: string;
  mode: "direct" | "tmux";
  output: string;
  media: boolean;
  holdMs: number;
}

interface ProbeEvidence {
  schemaVersion: 1;
  generatedAt: string;
  ok: boolean;
  label: string;
  mode: ProbeOptions["mode"];
  environment: {
    TERM?: string;
    TERM_PROGRAM?: string;
    TERM_PROGRAM_VERSION?: string;
    COLORTERM?: string;
    tmux: boolean;
  };
  terminal?: {
    width: number;
    height: number;
    adapter?: MediaAdapterSelection;
  };
  journey: {
    defaultFilesPage: boolean;
    discoveredHosts: number;
    unselectedHostNetworkConnections: number;
    hostOpenedByMouse: boolean;
    embeddedHostKeyPrompt: boolean;
    sharedAuthenticationPtys: number;
    filesLoaded: boolean;
    fileCreatedByMouse: boolean;
    contextMenuOpenedByMouse: boolean;
    directSshOpened: boolean;
    directSshSkippedTmuxDiscovery: boolean;
    sessionDiscovered: boolean;
    sessionAttachedByMouse: boolean;
    filesTerminalF2: boolean;
    terminalAliveWhileHidden: boolean;
    sidebarDraggedByMouse: boolean;
    splitDraggedByMouse: boolean;
    settingsClosedByMouse: boolean;
    previewOpenedByMouse: boolean;
    previewScrolledByMouse: boolean;
    rendererFocusRefresh: boolean;
    workspaceRestartRestored: boolean;
    noSecondAuthenticationAfterRestart: boolean;
  };
  media?: {
    markdown: boolean;
    png: boolean;
    gif: boolean;
    video: boolean;
    formula: boolean;
    playPauseByMouse: boolean;
    seekByMouse: boolean;
    volumeByMouse: boolean;
    muteByMouse: boolean;
    fullscreenByMouse: boolean;
  };
  cleanup?: {
    rendererDestroyed: boolean;
    controlMasterStopped: boolean;
    tmuxSocketClosed: boolean;
    authenticationPtysExited: boolean;
    mediaProcessesExited: boolean;
    sshdExited: boolean;
    ownedProcessMatches: number;
  };
  error?: string;
}

interface ProbeContext {
  options: ProbeOptions;
  config: TermLoomConfig;
  catalog: HostCatalog;
  ssh: SshClient;
  connections: HostConnectionCoordinator;
  tmux: CountingTmuxService;
  sftp: RcloneSftpService;
  workspaceStore: WorkspaceStore;
  cache: ResourceCache;
  permissions: DomainPermissionGate;
  hostId: string;
}

class CountingTmuxService extends TmuxService {
  public readonly listCalls: string[] = [];

  public override async list(hostId: string) {
    this.listCalls.push(hostId);
    return super.list(hostId);
  }
}

interface BootedWorkspace {
  renderer: CliRenderer;
  controller: WorkspaceController;
  app: WorkspaceApp;
  adapter?: MediaAdapterSelection;
}

interface CountingServer {
  server: Server;
  port: number;
  connections(): number;
}

const options = parseOptions(process.argv.slice(2));
const evidence: ProbeEvidence = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  ok: false,
  label: options.label,
  mode: options.mode,
  environment: terminalEnvironment(),
  journey: {
    defaultFilesPage: false,
    discoveredHosts: 0,
    unselectedHostNetworkConnections: -1,
    hostOpenedByMouse: false,
    embeddedHostKeyPrompt: false,
    sharedAuthenticationPtys: 0,
    filesLoaded: false,
    fileCreatedByMouse: false,
    contextMenuOpenedByMouse: false,
    directSshOpened: false,
    directSshSkippedTmuxDiscovery: false,
    sessionDiscovered: false,
    sessionAttachedByMouse: false,
    filesTerminalF2: false,
    terminalAliveWhileHidden: false,
    sidebarDraggedByMouse: false,
    splitDraggedByMouse: false,
    settingsClosedByMouse: false,
    previewOpenedByMouse: false,
    previewScrolledByMouse: false,
    rendererFocusRefresh: false,
    workspaceRestartRestored: false,
    noSecondAuthenticationAfterRestart: false,
  },
  ...(options.media
    ? {
        media: {
          markdown: false,
          png: false,
          gif: false,
          video: false,
          formula: false,
          playPauseByMouse: false,
          seekByMouse: false,
          volumeByMouse: false,
          muteByMouse: false,
          fullscreenByMouse: false,
        },
      }
    : {}),
};

let fixture: SshdFixture | undefined;
let inertServer: CountingServer | undefined;
let context: ProbeContext | undefined;
let currentBoot: BootedWorkspace | undefined;
let knownConfig: string | undefined;
let tmuxSocketName: string | undefined;
let tmuxSocketPath: string | undefined;
let authOutput = "";
const authenticationPids = new Set<number>();
const authenticationSubscriptions: Array<{ dispose(): void }> = [];
const mediaProcesses = new Map<number, "ffmpeg" | "mpv">();
const previews = new Set<RichDocumentRenderable>();
let sshdPid: number | undefined;
const connectionEvents: HostConnectionEvent[] = [];
let disposeConnectionEvents: (() => void) | undefined;

process.stdout.write(`\u001b]2;TermLoom Workspace ${options.label} ${options.mode}\u0007`);

try {
  fixture = await SshdFixture.create();
  sshdPid = fixture.pid;
  inertServer = await createCountingServer();
  const socketName = `termloom-journey-${process.pid}-${crypto.randomUUID()}`;
  tmuxSocketName = socketName;
  const sessionName = "journey";
  const docsDirectory = join(fixture.root, "remote-docs");
  await createSyntheticRemoteDocuments(docsDirectory, options);

  knownConfig = await fixture.createClientConfig({ strictHostKeyChecking: "yes" });
  const emptyKnownHosts = join(fixture.root, "known_hosts_prompt");
  await writeFile(emptyKnownHosts, "", { mode: 0o600 });
  const interactiveConfig = await fixture.createClientConfig({
    strictHostKeyChecking: "ask",
    knownHostsFile: emptyKnownHosts,
    batchMode: false,
  });
  await appendUnselectedHost(interactiveConfig, inertServer.port);
  await createIsolatedTmuxSession(fixture, knownConfig, socketName, sessionName, docsDirectory);
  tmuxSocketPath = await resolveTmuxSocketPath(fixture, knownConfig, socketName);

  const hostId = stableHostId(fixture.alias);
  const config = defaultConfig();
  config.ui.locale = "en";
  config.ssh.connectTimeoutSeconds = 5;
  config.hosts = [
    {
      id: hostId,
      alias: fixture.alias,
      label: "Fixture host",
      defaultPath: docsDirectory,
      defaultTmuxSession: sessionName,
      source: "discovered",
    },
  ];
  await new ConfigStore(join(fixture.root, "config", "termloom", "config.toml")).save(config);
  const catalog = await HostCatalog.create(config, {
    rootConfigPath: interactiveConfig,
    homeDirectory: fixture.root,
  });
  if (catalog.host(hostId).defaultPath !== docsDirectory) {
    throw new Error("The fixture Host metadata did not preserve its default Files path");
  }
  const ssh = await SshClient.create(config, {
    resolver: new OpenSshResolver({
      binary: fixture.sshBinary,
      configFile: interactiveConfig,
      timeoutMs: 5_000,
    }),
    controlDirectory: fixture.controlDirectory,
  });
  ssh.syncHosts(catalog.snapshot().profiles);
  const connections = new HostConnectionCoordinator(ssh, catalog);
  const tmux = new CountingTmuxService(ssh, { socketName, connections });
  const sftp = new RcloneSftpService(ssh, { connections, operationTimeoutMs: 15_000 });
  context = {
    options,
    config,
    catalog,
    ssh,
    connections,
    tmux,
    sftp,
    workspaceStore: new WorkspaceStore(
      join(fixture.root, "state", "workspaces.json"),
      fixture.root,
    ),
    cache: new ResourceCache(join(fixture.root, "cache", "resources"), 64 * 1024 * 1024),
    permissions: new DomainPermissionGate(),
    hostId,
  };

  disposeConnectionEvents = connections.onChange((event) => {
    connectionEvents.push(event);
    if (!event.authenticationBackend) return;
    authenticationPids.add(event.authenticationBackend.pid);
    authenticationSubscriptions.push(
      event.authenticationBackend.onData((data) => {
        authOutput += data;
      }),
    );
  });

  currentBoot = await bootWorkspace(context);
  const first = currentBoot;
  const initialTab = activeTab(first.controller.state);
  evidence.terminal = {
    width: first.renderer.width,
    height: first.renderer.height,
    ...(first.adapter ? { adapter: first.adapter } : {}),
  };
  evidence.journey.defaultFilesPage =
    initialTab.activeSurface === "files" && initialTab.target.kind === "local";
  evidence.journey.discoveredHosts = catalog.list().length;
  if (!evidence.journey.defaultFilesPage || catalog.list().length !== 2) {
    throw new Error("The initial Files page or two-host discovery state was not rendered");
  }
  await waitForFileBrowser(first.app, first.controller);
  const initialFilesPane = first.controller.state.panes[initialTab.surfaces.files.activePaneId];
  if (
    initialFilesPane?.kind !== "files" ||
    initialFilesPane.target.kind !== "local" ||
    initialFilesPane.path !== fixture.root
  ) {
    throw new Error("The initial Local Files workspace did not open the isolated HOME");
  }
  await Bun.sleep(100);
  if (connectionEvents.length !== 0 || inertServer.connections() !== 0) {
    throw new Error("An unselected Host initiated a network connection");
  }

  const mouse = createMockMouse(first.renderer);
  const hostList = requireRenderable(first.app.root, "sidebar-content-list", SelectRenderable);
  await clickSelectRow(mouse, hostList, 1);
  await waitUntil(() => {
    const target = activeTab(first.controller.state).target;
    return target.kind === "ssh" && target.hostId === hostId;
  }, "Host tab activation");
  evidence.journey.hostOpenedByMouse = true;
  await waitUntil(
    () => authOutput.includes("Are you sure you want to continue connecting"),
    "embedded OpenSSH host-key prompt",
  );
  evidence.journey.embeddedHostKeyPrompt =
    first.app.root.findDescendantById("ssh-authentication") !== undefined;
  const authenticationBackend = connectionEvents.find(
    (event) => event.authenticationBackend,
  )?.authenticationBackend;
  if (!authenticationBackend) throw new Error("The SSH authentication PTY was not exposed");
  authenticationBackend.write("yes\r");
  await waitUntil(() => connections.isConnected(hostId), "authenticated ControlMaster", 8_000);
  await waitUntil(
    () => first.app.root.findDescendantById("ssh-authentication") === undefined,
    "authentication panel closure",
  );
  evidence.journey.sharedAuthenticationPtys = authenticationPids.size;

  const files = await waitForFileBrowser(first.app, first.controller);
  const filesPane =
    first.controller.state.panes[activeTab(first.controller.state).surfaces.files.activePaneId];
  if (filesPane?.kind !== "files" || filesPane.path !== docsDirectory) {
    throw new Error(
      `The remote Files pane opened the wrong path: ${filesPane?.kind === "files" ? filesPane.path : "missing"}`,
    );
  }
  const fileList = requireRenderable(files, `${files.id}-current-list`, FileListRenderable);
  const directListing = await sftp.list(hostId, docsDirectory);
  if (!directListing.entries.some((entry) => entry.name === "README.md")) {
    throw new Error(
      `Direct SFTP listing missed README.md: ${directListing.entries.map((entry) => entry.name).join(", ")}`,
    );
  }
  try {
    await waitUntil(
      () => fileList.entries.some((entry) => entry.name === "README.md"),
      "remote SFTP file list",
      10_000,
    );
  } catch {
    throw new Error(
      `The Files UI did not adopt the remote listing: ${fileList.entries.map((entry) => entry.name).join(", ")}`,
    );
  }
  evidence.journey.filesLoaded = true;

  await first.renderer.idle();
  const blankY = Math.min(
    fileList.screenY + fileList.height - 1,
    fileList.screenY + fileList.entries.length + 1,
  );
  await mouse.click(fileList.screenX + 2, blankY, MouseButtons.RIGHT);
  const newFile = await waitForRenderable(
    () => findRenderable(first.app.root, (value) => value.id.endsWith("-action-new-file")),
    TextRenderable,
    "New File context action",
  );
  await clickVisible(mouse, newFile);
  const newFileInput = requireRenderable(files, `${files.id}-modal-input`, InputRenderable);
  newFileInput.value = "mouse-created.txt";
  newFileInput.submit();
  await waitUntil(
    async () => (await exists(join(docsDirectory, "mouse-created.txt"))) === true,
    "mouse-created remote file",
    8_000,
  );
  await waitUntil(
    () => fileList.entries.some((entry) => entry.name === "mouse-created.txt"),
    "refreshed file list",
    15_000,
  );
  evidence.journey.fileCreatedByMouse = true;

  const readmeIndex = fileList.entries.findIndex((entry) => entry.name === "README.md");
  if (readmeIndex < 0) throw new Error("README.md is missing from the SFTP list");
  await clickFileRow(mouse, fileList, readmeIndex, MouseButtons.RIGHT);
  await waitUntil(
    () =>
      findRenderable(first.app.root, (value) => value.id.startsWith("context-overlay-")) !==
      undefined,
    "file context menu opened from a right click",
    2_000,
  );
  evidence.journey.contextMenuOpenedByMouse = true;
  emitKey(first.renderer, key("escape", "\u001b"));
  await waitUntil(
    () =>
      findRenderable(first.app.root, (value) => value.id.startsWith("context-overlay-")) ===
      undefined,
    "file context menu closure",
  );

  if (tmux.listCalls.length !== 0) {
    throw new Error("Selecting a Host for Files unexpectedly queried tmux");
  }
  emitKey(first.renderer, key("f2", "\u001bOQ"));
  await waitUntil(
    () => activeTab(first.controller.state).activeSurface === "terminal",
    "Terminal launcher surface",
  );
  const directLauncherPane = Object.values(first.controller.state.panes).find(
    (pane) => pane.kind === "terminal-launcher" && pane.target.hostId === hostId,
  );
  if (directLauncherPane?.kind !== "terminal-launcher") {
    throw new Error("The remote Terminal launcher is missing");
  }
  const directLauncher = await waitForRenderable(
    () => first.app.root.findDescendantById(`content-${directLauncherPane.id}`),
    TerminalLauncherRenderable,
    "remote Terminal launcher",
  );
  const directButton = requireRenderable(
    directLauncher,
    `${directLauncher.id}-direct`,
    TextRenderable,
  );
  await clickVisible(mouse, directButton);
  await waitUntil(() => {
    const pane = first.controller.state.panes[directLauncherPane.id];
    return pane?.kind === "terminal" && pane.tmuxSession === undefined;
  }, "Direct SSH terminal");
  const directTerminal = await waitForRenderable(
    () => first.app.root.findDescendantById(`content-${directLauncherPane.id}`),
    TerminalRenderable,
    "Direct SSH terminal renderable",
  );
  await waitUntil(() => terminalBackendAttached(directTerminal), "Direct SSH shell backend", 8_000);
  directTerminal.sendInput("printf 'TERMLOOM_DIRECT_OK\\n'\r");
  await waitUntil(
    () => terminalText(directTerminal).includes("TERMLOOM_DIRECT_OK"),
    "Direct SSH shell command",
    8_000,
  );
  evidence.journey.directSshOpened = true;
  evidence.journey.directSshSkippedTmuxDiscovery = tmux.listCalls.length === 0;
  if (!evidence.journey.directSshSkippedTmuxDiscovery) {
    throw new Error("Direct SSH unexpectedly queried tmux");
  }

  emitKey(first.renderer, key("f2", "\u001bOQ"));
  await waitUntil(
    () => activeTab(first.controller.state).activeSurface === "files",
    "Files surface after Direct SSH",
  );
  const closeTab = requireRenderable(first.app.root, "tab-close", TextRenderable);
  await clickVisible(mouse, closeTab);
  await waitUntil(
    () => activeTab(first.controller.state).target.kind === "local",
    "Local tab after closing Direct SSH Host",
  );
  await clickSelectRow(mouse, hostList, 1);
  await waitUntil(() => {
    const target = activeTab(first.controller.state).target;
    return target.kind === "ssh" && target.hostId === hostId;
  }, "Host tab reopened for Tmux");
  emitKey(first.renderer, key("f2", "\u001bOQ"));
  await waitUntil(
    () => activeTab(first.controller.state).activeSurface === "terminal",
    "reopened Terminal launcher surface",
  );
  const launcherPane = Object.values(first.controller.state.panes).find(
    (pane) => pane.kind === "terminal-launcher" && pane.target.hostId === hostId,
  );
  if (launcherPane?.kind !== "terminal-launcher") {
    throw new Error("The reopened remote Terminal launcher is missing");
  }
  const launcher = await waitForRenderable(
    () => first.app.root.findDescendantById(`content-${launcherPane.id}`),
    TerminalLauncherRenderable,
    "reopened remote Terminal launcher",
  );
  const tmuxButton = requireRenderable(launcher, `${launcher.id}-tmux`, TextRenderable);
  await clickVisible(mouse, tmuxButton);
  await waitUntil(
    () => first.controller.state.panes[launcherPane.id]?.kind === "session-picker",
    "explicit tmux picker",
  );
  const picker = await waitForRenderable(
    () => first.app.root.findDescendantById(`content-${launcherPane.id}`),
    SessionPickerRenderable,
    "explicit tmux session picker",
  );
  const sessionList = requireRenderable(picker, `${picker.id}-list`, SelectRenderable);
  await waitUntil(
    () => sessionList.options.some((entry) => entry.name.includes(sessionName)),
    "explicitly discovered tmux session",
    8_000,
  );
  evidence.journey.sessionDiscovered = true;
  if (Number(tmux.listCalls.length) !== 1) {
    throw new Error(`Expected one on-demand tmux list, observed ${tmux.listCalls.length}`);
  }
  const sessionIndex = sessionList.options.findIndex((entry) => entry.name.includes(sessionName));
  await first.renderer.idle();
  await doubleClickSelectRow(mouse, sessionList, sessionIndex);
  await waitUntil(
    () =>
      activeTab(first.controller.state).activeSurface === "terminal" &&
      Object.values(first.controller.state.panes).some(
        (pane) => pane.kind === "terminal" && pane.tmuxSession === sessionName,
      ),
    "tmux session attach",
    10_000,
  );
  await waitUntil(
    async () => (await tmux.list(hostId)).some((session) => session.attachedClients > 0),
    "attached tmux client",
    8_000,
  );
  evidence.journey.sessionAttachedByMouse = true;

  emitKey(first.renderer, key("f2", "\u001bOQ"));
  await waitUntil(
    () => activeTab(first.controller.state).activeSurface === "files",
    "F2 Files surface",
  );
  await tmux.sendKeys(hostId, sessionName, "printf 'TERMLOOM_HIDDEN_OK\\n'");
  await waitUntil(
    async () => (await captureTmux(ssh, hostId, socketName, sessionName)).includes("HIDDEN_OK"),
    "remote tmux work while Terminal is hidden",
  );
  emitKey(first.renderer, key("f2", "\u001bOQ"));
  await waitUntil(
    () => activeTab(first.controller.state).activeSurface === "terminal",
    "F2 Terminal surface",
  );
  const terminalPane = Object.values(first.controller.state.panes).find(
    (pane) => pane.kind === "terminal" && pane.tmuxSession === sessionName,
  );
  if (!terminalPane) throw new Error("The attached terminal pane disappeared");
  const terminal = await waitForRenderable(
    () => first.app.root.findDescendantById(`content-${terminalPane.id}`),
    RemoteTerminalRenderable,
    "restored Terminal renderable",
  );
  await waitUntil(() => terminalText(terminal).includes("HIDDEN_OK"), "hidden terminal output");
  evidence.journey.filesTerminalF2 = true;
  evidence.journey.terminalAliveWhileHidden = true;

  emitKey(first.renderer, key("f2", "\u001bOQ"));
  await waitUntil(
    () => activeTab(first.controller.state).activeSurface === "files",
    "Files surface for preview",
  );
  const activeFiles = await waitForFileBrowser(first.app, first.controller);
  const activeFileList = requireRenderable(
    activeFiles,
    `${activeFiles.id}-current-list`,
    FileListRenderable,
  );
  const activeReadmeIndex = activeFileList.entries.findIndex((entry) => entry.name === "README.md");
  await clickFileRow(mouse, activeFileList, activeReadmeIndex, MouseButtons.RIGHT);
  const openSplit = await waitForRenderable(
    () => findRenderable(first.app.root, (value) => value.id.endsWith("-action-open-split")),
    TextRenderable,
    "Open in Split context action",
  );
  await clickVisible(mouse, openSplit);
  await waitUntil(
    () => Object.values(first.controller.state.panes).some((pane) => pane.kind === "preview"),
    "Markdown preview split",
  );
  const previewPane = Object.values(first.controller.state.panes).find(
    (pane) => pane.kind === "preview",
  );
  if (previewPane?.kind !== "preview") throw new Error("Preview pane is missing");
  const preview = await waitForRenderable(
    () => first.app.root.findDescendantById(`content-${previewPane.id}`),
    RichDocumentRenderable,
    "remote Markdown preview",
    10_000,
  );
  previews.add(preview);
  await waitUntil(
    () => preview.findDescendantById(`${preview.id}-markdown`) !== undefined,
    "rendered Markdown",
    10_000,
  );
  evidence.journey.previewOpenedByMouse = true;
  const beforeScroll = previewPane.scrollOffset;
  const previewScroll = await waitForRenderable(
    () => preview.findDescendantById(`${preview.id}-scroll`),
    ScrollBoxRenderable,
    "Markdown ScrollBox",
  );
  await waitUntil(
    () => previewScroll.scrollHeight > previewScroll.height,
    "scrollable Markdown layout",
  );
  for (let index = 0; index < 6; index += 1) {
    await mouse.scroll(previewScroll.screenX + 2, previewScroll.screenY + 2, "down");
  }
  await waitUntil(() => {
    const persistedPreview = first.controller.state.panes[previewPane.id];
    return persistedPreview?.kind === "preview" && persistedPreview.scrollOffset > beforeScroll;
  }, "persisted preview mouse scroll");
  evidence.journey.previewScrolledByMouse = true;

  const filesRoot = activeTab(first.controller.state).surfaces.files.root;
  if (filesRoot.type !== "split") throw new Error("Preview did not create a Files split");
  await first.renderer.idle();
  const splitDivider = await waitForRenderable(
    () => first.app.root.findDescendantById(`layout-${filesRoot.id}-divider`),
    BoxRenderable,
    "Files split divider",
  );
  await waitUntil(
    () => splitDivider.width > 0 && splitDivider.height > 0,
    "visible Files split divider",
  );
  const originalRatio = filesRoot.ratio;
  const splitStartX = splitDivider.screenX;
  const splitStartY = splitDivider.screenY + Math.min(1, splitDivider.height - 1);
  await mouse.drag(splitStartX, splitStartY, splitStartX + 8, splitStartY);
  await first.controller.flush();
  await waitUntil(() => {
    const resizedRoot = activeTab(first.controller.state).surfaces.files.root;
    return resizedRoot.type === "split" && resizedRoot.ratio !== originalRatio;
  }, "persisted Files split drag");
  evidence.journey.splitDraggedByMouse = true;

  const sidebarDivider = await waitForRenderable(
    () => first.app.root.findDescendantById("sidebar-divider"),
    TextRenderable,
    "sidebar divider",
  );
  const originalSidebarWidth = first.controller.state.sidebar.width;
  await mouse.drag(
    sidebarDivider.screenX,
    sidebarDivider.screenY + 2,
    sidebarDivider.screenX + 2,
    sidebarDivider.screenY + 2,
  );
  await first.controller.flush();
  evidence.journey.sidebarDraggedByMouse =
    first.controller.state.sidebar.width !== originalSidebarWidth;

  emitKey(first.renderer, key("g", "\u0007", true));
  emitKey(first.renderer, key("g", "g"));
  const settingsClose = await waitForRenderable(
    () => first.app.root.findDescendantById("settings-modal-close"),
    TextRenderable,
    "Settings Close button",
  );
  await first.renderer.idle();
  await waitUntil(
    () => settingsClose.width > 0 && settingsClose.height > 0,
    "visible Settings Close button",
  );
  await clickVisible(mouse, settingsClose);
  await waitUntil(
    () => first.app.root.findDescendantById("settings-modal") === undefined,
    "Settings closure",
  );
  evidence.journey.settingsClosedByMouse = true;

  if (options.media) {
    await exerciseRichMedia(first, preview, mouse, evidence, mediaProcesses);
  } else {
    evidence.media = undefined;
  }

  emitKey(first.renderer, key("f2", "\u001bOQ"));
  await waitUntil(
    () => activeTab(first.controller.state).activeSurface === "terminal",
    "Terminal surface before restart",
  );
  await first.controller.flush();
  const expected = structuredClone(first.controller.state);
  emitKey(first.renderer, key("q", "\u0011", true));
  await waitUntil(() => first.renderer.isDestroyed, "first Ctrl+Q renderer teardown");
  first.app.destroy();
  await first.controller.flush();
  await waitForPreviewDisposal(previews);
  currentBoot = undefined;

  const reloaded = await context.workspaceStore.load(context.config.ui.sidebarWidth);
  const expectedTab = activeTab(expected);
  const reloadedTab = activeTab(reloaded);
  evidence.journey.workspaceRestartRestored =
    JSON.stringify(reloadedTab.target) === JSON.stringify(expectedTab.target) &&
    reloadedTab.activeSurface === expectedTab.activeSurface &&
    JSON.stringify(reloadedTab.surfaces) === JSON.stringify(expectedTab.surfaces) &&
    Object.values(reloaded.panes).some(
      (pane) => pane.kind === "terminal" && pane.tmuxSession === sessionName,
    ) &&
    Object.values(reloaded.panes).some(
      (pane) => pane.kind === "preview" && pane.path.endsWith("README.md"),
    );
  if (!evidence.journey.workspaceRestartRestored) {
    throw new Error("The dual-surface workspace did not restore losslessly");
  }

  currentBoot = await bootWorkspace(context);
  const second = currentBoot;
  await waitUntil(
    () =>
      second.app.root.findDescendantById(`content-${terminalPane.id}`) instanceof
      RemoteTerminalRenderable,
    "reattached terminal after restart",
    8_000,
  );
  second.renderer.emit(CliRenderEvents.FOCUS);
  const resumeStart = Date.now();
  second.app.checkForResume(resumeStart);
  second.app.checkForResume(resumeStart + 15_001);
  await waitUntil(() => connections.isConnected(hostId), "renderer-focus connection refresh");
  evidence.journey.rendererFocusRefresh = true;
  evidence.journey.noSecondAuthenticationAfterRestart = authenticationPids.size === 1;
  emitKey(second.renderer, key("f2", "\u001bOQ"));
  await waitUntil(
    () => activeTab(second.controller.state).activeSurface === "files",
    "restored Files surface",
  );
  const restoredPreview = await waitForRenderable(
    () => second.app.root.findDescendantById(`content-${previewPane.id}`),
    RichDocumentRenderable,
    "restored preview split",
    10_000,
  );
  previews.add(restoredPreview);
  await Bun.sleep(options.holdMs);
  emitKey(second.renderer, key("f2", "\u001bOQ"));
  await waitUntil(
    () => activeTab(second.controller.state).activeSurface === "terminal",
    "final Terminal surface",
  );
  emitKey(second.renderer, key("q", "\u0011", true));
  await waitUntil(() => second.renderer.isDestroyed, "final Ctrl+Q renderer teardown");
  second.app.destroy();
  await second.controller.flush();
  await waitForPreviewDisposal(previews);
  currentBoot = undefined;

  evidence.journey.unselectedHostNetworkConnections = inertServer.connections();
  evidence.ok = journeyPassed(evidence) && (!options.media || mediaPassed(evidence));
} catch (error) {
  evidence.error = safeError(error, fixture?.root);
  process.exitCode = 1;
} finally {
  if (currentBoot) {
    currentBoot.app.destroy();
    if (!currentBoot.renderer.isDestroyed) currentBoot.renderer.destroy();
    await currentBoot.controller.flush().catch(() => undefined);
  }
  await waitForPreviewDisposal(previews).catch(() => undefined);
  disposeConnectionEvents?.();
  for (const subscription of authenticationSubscriptions.splice(0)) subscription.dispose();

  let controlMasterStopped = true;
  if (context) {
    await context.tmux.kill(context.hostId, "journey").catch(() => undefined);
    await context.ssh.stopMaster(context.hostId).catch(() => undefined);
    controlMasterStopped = !(await context.ssh.checkMaster(context.hostId).catch(() => false));
  }
  let tmuxSocketClosed = true;
  if (fixture && knownConfig && tmuxSocketName) {
    const result = await runProcess(
      fixture.sshBinary,
      ["-F", knownConfig, fixture.alias, "--", "tmux", "-L", tmuxSocketName, "has-session"],
      { allowNonZero: true, timeoutMs: 5_000 },
    ).catch(() => undefined);
    tmuxSocketClosed = result === undefined || result.exitCode !== 0;
    if (!tmuxSocketClosed) {
      await runProcess(
        fixture.sshBinary,
        ["-F", knownConfig, fixture.alias, "--", "tmux", "-L", tmuxSocketName, "kill-server"],
        { allowNonZero: true, timeoutMs: 5_000 },
      ).catch(() => undefined);
      tmuxSocketClosed = true;
    }
  }

  for (const [pid, kind] of mediaProcesses) {
    await terminateOwnedProcess(pid, kind, fixture?.root);
  }
  for (const pid of authenticationPids) {
    await terminateOwnedProcess(pid, "ssh", fixture?.root);
  }
  await fixture?.dispose().catch(() => undefined);
  await closeServer(inertServer?.server);

  const authenticationPtysExited = [...authenticationPids].every((pid) => !isProcessAlive(pid));
  const mediaProcessesExited = [...mediaProcesses.keys()].every((pid) => !isProcessAlive(pid));
  const sshdExited = sshdPid === undefined || !isProcessAlive(sshdPid);
  let ownedProcessMatches = tmuxSocketName
    ? await countOwnedProcesses([tmuxSocketName, fixture?.root].filter(Boolean) as string[])
    : 0;
  if (ownedProcessMatches > 0 && tmuxSocketName) {
    const markers = [tmuxSocketName, fixture?.root].filter(Boolean) as string[];
    await waitUntil(
      async () => {
        ownedProcessMatches = await countOwnedProcesses(markers);
        return ownedProcessMatches === 0;
      },
      "owned fixture process teardown",
      15_000,
    ).catch(() => undefined);
  }
  if (tmuxSocketPath && ownedProcessMatches === 0) {
    await unlink(tmuxSocketPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") tmuxSocketClosed = false;
    });
    if (await exists(tmuxSocketPath)) tmuxSocketClosed = false;
  }
  evidence.cleanup = {
    rendererDestroyed: currentBoot === undefined || currentBoot.renderer.isDestroyed,
    controlMasterStopped,
    tmuxSocketClosed,
    authenticationPtysExited,
    mediaProcessesExited,
    sshdExited,
    ownedProcessMatches,
  };
  evidence.ok =
    evidence.ok &&
    Object.entries(evidence.cleanup).every(([name, value]) =>
      name === "ownedProcessMatches" ? value === 0 : value === true,
    );
  if (!evidence.ok) process.exitCode = 1;
  await atomicWriteUtf8(options.output, `${JSON.stringify(evidence, null, 2)}\n`);
}

async function bootWorkspace(context: ProbeContext): Promise<BootedWorkspace> {
  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    useKittyKeyboard: null,
    useMouse: true,
    enableMouseMovement: true,
    targetFps: 30,
  });
  let adapter: MediaAdapterSelection = {
    name: "truecolor-cells",
    terminal: "generic",
    protocol: "truecolor-half-block",
  };
  if (context.options.media) {
    const capabilities = await waitForTerminalCapabilities(renderer);
    adapter = selectMediaAdapter(context.config.media.adapter, undefined, capabilities);
  }
  const rasterizer = new SvgRasterizer({ cache: context.cache });
  const preview: RichDocumentServices = {
    loader: new ResourceLoader({
      remote: context.sftp,
      cache: context.cache,
      permissions: context.permissions,
    }),
    permissions: context.permissions,
    decoder: new MediaDecoder({ maxWidth: 768, maxHeight: 768 }),
    rasterizer,
    formula: new FormulaRenderer({ cache: context.cache, rasterizer }),
    adapter,
    output: process.stdout,
    videoFramesPerSecond: 12,
    autoplayGif: true,
    mpv: { audioOutput: "null" },
  };
  const controller = new WorkspaceController(
    await context.workspaceStore.load(context.config.ui.sidebarWidth),
    context.workspaceStore,
  );
  let app: WorkspaceApp | undefined;
  const factory = new DefaultPaneViewFactory(
    renderer,
    new I18n("en"),
    {
      ssh: context.ssh,
      tmux: context.tmux,
      reconnect: context.config.reconnect,
      files: new FileProviderRouter(new LocalFileProvider(), context.sftp),
      preview,
      connections: context.connections,
      hostDefaultPath: (hostId) => context.catalog.host(hostId).defaultPath,
      hostDefaultSession: (hostId) => context.catalog.host(hostId).defaultTmuxSession,
      hostProfile: (hostId) => {
        try {
          return context.catalog.host(hostId);
        } catch {
          return undefined;
        }
      },
    },
    {
      onPaneUpdate: (pane) => controller.dispatch({ type: "update-pane", pane }),
      onOpenPreview: (filesPane, entry) =>
        controller.dispatch({
          type: "split-pane",
          paneId: filesPane.id,
          direction: "horizontal",
          pane: {
            id: `pane-${crypto.randomUUID()}`,
            kind: "preview",
            title: entry.name,
            target: filesPane.target,
            path: entry.path,
            scrollOffset: 0,
          },
        }),
      onFocusHosts: () => app?.focusHosts(),
      onAttachSession: (pane, session, inSplit) =>
        app?.attachSession(context.catalog.host(pane.target.hostId), session, inSplit),
      onRawShell: (pane, inSplit) =>
        app?.openRawShell(context.catalog.host(pane.target.hostId), inSplit),
      onDirectSsh: (pane) => app?.openDirectSsh(pane),
      onSelectTmux: (pane) => app?.selectTmux(pane),
      onContextMenu: (request, restoreFocus) => app?.openContextMenu(request, restoreFocus),
    },
  );
  app = new WorkspaceApp(renderer, context.config, new I18n("en"), controller, factory, {
    catalog: context.catalog,
    connections: context.connections,
    transferQueue: context.sftp.queue,
    saveConfig: async (next) => structuredClone(next),
    onCatalogChange: (snapshot) => context.ssh.syncHosts(snapshot.profiles),
    onRendererFocus: (hostId) => {
      if (hostId) void context.connections.ensureConnected(hostId).catch(() => undefined);
    },
  });
  renderer.requestRender();
  await renderer.idle();
  await Bun.sleep(60);
  return { renderer, controller, app, adapter };
}

async function exerciseRichMedia(
  boot: BootedWorkspace,
  preview: RichDocumentRenderable,
  mouse: ReturnType<typeof createMockMouse>,
  evidence: ProbeEvidence,
  processes: Map<number, "ffmpeg" | "mpv">,
): Promise<void> {
  const mediaEvidence = evidence.media;
  if (!mediaEvidence || !boot.adapter) throw new Error("Media evidence was not initialized");
  const image = await waitForRenderable(
    () => preview.findDescendantById("document-media-1"),
    DocumentMediaBlockRenderable,
    "PNG media block",
    12_000,
  );
  const gif = await waitForRenderable(
    () => preview.findDescendantById("document-media-2"),
    DocumentMediaBlockRenderable,
    "GIF media block",
    12_000,
  );
  const video = await waitForRenderable(
    () => preview.findDescendantById("document-media-3"),
    DocumentMediaBlockRenderable,
    "MP4 media block",
    12_000,
  );
  await waitUntil(
    () =>
      image.inspectFrame() !== undefined &&
      gif.inspectPlayback()?.status === "playing" &&
      video.inspectPlayback()?.status === "paused" &&
      statusText(preview, "status-math-1").includes(boot.adapter?.name ?? ""),
    "remote Markdown media and formula",
    15_000,
  );
  mediaEvidence.markdown = preview.findDescendantById(`${preview.id}-markdown`) !== undefined;
  mediaEvidence.png = image.inspectFrame() !== undefined;
  mediaEvidence.gif = gif.inspectPlayback()?.status === "playing";
  mediaEvidence.formula = statusText(preview, "status-math-1").includes(boot.adapter.name);

  for (let index = 0; index < 4 && preview.selectedMedia() !== video; index += 1) {
    preview.handleKeyPress(key("tab", "\t"));
  }
  if (preview.selectedMedia() !== video) throw new Error("The MP4 block could not be selected");
  preview.handleKeyPress(key("f", "f"));
  await waitUntil(() => preview.isMediaFullscreen(), "pane-native media fullscreen");
  await boot.renderer.idle();

  const play = requireRenderable(video, "play-media-3", TextRenderable);
  await clickVisible(mouse, play);
  await waitUntil(
    () =>
      video.inspectPlayback()?.status === "playing" &&
      (video.inspectFrame()?.timestampSeconds ?? 0) > 0.1 &&
      Object.keys(video.inspectProcesses()).length === 2,
    "MP4 playback",
    12_000,
  );
  mediaEvidence.video = true;
  mediaEvidence.playPauseByMouse = true;
  rememberProcesses(processes, video.inspectProcesses());
  rememberProcesses(processes, gif.inspectProcesses());
  const mediaControls = requireRenderable(video, "controls-media-3", ScrollBoxRenderable);

  const seek = requireRenderable(video, "seek-media-3", SliderRenderable);
  await scrollHorizontalIntoView(mouse, mediaControls, seek, boot.renderer, "seek control");
  await mouse.click(seek.screenX + Math.max(1, Math.floor(seek.width * 0.55)), seek.screenY);
  await waitUntil(() => (video.inspectPlayback()?.positionSeconds ?? 0) > 2, "mouse video seek");
  mediaEvidence.seekByMouse = true;

  const volume = requireRenderable(video, "volume-media-3", SliderRenderable);
  await scrollHorizontalIntoView(mouse, mediaControls, volume, boot.renderer, "volume control");
  await mouse.click(volume.screenX + Math.max(1, Math.floor(volume.width * 0.35)), volume.screenY);
  await waitUntil(() => (video.inspectPlayback()?.volume ?? 100) < 60, "mouse volume change");
  mediaEvidence.volumeByMouse = true;

  const mute = requireRenderable(video, "mute-media-3", TextRenderable);
  await scrollHorizontalIntoView(mouse, mediaControls, mute, boot.renderer, "mute control");
  await clickVisible(mouse, mute);
  await waitUntil(() => video.inspectPlayback()?.muted === true, "mouse mute");
  mediaEvidence.muteByMouse = true;

  const fullscreen = requireRenderable(video, "fullscreen-media-3", TextRenderable);
  await scrollHorizontalIntoView(
    mouse,
    mediaControls,
    fullscreen,
    boot.renderer,
    "fullscreen control",
  );
  await clickVisible(mouse, fullscreen);
  await waitUntil(() => !preview.isMediaFullscreen(), "mouse fullscreen exit");
  mediaEvidence.fullscreenByMouse = true;
  await video.togglePlayback();
}

async function createSyntheticRemoteDocuments(
  directory: string,
  probe: ProbeOptions,
): Promise<void> {
  const assets = join(directory, "assets");
  await mkdir(assets, { recursive: true, mode: 0o700 });
  const markdown = [
    `# TermLoom workspace probe: ${probe.label}`,
    "",
    `Mode: **${probe.mode}** · isolated OpenSSH/SFTP/tmux fixture`,
    "",
    "| Feature | Result |",
    "| --- | --- |",
    "| Remote Markdown | loaded through rclone SFTP |",
    "| Durable terminal | remote tmux |",
    "",
    ...Array.from(
      { length: 32 },
      (_, index) => `Journey paragraph ${index + 1}: persistent remote workspace evidence.`,
    ),
    ...(probe.media
      ? [
          "",
          "![PNG test pattern](assets/matrix.png)",
          "",
          "![Animated GIF test pattern](assets/matrix.gif)",
          "",
          "Formula: $E = mc^2$",
          "",
          '<video controls><source src="assets/matrix.mp4" type="video/mp4"></video>',
        ]
      : []),
  ].join("\n");
  await writeFile(join(directory, "README.md"), markdown, { mode: 0o600 });
  if (!probe.media) return;
  const ffmpeg = Bun.which("ffmpeg");
  if (!ffmpeg) throw new Error("ffmpeg is required for the full terminal workspace probe");
  await runProcess(
    ffmpeg,
    [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=768x768:rate=1",
      "-frames:v",
      "1",
      "-y",
      join(assets, "matrix.png"),
    ],
    { timeoutMs: 20_000 },
  );
  await runProcess(
    ffmpeg,
    [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=240x135:rate=10",
      "-t",
      "3",
      "-y",
      join(assets, "matrix.gif"),
    ],
    { timeoutMs: 20_000 },
  );
  await runProcess(
    ffmpeg,
    [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=320x180:rate=12",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:sample_rate=48000",
      "-t",
      "8",
      "-c:v",
      "mpeg4",
      "-q:v",
      "4",
      "-c:a",
      "aac",
      "-shortest",
      "-y",
      join(assets, "matrix.mp4"),
    ],
    { timeoutMs: 20_000 },
  );
}

async function appendUnselectedHost(configPath: string, port: number): Promise<void> {
  const existing = await Bun.file(configPath).text();
  await writeFile(
    configPath,
    `${existing}\nHost termloom-unselected\n  HostName 127.0.0.1\n  Port ${port}\n  BatchMode yes\n  ConnectTimeout 1\n  LogLevel ERROR\n`,
    { mode: 0o600 },
  );
}

async function createIsolatedTmuxSession(
  fixture: SshdFixture,
  configFile: string,
  socketName: string,
  sessionName: string,
  cwd: string,
): Promise<void> {
  await runProcess(
    fixture.sshBinary,
    [
      "-F",
      configFile,
      fixture.alias,
      "--",
      "tmux",
      "-L",
      socketName,
      "new-session",
      "-d",
      "-s",
      sessionName,
      "-c",
      cwd,
    ],
    { timeoutMs: 8_000 },
  );
}

async function resolveTmuxSocketPath(
  fixture: SshdFixture,
  configFile: string,
  socketName: string,
): Promise<string> {
  const result = await runProcess(
    fixture.sshBinary,
    [
      "-F",
      configFile,
      fixture.alias,
      "--",
      "tmux",
      "-L",
      socketName,
      "display-message",
      "-p",
      "\\#{socket_path}",
    ],
    { timeoutMs: 5_000 },
  );
  const socketPath = result.stdout.trim();
  if (!socketPath.endsWith(`/${socketName}`)) {
    throw new Error("tmux returned an unexpected socket path");
  }
  return socketPath;
}

async function captureTmux(
  ssh: SshClient,
  hostId: string,
  socketName: string,
  sessionName: string,
): Promise<string> {
  const result = await ssh.run(hostId, [
    "tmux",
    "-L",
    socketName,
    "capture-pane",
    "-p",
    "-t",
    `=${sessionName}:`,
  ]);
  return result.stdout;
}

async function waitForFileBrowser(
  app: WorkspaceApp,
  controller: WorkspaceController,
): Promise<FileBrowserRenderable> {
  const paneId = activeTab(controller.state).surfaces.files.activePaneId;
  return waitForRenderable(
    () => app.root.findDescendantById(`content-${paneId}`),
    FileBrowserRenderable,
    "Files browser",
    10_000,
  );
}

function findRenderable(
  root: Renderable,
  predicate: (value: Renderable) => boolean,
): Renderable | undefined {
  const stack: Renderable[] = [root];
  while (stack.length > 0) {
    const value = stack.shift();
    if (!value) continue;
    if (predicate(value)) return value;
    stack.push(...value.getChildren());
  }
  return undefined;
}

type Constructor<T> = abstract new (...args: never[]) => T;

async function waitForRenderable<T>(
  find: () => unknown,
  renderableClass: Constructor<T>,
  description: string,
  timeoutMs = 5_000,
): Promise<T> {
  let result: T | undefined;
  await waitUntil(
    () => {
      const candidate = find();
      if (candidate instanceof renderableClass) {
        result = candidate;
        return true;
      }
      return false;
    },
    description,
    timeoutMs,
  );
  if (!result) throw new Error(`Missing ${description}`);
  return result;
}

function requireRenderable<T>(
  root: { findDescendantById(id: string): unknown },
  id: string,
  renderableClass: Constructor<T>,
): T {
  const value = root.findDescendantById(id);
  if (!(value instanceof renderableClass)) throw new Error(`Missing renderable: ${id}`);
  return value;
}

async function clickVisible(
  mouse: ReturnType<typeof createMockMouse>,
  renderable: { screenX: number; screenY: number; width: number; height: number },
): Promise<void> {
  await waitUntil(
    () => renderable.width >= 1 && renderable.height >= 1,
    "visible mouse target",
    2_000,
  );
  await mouse.click(
    renderable.screenX + Math.min(1, renderable.width - 1),
    renderable.screenY + Math.min(1, renderable.height - 1),
  );
}

async function clickFileRow(
  mouse: ReturnType<typeof createMockMouse>,
  list: FileListRenderable,
  index: number,
  button: MockMouseButton = MouseButtons.LEFT,
): Promise<void> {
  if (index < 0 || index >= list.entries.length) throw new Error("File row is out of range");
  const row = requireRenderable(list, `${list.id}-row-${index}`, TextRenderable);
  await waitUntil(
    () =>
      row.width >= 1 &&
      row.height >= 1 &&
      row.screenY >= list.screenY &&
      row.screenY < list.screenY + list.height,
    "visible file row",
    2_000,
  );
  await mouse.click(row.screenX + Math.min(2, Math.max(0, row.width - 1)), row.screenY, button);
}

async function scrollHorizontalIntoView(
  mouse: ReturnType<typeof createMockMouse>,
  scroll: ScrollBoxRenderable,
  target: { screenX: number; width: number },
  renderer: CliRenderer,
  description: string,
): Promise<void> {
  for (let index = 0; index < 24; index += 1) {
    const visibleLeft = scroll.screenX;
    const visibleRight = visibleLeft + scroll.width;
    if (target.screenX >= visibleLeft && target.screenX + target.width <= visibleRight) return;
    const direction = target.screenX < visibleLeft ? "left" : "right";
    await mouse.scroll(scroll.screenX + 1, scroll.screenY, direction);
    await renderer.idle();
  }
  throw new Error(`Timed out waiting for visible mouse ${description}`);
}

async function doubleClickSelectRow(
  mouse: ReturnType<typeof createMockMouse>,
  select: SelectRenderable,
  index: number,
): Promise<void> {
  const { x, y } = selectRowPosition(select, index);
  await mouse.doubleClick(x, y);
}

async function clickSelectRow(
  mouse: ReturnType<typeof createMockMouse>,
  select: SelectRenderable,
  index: number,
  button: MockMouseButton = MouseButtons.LEFT,
): Promise<void> {
  const { x, y } = selectRowPosition(select, index);
  await mouse.click(x, y, button);
}

function selectRowPosition(select: SelectRenderable, index: number): { x: number; y: number } {
  if (index < 0 || index >= select.options.length) throw new Error("Select row is out of range");
  select.setSelectedIndex(index);
  const internals = select as unknown as { scrollOffset?: number; linesPerItem?: number };
  const offset = internals.scrollOffset ?? 0;
  const lines = Math.max(1, internals.linesPerItem ?? (select.showDescription ? 2 : 1));
  const row = index - offset;
  if (row < 0 || row * lines >= select.height) throw new Error("Select row is not visible");
  return { x: select.screenX + 1, y: select.screenY + row * lines + Math.min(1, lines - 1) };
}

function emitKey(renderer: CliRenderer, event: KeyEvent): void {
  renderer.keyInput.emit("keypress", event);
}

function key(name: string, sequence: string, ctrl = false): KeyEvent {
  return new KeyEvent({
    name,
    sequence,
    raw: sequence,
    eventType: "press",
    source: "raw",
    ctrl,
    shift: false,
    meta: false,
    option: false,
    super: false,
    hyper: false,
    number: false,
  });
}

function terminalText(terminal: TerminalRenderable): string {
  const buffer = terminal.terminal.buffer.active;
  const lines: string[] = [];
  for (let index = 0; index < buffer.length; index += 1) {
    lines.push(buffer.getLine(index)?.translateToString(true) ?? "");
  }
  return lines.join("\n");
}

function terminalBackendAttached(terminal: TerminalRenderable): boolean {
  return (
    (
      terminal as unknown as {
        backend?: unknown;
      }
    ).backend !== undefined
  );
}

function statusText(preview: RichDocumentRenderable, id: string): string {
  const status = preview.findDescendantById(id) as TextRenderable | undefined;
  return status?.content.chunks.map((chunk) => chunk.text).join("") ?? "";
}

function rememberProcesses(
  destination: Map<number, "ffmpeg" | "mpv">,
  processes: { ffmpeg?: number; mpv?: number },
): void {
  if (processes.ffmpeg) destination.set(processes.ffmpeg, "ffmpeg");
  if (processes.mpv) destination.set(processes.mpv, "mpv");
}

async function waitForPreviewDisposal(previews: Set<RichDocumentRenderable>): Promise<void> {
  for (const preview of previews) await preview.waitForMediaDisposal();
}

async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  description: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await Bun.sleep(25);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function createCountingServer(): Promise<CountingServer> {
  let count = 0;
  const server = createServer((socket) => {
    count += 1;
    socket.destroy();
  });
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address() as AddressInfo;
  return { server, port: address.port, connections: () => count };
}

async function closeServer(server: Server | undefined): Promise<void> {
  if (!server?.listening) return;
  await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function terminateOwnedProcess(
  pid: number,
  kind: "ffmpeg" | "mpv" | "ssh",
  fixtureRoot: string | undefined,
): Promise<void> {
  if (!isProcessAlive(pid)) return;
  const command = await processCommand(pid);
  const owned = command.includes(kind) && (!fixtureRoot || command.includes(fixtureRoot));
  if (!owned) return;
  process.kill(pid, "SIGTERM");
  await waitUntil(() => !isProcessAlive(pid), `${kind} PID ${pid} exit`, 2_000).catch(
    () => undefined,
  );
  if (isProcessAlive(pid)) process.kill(pid, "SIGKILL");
}

async function processCommand(pid: number): Promise<string> {
  const result = await runProcess("/bin/ps", ["-p", String(pid), "-o", "command="], {
    allowNonZero: true,
    timeoutMs: 2_000,
  }).catch(() => undefined);
  return result?.stdout.trim() ?? "";
}

async function countOwnedProcesses(markers: readonly string[]): Promise<number> {
  if (markers.length === 0) return 0;
  const result = await runProcess("/bin/ps", ["-axo", "command="], { timeoutMs: 2_000 });
  return result.stdout
    .split(/\r?\n/)
    .filter((line) => markers.some((marker) => line.includes(marker))).length;
}

function journeyPassed(value: ProbeEvidence): boolean {
  const checks = value.journey;
  return (
    checks.defaultFilesPage &&
    checks.discoveredHosts === 2 &&
    checks.unselectedHostNetworkConnections === 0 &&
    checks.hostOpenedByMouse &&
    checks.embeddedHostKeyPrompt &&
    checks.sharedAuthenticationPtys === 1 &&
    checks.filesLoaded &&
    checks.fileCreatedByMouse &&
    checks.contextMenuOpenedByMouse &&
    checks.directSshOpened &&
    checks.directSshSkippedTmuxDiscovery &&
    checks.sessionDiscovered &&
    checks.sessionAttachedByMouse &&
    checks.filesTerminalF2 &&
    checks.terminalAliveWhileHidden &&
    checks.sidebarDraggedByMouse &&
    checks.splitDraggedByMouse &&
    checks.settingsClosedByMouse &&
    checks.previewOpenedByMouse &&
    checks.previewScrolledByMouse &&
    checks.rendererFocusRefresh &&
    checks.workspaceRestartRestored &&
    checks.noSecondAuthenticationAfterRestart
  );
}

function mediaPassed(value: ProbeEvidence): boolean {
  return Boolean(value.media && Object.values(value.media).every(Boolean));
}

function parseOptions(args: readonly string[]): ProbeOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!name?.startsWith("--") || value === undefined) {
      throw new Error(`Invalid terminal workspace arguments near ${name ?? "end"}`);
    }
    values.set(name, value);
  }
  const label = values.get("--label");
  const mode = values.get("--mode");
  const output = values.get("--output");
  const mediaValue = values.get("--media") ?? "on";
  if (!label || (mode !== "direct" && mode !== "tmux") || !output) {
    throw new Error("Required: --label NAME --mode direct|tmux --output PATH");
  }
  if (mediaValue !== "on" && mediaValue !== "off") {
    throw new Error("--media must be on or off");
  }
  const holdMs = Number.parseInt(values.get("--hold-ms") ?? "0", 10);
  if (!Number.isInteger(holdMs) || holdMs < 0 || holdMs > 120_000) {
    throw new Error("--hold-ms must be an integer between 0 and 120000");
  }
  return {
    label,
    mode,
    output: resolve(output),
    media: mediaValue === "on",
    holdMs,
  };
}

function terminalEnvironment(): ProbeEvidence["environment"] {
  const {
    TERM: term,
    TERM_PROGRAM: termProgram,
    TERM_PROGRAM_VERSION: termProgramVersion,
    COLORTERM: colorTerm,
    TMUX: tmux,
  } = process.env;
  return {
    ...(term ? { TERM: term } : {}),
    ...(termProgram ? { TERM_PROGRAM: termProgram } : {}),
    ...(termProgramVersion ? { TERM_PROGRAM_VERSION: termProgramVersion } : {}),
    ...(colorTerm ? { COLORTERM: colorTerm } : {}),
    tmux: Boolean(tmux),
  };
}

function safeError(error: unknown, fixtureRoot: string | undefined): string {
  const message = redactText(error instanceof Error ? error.message : String(error));
  return fixtureRoot ? message.replaceAll(fixtureRoot, "<fixture>") : message;
}
