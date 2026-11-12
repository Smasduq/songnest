/**
 * Build the `songnest` CLI and copy it where Tauri bundles resources from
 * (`web/src-tauri/bin/`).
 *
 * This replaces the old shell-only npm script, which used `cp` and always
 * looked for `target/release/songnest` — so `npm run desktop:build` failed
 * on Windows before it even reached Tauri.
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = dirname(here);
const repoRoot = dirname(webRoot);

const exe = process.platform === "win32" ? "songnest.exe" : "songnest";
const built = join(repoRoot, "target", "release", exe);
const destDir = join(webRoot, "src-tauri", "bin");
const dest = join(destDir, exe);

console.log(`building ${exe}…`);
execFileSync("cargo", ["build", "--release", "-p", "songnest"], {
  cwd: repoRoot,
  stdio: "inherit",
});

const size = statSync(built).size;
if (size === 0) {
  throw new Error(`cargo produced an empty binary at ${built}`);
}
mkdirSync(destDir, { recursive: true });
copyFileSync(built, dest);
console.log(`sidecar ready: ${dest} (${size} bytes)`);
