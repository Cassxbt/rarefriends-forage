import assert from "node:assert/strict";
import { test } from "node:test";
import { readFriendHistory, readFriendState, readFriendTraits } from "./friend-chain.ts";
import { deriveVitals, sceneryPreset, toMilestones } from "./vitals.ts";

// Opt-in: reads Robinhood mainnet. Run with FORAGE_LIVE=1.
const live = process.env.FORAGE_LIVE === "1";

test("reads #93858's live state, world and history from mainnet", { skip: !live, timeout: 120_000 }, async () => {
  const state = await readFriendState(93858n);
  assert.equal(state.generation, 3);
  assert.equal(state.wallet, "0xA97911D0E4357146a52931E65F84D298aDE77Aa9");
  assert.ok(state.block > 75_000_000n);
  const traits = await readFriendTraits(93858n);
  assert.equal(traits.character, "Mask");
  assert.equal(sceneryPreset(traits.scenery).id, "04-rooftop-terrace-complete");
  const history = await readFriendHistory(93858n, state.owner);
  const milestones = toMilestones(history.transfers, history.activations);
  assert.deepEqual(milestones.map(m => [m.kind, m.block]), [["appeared", 67765091n], ["activated", 67767619n]]);
  assert.equal(history.times.get(67767619n), Date.parse("2026-09-20T07:40:33Z"));
  console.log("vitals", deriveVitals(state), "traits", traits);
});
