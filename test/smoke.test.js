const test = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');

const URL = process.env.WS_URL || 'ws://localhost:8080/ws';
const newId = () => 'test' + Math.random().toString(36).slice(2, 12) + Date.now().toString(36);

function open() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL);
    ws.inbox = [];
    ws.waiters = [];
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      const i = ws.waiters.findIndex((w) => w.pred(msg));
      if (i >= 0) {
        const [w] = ws.waiters.splice(i, 1);
        clearTimeout(w.timer);
        w.resolve(msg);
      } else {
        ws.inbox.push(msg);
      }
    });
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

function expectMsg(ws, pred, ms = 4000) {
  const i = ws.inbox.findIndex(pred);
  if (i >= 0) return Promise.resolve(ws.inbox.splice(i, 1)[0]);
  return new Promise((resolve, reject) => {
    const w = { pred, resolve };
    w.timer = setTimeout(() => {
      ws.waiters.splice(ws.waiters.indexOf(w), 1);
      reject(new Error('tempo esgotado esperando a mensagem'));
    }, ms);
    ws.waiters.push(w);
  });
}

const paint = (ws, x, y, c, id) => ws.send(JSON.stringify({ type: 'paint', x, y, c, id, nick: 'teste' }));
const paintMany = (ws, pixels, id) => ws.send(JSON.stringify({ type: 'paint', pixels, id, nick: 'teste' }));
const hits = (m, x, y) => m.type === 'pixels' && m.pixels.some((p) => p[0] === x && p[1] === y);

test('recebe o estado inicial do mural', async () => {
  const ws = await open();
  const init = await expectMsg(ws, (m) => m.type === 'init');
  assert.ok(Number.isInteger(init.width) && init.width >= 4);
  assert.ok(Number.isInteger(init.height) && init.height >= 4);
  assert.equal(init.pixels.length, init.width * init.height);
  assert.ok(init.host);
  ws.close();
});

test('pixel pintado chega para outro cliente e respeita a espera', async () => {
  const a = await open();
  const b = await open();
  const initA = await expectMsg(a, (m) => m.type === 'init');
  await expectMsg(b, (m) => m.type === 'init');

  const x = Math.floor(Math.random() * initA.width);
  const y = Math.floor(Math.random() * initA.height);
  const before = parseInt(initA.pixels[y * initA.width + x], 16);
  const color = (before + 1) % 16;
  const id = newId();

  paint(a, x, y, color, id);
  const ok = await expectMsg(a, (m) => m.type === 'ok');
  assert.equal(ok.type, 'ok');
  const seen = await expectMsg(b, (m) => hits(m, x, y));
  assert.equal(seen.pixels.find((p) => p[0] === x && p[1] === y)[2], color);

  if (initA.cooldown > 0) {
    paint(a, x, y, color, id);
    const wait = await expectMsg(a, (m) => m.type === 'cooldown' || m.type === 'limit');
    assert.ok(['cooldown', 'limit'].includes(wait.type));
  }

  paint(a, x, y, before, newId());
  await expectMsg(b, (m) => hits(m, x, y) && m.pixels[0][2] === before);

  a.close();
  b.close();
});

test('recusa jogada fora do mural', async () => {
  const ws = await open();
  const init = await expectMsg(ws, (m) => m.type === 'init');
  paint(ws, init.width + 5, 0, 1, newId());
  const err = await expectMsg(ws, (m) => m.type === 'error');
  assert.equal(err.type, 'error');
  ws.close();
});

test('pinta vários pixels de uma vez e todos chegam juntos', async () => {
  const a = await open();
  const b = await open();
  const init = await expectMsg(a, (m) => m.type === 'init');
  await expectMsg(b, (m) => m.type === 'init');
  const cells = [[0, 0], [1, 0], [0, 1]].map(([x, y]) => [x, y, (parseInt(init.pixels[y * init.width + x], 16) + 1) % 16]);

  paintMany(a, cells, newId());
  const ok = await expectMsg(a, (m) => m.type === 'ok' || m.type === 'limit');
  assert.equal(ok.type, 'ok');
  assert.equal(ok.n, 3);
  const seen = await expectMsg(b, (m) => m.type === 'pixels' && m.pixels.length === 3);
  assert.deepEqual(seen.pixels, cells);

  const undo = cells.map(([x, y]) => [x, y, parseInt(init.pixels[y * init.width + x], 16)]);
  paintMany(a, undo, newId());
  await expectMsg(b, (m) => m.type === 'pixels' && m.pixels.length === 3);
  a.close();
  b.close();
});

test('recusa jogada com pixels demais', async () => {
  const ws = await open();
  const init = await expectMsg(ws, (m) => m.type === 'init');
  const many = Array.from({ length: init.maxBatch + 1 }, (_, i) => [i % init.width, 0, 1]);
  paintMany(ws, many, newId());
  const err = await expectMsg(ws, (m) => m.type === 'error');
  assert.equal(err.type, 'error');
  ws.close();
});
