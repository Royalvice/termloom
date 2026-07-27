import { describe, expect, test } from "bun:test";
import { defaultConfig } from "../../../src/config/schema.js";
import { createControlPath, remoteCommand } from "../../../src/ssh/client.js";
import { parseEffectiveSshConfig } from "../../../src/ssh/resolver.js";

describe("OpenSSH adapters", () => {
  test("parses repeated and effective ssh -G values", () => {
    const parsed = parseEffectiveSshConfig(
      "fixture",
      [
        "host fixture",
        "hostname 127.0.0.1",
        "user tester",
        "port 2222",
        "identityfile ~/.ssh/id_one",
        "identityfile ~/.ssh/id_two",
        "userknownhostsfile ~/.ssh/known_hosts ~/.ssh/known_hosts2",
        "stricthostkeychecking ask",
        "proxyjump bastion",
      ].join("\n"),
    );
    expect(parsed.hostName).toBe("127.0.0.1");
    expect(parsed.port).toBe(2222);
    expect(parsed.identityFiles).toEqual(["~/.ssh/id_one", "~/.ssh/id_two"]);
    expect(parsed.userKnownHostsFiles).toEqual(["~/.ssh/known_hosts", "~/.ssh/known_hosts2"]);
    expect(parsed.proxyJump).toBe("bastion");
  });

  test("builds stable bounded control paths and safely quotes remote arguments", () => {
    const config = defaultConfig();
    const configured = { id: "fixture", alias: "fixture", defaultPath: "." };
    const effective = parseEffectiveSshConfig(
      "fixture",
      "hostname example.test\nuser tester\nport 22\nstricthostkeychecking yes\n",
    );
    const first = createControlPath("/tmp/termloom-control", configured, effective);
    const second = createControlPath("/tmp/termloom-control", configured, effective);
    expect(first).toBe(second);
    expect(Buffer.byteLength(first)).toBeLessThanOrEqual(100);
    expect(remoteCommand(["printf", "%s", "a b'c;$HOME"])).toBe(`'printf' '%s' 'a b'"'"'c;$HOME'`);
    expect(config.ssh.controlPersistSeconds).toBe(600);
  });
});
