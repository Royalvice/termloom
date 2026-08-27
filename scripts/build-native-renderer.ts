import { chmod, copyFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const cargo = Bun.which("cargo");
if (!cargo) {
  throw new Error("cargo is required to build TermLoom's native renderers");
}

const renderers = [
  {
    label: "Markdown tile experiment",
    manifest: resolve("native/termloom-render/Cargo.toml"),
    output: resolve("native/termloom-render/target/release/termloom-render"),
    packagedOutput: resolve("dist/termloom-render"),
  },
  {
    label: "strict LaTeX cell renderer",
    manifest: resolve("native/termloom-math/Cargo.toml"),
    output: resolve("native/termloom-math/target/release/termloom-math"),
    packagedOutput: resolve("dist/termloom-math"),
  },
] as const;

for (const renderer of renderers) {
  await mkdir(dirname(renderer.output), { recursive: true });
  const child = Bun.spawn([cargo, "build", "--release", "--manifest-path", renderer.manifest], {
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) {
    throw new Error(`${renderer.label} build failed with status ${exitCode}`);
  }
  await mkdir(dirname(renderer.packagedOutput), { recursive: true });
  await copyFile(renderer.output, renderer.packagedOutput);
  await chmod(renderer.packagedOutput, 0o755);
}
