export const RF = 10n ** 18n;
export const POUCH_PICKUP_UNIT = RF / 2n;
export const MAX_POUCH_PICKUPS = 12;
export const MAX_SPARKS_ON_GROUND = 6;
export const BASE_REACH = 20;
/** Extra pull per kept treat, in treat order (Crumb, Berry, Honeycomb, Stardrop). Redeeming a treat gives its pull up. */
export const TREAT_PULL = [6, 12, 20, 40] as const;
export const MAX_PULL = 60;

export type Address = `0x${string}`;
export type Hash = `0x${string}`;
export type WorldPoint = readonly [number, number];

export type FriendTraits = Readonly<{ character: string; scenery: string; floor: string; state: string }>;

export type FriendState = Readonly<{
  friendId: bigint;
  block: bigint;
  readAt: number;
  owner: Address;
  wallet: Address;
  generation: number;
  tier: number;
  weight: bigint;
  totalWeight: bigint;
  earnedRf: bigint;
  earnedWeth: bigint;
}>;

export type Vitals = Readonly<{ awake: boolean; level: number; shareBps: number; pouchRf: bigint; pouchWeth: bigint }>;

export type TransferLog = Readonly<{ from: Address; to: Address; tokenId: bigint; block: bigint; logIndex: number; tx: Hash }>;
export type ActivationLog = Readonly<{ tokenId: bigint; tier: number; weight: bigint; paid: bigint; block: bigint; logIndex: number; tx: Hash }>;
export type Milestone = Readonly<{ kind: "appeared" | "activated" | "reactivated" | "upgraded" | "new-owner"; block: bigint; logIndex: number; tx: Hash; title: string; detail: string }>;

const ZERO: Address = "0x0000000000000000000000000000000000000000";

const SCENERY_PRESETS = [
  ["garden", "01-garden-oval-complete"],
  ["circuit", "02-circuit-courtyard-complete"],
  ["crystal", "03-crystal-mesa-complete"],
  ["rooftop", "04-rooftop-terrace-complete"],
  ["tidal", "05-tidal-islands-complete"],
  ["orbital", "06-orbital-hex-complete"],
] as const;
export const DEFAULT_PRESET = SCENERY_PRESETS[0][1];

/** Reactivation price in RF per generation (docs: 10% of hardwire), index = generation − 1. */
const REACTIVATION_RF = ["10000", "1000", "100", "10", "1", "0.1"] as const;

export function sceneryPreset(scenery: string): Readonly<{ id: string; matched: boolean }> {
  const key = scenery.trim().toLowerCase();
  const found = SCENERY_PRESETS.find(([name]) => key.includes(name));
  return found ? { id: found[1], matched: true } : { id: DEFAULT_PRESET, matched: false };
}

export function reactivationCost(generation: number): string | null {
  return REACTIVATION_RF[generation - 1] ?? null;
}

export function deriveVitals(state: FriendState): Vitals {
  const shareBps = state.totalWeight > 0n ? Number((state.weight * 10n ** 12n) / state.totalWeight) / 1e8 : 0;
  return { awake: state.weight > 0n, level: state.tier, shareBps, pouchRf: state.earnedRf, pouchWeth: state.earnedWeth };
}

/** RF base units per second between two reads. A claim lowers `earned`, which yields 0 rather than a negative rate. */
export function accrualRate(previous: FriendState, next: FriendState): bigint {
  const seconds = BigInt(Math.round((next.readAt - previous.readAt) / 1000));
  if (seconds <= 0n || next.earnedRf <= previous.earnedRf) return 0n;
  return (next.earnedRf - previous.earnedRf) / seconds;
}

export function projectEarned(latest: FriendState, ratePerSecond: bigint, now: number): bigint {
  const elapsed = BigInt(Math.max(0, Math.floor((now - latest.readAt) / 1000)));
  return latest.earnedRf + ratePerSecond * elapsed;
}

