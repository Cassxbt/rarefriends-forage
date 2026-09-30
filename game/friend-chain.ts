import { createPublicClient, http, parseAbi, parseAbiItem } from "viem";
import { walkTransfers, type ActivationLog, type Address, type FriendState, type FriendTraits, type Hash, type TransferLog } from "./vitals.ts";

/** The only host the SDK sandbox's CSP lets game code reach. */
export const RPC_URL = "https://rpc.mainnet.chain.robinhood.com";
export const CONTRACTS = {
  generations: "0x14C49e6118F46525dE9ab41a51cBAA3c6EBF181D",
  activationManager: "0xD4A35e11318E3679168d409184B788bcF9F283Ac",
  rf: "0x0779369854d3EcdEA927206718FFD7730C67B71f",
} as const satisfies Record<string, Address>;
export const EXPLORER = "https://robinhoodchain.blockscout.com";

/** Before the Sep 15 2026 launch; the public RPC rejects log spans over 10M blocks, so history is chunked from here. */
const HISTORY_FLOOR = 62_000_000n;
const LOG_SPAN = 9_000_000n;
const MAX_OWNER_HOPS = 4;

const abi = parseAbi([
  "function ownerOf(uint256) view returns (address)",
  "function generation(uint256) view returns (uint8)",
  "function tokenBoundAccount(uint256) view returns (address)",
  "function tokenURI(uint256) view returns (string)",
  "function positions(address, uint256) view returns (uint256 tier, uint256 weight)",
  "function earned(address, address, uint256) view returns (uint256)",
  "function totalWeight() view returns (uint256)",
  "function weth() view returns (address)",
]);
const TRANSFER = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)");
const ACTIVATED = parseAbiItem("event Activated(address indexed collection, uint256 indexed tokenId, address indexed owner, uint8 tier, uint256 weight, uint256 paid)");

export const chain = createPublicClient({ transport: http(RPC_URL, { retryCount: 2, timeout: 15_000 }) });

let wethAddress: Promise<Address> | null = null;
const weth = () => (wethAddress ??= chain.readContract({ address: CONTRACTS.activationManager, abi, functionName: "weth" })
  .catch(cause => { wethAddress = null; throw cause; }));

/** Rejects after `ms` so a slow RPC call can't hold the game on its loading screen. */
export function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms); });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

/** One consistent read at the latest block. The public RPC keeps only recent state, so never read older blocks. */
export async function readFriendState(friendId: bigint): Promise<FriendState> {
  const blockNumber = await chain.getBlockNumber({ cacheTime: 0 });
  const readAt = Date.now();
  const at = { blockNumber } as const;
  const wethToken = await weth();
  const [owner, generation, wallet, [tier, weight], totalWeight, earnedRf, earnedWeth] = await Promise.all([
    chain.readContract({ ...at, address: CONTRACTS.generations, abi, functionName: "ownerOf", args: [friendId] }),
    chain.readContract({ ...at, address: CONTRACTS.generations, abi, functionName: "generation", args: [friendId] }),
    chain.readContract({ ...at, address: CONTRACTS.generations, abi, functionName: "tokenBoundAccount", args: [friendId] }),
    chain.readContract({ ...at, address: CONTRACTS.activationManager, abi, functionName: "positions", args: [CONTRACTS.generations, friendId] }),
    chain.readContract({ ...at, address: CONTRACTS.activationManager, abi, functionName: "totalWeight" }),
    chain.readContract({ ...at, address: CONTRACTS.activationManager, abi, functionName: "earned", args: [CONTRACTS.rf, CONTRACTS.generations, friendId] }),
    chain.readContract({ ...at, address: CONTRACTS.activationManager, abi, functionName: "earned", args: [wethToken, CONTRACTS.generations, friendId] }),
  ]);
  return { friendId, block: blockNumber, readAt, owner, wallet, generation, tier: Number(tier), weight, totalWeight, earnedRf, earnedWeth };
}

/** The Friend's own on-chain metadata: character, scenery (its world), floor and state. */
export async function readFriendTraits(friendId: bigint): Promise<FriendTraits> {
  const uri = await chain.readContract({ address: CONTRACTS.generations, abi, functionName: "tokenURI", args: [friendId] });
  const body = uri.slice(uri.indexOf(",") + 1);
  const json = uri.startsWith("data:application/json;base64,") ? new TextDecoder().decode(Uint8Array.from(atob(body), c => c.charCodeAt(0))) : decodeURIComponent(body);
  const attributes: { trait_type?: string; value?: unknown }[] = JSON.parse(json).attributes ?? [];
  const trait = (name: string) => String(attributes.find(a => a.trait_type === name)?.value ?? "");
  return { character: trait("Character"), scenery: trait("Scenery"), floor: trait("Floor"), state: trait("State") };
}

async function chunked<T>(read: (fromBlock: bigint, toBlock: bigint) => Promise<T[]>, head: bigint): Promise<T[]> {
  const out: T[] = [];
  for (let from = HISTORY_FLOOR; from <= head; from += LOG_SPAN) {
    const to = from + LOG_SPAN - 1n < head ? from + LOG_SPAN - 1n : head;
    out.push(...await read(from, to));
  }
  return out;
}

/**
 * Transfers are found by walking owners backwards, each step strictly earlier than the last (the RPC rejects token-only Transfer filters);
 * activations filter by collection and token directly, so they survive owner changes.
 */
export async function readFriendHistory(friendId: bigint, owner: Address): Promise<{ transfers: TransferLog[]; activations: ActivationLog[]; times: Map<bigint, number>; truncated: boolean }> {
  const head = await chain.getBlockNumber({ cacheTime: 0 });
  const activations = (await chunked((fromBlock, toBlock) => chain.getLogs({
    address: CONTRACTS.activationManager, event: ACTIVATED, args: { collection: CONTRACTS.generations, tokenId: friendId }, fromBlock, toBlock, strict: true,
  }), head)).map(log => ({ tokenId: friendId, tier: log.args.tier, weight: log.args.weight, paid: log.args.paid, block: log.blockNumber, logIndex: log.logIndex, tx: log.transactionHash as Hash }));

  const { transfers, truncated } = await walkTransfers(async holder => (await chunked((fromBlock, toBlock) => chain.getLogs({
    address: CONTRACTS.generations, event: TRANSFER, args: { to: holder, tokenId: friendId }, fromBlock, toBlock, strict: true,
  }), head)).map(log => ({ from: log.args.from, to: log.args.to, tokenId: friendId, block: log.blockNumber, logIndex: log.logIndex, tx: log.transactionHash as Hash })), owner, MAX_OWNER_HOPS);

  const blocks = [...new Set([...transfers.map(t => t.block), ...activations.map(a => a.block)])];
  const times = new Map<bigint, number>(await Promise.all(blocks.map(async block => [block, Number((await chain.getBlock({ blockNumber: block })).timestamp) * 1000] as const)));
  return { transfers, activations, times, truncated };
}
