// Synthetic suite: pass, fail, skip, todo, and a nested describe.
import assert from "node:assert/strict";
import { describe, test } from "node:test";

describe("outer", () => {
  test("passes", () => assert.equal(2, 2));
  test("fails", () => assert.equal(3, 2));
  describe("inner", () => {
    test("nested pass", () => assert.ok(true));
    test("is skipped", { skip: true }, () => {});
    test("is todo", { todo: true }, () => {});
  });
});
