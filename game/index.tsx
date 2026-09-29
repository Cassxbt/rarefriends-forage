"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { GameComponentProps } from "@rarefriends/friendsdk/runtime";
import { GameWorld } from "@rarefriends/friendsdk/world-view";
import { GameMenu } from "@rarefriends/friendsdk/frame";
import { maximumPrize, type GamePlay, type GameSnapshot } from "@rarefriends/friendsdk/game";
import { createFriendSoundKit, type FriendSoundCue, type FriendSoundKit } from "@rarefriends/friendsdk/sounds";
import { CONTRACTS, EXPLORER, readFriendHistory, readFriendState, readFriendTraits, withTimeout } from "./friend-chain.ts";
import { buildWorld, screen } from "./world.ts";
import {
  accrualRate, deriveVitals, formatRf, pickSpots, pouchPickups, projectEarned, reactivationCost,
  short, sparkStep, toMilestones,
  type FriendState, type FriendTraits, type Milestone, type WorldPoint,
} from "./vitals.ts";
import "@rarefriends/friendsdk/frame.css";
import "@rarefriends/friendsdk/world-view.css";
import "./style.css";

const POLL_MS = 15_000;
const TRAITS_TIMEOUT_MS = 8_000;
const GATHER_RADIUS = 20;

type Menu = "den" | "treats" | "proof" | "reward" | "settings" | null;
type Pickup = { id: string; at: WorldPoint; value: bigint; kind: "pouch" | "spark"; taken: boolean };
type Trip = { number: number; carried: bigint; pickups: number };
type History = { milestones: Milestone[]; times: Map<bigint, number> };

const when = (time?: number) => time ? new Date(time).toISOString().replace("T", " ").slice(0, 16) + " UTC" : "";

