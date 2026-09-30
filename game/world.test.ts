import assert from "node:assert/strict";
import { test } from "node:test";
import { createWorldNavigator } from "@rarefriends/friendsdk/navigation";
import { buildWorld, isVisible, labelAt, underLabel } from "./world.ts";
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
    const labels = scene.interactions.map(i => labelAt(i.position, i.labelOffset ?? -150));
    for (const [, ly] of labels) assert.ok(ly >= 140, "labels sit below the HUD");
    const [fx, fy] = labelAt(scene.spawn, -37);
    for (const [lx, ly] of labels) assert.ok(Math.abs(lx - fx) >= 170 || Math.abs(ly - fy) >= 60, "no label covers the Friend at spawn");
    for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++)
      assert.ok(Math.abs(labels[i][0] - labels[j][0]) >= 170 || Math.abs(labels[i][1] - labels[j][1]) >= 60, "station labels don't overlap");
    assert.ok(scene.open.length >= MAX_POUCH_PICKUPS + MAX_SPARKS_ON_GROUND, `${scene.open.length} open spots`);

    const navigator = createWorldNavigator(scene.world);
    const sample = scene.open.filter((_, i) => i % Math.ceil(scene.open.length / 12) === 0);
    for (const point of sample) assert.ok((navigator.route(scene.spawn, point)?.length ?? 0) > 0, `unreachable ${point}`);
    assert.ok(scene.open.every(isVisible), "every pickup spot is on screen");
    assert.ok(scene.open.every(p => labels.every(l => !underLabel(p, l))), "no pickup sits on a station label");
    if (scenery !== "Orbital") for (const station of scene.stations) assert.ok(station[0] + station[1] - 18 < scene.spawn[0] + scene.spawn[1], "station props draw behind the Friend's spawn");
    for (const station of scene.stations) assert.ok(!scene.open.some(p => p[0] === station[0] && p[1] === station[1]), "station spot is not a pickup spot");
  });
}
