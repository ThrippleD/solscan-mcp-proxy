// index.js — NALH Helius MCP (ALL Filters & Metrics v1)
// Runtime: Node >= 20 (ESM)
// Env required on Render/GitHub:
//   HELIUS_API_KEY
//   HELIUS_API_BASE=https://api.helius.xyz
//   HELIUS_RPC_URL=https://mainnet.helius-rpc.com/?api-key=XXXX
//   HELIUS_PARSE_TX_URL=https://api.helius.xyz/v0/transactions?api-key=XXXX
//   HELIUS_PARSE_ADDR_URL=https://api.helius.xyz/v0/addresses/{address}/transactions?api-key=XXXX
//   PORT=3000
//   RATE_RPS=12
//   RATE_CONCURRENCY=1
//   RPC_TIMEOUT_MS=20000
//   RPC_MAX_RETRIES=3
// Notes:
// - This file exposes an MCP server over SSE (/sse) with tools that mirror the full
//   Neo Aion LightHouse Filters & Metrics spec (Persian/English engineering mirror X).
// - Social Hype (off‑chain) is intentionally excluded from on-chain tools.

import express from "express";
import fetch from "node-fetch";
import Bottleneck from "bottleneck";
import dotenv from "dotenv";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";

dotenv.config();

// ===== Constants
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"; // mainnet USDC
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"; // SPL Token v2
const TOKEN_2022_PROGRAM = "TokenzQdBNbLqPSEvdnKAS6EPFCLPiNnBhqCxEPcXfwE"; // SPL Token‑2022

// ===== Env
const PORT = Number(process.env.PORT || 3000);
const HELIUS_API_KEY = process.env.HELIUS_API_KEY?.trim();
const HELIUS_API_BASE = (process.env.HELIUS_API_BASE || "https://api.helius.xyz").replace(/\/$/, "");
const HELIUS_RPC_URL = (process.env.HELIUS_RPC_URL || `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY || ""}`).replace(/\/$/, "");
const HELIUS_PARSE_TX_URL = (process.env.HELIUS_PARSE_TX_URL || `${HELIUS_API_BASE}/v0/transactions?api-key=${HELIUS_API_KEY || ""}`);
const HELIUS_PARSE_ADDR_URL = (process.env.HELIUS_PARSE_ADDR_URL || `${HELIUS_API_BASE}/v0/addresses/{address}/transactions?api-key=${HELIUS_API_KEY || ""}`);
const RATE_RPS = Number(process.env.RATE_RPS || 12);
const RATE_CONCURRENCY = Number(process.env.RATE_CONCURRENCY || 1);
const RPC_TIMEOUT_MS = Number(process.env.RPC_TIMEOUT_MS || 20000);
const RPC_MAX_RETRIES = Number(process.env.RPC_MAX_RETRIES || 3);

// ===== Rate limiter
const limiter = new Bottleneck({ minTime: Math.ceil(1000 / Math.max(1, RATE_RPS)), maxConcurrent: Math.max(1, RATE_CONCURRENCY) });

// ===== Helpers
async function rpc(method, params = []) {
  const body = { jsonrpc: "2.0", id: 1, method, params };
  for (let i = 0; i <= RPC_MAX_RETRIES; i++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), RPC_TIMEOUT_MS);
    try {
      const r = await limiter.schedule(() => fetch(HELIUS_RPC_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: ctrl.signal }));
      clearTimeout(t);
      if (!r.ok) throw new Error(`rpc ${method} http ${r.status}`);
      const j = await r.json();
      if (j.error) throw new Error(`rpc ${method} error: ${j.error.message}`);
      return j.result;
    } catch (e) {
      if (i === RPC_MAX_RETRIES) throw e;
      await new Promise(res => setTimeout(res, 250 * (i + 1)));
    }
  }
}

async function heliusGET(url) {
  const r = await limiter.schedule(() => fetch(url));
  if (!r.ok) throw new Error(`helius http ${r.status}`);
  return r.json();
}

function assertPubkey(x) { if (!x || typeof x !== "string" || x.length < 32) throw new Error("invalid pubkey/mint"); }

function toBN(x) { return BigInt(String(x)); }
function pow10(d) { return BigInt(10) ** BigInt(d); }
function uiFromRaw(amountBN, dec) { return Number(amountBN) / 10 ** dec; }

