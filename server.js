import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const root = fileURLToPath(new URL('.', import.meta.url));
const port = Number(process.env.PORT || 3000);
const rooms = new Map();
const takes = new Map();
const roomVideos = new Map();
const subscriptions = new Map();

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg'
};

function roomKey(path) {
  if (!path || typeof path !== 'string') return '';
  const parts = path.split('/');
  const idx = parts.indexOf('rooms');
  if (idx !== -1 && idx + 1 < parts.length) return parts[idx + 1];
  return parts[parts.length - 1] || '';
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
  if (!path || typeof path !== 'string') return null;
  if (path.includes('/rooms/') || path.includes('rooms/')) return rooms.get(roomKey(path)) || null;
  if (path.includes('takes_')) {
    const room = path.split('takes_')[1]?.split('/')[0];
    return [...(takes.get(room)?.values() || [])];
  }
  return null;
}

function updatePath(path, data) {
  if (!path || typeof path !== 'string') return null;
  if (path.includes('/rooms/') || path.includes('rooms/')) {
    const key = roomKey(path);
    if (!key) return null;
    const current = rooms.get(key) || {};
    const next = { ...current, ...data };
    rooms.set(key, next);
    broadcast(path, next);
    return next;
  }
  if (path.includes('takes_')) {
    const parts = path.split('takes_')[1]?.split('/') || [];
    const room = parts[0];
    const takeId = parts[1];
    if (!room || !takeId) return null;
    if (!takes.has(room)) takes.set(room, new Map());
    takes.get(room).set(takeId, data);
    const parentPath = path.includes('/') ? path.split('/').slice(0, -1).join('/') : path;
    broadcast(parentPath, [...takes.get(room).values()]);
    return data;
  }
  return null;
}

const httpServer = createServer(async (request, response) => {
  const requestUrl = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
  const videoMatch = requestUrl.pathname.match(/^\/api\/rooms\/([^/]+)\/video$/);

  if (videoMatch && request.method === 'POST') {
    const roomId = decodeURIComponent(videoMatch[1]).toUpperCase();
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      if (size > 250 * 1024 * 1024) {
        response.writeHead(413, { 'Content-Type': 'text/plain' });
        response.end('Video is too large. Maximum size is 250 MB.');
        request.destroy();
        return;
      }
      chunks.push(chunk);
    }
    const rawFileName = request.headers['x-file-name'] || '';
    const name = rawFileName ? decodeURIComponent(rawFileName) : 'video.mp4';
    roomVideos.set(roomId, {
      body: Buffer.concat(chunks),
      type: request.headers['content-type'] || 'video/mp4',
      name
    });
    response.writeHead(204);
    response.end();
    return;
  }

  if (videoMatch && request.method === 'GET') {
    const roomId = decodeURIComponent(videoMatch[1]).toUpperCase();
    const video = roomVideos.get(roomId);
    if (!video) {
      response.writeHead(404, { 'Content-Type': 'text/plain' });
      response.end('Room video not found');
      return;
    }
    const total = video.body.length;
    const range = request.headers.range;
    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : total - 1;
      const chunkSize = (end - start) + 1;
      response.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${total}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunkSize,
        'Content-Type': video.type,
        'Content-Disposition': `inline; filename="${encodeURIComponent(video.name || 'video.mp4')}"`,
        'Cache-Control': 'no-store'
      });
      response.end(video.body.subarray(start, end + 1));
      return;
    }

    response.writeHead(200, {
      'Content-Type': video.type,
      'Content-Length': total,
      'Accept-Ranges': 'bytes',
      'Content-Disposition': `inline; filename="${encodeURIComponent(video.name || 'video.mp4')}"`,
      'Cache-Control': 'no-store'
    });
    response.end(video.body);
    return;
  }

  const requested = requestUrl.pathname === '/' ? '/index.html' : requestUrl.pathname;
  const safePath = normalize(requested).replace(/^([.][.][/\\])+/, '');
  const filePath = join(root, safePath);
  try {
    const body = await readFile(filePath);
    const ext = extname(filePath).toLowerCase();
    const type = MIME_TYPES[ext] || 'application/octet-stream';
    response.writeHead(200, { 'Content-Type': type });
    response.end(body);
  } catch {
    response.writeHead(404, { 'Content-Type': 'text/plain' });
    response.end('Not found');
  }
});

const wss = new WebSocketServer({ server: httpServer });
wss.on('connection', socket => {
  subscriptions.set(socket, new Set());
  socket.on('message', raw => {
    try {
      const msg = JSON.parse(raw);
      const { requestId, op, path, data, roomId, event, player } = msg;

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
      if (op === 'room-event') {
        const normalizedRoomId = String(roomId || '').toUpperCase();
        for (const [s, paths] of subscriptions) {
          if (s !== socket) {
            let matches = false;
            for (const p of paths) {
              if (p.toUpperCase().includes(normalizedRoomId)) {
                matches = true;
                break;
              }
            }
            if (matches) send(s, { type: 'room-event', roomId: normalizedRoomId, event });
          }
        }
        return send(socket, { requestId, success: true });
      }
      if (op === 'player-presence') {
        if (!player || !player.id) return send(socket, { requestId, success: false });
        const current = rooms.get(roomId) || { id: roomId, players: [] };
        const existingIndex = (current.players || []).findIndex(p => p && p.id === player.id);
        const updatedPlayers = [...(current.players || [])];
        if (existingIndex >= 0) {
          updatedPlayers[existingIndex] = { ...updatedPlayers[existingIndex], ...player };
        } else {
          updatedPlayers.push(player);
        }
        const next = { ...current, players: updatedPlayers };
        rooms.set(roomId, next);
        broadcast(`artifacts/loop-booth-mp/public/data/rooms/${roomId}`, next);
        return send(socket, { requestId, success: true });
      }
      if (op === 'ping') {
        return send(socket, { type: 'pong' });
      }
      send(socket, { requestId, error: 'Unknown operation' });
    } catch (error) {
      send(socket, { error: error.message });
    }
  });
  socket.on('close', () => subscriptions.delete(socket));
});

httpServer.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.warn(`Port ${port} is already in use. Loop Booth dev server is active at http://0.0.0.0:${port}`);
  } else {
    console.error('Server error:', err);
  }
});

httpServer.listen(port, '0.0.0.0', () => console.log(`Loop Booth running at http://0.0.0.0:${port}`));
