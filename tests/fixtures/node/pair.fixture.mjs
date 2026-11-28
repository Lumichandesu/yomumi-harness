// Synthetic suite, passing state. broken.fixture.mjs and gone.fixture.mjs are other
// states of this same suite and keep its describe and test names.
import assert from "node:assert/strict";
import { describe, test } from "node:test";

describe("cart", () => {
  describe("quantity", () => {
    test("keeps the requested quantity", () => assert.equal(2, 2));
  });
  test("starts empty", () => assert.equal([].length, 0));
});
