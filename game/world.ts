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
  const { stations: [den, treats, proof], offsets } = placeStations(reachable.filter(p => isVisible(p) && isWorldWalkable(bare, [p[0], p[1] - PROP_BACK], 0)), spawn);
  const world = validateWorld({ ...bare, props: [...bare.props,
    { type: "bench", x: den[0], y: den[1] - PROP_BACK, scale: 1.2 },
    { type: "crate", x: treats[0], y: treats[1] - PROP_BACK, scale: 1.3 },
    { type: "terminal", x: proof[0], y: proof[1] - PROP_BACK, scale: 1.3 }] });
  const labels = [den, treats, proof].map((station, i) => labelAt(station, offsets[i]));
  const open = reachable.filter(point => isWorldWalkable(world, point, CLEARANCE) && isVisible(point) && !labels.some(label => underLabel(point, label)));
  const interactions: GameWorldInteraction[] = [
    { id: "den", label: "Den", position: den, reach: 80, labelOffset: offsets[0] },
    { id: "treats", label: "Treat stand", position: treats, reach: 80, labelOffset: offsets[1] },
    { id: "proof", label: "Proof board", position: proof, reach: 80, labelOffset: offsets[2] },
  ];
  return { world, spawn, open, stations: [den, treats, proof] as WorldPoint[], interactions, name: String(base.name), matched };
}

/** Label clearance: overlap if closer than a label's width horizontally and its height vertically. */
const LABEL = { width: 170, height: 60 } as const;
const LABEL_OFFSETS = [-150, -90, -210] as const;
/** Label centers must sit below the HUD cards. */
const LABEL_MIN_Y = 140;
/** Station props must not stand on top of each other. */
const STATION_GAP = 48;

/** Screen position of a station label: centered on the station, lifted by its offset. */
export const labelAt = (station: WorldPoint, offset: number): [number, number] => { const [x, y] = viewPosition(station); return [x, y + offset]; };
/** A pickup drawn at this spot would sit on a station label (with a little room around it). */
export const underLabel = (point: WorldPoint, label: [number, number]) => {
  const [x, y] = viewPosition(point);
  return Math.abs(x - label[0]) < LABEL.width / 2 + 16 && Math.abs(y - 22 - label[1]) < LABEL.height / 2 + 16;
};
const labelsClear = (a: [number, number], b: [number, number]) => Math.abs(a[0] - b[0]) >= LABEL.width || Math.abs(a[1] - b[1]) >= LABEL.height;

/**
 * Stations and their label heights are chosen together, nearest home first. Each must draw behind the Friend's spawn,
 * keep its label below the HUD, off the Friend's sprite and clear of the other labels.
 */
export function placeStations(candidates: readonly WorldPoint[], spawn: WorldPoint) {
  const near = (p: WorldPoint) => Math.hypot(p[0] - spawn[0], p[1] - spawn[1]);
  const [sx, sy] = viewPosition(spawn);
  const labels: [number, number][] = [[sx, sy - 37]], stations: WorldPoint[] = [], offsets: number[] = [];
  const byNear = (a: WorldPoint, b: WorldPoint) => near(a) - near(b);
  // The last pool drops the draw-behind rule, only for worlds too small to fit three stations behind the spawn.
  const pools = [candidates.filter(p => near(p) > 60 && p[0] + p[1] - PROP_BACK < spawn[0] + spawn[1]).sort(byNear),
    candidates.filter(p => near(p) > 40).sort(byNear)];
  const strict = (p: WorldPoint, o: number) => labelAt(p, o)[1] >= LABEL_MIN_Y && labels.every(l => labelsClear(labelAt(p, o), l));
  const loose = (p: WorldPoint, o: number) => labels.every(l => labelsClear(labelAt(p, o), l));
  for (const pool of pools) for (const fits of [strict, loose, () => true]) {
    while (stations.length < 3) {
      const spot = pool.find(p => !stations.includes(p) && stations.every(s => Math.hypot(p[0] - s[0], p[1] - s[1]) >= STATION_GAP) && LABEL_OFFSETS.some(o => fits(p, o)));
      if (!spot) break;
      const offset = LABEL_OFFSETS.find(o => fits(spot, o))!;
      stations.push(spot); offsets.push(offset); labels.push(labelAt(spot, offset));
    }
  }
  return { stations: stations as [WorldPoint, WorldPoint, WorldPoint], offsets };
}

export function viewPosition(point: WorldPoint): [number, number] {
  const [x, y] = project(point[0], point[1]);
  return [x - VIEW_OFFSET[0], y - VIEW_OFFSET[1]];
}

export function isVisible(point: WorldPoint) {
  const [x, y] = viewPosition(point);
  return x >= VISIBLE.left && x <= VISIBLE.right && y >= VISIBLE.top && y <= VISIBLE.bottom;
}

/** Position of a world point as a percentage of the 960 × 640 world surface, optionally nudged in view pixels. */
export function screen(point: WorldPoint, dx = 0, dy = 0) {
  const [x, y] = viewPosition(point);
  return { left: `${((x + dx) / 960) * 100}%`, top: `${((y + dy) / 640) * 100}%` };
}
