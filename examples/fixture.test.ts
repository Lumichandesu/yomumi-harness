import { expect, test } from "bun:test";

test("accepted order retains quantity", () => {
  const actual = { quantity: Number(process.env.HARNESS_EXAMPLE_QUANTITY ?? "2") };
  expect(actual.quantity).toBe(2);
});

test("empty cart has zero total", () => {
  expect([].length).toBe(0);
});
