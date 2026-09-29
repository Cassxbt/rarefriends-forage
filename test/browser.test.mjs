// End-to-end: the real SDK runtime in headless Chromium, the SDK's identity fixture, and a mock of Forage's own chain reads.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, encodeFunctionResult, padHex, parseAbi, toHex, zeroAddress } from "viem";
import { buildGame, createGameServer } from "../node_modules/@rarefriends/friendsdk/scripts/dev-game.mjs";
import { createArtworkFixture, installFixture, OWNER } from "../node_modules/@rarefriends/friendsdk/scripts/browser-fixture.mjs";

const GEN = "0x14c49e6118f46525de9ab41a51cbaa3c6ebf181d";
const AM = "0xd4a35e11318e3679168d409184b788bcf9f283ac";
const WETH = "0x4444444444444444444444444444444444444444";
const PREVIOUS_OWNER = "0x5555555555555555555555555555555555555555";
const FRIEND = 7730n;
const RF = 10n ** 18n;
const START = 63_102_473n;
const abi = parseAbi([
  "function tokenURI(uint256) view returns (string)",
  "function positions(address, uint256) view returns (uint256 tier, uint256 weight)",
  "function earned(address, address, uint256) view returns (uint256)",
  "function totalWeight() view returns (uint256)",
  "function weth() view returns (address)",
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
  "event Activated(address indexed collection, uint256 indexed tokenId, address indexed owner, uint8 tier, uint256 weight, uint256 paid)",
]);
const uri = "data:application/json;base64," + Buffer.from(JSON.stringify({ attributes: [
  { trait_type: "Character", value: "Mask" }, { trait_type: "Scenery", value: "Rooftop" }] })).toString("base64");
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function createChain({ resting = false, ownerCycle = false } = {}) {
  // Until the game makes its first read, the SDK's own fixture answers (identity and discovery).
  const chain = { started: false, block: START, claimed: false, fail: false, slowNext: false };
  const earned = () => chain.claimed ? 0n : 7n * RF + (chain.block - START) * 20_000_000_000_000n;
  const log = (address, topics, data, block, tx) => ({ address, topics, data, blockNumber: toHex(block), blockHash: padHex("0x10", { size: 32 }),
    logIndex: "0x0", transactionHash: padHex(tx, { size: 32 }), transactionIndex: "0x0", removed: false });
  const transfer = (from, to, block, tx) => log(GEN, encodeEventTopics({ abi, eventName: "Transfer", args: { from, to, tokenId: FRIEND } }), "0x", block, tx);
  chain.answer = async request => {
    if (chain.fail) return { error: { code: -32000, message: "mock outage" } };
    if (request.method === "eth_blockNumber") {
      if (!chain.started) return null;
      chain.block += 150n;
      if (chain.slowNext) { chain.slowNext = false; await sleep(20_000); }
      return { result: toHex(chain.block) };
    }
    if (request.method === "eth_call") {
      const { to, data } = request.params[0];
      if (to.toLowerCase() === GEN && data.startsWith("0xc87b56dd")) chain.started = true;
      if (to.toLowerCase() === GEN && data.startsWith("0xc87b56dd")) return { result: encodeFunctionResult({ abi, functionName: "tokenURI", result: uri }) };
      if (to.toLowerCase() !== AM) return null;
      const { functionName, args } = decodeFunctionData({ abi, data });
      const result = functionName === "weth" ? WETH : functionName === "totalWeight" ? 1_016_116_597_984_375_000_000_000_000n
        : functionName === "positions" ? [0n, resting ? 0n : 1450n * RF] : args[0].toLowerCase() === WETH ? 10n ** 13n : earned();
      return { result: encodeFunctionResult({ abi, functionName, result }) };
    }
    if (request.method === "eth_getLogs") {
      const filter = request.params[0];
      if (BigInt(filter.fromBlock) !== 62_000_000n) return null;
      if (filter.address.toLowerCase() === AM) return { result: [log(AM, encodeEventTopics({ abi, eventName: "Activated", args: { collection: GEN, tokenId: FRIEND, owner: OWNER } }),
        encodeAbiParameters([{ type: "uint8" }, { type: "uint256" }, { type: "uint256" }], [0, 1450n * RF, 1000n * RF]), START - 50n, "0xaa")] };
      if (filter.address.toLowerCase() !== GEN || !filter.topics?.[2]) return null;
      const to = `0x${filter.topics[2].slice(-40)}`.toLowerCase();
      if (to === OWNER.toLowerCase()) return { result: ownerCycle
        ? [transfer(zeroAddress, OWNER, START - 90n, "0xbb"), transfer(PREVIOUS_OWNER, OWNER, START - 20n, "0xdd")]
        : [transfer(zeroAddress, OWNER, START - 90n, "0xbb")] };
      if (to === PREVIOUS_OWNER) return { result: [transfer(OWNER, PREVIOUS_OWNER, START - 40n, "0xcc")] };
      return { result: [] };
    }
    if (request.method === "eth_getBlockByNumber") {
      const n = BigInt(request.params[0]), zero = padHex("0x0", { size: 32 });
      return { result: { number: toHex(n), hash: padHex("0x99", { size: 32 }), parentHash: padHex("0x98", { size: 32 }), timestamp: toHex(1_790_000_000n + n / 10n),
        nonce: "0x0", sha3Uncles: zero, logsBloom: "0x" + "0".repeat(512), transactionsRoot: zero, stateRoot: zero, receiptsRoot: zero, miner: zeroAddress,
        difficulty: "0x0", totalDifficulty: "0x0", extraData: "0x", size: "0x0", gasLimit: "0x0", gasUsed: "0x0", transactions: [], uncles: [], baseFeePerGas: "0x0", mixHash: zero } };
    }
    return null;
  };
  return chain;
}

