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

function createInitialPartyState(fragmentIndex = 0, roundSerial = 1) {
  return {
    enabled: true,
    phase: 'recording', // 'recording' | 'voting' | 'revote' | 'winner' | 'finale'
    fragmentIndex,
    roundSerial,
    submittedUids: [],
    candidates: [],
    votes: {},
    initialTally: null,
    revoteRound: 0,
    tiedVotesCount: 0,
    lastWinner: null,
    winners: {},
    readyUids: [],
    spotlightUid: null,
    finalePlayback: {
      playing: false,
      startedAt: 0,
      position: 0,
      seq: 1
    },
    statusBanner: `Line ${fragmentIndex + 1} · Everyone dub this line!`
  };
}

function getEligibleVoters(room, candidates) {
  const players = Array.isArray(room.players) ? room.players : [];
  if (!Array.isArray(candidates) || candidates.length === 0) return [];
  if (candidates.length === 1) {
    // Only players who did NOT record this lone take can vote on it
    return players.filter(p => p && p.id && p.id !== candidates[0]).map(p => p.id);
  }
  // When 2+ candidates exist, every player can vote for at least one other candidate
  return players.filter(p => p && p.id).map(p => p.id);
}

function clearFragmentTakes(roomId, fragId) {
  const roomTakes = takes.get(roomId);
  if (!roomTakes || !fragId) return false;
  let removed = false;
  for (const [key, val] of roomTakes.entries()) {
    if (val && val.fragId === fragId) {
      roomTakes.delete(key);
      removed = true;
    }
  }
  if (removed) {
    broadcast(`artifacts/loop-booth-mp/public/data/takes_${roomId}`, [...roomTakes.values()]);
  }
  return removed;
}

function getRoomTakesForFragment(roomId, fragId) {
  const roomTakes = takes.get(roomId);
  if (!roomTakes || !fragId) return [];
  const uids = [];
  for (const val of roomTakes.values()) {
    if (val && val.fragId === fragId && val.uid && !uids.includes(val.uid)) {
      uids.push(val.uid);
    }
  }
  return uids;
}

function resolvePartyVotes(room) {
  const party = room.party;
  if (!party) return room;
  const fragments = Array.isArray(room.fragments) ? room.fragments : [];
  const frag = fragments[party.fragmentIndex] || { id: `frag_${party.fragmentIndex}` };
  const candidates = Array.isArray(party.candidates) ? party.candidates : [];
  if (candidates.length === 0) return room;

  const counts = {};
  candidates.forEach(uid => { counts[uid] = 0; });
  Object.values(party.votes || {}).forEach((votedUid) => {
    if (Object.prototype.hasOwnProperty.call(counts, votedUid)) {
      counts[votedUid] += 1;
    }
  });

  let maxVotes = -1;
  candidates.forEach((uid) => {
    if (counts[uid] > maxVotes) maxVotes = counts[uid];
  });

  const topCandidates = candidates.filter(uid => counts[uid] === maxVotes);

  // Tie on initial vote -> 1 re-vote between only the highest-voted candidates
  if (topCandidates.length > 1 && (party.revoteRound || 0) === 0) {
    party.phase = 'revote';
    party.revoteRound = 1;
    party.tiedVotesCount = maxVotes;
    party.initialTally = { ...counts };
    party.candidates = topCandidates;
    party.votes = {};
    party.spotlightUid = topCandidates[0] || null;
    party.statusBanner = `TIE at ${maxVotes} vote${maxVotes === 1 ? '' : 's'}! 1 Re-Vote between top ${topCandidates.length} takes!`;
    return room;
  }

  // Decide winner (either clear winner OR tie on re-vote -> random pick!)
  let winnerUid = topCandidates[0];
  let winReason = (party.revoteRound || 0) >= 1 ? 'revote' : 'votes';
  if (topCandidates.length > 1) {
    winnerUid = topCandidates[Math.floor(Math.random() * topCandidates.length)];
    winReason = 'random_tiebreak';
  }

  const players = Array.isArray(room.players) ? room.players : [];
  const winnerPlayer = players.find(p => p && p.id === winnerUid) || {};
  const winnerInfo = {
    fragId: frag.id,
    fragIndex: party.fragmentIndex,
    uid: winnerUid,
    playerName: winnerPlayer.name || 'Player',
    playerColor: winnerPlayer.color || '#B285F5',
    votes: counts[winnerUid] || 0,
    tally: counts,
    initialTally: party.initialTally ? { ...party.initialTally } : null,
    winReason,
    decidedAt: Date.now()
  };

  if (!party.winners || typeof party.winners !== 'object') {
    party.winners = {};
  }
  party.winners[frag.id] = winnerInfo;
  party.lastWinner = winnerInfo;
  party.readyUids = [];
  party.phase = 'winner';
  party.statusBanner = winReason === 'random_tiebreak'
    ? `Double tie! Random tie-breaker crowned ${winnerInfo.playerName} on Line ${party.fragmentIndex + 1}!`
    : `${winnerInfo.playerName} wins Line ${party.fragmentIndex + 1}!`;
  return room;
}

