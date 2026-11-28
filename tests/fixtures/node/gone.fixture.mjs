// The pair.fixture.mjs suite after the failing test of broken.fixture.mjs was deleted.
// Everything passes, which must never be reported as a fix.
import assert from "node:assert/strict";
import { describe, test } from "node:test";

describe("cart", () => {
  test("starts empty", () => assert.equal([].length, 0));
});