let build, server, origin, browser;
before(async () => {
  build = await buildGame(new URL("../game", import.meta.url).pathname, { outdir: join(await mkdtemp(join(tmpdir(), "forage-")), "dist") });
  server = createGameServer(build.outdir);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true });
});
after(async () => { await browser?.close(); server?.closeAllConnections(); server?.close(); await build?.close(); });

async function open(chain) {
  const page = await (await browser.newContext({ viewport: { width: 960, height: 800 } })).newPage();
  page.setDefaultTimeout(40_000);
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  const fixture = await installFixture(page, origin, { artworkCall: await createArtworkFixture() });
  await page.route("https://rpc.mainnet.chain.robinhood.com/**", async route => {
    const request = route.request().method() === "POST" ? route.request().postDataJSON() : null;
    const out = request && !Array.isArray(request) ? await chain.answer(request) : null;
    return out ? route.fulfill({ json: { jsonrpc: "2.0", id: request.id, ...out }, headers: { "access-control-allow-origin": "*" } }) : route.fallback();
  });
  await page.goto(origin);
  await page.getByRole("button", { name: /^Connect (wallet|Browser wallet)$/ }).click();
  await page.getByRole("button", { name: new RegExp(`^Friend #${FRIEND}\\b`) }).click();
  const game = page.frameLocator("iframe");
  await game.getByText(/Awake · earning|Resting · not earning/).waitFor();
  return { page, game, errors, fixture, pickups: () => game.locator(".forage-pickup").count() };
}

test("an earning Friend gathers in its own world and only real events change the ground", { timeout: 240_000 }, async () => {
  const chain = createChain();
  const { page, game, errors, fixture, pickups } = await open(chain);
  await game.getByText(/on-chain scenery: Rooftop/).waitFor();
  assert.equal(await pickups(), 12, "pouch laid out as 12 visible pickups");

  const box = await game.locator(".forage-pickup").first().boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2 + 16);
  await game.getByText(/^Carrying 1 /).waitFor({ timeout: 20_000 });

  await game.locator(".forage-actions").getByRole("button", { name: "Den" }).click();
  await game.getByText(/Walk your Friend to the Den to bring 1 home/).waitFor();
  assert.equal(await game.getByRole("button", { name: /^Bring \d+ home/ }).count(), 0, "no bring-home away from the Den");
  await page.keyboard.press("Escape");
  await game.getByRole("button", { name: /close/i }).click().catch(() => {});

  const beforeSlow = await pickups();
  chain.slowNext = true;
  await sleep(40_000);
  assert.ok(await pickups() >= beforeSlow, "a slow poll never wipes the ground");
  assert.equal(await game.getByText(/rewards were claimed/).count(), 0, "a slow poll is not read as a claim");

  chain.fail = true;
  await game.getByText("Can't see your Friend's chain state right now").waitFor();
  await game.getByText("Pouch (last successful read)").waitFor();
  const frozen = await game.locator(".forage-pouch strong").innerText();
  await sleep(4_000);
  assert.equal(await game.locator(".forage-pouch strong").innerText(), frozen, "the pouch never counts up without the chain");
  chain.fail = false;

  chain.claimed = true;
  await game.getByText(/rewards were claimed/).waitFor();
  assert.equal(await pickups(), 0, "a claim clears the ground");
  assert.deepEqual(errors, []);
  assert.deepEqual(fixture.errors, []);
});

test("a resting Friend can't gather and is told why", { timeout: 120_000 }, async () => {
  const { game, errors, pickups } = await open(createChain({ resting: true }));
  await sleep(1_500);
  assert.equal(await pickups(), 0);
  await game.locator(".forage-actions").getByRole("button", { name: "Den" }).click();
  await game.getByText(/This Friend is resting.*costs [\d.,]+ RF/).waitFor();
  assert.deepEqual(errors, []);
});

test("the memory wall replays history once, even when ownership cycles", { timeout: 120_000 }, async () => {
  const { game, errors } = await open(createChain({ ownerCycle: true }));
  await game.locator(".forage-actions").getByRole("button", { name: "Den" }).click();
  await game.getByText("Reading history…").waitFor({ state: "hidden" });
  const rows = await game.locator(".forage-wall li strong").allInnerTexts();
  assert.deepEqual(rows, ["Appeared", "Hardwired and earning", "New home", "New home"]);
  assert.equal(new Set(await game.locator(".forage-wall li code").allInnerTexts()).size, 4, "each milestone appears once");
  assert.deepEqual(errors, []);
});
