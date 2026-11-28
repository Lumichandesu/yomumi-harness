// The process exits with status 0 after a first top-level suite has already reported.
import { describe, test } from "node:test";

describe("first", () => {
  test("reports", () => {});
});
describe("second", () => {
  test("exits late", () => new Promise(() => setTimeout(() => process.exit(0), 50)));
  test("never reports", () => {});
});