// ===== Low-level primitives
async function getAccountInfoParsed(pubkey) {
  const r = await rpc("getAccountInfo", [pubkey, { encoding: "jsonParsed" }]);
  return r?.value?.data?.parsed?.info || null;
}

async function getMintSupply(mint) {
  assertPubkey(mint);
  const r = await rpc("getTokenSupply", [mint]);
  return { amount: BigInt(r.value.amount), decimals: r.value.decimals, ui: uiFromRaw(BigInt(r.value.amount), r.value.decimals) };
}

async function getTokenAccountBalance(ta) {
  const r = await rpc("getTokenAccountBalance", [ta]);
  return { amount: BigInt(r.value.amount), decimals: r.value.decimals, ui: uiFromRaw(BigInt(r.value.amount), r.value.decimals) };
}

async function getProgramAccountsByMint(mint, programId) {
  const filters = [{ memcmp: { offset: 0, bytes: mint } }];
  const r = await rpc("getProgramAccounts", [programId, { encoding: "jsonParsed", commitment: "confirmed", filters }]);
  return Array.isArray(r) ? r : [];
}

// ====== CORE QUANT METRICS (1. Core Filters & Core Quantitative Metrics)
// TVL/price/FDV via pool reserves (USDC side inference)
async function poolReserves(reserveX, reserveY) {
  const [ax, ay] = await Promise.all([getTokenAccountBalance(reserveX), getTokenAccountBalance(reserveY)]);
  const [ix, iy] = await Promise.all([getAccountInfoParsed(reserveX), getAccountInfoParsed(reserveY)]);
  const mintX = ix?.mint, mintY = iy?.mint;
  let usdc = ax, tok = ay, tokMint = mintY, usdcMint = mintX;
  if (mintY === USDC_MINT) { usdc = ay; tok = ax; usdcMint = mintY; tokMint = mintX; }
  if (mintX === USDC_MINT) { usdc = ax; tok = ay; usdcMint = mintX; tokMint = mintY; }
  // Fallback heuristic by decimals
  if (!usdcMint && ay.decimals === 6 && ax.decimals !== 6) { usdc = ay; tok = ax; }
  return { usdc, tok, tokMint, usdcMint };
}

async function priceAndFDVFromReserves(tokenMint, reserveX, reserveY) {
  const { usdc, tok } = await poolReserves(reserveX, reserveY);
  if (tok.ui <= 0 || usdc.ui <= 0) throw new Error("pool reserves are zero");
  const price = usdc.ui / tok.ui; // USDC per token
  const supply = await getMintSupply(tokenMint);
  const fdv = price * supply.ui;
  return { price_usd: price, fdv_usd: fdv, total_supply: supply.ui, pool_usdc: usdc.ui, pool_token: tok.ui };
}

async function tvlTotalUSDC(pools /* array of {reserve_x, reserve_y} */) {
  let tvl = 0;
  for (const p of pools) {
    const { usdc } = await poolReserves(p.reserve_x, p.reserve_y);
    tvl += usdc.ui * 2; // rough: USDC side *2 (symmetry assumption)
  }
  return { tvl_usd: tvl };
}

async function lpProvidersCount(lpMint, excludeOwners = []) {
  const [v1, v2] = await Promise.all([
    getProgramAccountsByMint(lpMint, TOKEN_PROGRAM),
    getProgramAccountsByMint(lpMint, TOKEN_2022_PROGRAM)
  ]);
  const set = new Set(); let sum = 0;
  for (const row of [...v1, ...v2]) {
    const info = row?.account?.data?.parsed?.info; if (!info) continue;
    const owner = info.owner; const ui = Number(info.tokenAmount?.uiAmount || 0);
    if (ui > 0 && !excludeOwners.includes(owner)) { set.add(owner); sum += ui; }
  }
  const sup = await getMintSupply(lpMint);
  return { lp_mint: lpMint, holders: set.size, lp_sum_balances: sum, lp_total_supply: sup.ui };
}

