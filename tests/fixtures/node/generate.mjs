// Regenerates the checked-in reports from real `node --test` runs.
// Usage, from any directory: node tests/fixtures/node/generate.mjs
// Only the project directory and the host name are replaced before a report is written.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, hostname, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const root = resolve(here, "../../..");
const runs = [
  { name: "clean", files: ["pair"], exit: 0 },
  { name: "broken", files: ["broken"], exit: 1 },
  { name: "gone", files: ["gone"], exit: 0 },
  { name: "mixed", files: ["mixed"], exit: 1 },
  { name: "crash", files: ["pair", "crash"], exit: 1 },
  { name: "exit", files: ["exit"], exit: 0 },
  { name: "late-exit", files: ["late-exit"], exit: 0 },
  { name: "empty", files: ["empty"], exit: 0 },
];

const literal = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const flags = process.platform === "win32" ? "gi" : "g";
const forward = (path) => path.replaceAll("\\", "/");

function sanitize(xml) {
  const replacements = [
    [pathToFileURL(root).href, "file:///fixture-root"],
    [root.replaceAll("\\", "\\\\"), "/fixture-root"],
    [root, "/fixture-root"],
    [forward(root), "/fixture-root"],
  ];
  let text = xml;
  for (const [from, to] of replacements) {
    text = text.replace(new RegExp(literal(from), flags), to);
  }
  text = text.replace(/hostname="[^"]*"/g, 'hostname="redacted-host"');
  const home = homedir();
  for (const secret of [home, forward(home), home.replaceAll("\\", "\\\\"), hostname()]) {
    if (secret.length > 2 && text.toLowerCase().includes(secret.toLowerCase())) {
      throw new Error("a report still contains a local path or host name; nothing was written");
    }
  }
  return text;
}

const scratch = mkdtempSync(join(tmpdir(), "yomumi-node-fixtures-"));
const outputs = [];
try {
  for (const run of runs) {
    const report = join(scratch, `${run.name}.xml`);
    const env = { ...process.env };
    delete env.NODE_OPTIONS;
    delete env.NODE_TEST_CONTEXT;
    const child = spawnSync(
      process.execPath,
      [
        "--test",
        "--test-reporter=junit",
        `--test-reporter-destination=${report}`,
        ...run.files.map((file) => `tests/fixtures/node/${file}.fixture.mjs`),
      ],
      { cwd: root, env, stdio: "ignore", timeout: 60_000, windowsHide: true },
    );
    if (child.status !== run.exit) {
      throw new Error(`${run.name}: expected exit ${run.exit}, got ${child.status}`);
    }
    const xml = sanitize(readFileSync(report, "utf8"));
    // yomumi-evidence takes file scope from the caller because reports name no file.
    if (/<testcase\s[^>]*\sfile="/.test(xml)) {
      throw new Error(`${run.name}: this Node release names testcase files; revisit file scoping`);
    }
    outputs.push([`${run.name}.xml`, xml]);
  }
  const provenance = {
    node: process.version,
    platform: process.platform,
    method: "tests/fixtures/node/generate.mjs",
    runs,
  };
  outputs.push(["provenance.json", `${JSON.stringify(provenance, null, 2)}\n`]);
  for (const [name, content] of outputs) {
    writeFileSync(join(here, name), content);
  }
  console.log(`wrote ${outputs.length} files with Node ${process.version}`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
