import 'dotenv/config';
import express from 'express';
import fetch from 'node-fetch';
import Bottleneck from 'bottleneck';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { z } from 'zod';

/* ---------- ENV ---------- */
const PORT = process.env.PORT || 3000;

const HELIUS_API_KEY  = process.env.HELIUS_API_KEY || '';
const HELIUS_RPC_URL  = process.env.HELIUS_RPC_URL || '';
const HELIUS_API_BASE = process.env.HELIUS_API_BASE || 'https://api.helius.xyz';

/* Full URLs از داشبورد (ترجیح داده می‌شوند) */
const HELIUS_PARSE_TX_URL   = process.env.HELIUS_PARSE_TX_URL || '';
const HELIUS_PARSE_ADDR_URL = process.env.HELIUS_PARSE_ADDR_URL || '';

const RATE_RPS         = Number(process.env.RATE_RPS || 12);
const RATE_CONCURRENCY = Number(process.env.RATE_CONCURRENCY || 1);
const RPC_TIMEOUT_MS   = Number(process.env.RPC_TIMEOUT_MS || 20000);
const RPC_MAX_RETRIES  = Number(process.env.RPC_MAX_RETRIES || 3);

if (!HELIUS_RPC_URL && !HELIUS_API_KEY) {
  console.error('[FATAL] Provide HELIUS_RPC_URL or HELIUS_API_KEY');
  process.exit(1);
}

/* ---------- APP ---------- */
const app = express();
app.use(express.json({ limit: '1mb' }));

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    rpc: !!HELIUS_RPC_URL,
    parse_tx_url: !!HELIUS_PARSE_TX_URL,
    parse_addr_url: !!HELIUS_PARSE_ADDR_URL
  });
});

/* ---------- Limiter ---------- */
const limiter = new Bottleneck({
  reservoir: RATE_RPS,
  reservoirRefreshAmount: RATE_RPS,
  reservoirRefreshInterval: 1000,
  maxConcurrent: RATE_CONCURRENCY,
});

/* ---------- Helpers ---------- */
async function fetchWithTimeout(url, options = {}, timeoutMs = RPC_TIMEOUT_MS) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(url, { ...options, signal: controller.signal });
    return r;
  } finally {
    clearTimeout(id);
  }
}

async function rpcCall(method, params = []) {
  const body = { jsonrpc: '2.0', id: 1, method, params };
  let attempt = 0;
  while (true) {
    try {
      const r = await limiter.schedule(() =>
        fetchWithTimeout(HELIUS_RPC_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
      );
      const text = await r.text();
      let data; try { data = JSON.parse(text); } catch { data = text; }
      if (!r.ok) throw new Error(`RPC HTTP ${r.status}: ${text?.slice?.(0,400)}`);
      if (data?.error) throw new Error(`RPC Error: ${JSON.stringify(data.error)}`);
      return data?.result;
    } catch (e) {
      attempt += 1;
      if (attempt > RPC_MAX_RETRIES) throw e;
      await new Promise(s => setTimeout(s, Math.min(250 * attempt, 1500)));
    }
  }
}

/* Enhanced API — GET/POST (با پشتیبانی از Full URL یا Base) */
function buildUrl(baseOrFull, path, q = {}) {
  const u = new URL(baseOrFull.startsWith('http') ? baseOrFull :
    `${HELIUS_API_BASE}${path.startsWith('/') ? path : `/${path}`}`);
  // api-key اگر نبود، اضافه کن
  if (!u.searchParams.get('api-key') && HELIUS_API_KEY) {
    u.searchParams.set('api-key', HELIUS_API_KEY);
  }
  Object.entries(q).forEach(([k,v]) => (v !== undefined && v !== null) && u.searchParams.set(k, String(v)));
  return u.toString();
}

async function dasGET({ fullUrl = '', path = '', query = {} }) {
  const url = fullUrl ? buildUrl(fullUrl, '', query) : buildUrl(HELIUS_API_BASE, path, query);
  const r = await limiter.schedule(() => fetchWithTimeout(url, { method: 'GET' }));
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  if (!r.ok) throw new Error(`DAS GET ${r.status}: ${text?.slice?.(0,400)}`);
  return data;
}

async function dasPOST({ fullUrl = '', path = '', query = {}, body = {} }) {
  const url = fullUrl ? buildUrl(fullUrl, '', query) : buildUrl(HELIUS_API_BASE, path, query);
  const r = await limiter.schedule(() => fetchWithTimeout(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }));
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  if (!r.ok) throw new Error(`DAS POST ${r.status}: ${text?.slice?.(0,400)}`);
  return data;
}

/* ---------- MCP server ---------- */
const mcp = new McpServer({ name: 'helius-mcp', version: '1.1.0' }, { capabilities: { logging: {} } });

mcp.tool('rpc.call', { method: z.string(), params: z.array(z.any()).optional() }, async ({ method, params }) => {
  const result = await rpcCall(method, params ?? []);
  return { content: [{ type: 'json', json: result }] };
});

/* Parse Transaction(s) — Enhanced API (POST) */
mcp.tool('helius.parseTransactions', {
  transactions: z.array(z.string()),   // آرایه‌ای از TX sig ها
  fullUrl: z.string().optional()
}, async ({ transactions, fullUrl }) => {
  const url = fullUrl || HELIUS_PARSE_TX_URL || ''; // ترجیح: Full URL از Env
  const result = await dasPOST({
    fullUrl: url || '',
    path: url ? '' : '/v0/transactions',
    body: transactions
  });
  return { content: [{ type: 'json', json: result }] };
});

/* Address Transaction History — Enhanced API (GET) */
mcp.tool('helius.addressHistory', {
  address: z.string(),
  limit: z.number().optional(),
  before: z.string().optional(), // signature cursor
  fullUrl: z.string().optional()
}, async ({ address, limit = 100, before = '', fullUrl }) => {
  let url = fullUrl || HELIUS_PARSE_ADDR_URL || '';
  if (url && url.includes('{address}')) {
    url = url.replace('{address}', address);
  }
  const result = await dasGET({
    fullUrl: url || '',
    path: url ? '' : `/v0/addresses/${address}/transactions`,
    query: { limit, before }
  });
  return { content: [{ type: 'json', json: result }] };
});

/* SSE endpoint for MCP */
app.get('/sse', async (_req, res) => {
  const transport = new SSEServerTransport('/messages', res);
  await mcp.connect(transport);
});
app.post('/messages', (_req, res) => res.status(200).json({ status: 'ok' }));

/* ---------- Start ---------- */
app.listen(PORT, () => {
  console.log(`[MCP-Helius] listening on :${PORT}`);
  console.log(`RPC: ${HELIUS_RPC_URL ? '✓' : '—'}`);
  console.log(`ParseTX: ${HELIUS_PARSE_TX_URL ? '✓' : 'via base'}`);
  console.log(`AddrHist: ${HELIUS_PARSE_ADDR_URL ? '✓' : 'via base'}`);
});
