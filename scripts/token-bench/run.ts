import { encode } from "gpt-tokenizer/encoding/o200k_base";
import { mkdtempSync, readFileSync, rmdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");
const binary = join(root, "target", "release", process.platform === "win32" ? "yomumi-evidence.exe" : "yomumi-evidence");
const work = mkdtempSync(join(tmpdir(), "yomumi-token-bench-"));
const metrics = (value: string) => ({ bytes: Buffer.byteLength(value, "utf8"), tokens: encode(value).length });
const cases = [
  { file: "examples/fixture.test.ts", tests: 2, failures: 1 },
  { file: "examples/token-scale.test.ts", tests: 100, failures: 10 },
];

try {
  const results = cases.map(({ file, tests, failures }, index) => {
    const report = join(work, `fixture-${index}.xml`);
    const run = Bun.spawnSync(["bun", "test", "./" + file, "--reporter=junit", `--reporter-outfile=${report}`], {
      cwd: root,
      env: { ...process.env, BUN_OPTIONS: "", HARNESS_EXAMPLE_QUANTITY: "3", HARNESS_TOKEN_SCALE_FAIL: "1" },
      stdout: "ignore", stderr: "ignore", timeout: 20_000,
    });
    if (run.exitCode !== 1) throw new Error(`Unexpected Bun status for ${file}`);
    const compact = Bun.spawnSync([binary, "compact", report, "--bun-exit", String(run.exitCode), "--expect-file", file], {
      cwd: root, stderr: "ignore", timeout: 10_000,
    });
    if (compact.exitCode !== 1) throw new Error(`Unexpected evidence status for ${file}`);
    const summary = compact.stdout.toString("utf8").trimEnd();
    const parsed = JSON.parse(summary);
    if (parsed.verdict !== "scoped-fail" || parsed.tests !== tests || parsed.failures !== failures)
      throw new Error(`Wrong evidence scope for ${file}`);
    return { file, tests, failures, clusters: parsed.clusterCount, junit: metrics(readFileSync(report, "utf8")), summary: metrics(summary) };
  });
  console.log(JSON.stringify({ encoding: "o200k_base", tokenizer: "gpt-tokenizer@2.9.0", bun: Bun.version, platform: process.platform, results }, null, 2));
} finally {
  // Only this invocation's two generated files are in the temporary directory.
  for (let i = 0; i < cases.length; i++) rmSync(join(work, `fixture-${i}.xml`), { force: true });
  rmdirSync(work);
}