function broadcastRoomEvent(roomId, event) {
  const normalizedRoomId = String(roomId || '').toUpperCase();
  for (const [s, paths] of subscriptions) {
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

function handlePartyAction(roomId, payload = {}) {
  const normalizedRoomId = String(roomId || '').toUpperCase();
  const room = rooms.get(normalizedRoomId);
  if (!room) throw new Error('Room not found');

  const action = payload.action;
  const actorUid = payload.actorUid;
  const isHost = Boolean(actorUid && room.hostId === actorUid);
  const fragments = Array.isArray(room.fragments) ? room.fragments : [];

  if (!room.party) {
    room.party = createInitialPartyState(0, 1);
  }
  const party = room.party;

  if (action === 'init-party') {
    if (!isHost) throw new Error('Only host can initialize Party Showdown.');
    room.party = createInitialPartyState(0, 1);
    room.activeLineIndex = 0;
  } else if (action === 'mark-submitted') {
    if (party.phase !== 'recording') return room;
    const activeFrag = fragments[party.fragmentIndex];
    if (activeFrag && payload.fragId && payload.fragId !== activeFrag.id) return room;
    const uid = payload.uid || actorUid;
    if (uid) {
      if (!Array.isArray(party.submittedUids)) party.submittedUids = [];
      if (!party.submittedUids.includes(uid)) {
        party.submittedUids.push(uid);
      }
    }
  } else if (action === 'start-voting') {
    if (!isHost) throw new Error('Only host can open voting.');
    if (party.phase !== 'recording') return room;
    const activeFrag = fragments[party.fragmentIndex];
    const fragId = activeFrag?.id || payload.fragId;
    const takeUids = getRoomTakesForFragment(normalizedRoomId, fragId);
    const mergedCandidates = Array.from(new Set([...(party.submittedUids || []), ...takeUids]));
    if (mergedCandidates.length === 0) {
      throw new Error('At least 1 player must record a take before voting starts.');
    }
    party.submittedUids = mergedCandidates;
    party.candidates = mergedCandidates;
    party.votes = {};
    party.initialTally = null;
    party.revoteRound = 0;
    party.tiedVotesCount = 0;
    party.lastWinner = null;
    party.readyUids = [];
    party.spotlightUid = mergedCandidates[0] || null;
    party.phase = 'voting';
    party.statusBanner = `Voting Open! Pick the best dub for Line ${party.fragmentIndex + 1}`;
  } else if (action === 'cast-vote') {
    if (party.phase !== 'voting' && party.phase !== 'revote') return room;
    const voterUid = payload.voterUid || actorUid;
    const candidateUid = payload.candidateUid;
    if (!voterUid || !candidateUid) return room;
    if (!Array.isArray(party.candidates) || !party.candidates.includes(candidateUid)) {
      throw new Error('Invalid voting candidate.');
    }
    if (party.candidates.length > 1 && voterUid === candidateUid) {
      throw new Error('You cannot vote for your own recording.');
    }
    if (!party.votes || typeof party.votes !== 'object') party.votes = {};
    party.votes[voterUid] = candidateUid;

    const eligibleVoters = getEligibleVoters(room, party.candidates);
    const allVoted = eligibleVoters.length > 0 && eligibleVoters.every(vId => Boolean(party.votes[vId]));
    if (allVoted) {
      resolvePartyVotes(room);
    }
  } else if (action === 'close-voting') {
    if (!isHost) throw new Error('Only host can close voting.');
    if (party.phase !== 'voting' && party.phase !== 'revote') return room;
    resolvePartyVotes(room);
  } else if (action === 'ready-next') {
    if (party.phase !== 'winner') return room;
    const uid = payload.uid || actorUid;
    if (!uid) return room;
    if (!Array.isArray(party.readyUids)) party.readyUids = [];
    if (!party.readyUids.includes(uid)) {
      party.readyUids.push(uid);
    }
  } else if (action === 'advance-fragment') {
    if (!isHost) throw new Error('Only host can advance the game.');
    if (party.phase !== 'winner') return room;
    const players = Array.isArray(room.players) ? room.players : [];
    const readySet = new Set(party.readyUids || []);
    const allReady = players.every(p => !p?.id || readySet.has(p.id));
    if (!allReady && !payload.force) {
      throw new Error('Waiting for all players to click Ready Up.');
    }

    const total = fragments.length;
    if (party.fragmentIndex + 1 < total) {
      party.fragmentIndex += 1;
      party.phase = 'recording';
      party.roundSerial = (party.roundSerial || 1) + 1;
      party.submittedUids = [];
      party.candidates = [];
      party.votes = {};
      party.initialTally = null;
      party.revoteRound = 0;
      party.tiedVotesCount = 0;
      party.lastWinner = null;
      party.readyUids = [];
      party.spotlightUid = null;
      party.statusBanner = `Line ${party.fragmentIndex + 1} of ${total} · Everyone dub this line!`;
      room.activeLineIndex = party.fragmentIndex;
    } else {
      party.phase = 'finale';
      party.roundSerial = (party.roundSerial || 1) + 1;
      party.submittedUids = [];
      party.candidates = [];
      party.votes = {};
      party.initialTally = null;
      party.revoteRound = 0;
      party.tiedVotesCount = 0;
      party.lastWinner = null;
      party.readyUids = [];
      party.spotlightUid = null;
      party.finalePlayback = {
        playing: false,
        startedAt: 0,
        position: 0,
        seq: (party.finalePlayback?.seq || 0) + 1
      };
      party.statusBanner = 'Final Premiere Watch Party! Watch your winning group dub together!';
    }
  } else if (action === 'redo-fragment') {
    if (!isHost) throw new Error('Only host can redo a fragment.');
    const targetIdx = typeof payload.fragmentIndex === 'number'
      ? Math.max(0, Math.min(Math.max(0, fragments.length - 1), payload.fragmentIndex))
      : party.fragmentIndex;
    const targetFrag = fragments[targetIdx];
    const targetFragId = payload.fragId || targetFrag?.id;

    if (targetFragId) {
      clearFragmentTakes(normalizedRoomId, targetFragId);
      if (party.winners && party.winners[targetFragId]) {
        delete party.winners[targetFragId];
      }
    }

    party.fragmentIndex = targetIdx;
    party.phase = 'recording';
    party.roundSerial = (party.roundSerial || 1) + 1;
    party.submittedUids = [];
    party.candidates = [];
    party.votes = {};
    party.initialTally = null;
    party.revoteRound = 0;
    party.tiedVotesCount = 0;
    party.lastWinner = null;
    party.readyUids = [];
    party.spotlightUid = null;
    if (party.finalePlayback) {
      party.finalePlayback.playing = false;
      party.finalePlayback.position = 0;
    }
    party.statusBanner = `Host triggered a Redo on Line ${targetIdx + 1} — everyone dub again!`;
    room.activeLineIndex = targetIdx;

    broadcastRoomEvent(normalizedRoomId, {
      action: 'party-redo',
      fragmentIndex: targetIdx,
      fragId: targetFragId,
      roundSerial: party.roundSerial,
      playerName: payload.playerName || 'Host',
      sentAt: Date.now()
    });
  } else if (action === 'spotlight-take') {
    if (!isHost) throw new Error('Only host can spotlight takes for everyone.');
    party.spotlightUid = payload.candidateUid || null;
    broadcastRoomEvent(normalizedRoomId, {
      action: 'party-spotlight',
      candidateUid: party.spotlightUid,
      fragmentIndex: party.fragmentIndex,
      playerName: payload.playerName || 'Host',
      sentAt: Date.now()
    });
  } else if (action === 'finale-control') {
    if (!isHost) throw new Error('Only host controls Watch Party playback.');
    const cmd = payload.command || 'play';
    const prevSeq = party.finalePlayback?.seq || 0;
    const pos = cmd === 'restart' ? 0 : Math.max(0, Number(payload.position) || 0);
    party.finalePlayback = {
      playing: cmd === 'play' || cmd === 'restart',
      startedAt: Date.now(),
      position: pos,
      seq: prevSeq + 1
    };
  }

  rooms.set(normalizedRoomId, room);
  broadcast(`artifacts/loop-booth-mp/public/data/rooms/${normalizedRoomId}`, room);
  return room;
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
    let requestId;
    try {
      const msg = JSON.parse(raw);
      requestId = msg.requestId;
      const { op, path, data, roomId, event, player } = msg;

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
        const normalizedRoomId = String(roomId || '').toUpperCase();
        const current = rooms.get(normalizedRoomId) || { id: normalizedRoomId, players: [] };
        const existingIndex = (current.players || []).findIndex(p => p && p.id === player.id);
        const updatedPlayers = [...(current.players || [])];
        if (existingIndex >= 0) {
          updatedPlayers[existingIndex] = { ...updatedPlayers[existingIndex], ...player };
        } else {
          updatedPlayers.push(player);
        }
        const next = { ...current, players: updatedPlayers };
        rooms.set(normalizedRoomId, next);
        broadcast(`artifacts/loop-booth-mp/public/data/rooms/${normalizedRoomId}`, next);
        return send(socket, { requestId, success: true });
      }
      if (op === 'party-action') {
        const targetRoomId = String(roomId || path || '').toUpperCase();
        const updatedRoom = handlePartyAction(targetRoomId, data || {});
        return send(socket, { requestId, data: updatedRoom });
      }
      if (op === 'ping') {
        return send(socket, { type: 'pong' });
      }
      send(socket, { requestId, error: 'Unknown operation' });
    } catch (error) {
      send(socket, { requestId, error: error.message });
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
