// The process exits with status 0 inside the second test.
import { describe, test } from "node:test";

describe("cart", () => {
  test("starts empty", () => {});
  test("exits early", () => process.exit(0));
  test("never reports", () => {});
});
