import { expect, test } from "bun:test";

const first = process.env.HARNESS_DEMO_FOCUS === "1" ? test.only : test;
first("first cart check", () => expect(1).toBe(1));
test(process.env.HARNESS_DEMO_COVERAGE_RENAME === "1" ? "replacement check" : "second cart check", async () => {
  if (process.env.HARNESS_DEMO_SLOW === "1") await Bun.sleep(2500);
  expect(2).toBe(2);
});
