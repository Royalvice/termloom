import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type AddressInfo, connect } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runProcess } from "../../src/process/process-runner.js";

export interface ClientConfigOptions {
  strictHostKeyChecking: "yes" | "ask";
  knownHostsFile?: string;
  batchMode?: boolean;
}

export class SshdFixture {
  public readonly alias = "termloom-fixture";
  public readonly sshBinary: string;
  public readonly sshdBinary: string;
  public readonly root: string;
  public readonly port: number;
  public readonly knownHostsFile: string;
  public readonly controlDirectory: string;
  private readonly clientKey: string;
  private readonly userName: string;
  private readonly process: Bun.Subprocess<"ignore", "ignore", "ignore">;

  private constructor(options: {
    sshBinary: string;
    sshdBinary: string;
    root: string;
    port: number;
    knownHostsFile: string;
    controlDirectory: string;
    clientKey: string;
    userName: string;
    process: Bun.Subprocess<"ignore", "ignore", "ignore">;
  }) {
    this.sshBinary = options.sshBinary;
    this.sshdBinary = options.sshdBinary;
    this.root = options.root;
    this.port = options.port;
    this.knownHostsFile = options.knownHostsFile;
    this.controlDirectory = options.controlDirectory;
    this.clientKey = options.clientKey;
    this.userName = options.userName;
    this.process = options.process;
  }

  public static async create(): Promise<SshdFixture> {
    const sshBinary = requireBinary("ssh");
    const sshdBinary = Bun.which("sshd") ?? "/usr/sbin/sshd";
    const sshKeygen = requireBinary("ssh-keygen");
    const tmuxBinary = Bun.which("tmux");
    const { USER: userName = "" } = process.env;
    const root = await mkdtemp(join(tmpdir(), "termloom-sshd-"));
    const controlDirectory = await mkdtemp("/tmp/tl-ctl-");
    await chmod(root, 0o700);
    const port = await reserveTcpPort();
    const hostKey = join(root, "host_ed25519");
    const clientKey = join(root, "client_ed25519");
    const authorizedKeys = join(root, "authorized_keys");
    const knownHostsFile = join(root, "known_hosts");
    const sshdConfig = join(root, "sshd_config");

    try {
      await runProcess(sshKeygen, ["-q", "-t", "ed25519", "-N", "", "-f", hostKey]);
      await runProcess(sshKeygen, ["-q", "-t", "ed25519", "-N", "", "-f", clientKey]);
      await writeFile(authorizedKeys, await readFile(`${clientKey}.pub`, "utf8"), {
        mode: 0o600,
      });
      const hostPublicKey = (await readFile(`${hostKey}.pub`, "utf8")).trim().split(/\s+/);
      const keyType = hostPublicKey[0];
      const key = hostPublicKey[1];
      if (!keyType || !key) throw new Error("Generated host public key is invalid");
      await writeFile(knownHostsFile, `[127.0.0.1]:${port} ${keyType} ${key}\n`, {
        mode: 0o600,
      });
      await writeFile(
        sshdConfig,
        `${[
          `Port ${port}`,
          "ListenAddress 127.0.0.1",
          `HostKey ${hostKey}`,
          `PidFile ${join(root, "sshd.pid")}`,
          `AuthorizedKeysFile ${authorizedKeys}`,
          "PubkeyAuthentication yes",
          "PasswordAuthentication no",
          "KbdInteractiveAuthentication no",
          "UsePAM no",
          "PermitRootLogin no",
          "StrictModes no",
          `AllowUsers ${userName}`,
          "Subsystem sftp internal-sftp",
          "LogLevel ERROR",
          "PrintMotd no",
          ...(tmuxBinary
            ? [`SetEnv PATH=${dirname(tmuxBinary)}:/usr/bin:/bin:/usr/sbin:/sbin`]
            : []),
        ].join("\n")}\n`,
        { mode: 0o600 },
      );
      await runProcess(sshdBinary, ["-t", "-f", sshdConfig]);
      const processHandle = Bun.spawn([sshdBinary, "-D", "-e", "-f", sshdConfig], {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      });
      const fixture = new SshdFixture({
        sshBinary,
        sshdBinary,
        root,
        port,
        knownHostsFile,
        controlDirectory,
        clientKey,
        userName,
        process: processHandle,
      });
      await fixture.waitUntilListening();
      return fixture;
    } catch (error) {
      await rm(root, { recursive: true, force: true });
      await rm(controlDirectory, { recursive: true, force: true });
      throw error;
    }
  }

  public async createClientConfig(options: ClientConfigOptions): Promise<string> {
    const knownHostsFile = options.knownHostsFile ?? this.knownHostsFile;
    const path = join(this.root, `ssh_config_${crypto.randomUUID()}`);
    await writeFile(
      path,
      `${[
        `Host ${this.alias}`,
        "  HostName 127.0.0.1",
        `  Port ${this.port}`,
        `  User ${this.userName}`,
        `  IdentityFile ${this.clientKey}`,
        "  IdentitiesOnly yes",
        `  StrictHostKeyChecking ${options.strictHostKeyChecking}`,
        `  UserKnownHostsFile ${knownHostsFile}`,
        "  GlobalKnownHostsFile /dev/null",
        `  BatchMode ${options.batchMode === false ? "no" : "yes"}`,
        "  PasswordAuthentication no",
        "  KbdInteractiveAuthentication no",
        "  LogLevel ERROR",
      ].join("\n")}\n`,
      { mode: 0o600 },
    );
    return path;
  }

  public async dispose(): Promise<void> {
    this.process.kill("SIGTERM");
    await this.process.exited;
    await rm(this.root, { recursive: true, force: true });
    await rm(this.controlDirectory, { recursive: true, force: true });
  }

  private async waitUntilListening(): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      if (this.process.exitCode !== null) {
        throw new Error(`Fixture sshd exited early with status ${this.process.exitCode}`);
      }
      if (await canConnect(this.port)) return;
      await Bun.sleep(20);
    }
    this.process.kill("SIGTERM");
    throw new Error(`Fixture sshd did not listen on port ${this.port}`);
  }
}

function requireBinary(name: string): string {
  const path = Bun.which(name);
  if (!path) throw new Error(`Missing sshd fixture dependency: ${name}`);
  return path;
}

async function reserveTcpPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

async function canConnect(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
    socket.setTimeout(200, () => {
      socket.destroy();
      resolve(false);
    });
  });
}
