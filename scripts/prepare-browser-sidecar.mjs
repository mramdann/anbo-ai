import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import process from "node:process";

const root = process.cwd();
const rustc = spawnSync("rustc", ["-vV"], {
  cwd: root,
  encoding: "utf8",
});
if (rustc.status !== 0) {
  throw new Error(rustc.stderr || "failed to inspect the Rust host target");
}

const target = /^host:\s+(.+)$/m.exec(rustc.stdout)?.[1]?.trim();
if (!target) throw new Error("rustc did not report a host target");

const extension = process.platform === "win32" ? ".exe" : "";
const destination = join(
  root,
  "src-tauri",
  "binaries",
  `anbo-browser-${target}${extension}`,
);
mkdirSync(dirname(destination), { recursive: true });
if (!existsSync(destination)) closeSync(openSync(destination, "w"));

const cargo = spawnSync(
  "cargo",
  ["build", "--release", "--locked", "--bin", "anbo-browser"],
  {
    cwd: join(root, "src-tauri"),
    stdio: "inherit",
  },
);
if (cargo.status !== 0) process.exit(cargo.status ?? 1);

const source = join(
  root,
  "src-tauri",
  "target",
  "release",
  `anbo-browser${extension}`,
);
copyFileSync(source, destination);
console.log(`Prepared browser sidecar: ${destination}`);