async function lpLockedPercent(lpMint, lockerOwners = []) {
  const [v1, v2, sup] = await Promise.all([
    getProgramAccountsByMint(lpMint, TOKEN_PROGRAM),
    getProgramAccountsByMint(lpMint, TOKEN_2022_PROGRAM),
    getMintSupply(lpMint)
  ]);
  let locked = 0;
  for (const row of [...v1, ...v2]) {
    const info = row?.account?.data?.parsed?.info; if (!info) continue;
    if (lockerOwners.includes(info.owner)) locked += Number(info.tokenAmount?.uiAmount || 0);
  }
  return { lp_total_supply: sup.ui, locked_ui: locked, locked_pct: sup.ui ? (locked / sup.ui) * 100 : 0 };
}

async function mintAuthorities(mint) {
  const info = await getAccountInfoParsed(mint);
  const mintAuthority = info?.mintAuthority ?? null;
  const freezeAuthority = info?.freezeAuthority ?? null;
  const supply = await getMintSupply(mint);
  return { mintAuthority, freezeAuthority, isMintRevoked: !mintAuthority, isFreezeRevoked: !freezeAuthority, decimals: supply.decimals };
}

async function topHolders(mint, limit = 20) {
  const [v1, v2, sup] = await Promise.all([
    getProgramAccountsByMint(mint, TOKEN_PROGRAM),
    getProgramAccountsByMint(mint, TOKEN_2022_PROGRAM),
    getMintSupply(mint)
  ]);
  const items = [];
  for (const row of [...v1, ...v2]) {
    const info = row?.account?.data?.parsed?.info; if (!info) continue;
    const owner = info.owner; const ui = Number(info.tokenAmount?.uiAmount || 0);
    if (ui > 0) items.push({ owner, ui });
  }
  items.sort((a,b)=>b.ui-a.ui);
  const top = items.slice(0, limit).map((x,i)=>({ rank:i+1, owner:x.owner, amount:x.ui, pct_of_supply: sup.ui? (x.ui/sup.ui)*100:0 }));
  const top1 = top[0]?.pct_of_supply || 0;
  const top10 = top.slice(0,10).reduce((s,x)=>s+x.pct_of_supply,0);
  return { supply: sup.ui, total_accounts: items.length, top, concentration_top1_pct: top1, concentration_top10_pct: top10 };
}

// Activity windows (5m, 15m, 1/4/6/12/24/48/72h) by address list (pool, mint ATA owners, etc.)
async function activityWindows(addresses, windowsMinutes /* [5,15,60,240,360,720,1440,2880,4320] */) {
  const now = Math.floor(Date.now()/1000);
  const results = {};
  for (const w of windowsMinutes) results[w] = { tx: 0, volume_usdc: 0, unique_actors: 0 };
  const actorSets = Object.fromEntries(windowsMinutes.map(w=>[w, new Set()]));
  for (const addr of addresses) {
    const url = new URL(HELIUS_PARSE_ADDR_URL.replace("{address}", addr));
    url.searchParams.set("limit","500");
    url.searchParams.set("until","now");
    const arr = await heliusGET(url.toString());
    for (const it of arr) {
      const ts = it.blockTime || 0; if (!ts) continue;
      const dtMin = (now - ts) / 60;
      for (const w of windowsMinutes) {
        if (dtMin <= w) {
          results[w].tx += 1;
          for (const t of (it.tokenTransfers || [])) {
            if (t.mint === USDC_MINT) results[w].volume_usdc += Math.abs(Number(t.tokenAmount||0));
            if (t.fromUserAccount) actorSets[w].add(t.fromUserAccount);
            if (t.toUserAccount) actorSets[w].add(t.toUserAccount);
          }
        }
      }
    }
  }
  for (const w of windowsMinutes) results[w].unique_actors = actorSets[w].size;
  return results;
}

// Token age (seconds -> days)
async function tokenAgeDays(address) {
  const base = HELIUS_PARSE_ADDR_URL.replace("{address}", address);
  const url = new URL(base);
  url.searchParams.set("limit","1000");
  const arr = await heliusGET(url.toString());
  const oldest = arr[arr.length-1]?.blockTime || arr[0]?.blockTime || null;
  if (!oldest) return { days: null };
  return { days: (Date.now()/1000 - oldest)/86400 };
}

