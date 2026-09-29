import assert from "node:assert/strict";
import { test } from "node:test";
import { createWorldNavigator } from "@rarefriends/friendsdk/navigation";
import { buildWorld } from "./world.ts";
import { MAX_POUCH_PICKUPS, MAX_SPARKS_ON_GROUND } from "./vitals.ts";

const SCENERIES = ["Garden", "Circuit", "Crystal", "Rooftop", "Tidal", "Orbital", ""];

for (const scenery of SCENERIES) {
  test(`${scenery || "unknown scenery"} world builds fast with reachable room to forage`, () => {
    const started = performance.now();
    const scene = buildWorld(scenery);
    const elapsed = performance.now() - started;
    assert.ok(elapsed < 1500, `built in ${elapsed.toFixed(0)} ms`);
    assert.equal(scene.matched, scenery !== "");
    assert.equal(new Set(scene.stations.map(String)).size, 3);
    assert.ok(scene.open.length >= MAX_POUCH_PICKUPS + MAX_SPARKS_ON_GROUND, `${scene.open.length} open spots`);

    const navigator = createWorldNavigator(scene.world);
    const sample = scene.open.filter((_, i) => i % Math.ceil(scene.open.length / 12) === 0);
    for (const point of sample) assert.ok((navigator.route(scene.spawn, point)?.length ?? 0) > 0, `unreachable ${point}`);
    for (const station of scene.stations) assert.ok(!scene.open.some(p => p[0] === station[0] && p[1] === station[1]), "station spot is not a pickup spot");
  });
}
