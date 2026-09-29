import assert from "node:assert/strict";
import { test } from "node:test";
import { withTimeout } from "./friend-chain.ts";

test("withTimeout passes through a fast result", async () => {
  assert.equal(await withTimeout(Promise.resolve(7), 50, "fast"), 7);
});

test("withTimeout rejects a slow call with a named error", async () => {
  const slow = new Promise(resolve => setTimeout(resolve, 200));
  await assert.rejects(withTimeout(slow, 20, "Reading this Friend's world"), /Reading this Friend's world timed out/);
});
