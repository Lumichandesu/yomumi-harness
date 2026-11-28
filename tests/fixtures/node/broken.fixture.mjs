// The pair.fixture.mjs suite with one failing test.
import assert from "node:assert/strict";
import { describe, test } from "node:test";

describe("cart", () => {
  describe("quantity", () => {
    test("keeps the requested quantity", () => assert.equal(3, 2));
  });
  test("starts empty", () => assert.equal([].length, 0));
});
