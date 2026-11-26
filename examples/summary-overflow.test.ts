import { expect, test } from "bun:test";

// Both explicit modes intentionally fail. Running the default suite stays green.
const side = process.env.HARNESS_SUMMARY_SIDE;

for (let i = 1; i <= 13; i++) {
  test(`repaired case ${i}`, () => {
    expect(side !== "before").toBe(true);
  });
}
test("new regression", () => {
  expect(side === "after").toBe(false);
});
test("persistent failure with changed signal", () => {
  expect(side === "after" ? "candidate" : side === "before" ? "baseline" : "expected").toBe("expected");
});
