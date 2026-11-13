import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { GoogleGenAI, Type, ThinkingLevel } from '@google/genai';

const root = fileURLToPath(new URL('.', import.meta.url));
const port = Number(process.env.PORT || 3000);
const rooms = new Map();
const takes = new Map();
const roomVideos = new Map();
const subscriptions = new Map();

let aiClient = null;
function getAiClient() {
  const apiKey = process.env.GEMINI_API_KEY || process.env.API_KEY;
  if (!apiKey) return null;
  if (!aiClient) {
    try {
      aiClient = new GoogleGenAI({
        apiKey,
        httpOptions: {
          headers: {
            'User-Agent': 'aistudio-build'
          }
        }
      });
    } catch (err) {
      console.warn('Failed to initialize GoogleGenAI client:', err);
      return null;
    }
  }
  return aiClient;
}

async function mapConcurrent(items, limit, fn) {
  const results = new Array(items.length);
  let index = 0;
  const workers = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (index < items.length) {
      const currentIdx = index++;
      results[currentIdx] = await fn(items[currentIdx], currentIdx);
    }
  });
  await Promise.all(workers);
  return results;
}

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

  if (requestUrl.pathname === '/api/health' || requestUrl.pathname === '/healthz') {
    response.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-cache, no-store'
    });
    response.end(JSON.stringify({
      status: 'ok',
      service: 'loop-booth',
      uptime: Math.floor(process.uptime()),
      activeRooms: rooms.size,
      connectedClients: subscriptions.size,
      timestamp: new Date().toISOString()
    }));
    return;
  }

  if (requestUrl.pathname === '/api/transcribe' && request.method === 'POST') {
    const ai = getAiClient();
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      if (size > 50 * 1024 * 1024) {
        response.writeHead(413, { 'Content-Type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ error: 'Audio payload too large.' }));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    }

    let payload;
    try {
      payload = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
    } catch {
      response.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ error: 'Invalid JSON body.' }));
      return;
    }

    if (!ai) {
      if (Array.isArray(payload.items)) {
        response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({
          results: payload.items.map(it => ({ id: it?.id, transcript: '' })),
          keyMissing: true,
          warning: 'Gemini API key is not configured in environment. Scripts can be entered directly.'
        }));
        return;
      }
      response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({
        transcript: '',
        keyMissing: true,
        warning: 'Gemini API key is not configured in environment. Scripts can be entered directly.'
      }));
      return;
    }

    function parseRateLimitError(err) {
      const msg = String(err?.message || err || '');
      const isRateLimit = msg.includes('429') || msg.includes('RESOURCE_EXHAUSTED') || msg.includes('quota');
      if (!isRateLimit) return null;
      let retryAfterSec = 30;
      const match = msg.match(/retry(?:Delay["']?\s*:\s*["']?| in )(\d+(?:\.\d+)?)s/i);
      if (match) {
        retryAfterSec = Math.max(5, Math.ceil(Number(match[1])));
      }
      return {
        rateLimited: true,
        retryAfterSec,
        warning: `Voice-to-Text API rate limit reached. Please wait ${retryAfterSec}s before retrying.`
      };
    }

    function extractJsonArray(rawText) {
      if (!rawText || typeof rawText !== 'string') return null;
      const trimmed = rawText.trim();
      try {
        const parsed = JSON.parse(trimmed);
        return Array.isArray(parsed) ? parsed : null;
      } catch {}
      const match = trimmed.match(/\[[\s\S]*\]/);
      if (match) {
        try {
          const parsed = JSON.parse(match[0]);
          return Array.isArray(parsed) ? parsed : null;
        } catch {}
      }
      return null;
    }

    async function transcribeSingleAudio(audioBase64, mimeType = 'audio/wav') {
      const audioPart = {
        inlineData: {
          mimeType,
          data: audioBase64
        }
      };
      const contents = {
        parts: [
          audioPart,
          { text: 'Transcribe the spoken words in this audio clip verbatim as plain text. Output only the spoken dialogue. If there is no audible speech, silent pause, or only music/effects, output an empty string.' }
        ]
      };
      try {
        const res = await ai.models.generateContent({
          model: 'gemini-4-hydrogen',
          contents,
          config: { thinkingConfig: { thinkingLevel: ThinkingLevel.LOW } }
        });
        return (res.text || '').trim();
      } catch (err) {
        const msg = String(err?.message || '');
        if (msg.includes('thinking') || msg.includes('INVALID_ARGUMENT')) {
          const fallbackRes = await ai.models.generateContent({
            model: 'gemini-4-hydrogen',
            contents
          });
          return (fallbackRes.text || '').trim();
        }
        throw err;
      }
    }

    async function transcribeBatchItems(items) {
      const resultsMap = new Map();
      const validItems = [];
      for (const item of items) {
        if (!item || !item.id) continue;
        resultsMap.set(item.id, '');
        if (item.audio && typeof item.audio === 'string' && item.audio.length > 0) {
          validItems.push(item);
        }
      }

      if (validItems.length === 0) {
        return items.map(it => ({ id: it?.id, transcript: '' }));
      }

      if (validItems.length === 1) {
        const text = await transcribeSingleAudio(validItems[0].audio, validItems[0].mimeType || 'audio/wav');
        resultsMap.set(validItems[0].id, text);
        return items.map(it => ({ id: it?.id, transcript: resultsMap.get(it?.id) || '' }));
      }

      const parts = [
        {
          text:
            `Transcribe the spoken dialogue in each audio segment below. ` +
            `Respond ONLY with a JSON array of objects, one for each Segment ID in order: ` +
            `[{"id":"<Segment ID>","transcript":"<verbatim spoken dialogue or empty string if silent/music only>"}]. ` +
            `Do not include markdown code fences or extra commentary.`
        }
      ];
      for (const item of validItems) {
        parts.push({ text: `Segment ID: ${item.id}` });
        parts.push({
          inlineData: {
            mimeType: item.mimeType || 'audio/wav',
            data: item.audio
          }
        });
      }

      let rawText = '';
      try {
        const res = await ai.models.generateContent({
          model: 'gemini-4-hydrogen',
          contents: { parts },
          config: {
            thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
            responseMimeType: 'application/json',
            responseSchema: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  id: { type: Type.STRING },
                  transcript: { type: Type.STRING }
                },
                required: ['id', 'transcript']
              }
            }
          }
        });
        rawText = res.text || '';
      } catch (err) {
        const msg = String(err?.message || '');
        if (msg.includes('400') || msg.includes('INVALID_ARGUMENT') || msg.includes('responseSchema') || msg.includes('thinking')) {
          const plainRes = await ai.models.generateContent({
            model: 'gemini-4-hydrogen',
            contents: { parts }
          });
          rawText = plainRes.text || '';
        } else {
          throw err;
        }
      }

      const parsed = extractJsonArray(rawText);
      if (parsed) {
        for (const entry of parsed) {
          if (entry && entry.id && resultsMap.has(entry.id)) {
            resultsMap.set(entry.id, typeof entry.transcript === 'string' ? entry.transcript.trim() : '');
          }
        }
      }

      return items.map(it => ({ id: it?.id, transcript: resultsMap.get(it?.id) || '' }));
    }

    try {
      if (Array.isArray(payload.items)) {
        try {
          const results = await transcribeBatchItems(payload.items);
          response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          response.end(JSON.stringify({ results }));
          return;
        } catch (batchErr) {
          const rateInfo = parseRateLimitError(batchErr);
          if (rateInfo) {
            console.warn(`Voice-to-Text rate limit hit (retry in ${rateInfo.retryAfterSec}s).`);
            response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            response.end(JSON.stringify({
              results: payload.items.map(it => ({ id: it?.id, transcript: '' })),
              ...rateInfo
            }));
            return;
          }
          throw batchErr;
        }
      }

      if (!payload.audio) {
        response.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ error: 'Missing audio data in request.' }));
        return;
      }

      try {
        const text = await transcribeSingleAudio(payload.audio, payload.mimeType || 'audio/wav');
        response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ transcript: text }));
        return;
      } catch (singleErr) {
        const rateInfo = parseRateLimitError(singleErr);
        if (rateInfo) {
          console.warn(`Voice-to-Text rate limit hit (retry in ${rateInfo.retryAfterSec}s).`);
          response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          response.end(JSON.stringify({
            transcript: '',
            ...rateInfo
          }));
          return;
        }
        throw singleErr;
      }
    } catch (err) {
      console.error('Transcription endpoint failure:', err?.message || err);
      response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({
        transcript: '',
        error: err?.message || 'Failed to generate transcript from speech.'
      }));
      return;
    }
  }

  const requested = requestUrl.pathname === '/' ? '/index.html' : requestUrl.pathname;
  const safePath = normalize(requested).replace(/^([.][.][/\\])+/, '');
  const filePath = join(root, safePath);
  try {
    const body = await readFile(filePath);
    const ext = extname(filePath).toLowerCase();
    const type = MIME_TYPES[ext] || 'application/octet-stream';
    response.writeHead(200, {
      'Content-Type': type,
      'Accept-Ranges': 'bytes'
    });
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

const host = process.env.HOST || '0.0.0.0';

httpServer.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.warn(`Port ${port} is already in use. Loop Booth dev server is active at http://${host}:${port}`);
  } else {
    console.error('Server error:', err);
  }
});

httpServer.listen(port, host, () => {
  console.log(`Loop Booth server running at http://${host}:${port}`);
});

function gracefulShutdown(signal) {
  console.log(`Received ${signal}. Shutting down gracefully...`);
  wss.close(() => {
    httpServer.close(() => {
      console.log('Server terminated cleanly.');
      process.exit(0);
    });
  });
  // Force exit after 3 seconds if connections linger
  setTimeout(() => process.exit(0), 3000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
