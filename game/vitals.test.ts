import assert from "node:assert/strict";
import { test } from "node:test";
import {
  RF, MAX_POUCH_PICKUPS, MAX_SPARKS_ON_GROUND, accrualRate, deriveVitals, formatRf, pickSpots, pouchPickups,
  projectEarned, pullRadius, pullStep, reactivationCost, splitValue, sceneryPreset, reconcile, toMilestones, walkTransfers, journeyStep, reactionFor, BASE_REACH, MAX_PULL,
  type FriendState, type WorldPoint,
} from "./vitals.ts";

// #93858 as read on Robinhood mainnet, 2026-09-23 and 2026-09-29.
const friend: FriendState = {
  friendId: 93858n, block: 70614423n, readAt: 1_000_000, owner: "0xCf330e9d8aabf8a923E38614e8156e19B2aDFEBB",
  wallet: "0xA97911D0E4357146a52931E65F84D298aDE77Aa9", generation: 3, tier: 0,
  weight: 1450n * RF, totalWeight: 1016116597984375000000000000n,
  earnedRf: 7434521317667191284n, earnedWeth: 26958591771211n,
};
const HARDWIRE_TX = "0xf52fc13b2c2220841c5bce21ce3089f576d4684b14bf75ce4d07ec59fe660649";
const APPEAR_TX = "0x9044d0a5febc01d674325d31f15a7b9cbbd087734778a55ecc8c3304438cd860";

test("scenery trait selects the matching SDK world", () => {
  assert.deepEqual(sceneryPreset("Rooftop"), { id: "04-rooftop-terrace-complete", matched: true });
  assert.deepEqual(sceneryPreset("Tidal Islands"), { id: "05-tidal-islands-complete", matched: true });
  assert.equal(sceneryPreset("Unknown Moon").matched, false);
  assert.equal(sceneryPreset("Unknown Moon").id, "01-garden-oval-complete");
});

test("an earning Friend is awake with its real pouch and share", () => {
  const vitals = deriveVitals(friend);
  assert.equal(vitals.awake, true);
  assert.equal(vitals.level, 0);
  assert.equal(vitals.pouchRf, friend.earnedRf);
  assert.ok(vitals.shareBps > 0 && vitals.shareBps < 1);
});

test("a Friend with no active weight rests but keeps what it earned", () => {
  const resting = deriveVitals({ ...friend, weight: 0n });
  assert.equal(resting.awake, false);
  assert.equal(resting.shareBps, 0);
  assert.equal(resting.pouchRf, friend.earnedRf);
});

test("reactivation cost follows the docs table", () => {
  assert.equal(reactivationCost(1), "10000");
  assert.equal(reactivationCost(3), "100");
  assert.equal(reactivationCost(6), "0.1");
  assert.equal(reactivationCost(0), null);
});

test("accrual rate is positive while earning and zero after a claim", () => {
  const later = { ...friend, readAt: friend.readAt + 20_000, earnedRf: friend.earnedRf + 4634218696611282n };
  assert.equal(accrualRate(friend, later), 4634218696611282n / 20n);
  assert.equal(accrualRate(later, { ...later, readAt: later.readAt + 10_000, earnedRf: 0n }), 0n);
  assert.equal(accrualRate(friend, friend), 0n);
});

test("projected pouch never goes backwards between reads", () => {
  assert.equal(projectEarned(friend, 100n, friend.readAt - 5_000), friend.earnedRf);
  assert.equal(projectEarned(friend, 100n, friend.readAt + 3_000), friend.earnedRf + 300n);
});

// reconcile(earned, represented, laidOut, active, sparksOnGround): represented = ground + carried + brought home since the last claim.
test("an active Friend's waiting rewards are laid out once, in full", () => {
  assert.deepEqual(reconcile(7n * RF, 0n, false, true, 0), { kind: "layout", value: 7n * RF });
});

test("after the layout, only a real increase becomes a spark, worth exactly that increase", () => {
  assert.deepEqual(reconcile(7n * RF + 3n, 7n * RF, true, true, 0), { kind: "spark", value: 3n });
  assert.deepEqual(reconcile(7n * RF, 7n * RF, true, true, 0), { kind: "none" });
});

test("a full ground holds new earnings back for the next spark", () => {
  assert.deepEqual(reconcile(8n * RF, 7n * RF, true, true, MAX_SPARKS_ON_GROUND), { kind: "none" });
});

test("rewards below what the game represents mean a claim, even with pickups carried", () => {
  assert.deepEqual(reconcile(0n, RF / 2n, true, true, 0), { kind: "claimed" });
  assert.deepEqual(reconcile(0n, RF / 2n, true, false, 0), { kind: "claimed" });
});

test("a resting Friend gets nothing laid out, and its waiting rewards appear once it is active again", () => {
  assert.deepEqual(reconcile(7n * RF, 0n, false, false, 0), { kind: "none" });
  assert.deepEqual(reconcile(7n * RF, 0n, false, true, 0), { kind: "layout", value: 7n * RF });
});

test("pouch splits into bounded pickups that add back up", () => {
  assert.deepEqual(pouchPickups(0n), { count: 0, each: 0n });
  const small = pouchPickups(RF / 10n);
  assert.equal(small.count, 1);
  const real = pouchPickups(friend.earnedRf);
  assert.equal(real.count, MAX_POUCH_PICKUPS);
  assert.ok(real.each * BigInt(real.count) <= friend.earnedRf);
});

test("spots are deterministic, spaced, and avoid stations", () => {
  const grid: WorldPoint[] = [];
  for (let x = 0; x < 200; x += 12) for (let y = 0; y < 200; y += 12) grid.push([x, y]);
  const station: WorldPoint = [96, 96];
  const a = pickSpots(grid, 8, 93858, [station]), b = pickSpots(grid, 8, 93858, [station]);
  assert.deepEqual(a, b);
  assert.equal(a.length, 8);
  assert.notDeepEqual(a, pickSpots(grid, 8, 1));
  for (const point of a) assert.ok(Math.hypot(point[0] - station[0], point[1] - station[1]) >= 18);
});

