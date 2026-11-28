// Synthetic suite. YOMUMI_NODE_FIXTURE selects a passing, broken, or incomplete run.
import assert from "node:assert/strict";
import { describe, test } from "node:test";

const mode = process.env.YOMUMI_NODE_FIXTURE ?? "pass";

describe("cart", () => {
  describe("quantity", () => {
    test("keeps the requested quantity", () => assert.equal(mode === "broken" ? 3 : 2, 2));
  });
  if (mode !== "missing") {
    test("starts empty", () => assert.equal([].length, 0));
  }
});
