"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { GameComponentProps } from "@rarefriends/friendsdk/runtime";
import { GameWorld } from "@rarefriends/friendsdk/world-view";
import { GameMenu } from "@rarefriends/friendsdk/frame";
import { maximumPrize, type GamePlay, type GameSnapshot } from "@rarefriends/friendsdk/game";
import { createFriendSoundKit, type FriendSoundCue, type FriendSoundKit } from "@rarefriends/friendsdk/sounds";
import { CONTRACTS, EXPLORER, readFriendHistory, readFriendState, readFriendTraits, withTimeout } from "./friend-chain.ts";
import { buildWorld, screen, viewPosition } from "./world.ts";
import {
  accrualRate, deriveVitals, splitValue, pullRadius, pullStep, TREAT_PULL, BASE_REACH, formatRf, pickSpots, pouchPickups, projectEarned, reactivationCost,
  short, reconcile, toMilestones, advanceJourney, gatherTarget, reactionFor, homecomingLine, JOURNEY_START, type Journey,
  type FriendState, type FriendTraits, type Milestone, type WorldPoint,
} from "./vitals.ts";
import "@rarefriends/friendsdk/frame.css";
import "@rarefriends/friendsdk/world-view.css";
import "./style.css";

const POLL_MS = 15_000;
const TRAITS_TIMEOUT_MS = 8_000;
const PULL_SPEED = 180;
/** After this many sparks, real earnings are held back briefly and arrive as one golden spark. */
const GOLDEN_EVERY = 4;
const GOLDEN_HOLD_MS = 40_000;
const GOLDEN_MS = 12_000;
/** The first golden spark comes early, so a short first session sees one. */
const FIRST_GOLDEN_AFTER = 1;
const FIRST_GOLDEN_HOLD_MS = 20_000;
const TRAIL_MAX = 8;
/** Carried pickups stack above the Friend's head, in view pixels. */
const CARRY_LIFT = -58, CARRY_STEP = 12;

type Menu = "den" | "treats" | "proof" | "reward" | "settings" | "receipt" | null;
/** `born` is the block of the chain read that showed the earnings this pickup represents. */
type Pickup = { id: string; at: WorldPoint; value: bigint; kind: "pouch" | "spark" | "golden"; born: bigint; taken: boolean; expiresAt?: number };
type Trip = { number: number; carried: bigint; pickups: number };
type History = { milestones: Milestone[]; times: Map<bigint, number>; truncated: boolean };
type Session = { startBlock: bigint | null; startEarned: bigint; newSeen: bigint; gathered: number; gatheredRf: bigint; claims: number; restingSeen: boolean };
type Receipt = Session & { endBlock: bigint; trips: number; broughtHome: bigint };
const NEW_SESSION: Session = { startBlock: null, startEarned: 0n, newSeen: 0n, gathered: 0, gatheredRf: 0n, claims: 0, restingSeen: false };

const sameMilestone = (a: Milestone | null, b: Milestone) => a !== null && a.tx === b.tx && a.logIndex === b.logIndex && a.kind === b.kind;
const when = (time?: number) => time ? new Date(time).toISOString().replace("T", " ").slice(0, 16) + " UTC" : "";

