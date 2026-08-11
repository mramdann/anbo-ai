import { readFileSync, writeFileSync } from "node:fs";

const packageVersion = JSON.parse(readFileSync("package.json", "utf8")).version;
const tauriVersion = JSON.parse(
  readFileSync("src-tauri/tauri.conf.json", "utf8"),
).version;
const cargoManifest = readFileSync("src-tauri/Cargo.toml", "utf8");
const cargoVersion = cargoManifest.match(
  /^\[package\][\s\S]*?^version = "([^"]+)"/m,
)?.[1];

// Cargo.lock is auto-managed by cargo and is NOT bumped by release-please (its
// extra-file is type "generic"), so its `anbo` version can lag the manifests by
// one release. That is harmless — cargo resyncs it on the next build — but it
// used to fail this check and skip the release build. Auto-sync it to the
// manifest version instead of erroring.
const lockPath = "src-tauri/Cargo.lock";
const cargoLock = readFileSync(lockPath, "utf8");
const lockMatch = cargoLock.match(
  /^(\[\[package\]\]\r?\nname = "anbo"\r?\nversion = ")([^"]+)"/m,
);
const lockVersion = lockMatch?.[2];
if (lockMatch && lockVersion !== packageVersion) {
  writeFileSync(
    lockPath,
    cargoLock.replace(lockMatch[0], `${lockMatch[1]}${packageVersion}"`),
  );
  console.log(`Synced Cargo.lock: anbo ${lockVersion ?? "?"} -> ${packageVersion}`);
}

const versions = {
  "src-tauri/Cargo.toml": cargoVersion,
  "src-tauri/tauri.conf.json": tauriVersion,
};
const mismatches = Object.entries(versions).filter(
  ([, version]) => version !== packageVersion,
);

if (mismatches.length > 0) {
  for (const [file, version] of mismatches) {
    console.error(`${file}: expected ${packageVersion}, found ${version ?? "none"}`);
  }
  process.exit(1);
}

console.log(`Version files are synchronized at ${packageVersion}`);