export default function Forage({ friendId, client, paused }: GameComponentProps) {
  const [traits, setTraits] = useState<FriendTraits | null>(null);
  const [state, setState] = useState<FriendState | null>(null);
  const [rate, setRate] = useState(0n);
  const [now, setNow] = useState(Date.now());
  const [chainError, setChainError] = useState("");
  const [worldNote, setWorldNote] = useState("");
  const [atDen, setAtDen] = useState(false);
  const [history, setHistory] = useState<History | null>(null);
  const [historyError, setHistoryError] = useState("");
  const [snapshot, setSnapshot] = useState<GameSnapshot | null>(null);
  const [menu, setMenu] = useState<Menu>(null);
  const [pickups, setPickups] = useState<Pickup[]>([]);
  const [trips, setTrips] = useState<Trip[]>([]);
  const [sparkBase, setSparkBase] = useState<bigint | null>(null);
  const [result, setResult] = useState<GamePlay | null>(null);
  const [busy, setBusy] = useState(false), [message, setMessage] = useState(""), [error, setError] = useState("");
  const [muted, setMuted] = useState(true), [reducedMotion, setReducedMotion] = useState(false);
  const [retry, setRetry] = useState(0);
  const sound = useRef<FriendSoundKit | null>(null), locked = useRef(false), epoch = useRef(0), worldRef = useRef<HTMLDivElement>(null);
  const definition = client.definition;

  const scene = useMemo(() => traits ? buildWorld(traits.scenery) : null, [traits]);

  useEffect(() => {
    const version = ++epoch.current;
    sound.current = createFriendSoundKit({ muted: true });
    setTraits(null); setState(null); setHistory(null); setSnapshot(null); setMenu(null); setPickups([]); setTrips([]);
    setSparkBase(null); setChainError(""); setWorldNote(""); setHistoryError(""); setMuted(true); locked.current = false;
    const alive = () => version === epoch.current;
    client.read().then(value => alive() && setSnapshot(value)).catch(cause => alive() && setError(String(cause?.message ?? cause)));
    withTimeout(readFriendTraits(friendId), TRAITS_TIMEOUT_MS, "Reading this Friend's world").then(value => alive() && setTraits(value))
      .catch(cause => { if (!alive()) return; setTraits({ character: "", scenery: "", floor: "", state: "" }); setWorldNote(`Couldn't read this Friend's world (${cause instanceof Error ? cause.message.split("\n")[0] : "unknown error"}); showing the default world.`); });
    let previous: FriendState | null = null, polling = false;
    const poll = () => {
      if (polling) return;
      polling = true;
      readFriendState(friendId).then(next => {
        if (!alive() || (previous && next.block <= previous.block)) return;
        if (previous) setRate(accrualRate(previous, next));
        previous = next; setState(next); setChainError("");
      }).catch(cause => alive() && setChainError(cause instanceof Error ? cause.message.split("\n")[0] : "The chain could not be read."))
        .finally(() => { polling = false; });
    };
    void poll();
    const timer = setInterval(poll, POLL_MS), tick = setInterval(() => setNow(Date.now()), 1000);
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReducedMotion(preference.matches); update(); preference.addEventListener("change", update);
    return () => { epoch.current++; clearInterval(timer); clearInterval(tick); sound.current?.dispose(); sound.current = null; preference.removeEventListener("change", update); };
  }, [client, friendId, retry]);

  useEffect(() => {
    if (!state || history || historyError) return;
    const version = epoch.current;
    readFriendHistory(friendId, state.owner)
      .then(h => version === epoch.current && setHistory({ milestones: toMilestones(h.transfers, h.activations), times: h.times }))
      .catch(cause => version === epoch.current && setHistoryError(cause instanceof Error ? cause.message.split("\n")[0] : "History could not be read."));
  }, [state, history, historyError, friendId]);

  const vitals = state ? deriveVitals(state) : null;
  const fresh = Boolean(state) && !chainError && now - (state?.readAt ?? 0) <= POLL_MS * 2;
  const pouchNow = state ? (fresh ? projectEarned(state, rate, now) : state.earnedRf) : 0n;

  // The first run lays out the pouch that was already waiting; later runs only get what the chain adds.
  useEffect(() => {
    if (!scene || !state || sparkBase !== null) return;
    setSparkBase(state.earnedRf);
    if (!vitals?.awake) return;
    const { count, each } = pouchPickups(state.earnedRf);
    const spots = pickSpots(scene.open, count, Number(friendId % 2_147_483_647n), [...scene.stations, scene.spawn]);
    setPickups(spots.map((at, i) => ({ id: `pouch-${i}`, at, value: each, kind: "pouch", taken: false })));
  }, [scene, state, sparkBase, vitals?.awake, friendId]);

  // Only real new earnings grow the ground; a claim on rarefriends.com empties it.
  useEffect(() => {
    if (!scene || !state || sparkBase === null) return;
    const step = sparkStep(sparkBase, state.earnedRf, pickups.filter(p => p.kind === "spark" && !p.taken).length);
    if (step.kind === "claimed") {
      setSparkBase(state.earnedRf);
      setPickups(current => current.filter(p => p.taken));
      setMessage("Its rewards were claimed, so the ground is clear. New earnings will spark here.");
      return;
    }
    if (step.kind !== "spark" || !vitals?.awake) return;
    const [at] = pickSpots(scene.open, 1, Number(state.block % 2_147_483_647n), [...scene.stations, ...pickups.map(p => p.at)]);
    if (!at) return;
    setPickups(current => [...current, { id: `spark-${state.block}`, at, value: step.value, kind: "spark", taken: false }]);
    setSparkBase(state.earnedRf);
    sound.current?.play("action-ready");
  }, [scene, state, sparkBase, vitals?.awake, pickups]);

  useEffect(() => {
    if (!pickups.some(p => !p.taken)) return;
    let frame = 0;
    const scan = () => {
      const canvas = worldRef.current?.querySelector("canvas");
      const x = Number(canvas?.dataset.x), y = Number(canvas?.dataset.y);
      if (!paused && !menu && Number.isFinite(x) && Number.isFinite(y)) {
        const hit = pickups.find(p => !p.taken && Math.hypot(p.at[0] - x, p.at[1] - y) <= GATHER_RADIUS);
        if (hit) { setPickups(current => current.map(p => p.id === hit.id ? { ...p, taken: true } : p)); sound.current?.play(hit.kind === "spark" ? "reveal-rare" : "select"); return; }
      }
      frame = requestAnimationFrame(scan);
    };
    frame = requestAnimationFrame(scan);
    return () => cancelAnimationFrame(frame);
  }, [pickups, paused, menu]);

  // The SDK canvas only hears keys while focused; hand focus back whenever the world is in play.
  useEffect(() => {
    if (!scene || menu || paused) return;
    const frame = requestAnimationFrame(() => worldRef.current?.querySelector("canvas")?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, [scene, menu, paused]);

  const carrying = pickups.filter(p => p.taken);
  const carried = carrying.reduce((sum, p) => sum + p.value, 0n);
  const remaining = pickups.filter(p => !p.taken).length;

  const broughtHome = trips.reduce((sum, t) => sum + t.carried, 0n);

  function bringHome() {
    if (carrying.length === 0 || paused || !atDen) return;
    setTrips(current => [...current, { number: current.length + 1, carried, pickups: carrying.length }]);
    setPickups(current => current.filter(p => !p.taken));
    sound.current?.play("reward");
    setMessage(`Trip ${trips.length + 1} home: ${formatRf(carried)} RF of real claimable rewards, carried as a picture of what it earned.`);
  }

  async function act(work: () => Promise<void>, cue?: FriendSoundCue, after?: () => void) {
    if (locked.current || paused) return;
    const version = epoch.current; locked.current = true; setBusy(true); setError(""); setMessage(""); void sound.current?.unlock();
    try { await work(); const value = await client.read(); if (version === epoch.current) { setSnapshot(value); if (cue) sound.current?.play(cue); after?.(); } }
    catch (cause) { if (version === epoch.current) setError(cause instanceof Error ? cause.message : "The preview action failed."); }
    finally { if (version === epoch.current) { locked.current = false; setBusy(false); } }
  }
  const navigate = (next: Menu, fromWorld = false) => { if (!busy && !paused) { setMenu(next); setAtDen(fromWorld && next === "den"); setError(""); if (next !== "den") setMessage(""); } };

  if (!scene || !snapshot) return <div className="forage-loading" role={error ? "alert" : "status"}>{error || "Finding your Friend's world on Robinhood Chain…"}
    {error && <button type="button" onClick={() => { setError(""); setRetry(r => r + 1); }}>Retry</button>}</div>;
  if (snapshot.friendId !== friendId) return <p role="alert">This game session does not match the selected Friend.</p>;

  const maxPrize = maximumPrize(definition);
  const canBuy = snapshot.rfBalance >= definition.price && snapshot.freeStake >= maxPrize;
  const pending = snapshot.plays.find(play => play.outcomeId === null);
  const outcome = result?.outcomeId ? definition.outcomes[result.outcomeId - 1] : null;
  const openTreat = () => act(async () => {
    const version = epoch.current;
    const play = pending ?? (await client.play(1n))[0];
    const settled = await client.settle(play.id);
    if (version === epoch.current) { setResult(settled); setMenu("reward"); }
  }, "reveal-common");
  const status = chainError ? "Can't see your Friend's chain state right now" : !state ? "Reading the chain…" : vitals?.awake ? "Awake · earning" : "Resting · not earning";
  const feedback = <p role={error ? "alert" : "status"}>{error || message || (busy ? "Waiting for preview confirmation…" : "Treats are simulated RF. Chain readings are live and read-only.")}</p>;
  const reactivation = state ? reactivationCost(state.generation) : null;
  const nextCheck = state ? Math.max(0, Math.ceil((state.readAt + POLL_MS - now) / 1000)) : 0;

  return <section className="forage" aria-label="Forage" aria-busy={busy}>
    <div className="forage-world" ref={worldRef} inert={Boolean(menu) || paused || undefined}>
      <GameWorld world={scene.world} spawn={scene.spawn} interactions={scene.interactions} friendId={friendId}
        paused={Boolean(menu) || paused} reducedMotion={reducedMotion} onInteract={id => navigate(id as Menu, true)} />
      <div className="forage-pickups" aria-hidden="true"><div className="forage-surface">
        {pickups.filter(p => !p.taken).map(p => <span key={p.id} className={`forage-pickup forage-${p.kind}${reducedMotion ? "" : " forage-bob"}`} style={screen(p.at)} />)}
      </div></div>
      <div className="forage-hud">
        <div className="forage-card">
          <strong>Friend #{friendId.toString()} · {traits?.character || "Friend"}</strong>
          <span>{scene.name}{traits?.scenery ? ` · on-chain scenery: ${traits.scenery}` : ""}</span>
          <span className={chainError ? "forage-warn" : vitals?.awake ? "forage-live" : "forage-rest"}>{status}</span>
          {worldNote && <span className="forage-warn">{worldNote}</span>}
        </div>
        <div className="forage-card forage-pouch">
          <span>{fresh ? "Pouch (claimable, live)" : "Pouch (last successful read)"}</span>
          <strong>{state ? `${formatRf(pouchNow, 5)} RF` : "—"}</strong>
          <span>{state ? `+ ${formatRf(state.earnedWeth, 8)} WETH` : ""}</span>
        </div>
        <div className="forage-card">
          <span>Carrying {carrying.length} · {formatRf(carried)} RF</span>
          <span>{!state ? "Reading its pouch…" : remaining ? `${remaining} to gather` : vitals?.awake ? `Can't carry what it hasn't earned · next check ${nextCheck}s` : "Resting: nothing to gather"}</span>
          <span>Brought home: {trips.length} {trips.length === 1 ? "trip" : "trips"} · {formatRf(broughtHome)} RF</span>
        </div>
      </div>
      <div className="forage-actions">
        <button type="button" onClick={() => navigate("den")}>Den</button>
        <button type="button" onClick={() => navigate("proof")}>Proof</button>
        <button type="button" onClick={() => navigate("settings")}>Settings</button>
      </div>
      {!menu && message && <p className="forage-toast" role="status">{message}</p>}
      <p className="forage-hint">WASD / arrows or tap to walk · walk into glowing pickups · E at the Den, Treat stand or Proof board</p>
    </div>

    {menu && <GameMenu title={{ den: "Den", treats: "Treat stand", proof: "Proof board", reward: "Your treat", settings: "Settings" }[menu]} onClose={busy ? undefined : () => navigate(null)}>
      {menu === "den" ? <>
        {carrying.length > 0 && !atDen ? <p>Walk your Friend to the Den to bring {carrying.length} home.</p>
          : carrying.length > 0
          ? <button type="button" className="rf-frame-primary" disabled={paused} onClick={bringHome}>Bring {carrying.length} home · {formatRf(carried)} RF</button>
          : <p>{remaining ? "Go gather what your Friend earned, then bring it home." : "Nothing carried yet."}</p>}
        {state && !vitals?.awake && <p className="forage-rest">This Friend is resting: its activation is cleared, so it isn't earning and can't gather. Reactivating a generation {state.generation} Friend costs {reactivation ?? "?"} RF on rarefriends.com. It stays fully playable here.</p>}
        <h3>Memory wall</h3>
        <p className="forage-small">Read from this Friend's own on-chain events. It follows the NFT to every device and every owner.</p>
        {historyError ? <p role="alert">History unavailable: {historyError}</p> : !history ? <p>Reading history…</p> :
          <ol className="forage-wall">{history.milestones.map(m => <li key={`${m.tx}-${m.kind}`}>
            <strong>{m.title}</strong><span>{when(history.times.get(m.block))} · block {m.block.toLocaleString("en-US")}</span>
            <span>{m.detail}</span><code className="forage-hash">{EXPLORER.replace("https://", "")}/tx/{m.tx}</code></li>)}
            {trips.map(t => <li key={`trip-${t.number}`} className="forage-trip"><strong>Trip {t.number} home</strong>
              <span>{t.pickups} pickups · {formatRf(t.carried)} RF carried</span><span>This session only. Care isn't saved on-chain.</span></li>)}
          </ol>}
      </> : menu === "treats" ? <>
        <p>One treat costs {formatGameRf(definition.price)} and cracks into one snack for your Friend.</p>
        <table><thead><tr><th>Treat</th><th>Chance</th><th>Value</th></tr></thead><tbody>{definition.outcomes.map(item =>
          <tr key={item.name}><td>{item.name}</td><td>{item.chanceBps / 100}%</td><td>{formatGameRf(item.reward)}</td></tr>)}</tbody></table>
        <p>Preview wallet: {formatGameRf(snapshot.rfBalance)} · {snapshot.consumables.toString()} treats · expected value 0.875 RF per treat.</p>
        <button type="button" className="rf-frame-primary" disabled={!canBuy || busy || paused} onClick={() => void act(() => client.buy(1n), "purchase", () => setMessage("One simulated treat bought."))}>Buy one treat · {formatGameRf(definition.price)}</button>
        <button type="button" disabled={busy || paused || !pending && snapshot.consumables === 0n} onClick={() => void openTreat()}>{pending ? "Finish pending treat" : "Crack a treat"}</button>
        {definition.outcomes.map((item, index) => snapshot.inventory[index] > 0n && <div className="forage-item" key={item.name}>
          <span>{item.name} × {snapshot.inventory[index].toString()}</span>
          <button type="button" disabled={busy || paused} onClick={() => void act(() => client.redeem(index + 1, 1n), "reward")}>Redeem one · {formatGameRf(item.reward)}</button></div>)}
        <p className="forage-small">Every treat reserves {formatGameRf(maxPrize)} of backing. Kept snacks have no expiry.</p>
      </> : menu === "reward" && outcome ? <div className="forage-reward">
        <h3>{outcome.name}</h3><p>{formatGameRf(outcome.reward)} · {outcome.chanceBps / 100}% chance</p>
        <button type="button" disabled={busy || paused} onClick={() => navigate(null)}>Keep it</button>
        <button type="button" disabled={busy || paused} onClick={() => void act(() => client.redeem(result!.outcomeId!, 1n), "reward", () => setMenu("treats"))}>Redeem · {formatGameRf(outcome.reward)}</button>
      </div> : menu === "proof" ? <>
        <p className="forage-small">Each value below is one read-only call to Robinhood Chain (4663) at the block shown. Nothing is signed or stored. The HUD pouch counts up between reads at the measured rate and freezes if a read fails.</p>
        {chainError && <p role="alert">Last read failed: {chainError}. <button type="button" onClick={() => setRetry(r => r + 1)}>Retry</button></p>}
        {state && <dl className="forage-proof">
          <dt>Block</dt><dd>{state.block.toLocaleString("en-US")}</dd>
          <dt>Owner</dt><dd>{short(state.owner)} · Generations.ownerOf</dd>
          <dt>Friend wallet</dt><dd>{short(state.wallet)} · Generations.tokenBoundAccount</dd>
          <dt>Generation</dt><dd>{state.generation} · Generations.generation</dd>
          <dt>Tier · weight</dt><dd>{state.tier} · {formatRf(state.weight, 2)} · ActivationManager.positions</dd>
          <dt>Reward share</dt><dd>{vitals?.shareBps.toFixed(4)} bps of {formatRf(state.totalWeight, 0)} · totalWeight</dd>
          <dt>Pouch</dt><dd>{formatRf(state.earnedRf, 6)} RF · {formatRf(state.earnedWeth, 8)} WETH · ActivationManager.earned</dd>
          <dt>World</dt><dd>{traits?.scenery || "unknown"}{scene.matched ? "" : " (fallback world)"} · Generations.tokenURI</dd>
        </dl>}
        <p className="forage-small">Contracts: Generations {short(CONTRACTS.generations)} · ActivationManager {short(CONTRACTS.activationManager)} · RF {short(CONTRACTS.rf)}. Verify on {EXPLORER.replace("https://", "")}.</p>
      </> : menu === "settings" ? <>
        <button type="button" aria-pressed={!muted} onClick={() => { const next = !muted; setMuted(next); sound.current?.setMuted(next); if (!next) void sound.current?.unlock(); }}>{muted ? "Sound off" : "Sound on"}</button>
        <label><input type="checkbox" checked={reducedMotion} onChange={event => setReducedMotion(event.target.checked)} /> Reduce motion</label>
        <p>Pickups are a picture of real claimable rewards; gathering them moves nothing. Treats are simulated. Reloading resets trips and treats; the memory wall and live readings come back from the chain.</p>
      </> : null}{feedback}
    </GameMenu>}
  </section>;
}

function formatGameRf(value: bigint) {
  return `${formatRf(value, 4)} RF`;
}