export default function Forage({ friendId, client, paused }: GameComponentProps) {
  const [traits, setTraits] = useState<FriendTraits | null>(null);
  const [state, setState] = useState<FriendState | null>(null);
  const [rate, setRate] = useState(0n);
  const [now, setNow] = useState(Date.now());
  const [chainError, setChainError] = useState("");
  const [worldNote, setWorldNote] = useState("");
  const [atDen, setAtDen] = useState(false);
  const [friendAt, setFriendAt] = useState<WorldPoint | null>(null);
  const [pour, setPour] = useState<{ from: WorldPoint; count: number; landed: boolean } | null>(null);
  const [history, setHistory] = useState<History | null>(null);
  const [historyError, setHistoryError] = useState("");
  const [snapshot, setSnapshot] = useState<GameSnapshot | null>(null);
  const [menu, setMenu] = useState<Menu>(null);
  const [pickups, setPickups] = useState<Pickup[]>([]);
  const [trips, setTrips] = useState<Trip[]>([]);
  const [journey, setJourney] = useState<Journey>(JOURNEY_START);
  const [session, setSession] = useState<Session>(NEW_SESSION);
  const [receipt, setReceipt] = useState<Receipt | null>(null), [bubble, setBubble] = useState<string | null>(null);
  const [keepsake, setKeepsake] = useState<Milestone | null>(null);
  const [laidOut, setLaidOut] = useState(false), [homeSinceClaim, setHomeSinceClaim] = useState(0n), [goldensSeen, setGoldensSeen] = useState(0);
  const [streak, setStreak] = useState(0), [holdSince, setHoldSince] = useState<number | null>(null);
  const [result, setResult] = useState<GamePlay | null>(null);
  const [busy, setBusy] = useState(false), [message, setMessage] = useState(""), [error, setError] = useState("");
  const [muted, setMuted] = useState(true), [reducedMotion, setReducedMotion] = useState(false);
  const [retry, setRetry] = useState(0);
  const sound = useRef<FriendSoundKit | null>(null), locked = useRef(false), epoch = useRef(0), worldRef = useRef<HTMLDivElement>(null), historyLoading = useRef(false);
  const readNow = useRef<(() => void) | null>(null);
  const definition = client.definition;

  const scene = useMemo(() => traits ? buildWorld(traits.scenery) : null, [traits]);

  useEffect(() => {
    const version = ++epoch.current;
    sound.current = createFriendSoundKit({ muted: true });
    setTraits(null); setState(null); setHistory(null); setSnapshot(null); setMenu(null); setPickups([]); setTrips([]);
    setLaidOut(false); setHomeSinceClaim(0n); setGoldensSeen(0); setStreak(0); setReceipt(null); setBubble(null); setKeepsake(null);
    setJourney(JOURNEY_START); setSession(NEW_SESSION); setHoldSince(null); setChainError(""); setWorldNote(""); setHistoryError(""); setMuted(true); locked.current = false; historyLoading.current = false;
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
        const increase = previous && next.earnedRf > previous.earnedRf ? next.earnedRf - previous.earnedRf : 0n;
        if (increase) setSession(current => ({ ...current, newSeen: current.newSeen + increase }));
        previous = next; setState(next); setChainError("");
      }).catch(cause => alive() && setChainError(cause instanceof Error ? cause.message.split("\n")[0] : "The chain could not be read."))
        .finally(() => { polling = false; });
    };
    void poll();
    readNow.current = poll;
    const timer = setInterval(poll, POLL_MS), tick = setInterval(() => setNow(Date.now()), 1000);
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReducedMotion(preference.matches); update(); preference.addEventListener("change", update);
    return () => { epoch.current++; readNow.current = null; clearInterval(timer); clearInterval(tick); sound.current?.dispose(); sound.current = null; preference.removeEventListener("change", update); };
  }, [client, friendId, retry]);

  useEffect(() => {
    if (!state || history || historyError || historyLoading.current) return;
    historyLoading.current = true;
    const version = epoch.current;
    readFriendHistory(friendId, state.owner)
      .then(h => version === epoch.current && setHistory({ milestones: toMilestones(h.transfers, h.activations), times: h.times, truncated: h.truncated }))
      .catch(cause => version === epoch.current && setHistoryError(cause instanceof Error ? cause.message.split("\n")[0] : "History could not be read."))
      .finally(() => { if (version === epoch.current) historyLoading.current = false; });
  }, [state, history, historyError, friendId]);

  const vitals = state ? deriveVitals(state) : null;
  const fresh = Boolean(state) && !chainError && now - (state?.readAt ?? 0) <= POLL_MS * 2;
  const pouchNow = state ? (fresh ? projectEarned(state, rate, now) : state.earnedRf) : 0n;

  const active = Boolean(vitals?.awake);
  const represented = pickups.reduce((sum, p) => sum + p.value, 0n) + homeSinceClaim;

  // One rule for the ground: never represent more than the Friend's real unclaimed rewards (see `reconcile`).
  useEffect(() => {
    if (!scene || !state) return;
    const step = reconcile(state.earnedRf, represented, laidOut, active, pickups.filter(p => p.kind === "spark" && !p.taken).length);
    if (step.kind === "claimed") {
      const hadSomething = represented > 0n;
      setPickups([]); setHomeSinceClaim(0n); setLaidOut(false); setStreak(0); setHoldSince(null);
      if (hadSomething) setMessage("Its rewards were claimed on-chain, so the ground and everything it carried are cleared.");
      if (hadSomething) setSession(current => ({ ...current, claims: current.claims + 1 }));
      if (hadSomething) setJourney(current => advanceJourney(current, { type: "claim" }));
      return;
    }
    if (step.kind === "layout") {
      const { count, each } = pouchPickups(step.value);
      const spots = pickSpots(scene.open, count, Number(friendId % 2_147_483_647n), [...scene.stations, scene.spawn]);
      const values = splitValue(step.value, Math.max(1, spots.length));
      setPickups(current => [...current, ...spots.map((at, i) => ({ id: `pouch-${state.block}-${i}`, at, value: values[i], kind: "pouch" as const, born: state.block, taken: false }))]);
      setLaidOut(true);
      return;
    }
    if (step.kind !== "spark") return;
    const threshold = goldensSeen === 0 ? FIRST_GOLDEN_AFTER : GOLDEN_EVERY;
    const golden = streak >= threshold;
    if (golden && holdSince === null) { setHoldSince(state.readAt); return; }
    if (golden && state.readAt - holdSince! < (goldensSeen === 0 ? FIRST_GOLDEN_HOLD_MS : GOLDEN_HOLD_MS)) return;
    const [at] = pickSpots(scene.open, 1, Number(state.block % 2_147_483_647n), [...scene.stations, ...pickups.map(p => p.at)]);
    if (!at) return;
    setPickups(current => [...current, golden
      ? { id: `golden-${state.block}`, at, value: step.value, kind: "golden", born: state.block, taken: false, expiresAt: Date.now() + GOLDEN_MS }
      : { id: `spark-${state.block}`, at, value: step.value, kind: "spark", born: state.block, taken: false }]);
    setStreak(golden ? 0 : streak + 1);
    setHoldSince(null);
    if (golden) setGoldensSeen(n => n + 1);
    sound.current?.play(golden ? "anticipation" : "action-ready");
    if (golden) setMessage(`A golden spark: ${formatRf(step.value)} RF of real earnings held back for it. Grab it before it scatters.`);
  }, [scene, state, represented, laidOut, active, pickups, streak, holdSince, goldensSeen, friendId]);

  useEffect(() => {
    if (!state) return;
    setSession(current => current.startBlock === null ? { ...current, startBlock: state.block, startEarned: state.earnedRf, restingSeen: !active }
      : !active && !current.restingSeen ? { ...current, restingSeen: true } : current);
  }, [state, active]);

  // First Forage ends with the Friend's own reaction and a receipt of what the chain showed this session.
  // The receipt is frozen at the moment of completion, so its end block and totals don't drift afterwards.
  useEffect(() => {
    if (journey.stage !== "done" || receipt || !state) return;
    setReceipt({ ...session, endBlock: state.block, trips: trips.length, broughtHome: trips.reduce((sum, t) => sum + t.carried, 0n) });
    setBubble(reactionFor(traits?.character ?? "")); setMenu("receipt"); setMessage("");
    sound.current?.play("reveal-legendary");
  }, [journey.stage, receipt, session, state, trips, traits]);

  useEffect(() => {
    if (!bubble) return;
    const timer = setTimeout(() => setBubble(null), 6_000);
    return () => clearTimeout(timer);
  }, [bubble]);

  // A golden spark's timer stops while a menu is open or the game is paused.
  const frozenSince = useRef<number | null>(null);
  useEffect(() => {
    if (menu || paused) { frozenSince.current ??= Date.now(); return; }
    if (frozenSince.current === null) return;
    const since = frozenSince.current, resumed = Date.now();
    frozenSince.current = null;
    // A spark that appeared mid-freeze is only extended by the time since it appeared.
    setPickups(current => current.map(p => p.kind === "golden" && p.expiresAt ? { ...p, expiresAt: p.expiresAt + resumed - Math.max(since, p.expiresAt - GOLDEN_MS) } : p));
  }, [menu, paused]);

  // A missed golden spark scatters into three sparks worth exactly the same; nothing is lost.
  useEffect(() => {
    if (!scene || menu || paused) return;
    const expired = pickups.find(p => p.kind === "golden" && !p.taken && (p.expiresAt ?? Infinity) <= now);
    if (!expired) return;
    const spots = pickSpots(scene.open.filter(p => Math.hypot(p[0] - expired.at[0], p[1] - expired.at[1]) < 90), 3, now % 2_147_483_647,
      [...scene.stations, ...pickups.filter(p => p.id !== expired.id).map(p => p.at)]);
    const values = splitValue(expired.value, Math.max(1, spots.length));
    setPickups(current => [...current.filter(p => p.id !== expired.id),
      ...(spots.length ? spots : [expired.at]).map((at, i) => ({ id: `${expired.id}-${i}`, at, value: values[i], kind: "spark" as const, born: expired.born, taken: false }))]);
    setMessage("The golden spark scattered. Its value is still on the ground.");
  }, [now, pickups, scene, menu, paused]);

  const reach = pullRadius(snapshot?.inventory ?? []);

  // Each frame, pickups inside the Friend's pull glide toward it; kept treats widen the pull.
  useEffect(() => {
    if (!active || !pickups.some(p => !p.taken)) return;
    let frame = 0, last = performance.now();
    const scan = (time: number) => {
      const seconds = Math.min(0.1, (time - last) / 1000);
      last = time;
      const canvas = worldRef.current?.querySelector("canvas");
      const x = Number(canvas?.dataset.x), y = Number(canvas?.dataset.y);
      if (!paused && !menu && Number.isFinite(x) && Number.isFinite(y)) {
        let moved = false;
        const collected: Pickup[] = [];
        const next = pickups.map(p => {
          if (p.taken) return p;
          const step = pullStep(p.at, [x, y], reach, PULL_SPEED * seconds);
          if (step === null) return p;
          moved = true;
          if (step === "collected") { collected.push(p); return { ...p, taken: true }; }
          return { ...p, at: step };
        });
        if (moved) {
          setPickups(next);
          if (collected.length) {
            const value = collected.reduce((sum, p) => sum + p.value, 0n), left = next.filter(p => !p.taken).length;
            setSession(current => ({ ...current, gathered: current.gathered + collected.length, gatheredRf: current.gatheredRf + value }));
            setJourney(current => advanceJourney(current, { type: "collect", born: collected.map(p => p.born), left }));
            const kind = collected.some(p => p.kind === "golden") ? "golden" : collected.some(p => p.kind === "spark") ? "spark" : "pouch";
            if (kind === "golden") setMessage("");
            sound.current?.play(({ golden: "reveal-legendary", spark: "reveal-rare", pouch: "select" } as const)[kind]);
          }
          return;
        }
      }
      frame = requestAnimationFrame(scan);
    };
    frame = requestAnimationFrame(scan);
    return () => cancelAnimationFrame(frame);
  }, [pickups, paused, menu, reach, active]);

  // The SDK canvas only hears keys while focused; hand focus back whenever the world is in play.
  useEffect(() => {
    if (!scene || menu || paused) return;
    const frame = requestAnimationFrame(() => worldRef.current?.querySelector("canvas")?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, [scene, menu, paused]);

  const carryingCount = pickups.filter(p => p.taken).length;
  useEffect(() => {
    if (!carryingCount && !pour && !bubble) return;
    const timer = setInterval(() => {
      const canvas = worldRef.current?.querySelector("canvas");
      const x = Number(canvas?.dataset.x), y = Number(canvas?.dataset.y);
      if (Number.isFinite(x) && Number.isFinite(y)) setFriendAt(at => at && Math.hypot(at[0] - x, at[1] - y) < 1 ? at : [x, y]);
    }, 80);
    return () => clearInterval(timer);
  }, [carryingCount, pour, bubble]);

  useEffect(() => {
    if (!pour) return;
    const land = requestAnimationFrame(() => setPour(current => current && { ...current, landed: true }));
    const done = setTimeout(() => setPour(null), 1400);
    return () => { cancelAnimationFrame(land); clearTimeout(done); };
  }, [pour?.from]);

  const carrying = pickups.filter(p => p.taken);
  const carried = carrying.reduce((sum, p) => sum + p.value, 0n);
  const remaining = pickups.filter(p => !p.taken).length;

  const broughtHome = trips.reduce((sum, t) => sum + t.carried, 0n);
  const target = gatherTarget(journey, remaining);
  const freshOnGround = pickups.some(p => !p.taken && p.born > journey.homeBlock);

  function bringHome() {
    if (carrying.length === 0 || paused || !atDen) return;
    setTrips(current => [...current, { number: current.length + 1, carried, pickups: carrying.length }]);
    setHomeSinceClaim(home => home + carried);
    if (state) setJourney(current => advanceJourney(current, { type: "home", block: state.block, left: remaining }));
    if (!reducedMotion && friendAt) setPour({ from: friendAt, count: Math.min(carrying.length, TRAIL_MAX), landed: false });
    setPickups(current => current.filter(p => !p.taken));
    sound.current?.play("reward");
    setMessage(`Trip ${trips.length + 1} home: ${formatRf(carried)} RF of real claimable rewards, carried as a picture of what it earned.`);
  }

  /** Homecoming: hang one of the Friend's real milestones in the Den; the Friend reacts in its family's voice. */
  function hangKeepsake(milestone: Milestone) {
    setKeepsake(milestone);
    setBubble(homecomingLine(traits?.character ?? "", milestone));
    sound.current?.play("reveal-rare");
    navigate(null);
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
  const status = chainError ? "Can't see your Friend's chain state right now" : !state ? "Reading the chain…" : vitals?.awake ? "Awake · in the reward pool" : "Resting · out of the reward pool";
  const feedback = <p role={error ? "alert" : "status"}>{error || message || (busy ? "Waiting for preview confirmation…" : "Treats are simulated RF. Chain readings are live and read-only.")}</p>;
  const reactivation = state ? reactivationCost(state.generation) : null;
  const nextCheck = state ? Math.max(0, Math.ceil((state.readAt + POLL_MS - now) / 1000)) : 0;
  const objective = {
    gather: target === 0 ? `Waiting for new earnings · next check ${nextCheck}s` : `Gather ${target} of what it earned (${Math.min(journey.gathered, target)}/${target})`,
    home: "Bring them home to the Den",
    spark: freshOnGround ? "Catch one fresh spark of new earnings"
      : holdSince !== null ? "Catch one fresh spark · held back for a golden one"
      : `Catch one fresh spark · next check ${nextCheck}s`,
    done: "",
  }[journey.stage];

  return <section className="forage" aria-label="Forage" aria-busy={busy}>
    <div className="forage-world" ref={worldRef} inert={Boolean(menu) || paused || undefined}>
      <GameWorld world={scene.world} spawn={scene.spawn} interactions={scene.interactions} friendId={friendId}
        paused={Boolean(menu) || paused} reducedMotion={reducedMotion} onInteract={id => navigate(id as Menu, true)} />
      <div className="forage-pickups" aria-hidden="true"><div className="forage-surface">
        {pickups.filter(p => !p.taken).map(p => <span key={p.id} data-id={p.id} className={`forage-pickup forage-${p.kind}${active ? "" : " forage-waiting"}${reducedMotion || !active ? "" : " forage-bob"}`} style={screen(p.at)}>
          {p.kind === "golden" && <b>{Math.max(0, Math.ceil(((p.expiresAt ?? now) - now) / 1000))}</b>}</span>)}
        {friendAt && carrying.slice(0, TRAIL_MAX).map((p, i) => <span key={`trail-${p.id}`} className={`forage-pickup forage-trail forage-${p.kind}`}
          style={screen(friendAt, 0, CARRY_LIFT - i * CARRY_STEP)} />)}
        {keepsake && <span className={`forage-keepsake${reducedMotion ? "" : " forage-pop"}`} style={screen(scene.stations[0], 0, -34)} />}
        {pour && Array.from({ length: pour.count }, (_, i) => <span key={`pour-${i}`} className="forage-pickup forage-pour"
          style={{ ...(pour.landed ? screen(scene.stations[0]) : screen(pour.from, 0, CARRY_LIFT - i * CARRY_STEP)), transitionDelay: `${i * 70}ms` }} />)}
      </div></div>
      <div className="forage-hud">
        <div className="forage-card">
          <strong>Friend #{friendId.toString()} · {traits?.character || "Friend"}</strong>
          <span>{scene.name}{traits?.scenery ? ` · on-chain scenery: ${traits.scenery}` : ""}</span>
          <span className={chainError ? "forage-warn" : vitals?.awake ? "forage-live" : "forage-rest"}>{status}</span>
          {worldNote && <span className="forage-warn">{worldNote}</span>}
        </div>
        <div className="forage-card forage-pouch">
          <span>{fresh && rate > 0n ? "Unclaimed RF · estimate" : "Unclaimed RF · last read"}</span>
          <strong>{state ? `${formatRf(pouchNow, 5)} RF` : "—"}</strong>
          <span>{state ? `+ ${formatRf(state.earnedWeth, 8)} WETH` : ""}</span>
        </div>
        <div className="forage-card">
          <span>Carrying {carrying.length} · {formatRf(carried)} RF · pull {reach}{reach > BASE_REACH ? " (treats)" : ""}</span>
          <span>{!state ? "Reading its pouch…" : !active ? (remaining ? `Resting: ${remaining} waiting, can't gather` : "Resting: nothing to gather") : remaining ? `${remaining} to gather` : `Can't carry what it hasn't earned · next check ${nextCheck}s`}</span>
          <span>Brought home: {trips.length} {trips.length === 1 ? "trip" : "trips"} · {formatRf(broughtHome)} RF</span>
        </div>
      </div>
      <div className="forage-actions">
        <button type="button" onClick={() => navigate("den")}>Den</button>
        <button type="button" onClick={() => navigate("proof")}>Proof</button>
        {receipt && <button type="button" onClick={() => navigate("receipt")}>Receipt</button>}
        <button type="button" onClick={() => navigate("settings")}>Settings</button>
      </div>
      {!menu && message && <p className="forage-toast" role="status">{message}</p>}
      {journey.stage !== "done" && state && <p className="forage-journey">{!active
        ? "First Forage waits: your Friend is resting, out of the reward pool, so nothing new can be gathered."
        : `First Forage · ${objective}`}</p>}
      {bubble && friendAt && <div className="forage-bubble" style={screen(friendAt, bubbleShift(friendAt), -120)}>{bubble}</div>}
      <p className="forage-hint">WASD / arrows or tap to walk · walk into glowing pickups · E at the Den, Treat stand or Proof board</p>
    </div>

    {menu && <GameMenu title={{ den: "Den", treats: "Treat stand", proof: "Proof board", reward: "Your treat", settings: "Settings", receipt: "First Forage receipt" }[menu]} onClose={busy ? undefined : () => navigate(null)}>
      {menu === "den" ? <>
        {carrying.length > 0 && !atDen ? <p>Walk your Friend to the Den to bring {carrying.length} home.</p>
          : carrying.length > 0
          ? <button type="button" className="rf-frame-primary" disabled={paused} onClick={bringHome}>Bring {carrying.length} home · {formatRf(carried)} RF</button>
          : <p>{remaining ? "Go gather what your Friend earned, then bring it home." : "Nothing carried yet."}</p>}
        {state && !vitals?.awake && <p className="forage-rest">This Friend is resting: its activation is cleared, so it isn't earning and can't gather. Reactivating a generation {state.generation} Friend costs {reactivation ?? "?"} RF on rarefriends.com. It stays fully playable here.</p>}
        <h3>Memory wall</h3>
        <p className="forage-small">Read from this Friend's own on-chain events. It follows the NFT to every device and every owner.</p>
        {historyError ? <p role="alert">History unavailable: {historyError} <button type="button" onClick={() => setHistoryError("")}>Retry history</button></p> : !history ? <p>Reading history…</p> :
          <ol className="forage-wall">{history.truncated && <li className="forage-trip"><strong>Earlier owners</strong><span>Not shown: the wall walks back through the latest four ownership moves.</span></li>}
            {history.milestones.map(m => <li key={`${m.tx}-${m.logIndex}-${m.kind}`} className={sameMilestone(keepsake, m) ? "forage-kept" : undefined}>
            <strong>{m.title}{sameMilestone(keepsake, m) ? " · hung in the Den this session" : ""}</strong><span>{when(history.times.get(m.block))} · block {m.block.toLocaleString("en-US")}</span>
            <span>{m.detail}</span><code className="forage-hash">{EXPLORER.replace("https://", "")}/tx/{m.tx}</code></li>)}
          </ol>}
        {trips.length > 0 && <ol className="forage-wall">{trips.map(t => <li key={`trip-${t.number}`} className="forage-trip"><strong>Trip {t.number} home</strong>
          <span>{t.pickups} pickups · {formatRf(t.carried)} RF carried</span><span>This session only. Care isn't saved on-chain.</span></li>)}</ol>}
        {trips.length > 0 && history && history.milestones.length > 0 && <>
          <h3>Homecoming</h3>
          <p className="forage-small">Hang one of its real milestones in the Den. The milestone is on-chain; hanging it is this session only.</p>
          <div className="forage-keepsakes">{history.milestones.map(m => <button key={`keep-${m.tx}-${m.logIndex}-${m.kind}`} type="button" aria-pressed={sameMilestone(keepsake, m)}
            disabled={paused} onClick={() => hangKeepsake(m)}>{m.title} · block {m.block.toLocaleString("en-US")}</button>)}</div>
        </>}
      </> : menu === "treats" ? <>
        <p>One treat costs {formatGameRf(definition.price)} and cracks into one snack for your Friend.</p>
        <table><thead><tr><th>Treat</th><th>Chance</th><th>Value</th><th>Pull while kept</th></tr></thead><tbody>{definition.outcomes.map((item, index) =>
          <tr key={item.name}><td>{item.name}</td><td>{item.chanceBps / 100}%</td><td>{formatGameRf(item.reward)}</td><td>+{TREAT_PULL[index]}</td></tr>)}</tbody></table>
        <p className="forage-small">Keep a snack and your Friend pulls pickups in from farther away. Redeem it for RF and the pull goes with it.</p>
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
        <p className="forage-small">The values down to Pouch are one read-only snapshot of Robinhood Chain (4663) at the block shown, refreshed every 15 s; reward share is worked out from weight and totalWeight. World is read once when the session starts. Nothing is signed or stored. Between reads the HUD pouch is an estimate at the measured rate; after a failed read it shows the last read value.</p>
        {chainError && <p role="alert">Last read failed: {chainError}. <button type="button" onClick={() => readNow.current?.()}>Read again</button></p>}
        {state && <dl className="forage-proof">
          <dt>Block</dt><dd>{state.block.toLocaleString("en-US")}</dd>
          <dt>Owner</dt><dd>{short(state.owner)} · Generations.ownerOf</dd>
          <dt>Friend wallet</dt><dd>{short(state.wallet)} · Generations.tokenBoundAccount</dd>
          <dt>Generation</dt><dd>{state.generation} · Generations.generation</dd>
          <dt>Tier · weight</dt><dd>{state.tier} · {formatRf(state.weight, 2)} · ActivationManager.positions</dd>
          <dt>Reward share</dt><dd>{vitals?.shareBps.toFixed(4)} bps of {formatRf(state.totalWeight, 0)} · totalWeight</dd>
          <dt>Pouch</dt><dd>{formatRf(state.earnedRf, 6)} RF · {formatRf(state.earnedWeth, 8)} WETH · ActivationManager.earned</dd>
          <dt>World</dt><dd>{traits?.scenery || "unknown"}{scene.matched ? "" : " (fallback world)"} · Generations.tokenURI, read at session start</dd>
        </dl>}
        <p className="forage-small">Contracts: Generations {short(CONTRACTS.generations)} · ActivationManager {short(CONTRACTS.activationManager)} · RF {short(CONTRACTS.rf)}. Verify on {EXPLORER.replace("https://", "")}.</p>
      </> : menu === "receipt" && receipt ? <>
        <p><strong>First Forage complete.</strong> {reactionFor(traits?.character ?? "")}</p>
        <h3>From the chain</h3>
        <dl className="forage-proof">
          <dt>Friend</dt><dd>#{friendId.toString()} · {traits?.character || "Friend"} · {traits?.scenery || scene.name}</dd>
          <dt>Blocks read</dt><dd>{receipt.startBlock?.toLocaleString("en-US")} → {receipt.endBlock.toLocaleString("en-US")}</dd>
          <dt>Unclaimed at start</dt><dd>{formatRf(receipt.startEarned)} RF</dd>
          <dt>New earnings seen</dt><dd>{formatRf(receipt.newSeen, 6)} RF, the sum of increases between reads</dd>
          <dt>Claims · resting</dt><dd>{receipt.claims} {receipt.claims === 1 ? "drop" : "drops"} in unclaimed RF, read as claims · {receipt.restingSeen ? "resting at a read" : "no resting seen at reads"}</dd>
        </dl>
        <h3>This session's play</h3>
        <dl className="forage-proof">
          <dt>Gathered</dt><dd>{receipt.gathered} pickups · {formatRf(receipt.gatheredRf)} RF</dd>
          <dt>Brought home</dt><dd>{receipt.trips} {receipt.trips === 1 ? "trip" : "trips"} · {formatRf(receipt.broughtHome)} RF</dd>
          {keepsake && <><dt>Keepsake</dt><dd>{keepsake.title} · block {keepsake.block.toLocaleString("en-US")}, hung in the Den</dd></>}
        </dl>
        <p className="forage-small">Chain rows are read-only reads of this Friend, frozen when First Forage finished. Play rows count what you did here; pickups are a picture of its real rewards, and nothing was moved, signed or stored.</p>
      </> : menu === "settings" ? <>
        <button type="button" aria-pressed={!muted} onClick={() => { const next = !muted; setMuted(next); sound.current?.setMuted(next); if (!next) void sound.current?.unlock(); }}>{muted ? "Sound off" : "Sound on"}</button>
        <label><input type="checkbox" checked={reducedMotion} onChange={event => setReducedMotion(event.target.checked)} /> Reduce motion</label>
        <p>Pickups are a picture of real claimable rewards; gathering them moves nothing. Treats are simulated. Reloading resets trips and treats; the memory wall and live readings come back from the chain.</p>
      </> : null}{feedback}
    </GameMenu>}
  </section>;
}

/** Keeps the 240px reaction bubble inside the 960px world when the Friend stands near an edge. */
function bubbleShift(at: WorldPoint) {
  const [x] = viewPosition(at);
  return Math.min(960 - 136, Math.max(136, x)) - x;
}

function formatGameRf(value: bigint) {
  return `${formatRf(value, 4)} RF`;
}