// Global Fees Paid (approx) = sum(tx.fee) for provided addresses in last 24h
async function globalFeesPaid24h(addresses) {
  const since = Math.floor(Date.now()/1000) - 86400;
  let fees = 0, txs = 0;
  for (const addr of addresses) {
    const url = new URL(HELIUS_PARSE_ADDR_URL.replace("{address}", addr));
    url.searchParams.set("limit", "500");
    url.searchParams.set("until", "now");
    const arr = await heliusGET(url.toString());
    for (const it of arr) {
      if ((it.blockTime||0) < since) continue;
      txs += 1;
      if (typeof it.fee === "number") fees += it.fee; // lamports
    }
  }
  return { tx_24h: txs, fees_lamports_24h: fees, fees_sol_24h: fees/1e9 };
}

// Deposit Vault sum (sum balances of given vault token accounts for the token mint)
async function depositVaultSum(vaultTokenAccounts /* array of token-account pubkeys */) {
  let sum = 0; let dec = 0;
  for (const ta of vaultTokenAccounts) { const b = await getTokenAccountBalance(ta); sum += b.ui; dec = b.decimals; }
  return { sum_ui: sum, decimals: dec };
}

// Traders / Trades / Volume 24h by addresses
async function tradersTradesVolume24h(addresses) {
  const since = Math.floor(Date.now()/1000) - 86400;
  const actors = new Set(); let trades = 0; let volUSDC = 0;
  for (const addr of addresses) {
    const url = new URL(HELIUS_PARSE_ADDR_URL.replace("{address}", addr));
    url.searchParams.set("limit","500"); url.searchParams.set("until","now");
    const arr = await heliusGET(url.toString());
    for (const it of arr) {
      if ((it.blockTime||0) < since) continue;
      trades += 1;
      for (const t of (it.tokenTransfers||[])) {
        if (t.fromUserAccount) actors.add(t.fromUserAccount);
        if (t.toUserAccount) actors.add(t.toUserAccount);
        if (t.mint === USDC_MINT) volUSDC += Math.abs(Number(t.tokenAmount||0));
      }
    }
  }
  return { unique_traders_24h: actors.size, total_trades_24h: trades, total_volume_usdc_24h: volUSDC };
}

// FDV / MC ratio helper
function fdvToMcap(price, totalSupply, circulatingSupply = null) {
  const fdv = price * totalSupply;
  const mc = price * (circulatingSupply ?? totalSupply);
  return { fdv_usd: fdv, marketcap_usd: mc, fdv_to_mcap: mc ? fdv/mc : null };
}

// ====== ADVANCED & CUSTOM FILTERS (2.)
async function vipWalletsPresence(vipAddresses /* string[] */, addressesToScan /* pool or mint owners */) {
  const since = Math.floor(Date.now()/1000) - 86400;
  const vip = new Set(vipAddresses.map(s=>s.trim()).filter(Boolean));
  const hits = new Map();
  for (const addr of addressesToScan) {
    const url = new URL(HELIUS_PARSE_ADDR_URL.replace("{address}", addr));
    url.searchParams.set("limit","500"); url.searchParams.set("until","now");
    const arr = await heliusGET(url.toString());
    for (const it of arr) {
      if ((it.blockTime||0) < since) continue;
      for (const t of (it.tokenTransfers||[])) {
        const a = t.fromUserAccount || ""; const b = t.toUserAccount || "";
        if (vip.has(a) || vip.has(b)) {
          const hit = vip.has(a) ? a : b; const prev = hits.get(hit) || 0; hits.set(hit, prev+1);
        }
      }
    }
  }
  return { vip_count: hits.size, vip_hits: Array.from(hits.entries()).map(([address,count])=>({ address, count })) };
}

async function devBehavior(devAddresses /* string[] */, addressesToScan /* pool/mint */) {
  const since = Math.floor(Date.now()/1000) - 86400;
  let suspicious = [];
  for (const dev of devAddresses) {
    const url = new URL(HELIUS_PARSE_ADDR_URL.replace("{address}", dev));
    url.searchParams.set("limit","500"); url.searchParams.set("until","now");
    const arr = await heliusGET(url.toString());
    for (const it of arr) {
      if ((it.blockTime||0) < since) continue;
      const hasLP = (it.tokenTransfers||[]).some(x=>x.tokenStandard==="lpToken" || /LP/i.test(x.tokenSymbol||""));
      const large = (it.nativeTransfers||[]).some(x=>Math.abs(Number(x.amount||0)) > 2*1e9); // >2 SOL as example
      if (hasLP || large) suspicious.push({ dev, sig: it.signature, blockTime: it.blockTime, note: hasLP?"LP move":"large SOL move" });
    }
  }
  return { suspicious };
}

