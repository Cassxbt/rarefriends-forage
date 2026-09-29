import type { GameWorldInteraction } from "@rarefriends/friendsdk/world-view";
import { getWorldPreset, isWorldWalkable, project, validateWorld } from "@rarefriends/friendsdk/world";
import { createWorldNavigator } from "@rarefriends/friendsdk/navigation";
import { sceneryPreset, type WorldPoint } from "./vitals.ts";

const GRID = 12;
const CLEARANCE = 10;
/** Station props stand this far behind their interaction spot. */
const PROP_BACK = 18;
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
  const [den, treats, proof] = placeStations(reachable.filter(p => isVisible(p) && isWorldWalkable(bare, [p[0], p[1] - PROP_BACK], 0)), spawn);
  const world = validateWorld({ ...bare, props: [...bare.props,
    { type: "bench", x: den[0], y: den[1] - PROP_BACK, scale: 1.2 },
    { type: "crate", x: treats[0], y: treats[1] - PROP_BACK, scale: 1.3 },
    { type: "terminal", x: proof[0], y: proof[1] - PROP_BACK, scale: 1.3 }] });
  const open = reachable.filter(point => isWorldWalkable(world, point, CLEARANCE) && isVisible(point));
  const offsets = labelOffsets([den, treats, proof]);
  const interactions: GameWorldInteraction[] = [
    { id: "den", label: "Den", position: den, reach: 80, labelOffset: offsets[0] },
    { id: "treats", label: "Treat stand", position: treats, reach: 80, labelOffset: offsets[1] },
    { id: "proof", label: "Proof board", position: proof, reach: 80, labelOffset: offsets[2] },
  ];
  return { world, spawn, open, stations: [den, treats, proof] as WorldPoint[], interactions, name: String(base.name), matched };
}

/** Label clearance: overlap if closer than a label's width horizontally and its height vertically. */
const LABEL = { width: 170, height: 60 } as const;
const labelGap = (a: WorldPoint, b: WorldPoint) => {
  const [ax, ay] = viewPosition(a), [bx, by] = viewPosition(b);
  return Math.max(Math.abs(ax - bx) / LABEL.width, Math.abs(ay - by) / LABEL.height);
};

/** Den nearest the spawn, then each station where its label sits furthest from the others, preferring spots near home. */
export function placeStations(candidates: readonly WorldPoint[], spawn: WorldPoint): [WorldPoint, WorldPoint, WorldPoint] {
  const near = (p: WorldPoint) => Math.hypot(p[0] - spawn[0], p[1] - spawn[1]);
  const pool = candidates.filter(p => near(p) > 60);
  const chosen = [pool.reduce((best, p) => near(p) < near(best) ? p : best)];
  while (chosen.length < 3) {
    const score = (p: WorldPoint) => Math.min(Math.min(...chosen.map(c => labelGap(p, c))), 1.5) - near(p) / 1000;
    chosen.push(pool.filter(p => !chosen.includes(p)).reduce((best, p) => score(p) > score(best) ? p : best));
  }
  return chosen as [WorldPoint, WorldPoint, WorldPoint];
}

const LABEL_OFFSETS = [-150, -90, -210] as const;
/** Screen box of a station label: centered on the station, lifted by its offset. */
export const labelAt = (station: WorldPoint, offset: number): [number, number] => { const [x, y] = viewPosition(station); return [x, y + offset]; };
const labelsClear = (a: [number, number], b: [number, number]) => Math.abs(a[0] - b[0]) >= LABEL.width || Math.abs(a[1] - b[1]) >= LABEL.height;

/** Where stations crowd together (small island worlds), later labels move to a free height. */
export function labelOffsets(stations: readonly WorldPoint[]): number[] {
  const placed: [number, number][] = [];
  return stations.map(station => {
    const offset = LABEL_OFFSETS.find(o => placed.every(p => labelsClear(labelAt(station, o), p))) ?? LABEL_OFFSETS[0];
    placed.push(labelAt(station, offset));
    return offset;
  });
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