test("milestones replay #93858's real history in block order", () => {
  const milestones = toMilestones(
    [{ from: "0x0000000000000000000000000000000000000000", to: friend.owner, tokenId: 93858n, logIndex: 0, block: 67765091n, tx: APPEAR_TX }],
    [{ tokenId: 93858n, tier: 0, weight: 1450n * RF, paid: 1000n * RF, logIndex: 1, block: 67767619n, tx: HARDWIRE_TX }],
  );
  assert.deepEqual(milestones.map(m => [m.kind, m.block]), [["appeared", 67765091n], ["activated", 67767619n]]);
  assert.match(milestones[1].detail, /paid 1,000 RF/);
});

test("later activations read as upgrades; transfers read as new homes", () => {
  const milestones = toMilestones(
    [{ from: friend.owner, to: "0x1111111111111111111111111111111111111111", tokenId: 93858n, logIndex: 0, block: 70000000n, tx: APPEAR_TX }],
    [{ tokenId: 93858n, tier: 0, weight: 1n, paid: 1n, logIndex: 1, block: 67767619n, tx: HARDWIRE_TX },
      { tokenId: 93858n, tier: 1, weight: 2n, paid: 2n, logIndex: 1, block: 69000000n, tx: HARDWIRE_TX }],
  );
  assert.deepEqual(milestones.map(m => m.kind), ["activated", "upgraded", "new-owner"]);
});

test("RF formatting is exact and trims zeros", () => {
  assert.equal(formatRf(1000n * RF), "1,000");
  assert.equal(formatRf(friend.earnedRf), "7.4345");
  assert.equal(formatRf(RF / 2n, 2), "0.5");
});

test("kept treats widen the pull, capped, and redeeming gives it up", () => {
  assert.equal(pullRadius([0n, 0n, 0n, 0n]), BASE_REACH);
  assert.equal(pullRadius([1n, 1n, 0n, 0n]), BASE_REACH + 18);
  assert.equal(pullRadius([0n, 0n, 0n, 5n]), BASE_REACH + MAX_PULL);
});

test("pickups inside the pull glide in and are collected at base reach", () => {
  assert.equal(pullStep([100, 0], [0, 0], 50, 5), null, "outside the pull stays put");
  assert.deepEqual(pullStep([40, 0], [0, 0], 50, 5), [35, 0], "inside the pull moves closer");
  assert.equal(pullStep([BASE_REACH, 0], [0, 0], 50, 5), "collected");
});

test("a missed golden spark scatters into parts worth exactly the same", () => {
  const parts = splitValue(10n * RF + 1n, 3);
  assert.equal(parts.length, 3);
  assert.equal(parts.reduce((a, b) => a + b, 0n), 10n * RF + 1n);
});

const A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", Z = "0x0000000000000000000000000000000000000000";
const move = (from: string, to: string, block: bigint, logIndex: number) =>
  ({ from: from as `0x${string}`, to: to as `0x${string}`, tokenId: 1n, block, logIndex, tx: `0x${block}${logIndex}` as `0x${string}` });

test("history keeps every transfer inside one block, in log order", async () => {
  // Minted to A, then A -> B and B -> A in one later block (the audit's reproduction).
  const logs = [move(Z, A, 100n, 0), move(A, B, 200n, 3), move(B, A, 200n, 7)];
  const { transfers, truncated } = await walkTransfers(async holder => logs.filter(l => l.to === holder), A as `0x${string}`, 4);
  assert.deepEqual(transfers.map(t => [t.block, t.logIndex]), [[200n, 7], [200n, 3], [100n, 0]]);
  assert.equal(truncated, false);
  assert.deepEqual(toMilestones(transfers, []).map(m => m.kind), ["appeared", "new-owner", "new-owner"]);
});

test("history says when it stopped before the first owner", async () => {
  const logs = [move(Z, A, 1n, 0), move(A, B, 2n, 0), move(B, A, 3n, 0), move(A, B, 4n, 0), move(B, A, 5n, 0)];
  const { transfers, truncated } = await walkTransfers(async holder => logs.filter(l => l.to === holder), A as `0x${string}`, 4);
  assert.equal(transfers.length, 4);
  assert.equal(truncated, true);
});

test("First Forage: gather three, bring them home, then catch one fresh spark", () => {
  const j = { pouchTotal: 12, pouchGathered: 0, tripsHome: 0, sparksAfterHome: 0 };
  assert.equal(journeyStep(j), 1);
  assert.equal(journeyStep({ ...j, pouchGathered: 3 }), 2);
  assert.equal(journeyStep({ ...j, pouchGathered: 3, tripsHome: 1 }), 3);
  assert.equal(journeyStep({ ...j, pouchGathered: 3, tripsHome: 1, sparksAfterHome: 1 }), 4);
});

test("First Forage with a small or empty pouch never asks for more than exists", () => {
  assert.equal(journeyStep({ pouchTotal: 1, pouchGathered: 1, tripsHome: 0, sparksAfterHome: 0 }), 2);
  assert.equal(journeyStep({ pouchTotal: 0, pouchGathered: 0, tripsHome: 0, sparksAfterHome: 0 }), 3, "just claimed: straight to the spark");
});

test("every character family has its own reaction", () => {
  for (const family of ["Skeleton", "Mask", "Family", "Cellular", "Asymmetry", "Hoverer", "Colossus", "Sparkling", "Hollow"])
    assert.notEqual(reactionFor(family), reactionFor(""));
});