function devLinkToSuccess(devAddress, knownCreators /* string[] */) {
  const set = new Set(knownCreators.map(s=>s.trim()));
  return { linked: set.has(devAddress), dev: devAddress };
}

async function revivalDetector(poolAddresses /* string[] */) {
  const win = await activityWindows(poolAddresses, [60*24, 60*72]); // 24h vs 72h
  const daily = win[1440] || { tx:0, volume_usdc:0 };
  const tri = win[4320] || { tx:1, volume_usdc:1 };
  const multiplier = (daily.volume_usdc / (tri.volume_usdc/3));
  return { revival_active: multiplier > 3, multiplier, daily_volume_usdc: daily.volume_usdc };
}

async function firstWaveBuyers(poolAddress /* pair vault/reserve owner address */ , minutes = 10, vipList = []) {
  const since = Math.floor(Date.now()/1000) - (minutes*60);
  const url = new URL(HELIUS_PARSE_ADDR_URL.replace("{address}", poolAddress));
  url.searchParams.set("limit","500"); url.searchParams.set("until","now");
  const arr = await heliusGET(url.toString());
  const vip = new Set(vipList);
  const buyers = new Map();
  for (const it of arr) {
    if ((it.blockTime||0) < since) continue;
    for (const t of (it.tokenTransfers||[])) {
      if (t.toUserAccount) buyers.set(t.toUserAccount, (buyers.get(t.toUserAccount)||0) + Math.abs(Number(t.tokenAmount||0)));
    }
  }
  const list = Array.from(buyers.entries()).map(([address,amount])=>({ address, amount, vip: vip.has(address) }));
  list.sort((a,b)=>b.amount-a.amount);
  return { buyers: list, count: list.length, vip_count: list.filter(x=>x.vip).length };
}

// ====== SCORING (3.)
function scoreToken(inputs) {
  // inputs = {
  //   lpProvidersMin, lpLockedMinPct, decimalsPref:[9,6], maxTop1Pct, maxTop10Pct,
  //   priceUsd, totalSupply, circulatingSupply, activity24h:{traders,trades,volume},
  //   vipHits, revivalActive, tokenAgeDays,
  //   weights: { lpCount, lpLocked, holdersDist, activity, vip, revival, age, fdvToMc }
  // }
  const w = inputs.weights || { lpCount:2, lpLocked:2, holdersDist:2, activity:1, vip:1, revival:1, age:1, fdvToMc:1 };
  let score = 0; const reasons = [];
  if (inputs.lpProviders >= inputs.lpProvidersMin) { score += 10*w.lpCount; } else reasons.push("LP providers below threshold");
  if (inputs.lpLockedPct >= inputs.lpLockedMinPct) { score += 8*w.lpLocked; } else reasons.push("LP locked pct low");
  if (inputs.concentrationTop1Pct <= inputs.maxTop1Pct) { score += 6*w.holdersDist; } else reasons.push("Top1 concentration high");
  if (inputs.concentrationTop10Pct <= inputs.maxTop10Pct) { score += 6*w.holdersDist; } else reasons.push("Top10 concentration high");
  if ((inputs.activity24h?.traders||0) >= (inputs.minTraders24h||0)) score += 5*w.activity; else reasons.push("Low traders 24h");
  if ((inputs.vipHits||0) > 0) score += 4*w.vip; 
  if (inputs.revivalActive) score += 3*w.revival;
  if (inputs.tokenAgeDays <= (inputs.maxAgeDays||0.25)) score += 2*w.age; // 0.25 ~ 6h
  if ((inputs.fdvToMc||1) >= 0.9 && (inputs.fdvToMc||1) <= 1.1) score += 4*w.fdvToMc; // FDV≈MC
  return { score, reasons };
}

