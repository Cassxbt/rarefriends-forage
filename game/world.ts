import type { GameWorldInteraction } from "@rarefriends/friendsdk/world-view";
import { getWorldPreset, isWorldWalkable, project, validateWorld } from "@rarefriends/friendsdk/world";
import { createWorldNavigator } from "@rarefriends/friendsdk/navigation";
import { pickSpots, sceneryPreset, type WorldPoint } from "./vitals.ts";

const GRID = 12;
const CLEARANCE = 10;
/** The SDK renderer draws the 960 × 640 view starting at this offset in projected space. */
const VIEW_OFFSET = [320, 330] as const;
/** Pickups must be visible: inside the view, below the HUD cards and above the SDK toolbar. */
const VISIBLE = { left: 40, right: 920, top: 130, bottom: 560 } as const;

type World = ReturnType<typeof validateWorld>;

/** One pass over the grid instead of a route per point; islands the Friend can't reach are excluded. */
export function floodFill(world: World, walkable: readonly WorldPoint[], start: WorldPoint): WorldPoint[] {
  const navigator = createWorldNavigator(world);
  const key = (p: WorldPoint) => `${p[0]},${p[1]}`;
  const byKey = new Map(walkable.map(p => [key(p), p] as const));
  const seen = new Set([key(start)]), queue: WorldPoint[] = [start], out: WorldPoint[] = [];
  for (let head = 0; head < queue.length; head++) {
    const point = queue[head];
    out.push(point);
    for (const [dx, dy] of [[GRID, 0], [-GRID, 0], [0, GRID], [0, -GRID]] as const) {
      const next = byKey.get(key([point[0] + dx, point[1] + dy]));
      if (next && !seen.has(key(next)) && navigator.segmentClear(point, next)) { seen.add(key(next)); queue.push(next); }
    }
  }
  return out;
}

/** This Friend's own world: its on-chain scenery, three stations near the spawn, and every reachable open spot. */
export function buildWorld(scenery: string) {
  const { id, matched } = sceneryPreset(scenery);
  const base = getWorldPreset(id);
  const bare = validateWorld({ ...base, actors: [] });
  const walkable: WorldPoint[] = [];
  for (let x = GRID; x < 576; x += GRID) for (let y = GRID; y < 384; y += GRID) if (isWorldWalkable(bare, [x, y], CLEARANCE)) walkable.push([x, y]);
  const cx = walkable.reduce((sum, p) => sum + p[0], 0) / walkable.length, cy = walkable.reduce((sum, p) => sum + p[1], 0) / walkable.length;
  const spawn = [...walkable].sort((a, b) => Math.hypot(a[0] - cx, a[1] - cy) - Math.hypot(b[0] - cx, b[1] - cy))[0];
  const reachable = floodFill(bare, walkable, spawn);
  const [den, treats, proof] = pickSpots(reachable.filter(p => Math.hypot(p[0] - spawn[0], p[1] - spawn[1]) < 140), 3, 7, [spawn], 70);
  const world = validateWorld({ ...bare, props: [...bare.props,
    { type: "bench", x: den[0], y: den[1] - 18, scale: 1.2 },
    { type: "crate", x: treats[0], y: treats[1] - 18, scale: 1.3 },
    { type: "terminal", x: proof[0], y: proof[1] - 18, scale: 1.3 }] });
  const open = reachable.filter(point => isWorldWalkable(world, point, CLEARANCE) && isVisible(point));
  const interactions: GameWorldInteraction[] = [
    { id: "den", label: "Den", position: den, reach: 80, labelOffset: -150 },
    { id: "treats", label: "Treat stand", position: treats, reach: 80, labelOffset: -150 },
    { id: "proof", label: "Proof board", position: proof, reach: 80, labelOffset: -150 },
  ];
  return { world, spawn, open, stations: [den, treats, proof] as WorldPoint[], interactions, name: String(base.name), matched };
}

export function viewPosition(point: WorldPoint): [number, number] {
  const [x, y] = project(point[0], point[1]);
  return [x - VIEW_OFFSET[0], y - VIEW_OFFSET[1]];
}

export function isVisible(point: WorldPoint) {
  const [x, y] = viewPosition(point);
  return x >= VISIBLE.left && x <= VISIBLE.right && y >= VISIBLE.top && y <= VISIBLE.bottom;
}

/** Position of a world point as a percentage of the 960 × 640 world surface. */
export function screen(point: WorldPoint) {
  const [x, y] = viewPosition(point);
  return { left: `${(x / 960) * 100}%`, top: `${(y / 640) * 100}%` };
}
