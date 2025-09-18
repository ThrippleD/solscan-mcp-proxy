import 'dotenv/config';
import express from 'express';
import fetch from 'node-fetch';
import { Server as MCPServer } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { z } from 'zod';

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || 'https://pro-api.solscan.io';
const API_KEY = process.env.SOLSCAN_API_KEY;

app.get('/health', (_req, res) => res.status(200).send('Running'));

async function solscanGet(path, query = {}) {
  if (!API_KEY) throw new Error('Missing SOLSCAN_API_KEY');
  const url = new URL(path.startsWith('/') ? path : `/${path}`, BASE_URL);
  Object.entries(query).forEach(([k, v]) => url.searchParams.set(k, v));
  const r = await fetch(url, { headers: { token: API_KEY } });
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  if (!r.ok) throw new Error(`Solscan error ${r.status}: ${String(text).slice(0,400)}`);
  return data;
}

const server = new MCPServer({ name: 'solscan-mcp', version: '1.0.0' });

server.tool(
  'solscan.get',
  { path: z.string(), query: z.object({}).passthrough().optional() },
  async ({ path, query }) => {
    const data = await solscanGet(path, query || {});
    return { content: [{ type: 'json', json: data }] };
  }
);

app.get('/sse', async (req, res) => {
  const transport = new SSEServerTransport('/messages', res);
  await server.connect(transport);
});

app.post('/messages', async (_req, res) => res.status(200).json({ status: 'received' }));

app.listen(PORT, () => console.log(`HTTP up on :${PORT}`));