// ====== ADVANCED (4.) — stubs with structure for future wiring
function mlSuggestWallets() { return { status: "todo", note: "ML on previous successful hunts" }; }
function discoverNewProfitWallets() { return { status: "todo", note: "auto discovery of profitable wallets" }; }
function analyzeTokenomics(options={}) { return { status: "todo", note: "deflation/mintable/tax change analysis", options }; }

// ====== FEATURES/UTILITY (5., 6.)
function blacklistCheck(address, blacklist=[]) { const set = new Set(blacklist); return { address, blacklisted: set.has(address) }; }

// ====== HTTP (health)
const app = express();
app.get("/health", (_req,res)=>res.json({ ok:true, rpc: !!HELIUS_RPC_URL, api: !!HELIUS_API_KEY }));
app.post("/messages", (_req,res)=>res.status(200).json({ status: "received" }));

// ====== MCP server + tools
const server = new McpServer({ name: "NALH-Helius-MCP", version: "1.0.0" }, { capabilities: { logging: {} } });

function addTool(name, schema, impl, description) {
  server.tool(name, schema, async (args) => {
    const out = await impl(args);
    return { content: [{ type: "json", json: out }] };
  }, { description });
}

// --- RAW
addTool("raw.rpc", z.object({ method: z.string(), params: z.array(z.any()).optional() }), ({ method, params }) => rpc(method, params||[]), "Raw Solana RPC passthrough");
addTool("raw.helius_get", z.object({ url: z.string() }), ({ url }) => heliusGET(url), "Raw Helius GET");

// --- CORE FILTERS & QUANT METRICS (exact names kept in descriptions)
addTool("metrics.token_supply", z.object({ mint: z.string() }), ({ mint }) => getMintSupply(mint), "Total supply / decimals / ui");
addTool("metrics.price_fdv_from_reserves", z.object({ token_mint: z.string(), reserve_x: z.string(), reserve_y: z.string() }), ({ token_mint, reserve_x, reserve_y }) => priceAndFDVFromReserves(token_mint, reserve_x, reserve_y), "Price & FDV via USDC pool reserves");
addTool("metrics.tvl_total_usdc", z.object({ pools: z.array(z.object({ reserve_x: z.string(), reserve_y: z.string() })) }), ({ pools }) => tvlTotalUSDC(pools), "TVL sum across pools (USDC‑based)");
addTool("metrics.lp_providers_count", z.object({ lp_mint: z.string(), excludeOwners: z.array(z.string()).optional() }), ({ lp_mint, excludeOwners }) => lpProvidersCount(lp_mint, excludeOwners||[]), "LP providers (unique LP token holders)");
addTool("metrics.lp_locked_percent", z.object({ lp_mint: z.string(), lockerOwners: z.array(z.string()).optional() }), ({ lp_mint, lockerOwners }) => lpLockedPercent(lp_mint, lockerOwners||[]), "LP locked % by locker/burn owners");
addTool("metrics.mint_authorities", z.object({ mint: z.string() }), ({ mint }) => mintAuthorities(mint), "Mint/Freeze authorities (revoked / multisig check)");
addTool("metrics.top_holders", z.object({ mint: z.string(), limit: z.number().int().min(1).max(100).optional() }), ({ mint, limit }) => topHolders(mint, limit||20), "Top holders & concentration");
addTool("metrics.activity_windows", z.object({ addresses: z.array(z.string()), windows_minutes: z.array(z.number()).default([5,15,60,240,360,720,1440,2880,4320]) }), ({ addresses, windows_minutes }) => activityWindows(addresses, windows_minutes), "TX/USDC/actors across windows 5m/15m/1/4/6/12/24/48/72h");
addTool("metrics.global_fees_paid_24h", z.object({ addresses: z.array(z.string()) }), ({ addresses }) => globalFeesPaid24h(addresses), "Global_Fees_Paid (GFP) 24h over addresses");
addTool("metrics.deposit_vault_sum", z.object({ vault_token_accounts: z.array(z.string()) }), ({ vault_token_accounts }) => depositVaultSum(vault_token_accounts), "Deposit_Vault sum over vault token accounts");
addTool("metrics.traders_trades_volume_24h", z.object({ addresses: z.array(z.string()) }), ({ addresses }) => tradersTradesVolume24h(addresses), "No_Traders_24H / Total_Trades_24H / Total_Volume_24H (USDC)");
addTool("metrics.fdv_to_mcap", z.object({ price_usd: z.number(), total_supply: z.number(), circulating_supply: z.number().nullable().optional() }), ({ price_usd, total_supply, circulating_supply }) => fdvToMcap(price_usd, total_supply, circulating_supply ?? null), "FDV_to_MCap ratio");

