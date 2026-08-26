import { readFileSync } from "node:fs";

const taoRevision = "c704261c519c58cfdd0bc2d58ba24e06a0b71c92";
const taoRepository = "https://github.com/tauri-apps/tao";
const cargoManifest = readFileSync("src-tauri/Cargo.toml", "utf8");
const cargoLock = readFileSync("src-tauri/Cargo.lock", "utf8");

const manifestPin = `tao = { git = "${taoRepository}", rev = "${taoRevision}" }`;
const lockPin = `source = "git+${taoRepository}?rev=${taoRevision}#${taoRevision}"`;

if (!cargoManifest.includes(manifestPin) || !cargoLock.includes(lockPin)) {
  console.error("Tao must remain pinned to the Windows input deadlock fix");
  process.exit(1);
}

console.log(`Tao Windows input deadlock fix is pinned at ${taoRevision}`);
