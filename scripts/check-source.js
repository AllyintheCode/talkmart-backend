import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
function files(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((item) => item.isDirectory() ? files(path.join(directory, item.name)) : item.name.endsWith(".js") ? [path.join(directory, item.name)] : []);
}
let failed = false;
for (const file of [...["src", "scripts", "test"].filter(fs.existsSync).flatMap(files), "ecosystem.config.cjs"]) {
  const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8", windowsHide: true });
  if (result.status !== 0) { console.error(result.stderr); failed = true; }
  const content = fs.readFileSync(file, "utf8");
  if (file.startsWith("src") && !file.endsWith("logger.js") && /console\.(log|info|error|warn)/.test(content)) { console.error(`Use redacting logger: ${file}`); failed = true; }
  if (/redis\.keys\(|from ["']p-queue["']/.test(content)) { console.error(`Unsafe legacy operation: ${file}`); failed = true; }
}
if (failed) process.exit(1);
console.log("Source checks passed");