export type Reconciled = Readonly<{ kind: "claimed" } | { kind: "layout"; value: bigint } | { kind: "spark"; value: bigint } | { kind: "none" }>;

/**
 * One rule keeps the game honest: `represented` (ground + carried + brought home since the last claim) may never
 * exceed the Friend's real unclaimed rewards. Less than represented means a claim; more means new ground, laid out
 * in full the first time the Friend is active, then as one spark per real increase.
 */
export function reconcile(earned: bigint, represented: bigint, laidOut: boolean, active: boolean, sparksOnGround: number): Reconciled {
  if (earned < represented) return { kind: "claimed" };
  if (!active || earned === represented) return { kind: "none" };
  if (!laidOut) return { kind: "layout", value: earned - represented };
  if (sparksOnGround >= MAX_SPARKS_ON_GROUND) return { kind: "none" };
  return { kind: "spark", value: earned - represented };
}

/** Pull radius from kept treats: more held, farther the Friend draws pickups in. */
export function pullRadius(inventory: readonly bigint[]): number {
  const extra = inventory.reduce((sum, count, i) => sum + Number(count) * (TREAT_PULL[i] ?? 0), 0);
  return BASE_REACH + Math.min(MAX_PULL, extra);
}

/** Moves a pickup toward the Friend; it is collected once inside base reach. */
export function pullStep(at: WorldPoint, friend: WorldPoint, radius: number, speed: number): WorldPoint | "collected" | null {
  const dx = friend[0] - at[0], dy = friend[1] - at[1], distance = Math.hypot(dx, dy);
  if (distance <= BASE_REACH) return "collected";
  if (distance > radius) return null;
  const step = Math.min(speed, distance);
  return [at[0] + (dx / distance) * step, at[1] + (dy / distance) * step];
}

export type Journey = Readonly<{ pouchTotal: number; pouchGathered: number; tripsHome: number; sparksAfterHome: number }>;
export const FIRST_FORAGE_GATHER = 3;

/**
 * First Forage: gather some of what the Friend earned, bring it home, then catch one fresh spark of new earnings.
 * A Friend with nothing waiting (just claimed) starts at the spark step. Returns the current step, 4 when done.
 */
export function journeyStep(j: Journey): 1 | 2 | 3 | 4 {
  const need = Math.min(FIRST_FORAGE_GATHER, j.pouchTotal);
  if (j.pouchGathered < need) return 1;
  if (need > 0 && j.tripsHome < 1) return 2;
  return j.sparksAfterHome < 1 ? 3 : 4;
}

const REACTIONS: Record<string, string> = {
  Skeleton: "Its bones rattle happily. Every crumb is counted.",
  Mask: "The Mask gives nothing away, but it is clearly pleased.",
  Family: "The whole family cheers the haul.",
  Cellular: "It splits into a grin.",
  Asymmetry: "A lopsided victory dance.",
  Hoverer: "It floats a little higher than before.",
  Colossus: "The ground shakes, gently.",
  Sparkling: "It sparkles brighter than the sparks.",
  Hollow: "The hollow fills with a quiet glow.",
};

/** A one-line reaction in the voice of the Friend's character family. */
export function reactionFor(character: string): string {
  return REACTIONS[character] ?? "It looks proud of what it earned.";
}

/** Splits a value into parts that add back up exactly; the last part takes the remainder. */
export function splitValue(value: bigint, parts: number): bigint[] {
  const each = value / BigInt(parts);
  return Array.from({ length: parts }, (_, i) => i === parts - 1 ? value - each * BigInt(parts - 1) : each);
}

export function pouchPickups(earned: bigint): Readonly<{ count: number; each: bigint }> {
  if (earned <= 0n) return { count: 0, each: 0n };
  const count = Math.min(MAX_POUCH_PICKUPS, Number((earned + POUCH_PICKUP_UNIT - 1n) / POUCH_PICKUP_UNIT));
  return { count, each: earned / BigInt(count) };
}