// --- ADVANCED & CUSTOM (VIP, dev/team, whales, revival, blacklist)
addTool("filters.vip_wallets_presence", z.object({ vip_addresses: z.array(z.string()), addresses_to_scan: z.array(z.string()) }), ({ vip_addresses, addresses_to_scan }) => vipWalletsPresence(vip_addresses, addresses_to_scan), "VIP/Smart Wallet presence");
addTool("filters.dev_behavior", z.object({ dev_addresses: z.array(z.string()), addresses_to_scan: z.array(z.string()) }), ({ dev_addresses, addresses_to_scan }) => devBehavior(dev_addresses, addresses_to_scan), "Dev/Team behavior (LP or large moves)");
addTool("filters.dev_link_success", z.object({ dev_address: z.string(), known_creators: z.array(z.string()) }), ({ dev_address, known_creators }) => devLinkToSuccess(dev_address, known_creators), "Link Dev/Team to known successful creators");
addTool("filters.revival_detector", z.object({ pool_addresses: z.array(z.string()) }), ({ pool_addresses }) => revivalDetector(pool_addresses), "Revival/Zombie detection by surge multiplier");
addTool("filters.first_wave_buyers", z.object({ pool_address: z.string(), minutes: z.number().int().min(1).max(60).default(10), vip_list: z.array(z.string()).optional() }), ({ pool_address, minutes, vip_list }) => firstWaveBuyers(pool_address, minutes, vip_list||[]), "First wave buyers count & VIP flag");
addTool("filters.blacklist_check", z.object({ address: z.string(), blacklist: z.array(z.string()).default([]) }), ({ address, blacklist }) => blacklistCheck(address, blacklist), "Blacklist/Ignore check");

// --- SCORING
addTool("score.compute", z.object({
  inputs: z.object({
    lpProviders: z.number(), lpProvidersMin: z.number(), lpLockedPct: z.number(), lpLockedMinPct: z.number(),
    concentrationTop1Pct: z.number(), maxTop1Pct: z.number(), concentrationTop10Pct: z.number(), maxTop10Pct: z.number(),
    activity24h: z.object({ traders: z.number().default(0) }).default({ traders:0 }), minTraders24h: z.number().default(0),
    vipHits: z.number().default(0), revivalActive: z.boolean().default(false), tokenAgeDays: z.number().default(0.0),
    fdvToMc: z.number().nullable().optional(), maxAgeDays: z.number().default(0.25),
    weights: z.object({ lpCount: z.number().default(2), lpLocked: z.number().default(2), holdersDist: z.number().default(2), activity: z.number().default(1), vip: z.number().default(1), revival: z.number().default(1), age: z.number().default(1), fdvToMc: z.number().default(1) }).optional()
  })
}), ({ inputs }) => scoreToken(inputs), "Dynamic scoring per NALH spec (weights adjustable)");

// --- ADVANCED FUTURE (stubs)
addTool("advanced.ml_suggest_wallets", z.object({}).optional().default({}), () => mlSuggestWallets(), "ML on successful hunts (future)");
addTool("advanced.discover_profit_wallets", z.object({}).optional().default({}), () => discoverNewProfitWallets(), "Auto discovery of profitable wallets (future)");
addTool("advanced.tokenomics_analyze", z.object({ options: z.record(z.any()).optional() }), ({ options }) => analyzeTokenomics(options||{}), "Advanced tokenomics (deflation/mintable/tax change)");

// --- MCP (SSE) bootstrap — SDK 0.2.x
// مهم: هیچ body-parser روی /messages ست نکن؛ خود ترنسپورت روت‌ها را رجیستر می‌کند
const transport = new SSEServerTransport("/sse", app);
await server.connect(transport);

// Health
app.get("/health", (_req, res) =>
  res.json({ ok: true, rpc: !!HELIUS_RPC_URL, api: !!HELIUS_API_KEY })
);

// Start HTTP
app.listen(PORT, () => console.log(`HTTP up on :${PORT}`));

