# Forage

**Your Rare Friend gathers only what it really earned, in the world written into its own token.**

A Rare Friends Vibeathon entry for **Character Spotlight**, built on FriendSDK 0.1.3.

**Play:** https://cassxbt.github.io/rarefriends-forage/
Needs a browser wallet on Robinhood mainnet (chain 4663) holding a hardwired Generations Friend (generation 1 or higher). No RF, signature or transaction is needed to play.

## What did you build?

A walk-and-gather game where every part of the world comes from your Friend's own on-chain life.

Your Friend spawns in **its own world**: the *Scenery* trait in its token metadata picks one of the six SDK worlds (Garden, Circuit, Crystal, Rooftop, Tidal, Orbital). Its **real unclaimed rewards**, read live from the Rare Friends ActivationManager, are laid out as glowing pickups. Walk into them, carry them home to the **Den**, and a trip lands on its **Memory wall**, next to the Friend's real lifecycle events with their transaction hashes.

After that first run, the rule is **Earned Ground: it can't carry what it hasn't earned.** New pickups ("sparks") appear only when a chain read shows its rewards actually grew, each worth exactly that increase. Every few sparks, real earnings are held back for about 40 seconds and arrive as one **golden spark** on a 12-second timer. Miss it and it scatters into three sparks worth exactly the same. Nothing is ever invented.

A resting Friend (activation cleared, not earning) can't gather, and the Den says why and what reactivation costs. If the chain can't be read, the game says so and freezes the numbers instead of guessing.

## How does it use Rare Friends?

Remove Rare Friends and nothing is left: no world, no character, nothing to gather, no memories.

| In the game | Read from | Call |
|---|---|---|
| The world you walk | the Friend's Scenery trait | `Generations.tokenURI` |
| The character | canonical on-chain sprite, drawn unmodified by the SDK | SDK sprite reader |
| Everything you gather | real unclaimed RF and WETH, updated every 15 s | `ActivationManager.earned` |
| Awake or resting | the Friend's active reward weight | `ActivationManager.positions` |
| Memory wall | its own `Activated` and `Transfer` events, with tx hashes | event logs |
| Proof board | owner, Friend wallet, generation, tier, weight, share, pouch, world, each at the block shown | `ownerOf`, `tokenBoundAccount`, `generation`, `totalWeight` |

The Friend's history survives any device and any owner, because it is read from the chain, not saved in the browser. All reads are read-only; nothing is signed.

## How RF is spent, and the economy

**All purchases and rewards are simulated.** The preview wallet starts with 20 RF.

RF is spent in one place: the **Treat stand**. A treat costs **1 RF** and cracks into one snack. A kept snack gives your Friend **pull**: pickups inside its pull radius glide to it. Redeem the snack for its fixed RF value and the pull goes with it. Every reveal asks: *take the RF, or keep the magnet?*

| Snack | Chance | Redemption value | Pull while kept |
|---|---:|---:|---:|
| Crumb | 40% | 0.25 RF | +6 |
| Berry | 30% | 0.75 RF | +12 |
| Honeycomb | 20% | 1.5 RF | +20 |
| Stardrop | 10% | 2.5 RF | +40 |

Expected value **0.875 RF per treat** (12.5% vendor edge). Base pull is 20; treats add up to +60. Backing follows the SDK unchanged: each treat reserves the 2.5 RF maximum prize, kept snacks stay backed, and there is no redemption expiry. Exact terms: [`game/game.json`](game/game.json).

The pickups themselves are a picture of real rewards. Gathering them moves nothing; claiming stays on rarefriends.com. When a real claim happens, the game notices the drop and clears the ground.

## What would be on-chain?

Nothing new. Going live is a deployment of the SDK's `ChanceGame` with this `game.json`: `buy` moves RF from the Friend wallet and mints treats, `play` burns one and commits, `settle` mints the snack to the Friend's canonical wallet, `redeem` burns it for its fixed RF. The pull would read the Friend wallet's snack balances, so it stays verifiable from chain state. Pickups, sparks and trips stay read-only views of the Friend's real rewards.

## How does it use randomness?

Only a treat's snack is random. It comes from the SDK ledger in preview and from Dice commit-reveal when live. The reveal only presents it. Pickup and spark positions are deterministic from the Friend's token ID and block number.

## Playable demo / how to run

Hosted: https://cassxbt.github.io/rarefriends-forage/ (GitHub Pages, built by CI from `main`).

Locally, with Node.js 22.18+:

```sh
git clone https://github.com/Cassxbt/rarefriends-forage.git
cd rarefriends-forage
npm ci
npm run dev
```

Open http://127.0.0.1:4173, connect your wallet and choose your Friend.

## How do you play?

WASD or arrow keys, or tap to walk. Walk into glowing pickups. Press **E** or tap the prompt at a station:

- **Den**: bring what you carry home; read the Memory wall.
- **Treat stand**: buy and crack treats, keep or redeem snacks.
- **Proof board**: every live number with its contract call and block.

Settings has sound and reduced motion.

## What have you tested?

- `npm test`: 26 unit and world tests. Vitals, spark and claim rules, pull, value splitting, and all six worlds (build time, reachability, every pickup on screen, station labels clear of each other, the HUD and the Friend).
- `npm run test:browser`: 4 end-to-end tests running the real SDK runtime in headless Chromium, with the SDK's identity fixture and a mock of Forage's own chain reads. Covers gathering, the Den handoff, a slow poll, an RPC outage, a real claim, a resting Friend, an ownership cycle on the Memory wall, and a golden spark scattering.
- `npm run test:live`: reads Friend #93858's real state, world and history from Robinhood mainnet.
- `npm run typecheck` and `npm run check` (SDK game validation) pass.
- Played by hand with a real wallet and Generation 3 Friend #93858: gate, world, gathering, sparks, Den trip, Memory wall, Proof board and a treat that raised the pull from 20 to 40.

## Known limitations

- Trips and treats reset on reload: the SDK sandbox has no storage. The world, memories and live readings come back from the chain.
- The SDK's stock `friendsdk test` harness fails on Forage, because its mock RPC only answers SDK calls. `test/browser.test.mjs` layers the missing reads on top of the same fixture.
- The public RPC keeps only recent state and caps log queries at 10M blocks, so history is read from events in chunks. A Friend passed through more than four owners shows its latest four moves.
- Tested on desktop Chrome. Phone layout scales down but wasn't tested with a mobile wallet.

## Needs future SDK support

Per-Friend saves (so trips and snacks persist), more than one consumable, and a way to show a claim from inside the game.

## Credits

Built by [@Cassxbt](https://github.com/Cassxbt). FriendSDK 0.1.3 (Apache-2.0) supplies the runtime, worlds, canonical sprites and sounds; see [NOTICE.md](NOTICE.md). Forage adds no third-party art, fonts or audio. Its own code is MIT.
