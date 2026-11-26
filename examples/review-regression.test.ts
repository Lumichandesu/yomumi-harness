import { expect, test } from "bun:test";

// Controlled values for a before/after review of the same named tests.
const scenario = process.env.YOMUMI_REVIEW_SCENARIO;
test("order retains the requested quantity", () => {
  const received = scenario === "baseline" ? 1 : scenario === "different-failure" ? 3 : 2;
  expect(received).toBe(2);
});
test("empty cart has no items", () => {
  expect(scenario === "moved-failure" ? 1 : 0).toBe(0);
});
