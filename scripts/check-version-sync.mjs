import { readFileSync } from "node:fs";

const packageVersion = JSON.parse(readFileSync("package.json", "utf8")).version;
const tauriVersion = JSON.parse(
  readFileSync("src-tauri/tauri.conf.json", "utf8"),
).version;
const cargoManifest = readFileSync("src-tauri/Cargo.toml", "utf8");
const cargoVersion = cargoManifest.match(
  /^\[package\][\s\S]*?^version = "([^"]+)"/m,
)?.[1];
const lockPath = "src-tauri/Cargo.lock";
const cargoLock = readFileSync(lockPath, "utf8");
const lockVersion = cargoLock.match(
  /^\[\[package\]\]\r?\nname = "anbo"\r?\nversion = "([^"]+)"/m,
)?.[1];

// Cargo drops this annotation whenever it re-resolves the lockfile, and without
// it release-please's generic updater leaves the anbo entry behind at the old
// version. Catch that here rather than at the next release.
const lockMarker =
  /^\[\[package\]\]\r?\nname = "anbo"\r?\nversion = "[^"]+" # x-release-please-version$/m.test(
    cargoLock,
  );

const versions = {
  "src-tauri/Cargo.toml": cargoVersion,
  "src-tauri/tauri.conf.json": tauriVersion,
  [lockPath]: lockVersion,
};
const mismatches = Object.entries(versions).filter(
  ([, version]) => version !== packageVersion,
);

if (mismatches.length > 0) {
  for (const [file, version] of mismatches) {
    console.error(
      `${file}: expected ${packageVersion}, found ${version ?? "none"}`,
    );
  }
  process.exit(1);
}

if (!lockMarker) {
  console.error(
    `${lockPath}: the anbo version line lost its "# x-release-please-version" annotation, so the next release would leave it behind. Restore it before committing.`,
  );
  process.exit(1);
}

console.log(`Version files are synchronized at ${packageVersion}`);
