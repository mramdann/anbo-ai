import { readFileSync } from "node:fs";

// Tao before 0.36 could deadlock the UI thread on reentrant Windows input
// callbacks (RDP or display-session transitions). The fix, tauri-apps/tao#1215
// (commit c704261c519c58cfdd0bc2d58ba24e06a0b71c92), first shipped in 0.36.0;
// until tauri moved to a Tao that has it, Cargo.toml pinned that commit.
const minimum = [0, 36, 0];
const cargoLock = readFileSync("src-tauri/Cargo.lock", "utf8");

const taoVersions = [...cargoLock.matchAll(/\[\[package\]\]\nname = "tao"\nversion = "([^"]+)"/g)].map(
  (match) => match[1],
);
const older = (version) => {
  const parts = version.split(/[.+-]/).slice(0, 3).map(Number);
  for (let index = 0; index < minimum.length; index++) {
    if (parts[index] !== minimum[index]) return parts[index] < minimum[index];
  }
  return false;
};

if (taoVersions.length === 0) {
  console.error("Cargo.lock resolves no tao package; the native input check cannot run");
  process.exit(1);
}
const stale = taoVersions.filter(older);
if (stale.length > 0) {
  console.error(
    `Tao ${stale.join(", ")} lacks the Windows input deadlock fix (tauri-apps/tao#1215); use ${minimum.join(".")} or newer`,
  );
  process.exit(1);
}

console.log(`Tao ${taoVersions.join(", ")} contains the Windows input deadlock fix (tauri-apps/tao#1215)`);
