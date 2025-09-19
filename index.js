import 'dotenv/config';
import express from 'express';
import fetch from 'node-fetch';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { z } from 'zod';

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || 'https://pro-api.solscan.io';
const API_KEY = process.env.SOLSCAN_API_KEY;

// Health check
app.get('/health', (_req, res) => res.json({ ok: true }));

// ----- Solscan fetch helper
async function solscanGet(path, query = {}) {
  const url = new URL(`${BASE_URL}${path.startsWith('/') ? '' : '/'}${path}`);
  Object.entries(query || {}).forEach(([k, v]) => url.searchParams.set(k, v));
  const r = await fetch(url, { headers: { token: API_KEY } });
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  if (!r.ok) throw new Error(`Solscan error ${r.status}: ${String(text).slice(0, 400)}`);
  return data;
}

// ----- MCP server (درستش اینه!)
const server = new McpServer(
  { name: 'solscan-mcp-proxy', version: '1.0.0' },
  { capabilities: { logging: {} } }
);

// ابزار اصلی: GET به Solscan
server.tool(
  'solscan.get',
  {
    path: z.string(),
    query: z.record(z.any()).optional(),
  },
  async ({ path, query }) => {
    const data = await solscanGet(path, query || {});
    return { content: [{ type: 'json', json: data }] };
  }
);

// ----- SSE endpoint for MCP
app.get('/sse', async (_req, res) => {
  const transport = new SSEServerTransport('/messages', res);
  await server.connect(transport);
});

// messages stub (SSE transport پیام‌ها را هندل می‌کند)
app.post('/messages', (_req, res) => {
  res.status(200).json({ status: 'received' });
});

app.listen(PORT, () => console.log(`HTTP up on :${PORT}`));
