import 'dotenv/config';
import express from 'express';
import fetch from 'node-fetch';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { z } from 'zod';

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const QUICKNODE_HTTP_URL = process.env.QUICKNODE_HTTP_URL;
const RPC_COMMITMENT = process.env.RPC_COMMITMENT || 'processed';
const RPC_TIMEOUT_MS = Number(process.env.RPC_TIMEOUT_MS || 12000);
const RPC_MAX_RETRIES = Number(process.env.RPC_MAX_RETRIES || 2);

if (!QUICKNODE_HTTP_URL) {
  console.error('Missing QUICKNODE_HTTP_URL');
  process.exit(1);
}

app.get('/health', (_req, res) => res.json({ ok: true, provider: 'quicknode' }));

// ---------- QuickNode RPC helper (timeout + retry) ----------
async function qnRpc(method, params = []) {
  let lastErr;
  for (let attempt = 0; attempt <= RPC_MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), RPC_TIMEOUT_MS);
    try {
      const body = JSON.stringify({
        jsonrpc: '2.0',
        id: Date.now(),
        method,
        params: params.length ? params : [{ commitment: RPC_COMMITMENT }],
      });
      const r = await fetch(QUICKNODE_HTTP_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        signal: controller.signal,
      });
      const json = await r.json().catch(async () => ({ text: await r.text() }));
      clearTimeout(timer);
      if (!r.ok || (json && json.error)) {
        const msg = json && json.error ? JSON.stringify(json.error) : await r.text();
        throw new Error(`RPC ${r.status}: ${String(msg).slice(0, 400)}`);
      }
      return json;
    } catch (e) {
      lastErr = e;
      if (attempt === RPC_MAX_RETRIES) break;
      await new Promise((rs) => setTimeout(rs, 350 * (attempt + 1)));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

// ---------- MCP Server ----------
const server = new McpServer(
  { name: 'quicknode-mcp-proxy', version: '1.0.0' },
  { capabilities: { logging: {} } }
);

// ابزار MCP: Solana RPC از طریق QuickNode
server.tool(
  'solana.rpc',
  {
    method: z.string(),
    params: z.array(z.any()).optional(),
  },
  async ({ method, params }) => {
    const out = await qnRpc(method, params || []);
    return { content: [{ type: 'json', json: out }] };
  }
);

// SSE endpoint برای MCP
app.get('/sse', async (_req, res) => {
  const transport = new SSEServerTransport('/messages', res);
  await server.connect(transport);
});

// stub پیام‌ها
app.post('/messages', (_req, res) => res.status(200).json({ status: 'received' }));

// REST تست سریع (اختیاری)
app.post('/rpc', async (req, res) => {
  try {
    const { method, params = [] } = req.body || {};
    if (!method) return res.status(400).json({ error: 'method is required' });
    const out = await qnRpc(method, params);
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.listen(PORT, () => console.log(`HTTP up on :${PORT}`));
