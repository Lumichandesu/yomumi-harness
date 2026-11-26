import { expect, test } from "bun:test";

// Controlled, public data; ten cases exercise the same failure cluster.
for (let i = 0; i < 100; i++) {
  test(`fixture case ${i}`, () => {
    const fail = process.env.HARNESS_TOKEN_SCALE_FAIL === "1";
    expect(fail && i < 10 ? 1 : 2).toBe(2);
  });
}
