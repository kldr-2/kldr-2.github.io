import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const root = fileURLToPath(new URL('.', import.meta.url));
const port = Number(process.env.PORT || 5173);
const rooms = new Map();
const takes = new Map();
const subscriptions = new Map();

function roomKey(path) {
  const parts = path.split('/');
  return parts[parts.indexOf('rooms') + 1];
}

function send(socket, message) {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
}

function broadcast(path, data) {
  for (const [socket, paths] of subscriptions) {
    if (paths.has(path)) send(socket, { type: 'snapshot', path, data });
  }
}

function dataFor(path) {
  if (path.includes('/rooms/')) return rooms.get(roomKey(path)) || null;
  if (path.includes('/takes_')) {
    const room = path.split('/takes_')[1]?.split('/')[0];
    return [...(takes.get(room)?.values() || [])];
  }
  return null;
}

function updatePath(path, data) {
  if (path.includes('/rooms/')) {
    const key = roomKey(path);
    const current = rooms.get(key) || {};
    const next = { ...current, ...data };
    rooms.set(key, next);
    broadcast(path, next);
    return next;
  }
  if (path.includes('/takes_')) {
    const parts = path.split('/takes_')[1].split('/');
    const room = parts[0];
    const takeId = parts[1];
    if (!takes.has(room)) takes.set(room, new Map());
    takes.get(room).set(takeId, data);
    broadcast(path.split('/').slice(0, -1).join('/'), [...takes.get(room).values()]);
    return data;
  }
  return null;
}

const httpServer = createServer(async (request, response) => {
  const requested = request.url === '/' ? '/index.html' : request.url;
  const safePath = normalize(requested).replace(/^([.][.][/\\])+/, '');
  const filePath = join(root, safePath);
  try {
    const body = await readFile(filePath);
    const type = extname(filePath) === '.js' ? 'text/javascript' : extname(filePath) === '.css' ? 'text/css' : 'text/html';
    response.writeHead(200, { 'Content-Type': type });
    response.end(body);
  } catch {
    response.writeHead(404);
    response.end('Not found');
  }
});

const wss = new WebSocketServer({ server: httpServer });
wss.on('connection', socket => {
  subscriptions.set(socket, new Set());
  socket.on('message', raw => {
    try {
      const { requestId, op, path, data } = JSON.parse(raw);
      if (op === 'get') return send(socket, { requestId, data: dataFor(path) });
      if (op === 'set') {
        const value = updatePath(path, data);
        return send(socket, { requestId, data: value });
      }
      if (op === 'update') {
        const value = updatePath(path, data);
        return send(socket, { requestId, data: value });
      }
      if (op === 'subscribe') {
        subscriptions.get(socket).add(path);
        return send(socket, { requestId, data: dataFor(path) });
      }
      if (op === 'unsubscribe') {
        subscriptions.get(socket).delete(path);
        return send(socket, { requestId, data: true });
      }
      send(socket, { requestId, error: 'Unknown operation' });
    } catch (error) {
      send(socket, { error: error.message });
    }
  });
  socket.on('close', () => subscriptions.delete(socket));
});

httpServer.listen(port, () => console.log(`Loop Booth running at http://localhost:${port}`));
