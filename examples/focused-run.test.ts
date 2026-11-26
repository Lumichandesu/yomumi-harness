import { expect, test } from "bun:test";

const first = process.env.HARNESS_DEMO_FOCUS === "1" ? test.only : test;
first("first cart check", () => expect(1).toBe(1));
test("second cart check", () => expect(2).toBe(2));
