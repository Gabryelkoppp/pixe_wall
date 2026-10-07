const http = require('http');
const os = require('os');
const path = require('path');
const express = require('express');
const { WebSocketServer } = require('ws');
const { createClient } = require('redis');


const intEnv = (name, def) => {
  const n = parseInt(process.env[name], 10);
  return Number.isFinite(n) ? n : def;
};
const clamp = (n, min, max) => Math.min(max, Math.max(min, n));

const HOST = os.hostname(); 
const PORT = intEnv('PORT', 3000);
const WIDTH = clamp(intEnv('WIDTH', 32), 4, 128); // coluna
const HEIGHT = clamp(intEnv('HEIGHT', 32), 4, 128); // linha
const COOLDOWN = clamp(intEnv('COOLDOWN_SECONDS', 5), 0, 3600); // espera
const MAX_PER_USER = clamp(intEnv('MAX_PIXELS_PER_USER', 0), 0, 100000); // limite
const ADMIN_KEY = process.env.ADMIN_KEY || 'host123';
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const PALETTE_SIZE = 16;

const SIZE = `${WIDTH}x${HEIGHT}`;
const CANVAS_KEY = `canvas:${SIZE}`; 
const TOTAL_KEY = `total:${SIZE}`; 
const CHANNEL = `events:${SIZE}`; 
const cdKey = (id) => `cd:${id}`; // TTL
const cntKey = (id) => `cnt:${SIZE}:${id}`; 

const redis = createClient({ url: REDIS_URL });
const sub = redis.duplicate();
redis.on('error', (err) => console.error(`[${HOST}] redis:`, err.message));
sub.on('error', (err) => console.error(`[${HOST}] redis(sub):`, err.message));

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/health', (req, res) => res.json({ status: 'ok', host: HOST }));

app.get('/api/info', (req, res) =>
  res.json({ host: HOST, width: WIDTH, height: HEIGHT, cooldown: COOLDOWN, maxPerUser: MAX_PER_USER })
);

app.post('/api/reset', async (req, res) => {
  if (req.get('x-admin-key') !== ADMIN_KEY) return res.status(401).json({ error: 'chave inválida' });
  try {
    await redis.del([CANVAS_KEY, TOTAL_KEY]);
    for await (const key of redis.scanIterator({ MATCH: `cnt:${SIZE}:*`, COUNT: 100 })) {
      await redis.del(key);
    }
    await redis.publish(CHANNEL, JSON.stringify({ type: 'reset' }));
    res.json({ ok: true, host: HOST });
  } catch (err) {
    console.error(`[${HOST}]`, err);
    res.status(500).json({ error: 'erro interno' });
  }
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 2048 });

const send = (ws, obj) => {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
};
const online = () => [...wss.clients].filter((c) => c.readyState === c.OPEN).length;
const broadcastLocal = (raw) => {
  for (const client of wss.clients) if (client.readyState === client.OPEN) client.send(raw);
};

async function snapshot() {
  const raw = (await redis.get(CANVAS_KEY)) || '';
  let pixels = '';
  for (let i = 0; i < WIDTH * HEIGHT; i++) {
    const ch = raw[i];
    pixels += ch && /[0-9a-f]/.test(ch) ? ch : '0';
  }
  const total = Number((await redis.get(TOTAL_KEY)) || 0);
  return { pixels, total };
}

async function handlePaint(ws, msg) {
  const { x, y, c, id } = msg;
  const nick = String(msg.nick || 'anônimo').slice(0, 16);

  const valid =
    /^[A-Za-z0-9-]{8,40}$/.test(String(id)) &&
    Number.isInteger(x) && Number.isInteger(y) && Number.isInteger(c) &&
    x >= 0 && x < WIDTH && y >= 0 && y < HEIGHT && c >= 0 && c < PALETTE_SIZE;
  if (!valid) return send(ws, { type: 'error', message: 'jogada inválida' });

  if (COOLDOWN > 0) {
    const ok = await redis.set(cdKey(id), '1', { NX: true, EX: COOLDOWN });
    if (!ok) {
      const ttl = await redis.ttl(cdKey(id));
      return send(ws, { type: 'cooldown', wait: Math.max(ttl, 1) });
    }
  }

  let left = null;
  if (MAX_PER_USER > 0) {
    const used = await redis.incr(cntKey(id));
    if (used === 1) await redis.expire(cntKey(id), 6 * 3600);
    if (used > MAX_PER_USER) {
      await redis.decr(cntKey(id));
      return send(ws, { type: 'limit', max: MAX_PER_USER });
    }
    left = MAX_PER_USER - used;
  }

  await redis.setRange(CANVAS_KEY, y * WIDTH + x, c.toString(16));
  const total = await redis.incr(TOTAL_KEY);
  await redis.publish(CHANNEL, JSON.stringify({ type: 'pixel', x, y, c, by: nick, total, host: HOST }));
  send(ws, { type: 'ok', wait: COOLDOWN, left });
}

wss.on('connection', async (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => (ws.isAlive = true));
  ws.on('error', () => {});

  try {
    const snap = await snapshot();
    send(ws, {
      type: 'init', host: HOST, width: WIDTH, height: HEIGHT,
      cooldown: COOLDOWN, maxPerUser: MAX_PER_USER, ...snap,
    });
  } catch (err) {
    console.error(`[${HOST}]`, err);
    ws.close();
    return;
  }
  broadcastLocal(JSON.stringify({ type: 'online', n: online() }));

  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return send(ws, { type: 'error', message: 'mensagem inválida' });
    }
    if (!msg || msg.type !== 'paint') return;
    handlePaint(ws, msg).catch((err) => {
      console.error(`[${HOST}]`, err);
      send(ws, { type: 'error', message: 'erro interno' });
    });
  });

  ws.on('close', () => broadcastLocal(JSON.stringify({ type: 'online', n: online() })));
});

const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 15000);

async function main() {
  await redis.connect();
  await sub.connect();
  await sub.subscribe(CHANNEL, (message) => broadcastLocal(message));
  server.listen(PORT, () =>
    console.log(`[${HOST}] mural ${SIZE} no ar na porta ${PORT} (espera ${COOLDOWN}s, limite ${MAX_PER_USER || 'sem'})`)
  );
}

async function shutdown(signal) {
  console.log(`[${HOST}] ${signal} recebido, encerrando...`);
  clearInterval(heartbeat);
  for (const ws of wss.clients) ws.close(1001, 'servidor reiniciando');
  server.close();
  await Promise.allSettled([redis.quit(), sub.quit()]);
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

main().catch((err) => {
  console.error('falha ao iniciar:', err);
  process.exit(1);
});