function mulberry32(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Deterministic, spread-out spots: the same Friend and seed always get the same layout. */
export function pickSpots(candidates: readonly WorldPoint[], count: number, seed: number, avoid: readonly WorldPoint[] = [], spacing = 36): WorldPoint[] {
  const random = mulberry32(seed);
  const pool = [...candidates];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  const chosen: WorldPoint[] = [];
  const clear = (point: WorldPoint, minimum: number) =>
    [...chosen, ...avoid].every(other => Math.hypot(point[0] - other[0], point[1] - other[1]) >= minimum);
  for (const minimum of [spacing, spacing / 2, 0]) {
    for (const point of pool) {
      if (chosen.length >= count) return chosen;
      if (!chosen.includes(point) && clear(point, minimum)) chosen.push(point);
    }
  }
  return chosen;
}

export function formatRf(value: bigint, digits = 4): string {
  const negative = value < 0n, absolute = negative ? -value : value;
  const whole = absolute / RF, fraction = (absolute % RF).toString().padStart(18, "0").slice(0, digits).replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole.toLocaleString("en-US")}${fraction ? `.${fraction}` : ""}`;
}

/** Chain order: block, then position within the block. */
export const chainOrder = (a: { block: bigint; logIndex: number }, b: { block: bigint; logIndex: number }) =>
  a.block !== b.block ? (a.block < b.block ? -1 : 1) : a.logIndex - b.logIndex;

/**
 * Walks ownership backwards from the current owner: each step takes the latest transfer *to* the holder that is
 * strictly earlier in chain order than the previous step, so transfers inside one block are kept.
 */
export async function walkTransfers(incomingTo: (holder: Address) => Promise<TransferLog[]>, owner: Address, maxHops: number) {
  const transfers: TransferLog[] = [];
  let holder: Address | null = owner, cursor: TransferLog | null = null;
  for (let hop = 0; holder && hop < maxHops; hop++) {
    const earlier = (await incomingTo(holder)).filter(log => !cursor || chainOrder(log, cursor) < 0).sort(chainOrder);
    const latest = earlier.at(-1);
    if (!latest) return { transfers, truncated: false };
    transfers.push(latest);
    cursor = latest;
    holder = /^0x0+$/.test(latest.from) ? null : latest.from;
  }
  return { transfers, truncated: holder !== null };
}

/** Chronological milestones from a Friend's own Transfer and Activated events. */
export function toMilestones(transfers: readonly TransferLog[], activations: readonly ActivationLog[]): Milestone[] {
  const events: Milestone[] = [];
  for (const log of transfers) {
    events.push(log.from.toLowerCase() === ZERO
      ? { kind: "appeared", block: log.block, logIndex: log.logIndex, tx: log.tx, title: "Appeared", detail: "A temporary Friend appeared in its first owner's wallet." }
      : { kind: "new-owner", block: log.block, logIndex: log.logIndex, tx: log.tx, title: "New home", detail: `Moved to ${short(log.to)}. A transfer clears activation.` });
  }
  const ordered = [...activations].sort(chainOrder);
  ordered.forEach((log, index) => {
    // Only the first activation is the hardwiring; a later tier-0 activation is a reactivation after a transfer.
    const kind = index === 0 ? "activated" : log.tier === 0 ? "reactivated" : "upgraded";
    events.push({
      kind, block: log.block, logIndex: log.logIndex, tx: log.tx,
      title: { activated: "Hardwired and earning", reactivated: "Reactivated and earning", upgraded: `Upgraded to tier ${log.tier}` }[kind],
      detail: `Weight ${formatRf(log.weight, 2)} · paid ${formatRf(log.paid, 2)} RF (50% burned, 50% to rewards).`,
    });
  });
  return events.sort(chainOrder);
}


export function short(address: string) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}
