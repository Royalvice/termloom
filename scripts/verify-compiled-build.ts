import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { DoctorReport } from "../src/doctor/doctor.js";

const binary = resolve(process.argv[2] ?? "dist/termloom");

try {
  const nativeFormat = await inspectNativeFormat(binary);
  const expectedFormat = process.platform === "darwin" ? "Mach-O" : "ELF";
  if (nativeFormat !== expectedFormat) {
    throw new Error(`Expected ${expectedFormat}, received ${nativeFormat}`);
  }

  const version = await execute([binary, "--version"]);
  if (version.exitCode !== 0 || version.stdout.trim() !== "TermLoom 0.2.0") {
    throw new Error(`Compiled --version failed with status ${version.exitCode}`);
  }
  const help = await execute([binary, "--help"]);
  if (help.exitCode !== 0 || !help.stdout.includes("termloom doctor")) {
    throw new Error(`Compiled --help failed with status ${help.exitCode}`);
  }
  const doctor = await execute([binary, "doctor", "--json", "--no-terminal-probe"]);
  if (doctor.stderr.length > 0) throw new Error("Compiled doctor wrote unexpected stderr");
  const report = JSON.parse(doctor.stdout) as DoctorReport;
  if (doctor.exitCode !== 0 || !report.ok) {
    const failedDependencies = report.dependencies
      .filter((dependency) => dependency.status === "fail")
      .map((dependency) => dependency.name)
      .join(", ");
    throw new Error(
      `Compiled doctor failed with status ${doctor.exitCode}${
        failedDependencies ? `; dependencies: ${failedDependencies}` : ""
      }`,
    );
  }
  if (report.schemaVersion !== 1) throw new Error("Compiled doctor schema is not version 1");
  if (report.runtime.platform !== process.platform || report.runtime.arch !== process.arch) {
    throw new Error(
      `Compiled runtime mismatch: ${report.runtime.platform}/${report.runtime.arch} vs ${process.platform}/${process.arch}`,
    );
  }
  if (report.terminal.capabilitySource !== "environment-only") {
    throw new Error("Non-interactive compiled doctor did not preserve environment-only provenance");
  }
  console.log(
    `Verified ${nativeFormat} ${report.runtime.platform}/${report.runtime.arch}: version, help, and doctor PASS`,
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

async function inspectNativeFormat(path: string): Promise<"Mach-O" | "ELF" | "unknown"> {
  const content = await readFile(path);
  if (content.length < 4) return "unknown";
  if (content[0] === 0x7f && content[1] === 0x45 && content[2] === 0x4c && content[3] === 0x46) {
    return "ELF";
  }
  const magic = content.subarray(0, 4).toString("hex");
  return ["cffaedfe", "feedfacf", "cafebabe", "bebafeca"].includes(magic) ? "Mach-O" : "unknown";
}

async function execute(command: readonly string[]) {
  const subprocess = Bun.spawn([...command], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    subprocess.exited,
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}
