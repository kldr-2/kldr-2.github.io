function makeId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function createMultiplayerClient() {
  let Peer;
  let peer;
  let peerReady;
  let hostRoomId = null;
  let hostRoomData = new Map();
  let hostTakes = new Map();
  const hostConnections = new Set();
  const connections = new Map();
  const pending = new Map();
  const videoStore = new Map();
  const listeners = new Map();

  async function loadPeer(){
    if(!Peer) ({ Peer } = await import('https://esm.sh/peerjs@1.5.4'));
    return Peer;
  }

  function roomIdFromPath(path){
    return path.split('/').at(-1);
  }

  function takesRoomFromPath(path){
    return path.match(/takes_([^/]+)/)?.[1] || null;
  }

  function notify(path, data){
    (listeners.get(path) || []).forEach(listener => listener(data));
  }

  function snapshot(data){
    if (Array.isArray(data)) {
      return { docChanges: () => data.map(item => ({ type: 'added', doc: { data: () => item } })) };
    }
    return { exists: () => data !== null, data: () => data };
  }

  function roomPath(roomId){
    return `artifacts/loop-booth-mp/public/data/rooms/${roomId}`;
  }

  function takesPath(roomId){
    return `artifacts/loop-booth-mp/public/data/takes_${roomId}`;
  }

  async function ensureHost(roomId){
    if(hostRoomId === roomId && peerReady) return peerReady;
    const PeerClass = await loadPeer();
    hostRoomId = roomId;
    peerReady = new Promise((resolve, reject) => {
      peer = new Peer(`loop-booth-${roomId}`);
      peer.on('open', resolve);
      peer.on('error', reject);
      peer.on('connection', connection => {
        hostConnections.add(connection);
        connection.on('data', message => handleHostMessage(connection, message));
        connection.on('close', () => hostConnections.delete(connection));
      });
    });
    await peerReady;
    return peerReady;
  }

  async function ensureGuest(roomId){
    if(connections.has(roomId)) return connections.get(roomId);
    const PeerClass = await loadPeer();
    const guestPeer = new Peer();
    const connectionPromise = new Promise((resolve, reject) => {
      guestPeer.on('error', reject);
      guestPeer.on('open', () => {
        const connection = guestPeer.connect(`loop-booth-${roomId}`, { reliable: true });
        connection.on('open', () => {
          connections.set(roomId, connection);
          resolve(connection);
        });
        connection.on('error', reject);
        connection.on('data', message => handleGuestMessage(roomId, message));
        connection.on('close', () => connections.delete(roomId));
      });
    });
    connections.set(roomId, connectionPromise);
    return Promise.race([
      connectionPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('The host could not be reached. Check the room code and try again.')), 15000))
    ]);
  }

  function send(connection, message){
    if(connection.open) connection.send(message);
  }

  function roomDataFor(path){
    const roomId = roomIdFromPath(path);
    return hostRoomData.get(roomId) || null;
  }

  function takesDataFor(path){
    return [...(hostTakes.get(takesRoomFromPath(path))?.values() || [])];
  }

  function broadcast(path, data){
    notify(path, data);
    hostConnections.forEach(connection => {
      const isRoomSnapshot = path.includes('/rooms/');
      if(isRoomSnapshot || connection.subscriptions?.has(path)) send(connection, { type: 'snapshot', path, data });
    });
  }

  async function handleHostMessage(connection, message){
    if(message.type === 'player-presence'){
      const room = hostRoomData.get(message.roomId);
      if(!room) return;
      const players = room.players.filter(player => player.id !== message.player.id);
      players.push(message.player);
      const next = { ...room, players };
      hostRoomData.set(message.roomId, next);
      broadcast(roomPath(message.roomId), next);
      return;
    }
    if(message.type === 'video-request'){
      const video = videoStore.get(message.roomId);
      if(!video) return send(connection, { type: 'video-error', requestId: message.requestId });
      const chunkSize = 64 * 1024;
      const total = Math.ceil(video.body.byteLength / chunkSize);
      send(connection, { type: 'video-meta', requestId: message.requestId, name: video.name, type: video.type, total });
      for(let index = 0; index < total; index++){
        send(connection, { type: 'video-chunk', requestId: message.requestId, index, data: video.body.slice(index * chunkSize, (index + 1) * chunkSize) });
      }
      return;
    }
    if(message.type !== 'request') return;
    const { requestId, op, path, data } = message;
    connection.subscriptions ||= new Set();
    try {
      let value;
      const roomId = roomIdFromPath(path);
      const takesRoom = takesRoomFromPath(path);
      if(op === 'get') value = path.includes('/takes_') ? takesDataFor(path) : roomDataFor(path);
      if(op === 'subscribe'){
        connection.subscriptions.add(path);
        value = path.includes('/takes_') ? takesDataFor(path) : roomDataFor(path);
      }
      if(op === 'unsubscribe'){
        connection.subscriptions.delete(path);
        value = true;
      }
      if(op === 'set' || op === 'update'){
        if(path.includes('/takes_')){
          if(!hostTakes.has(takesRoom)) hostTakes.set(takesRoom, new Map());
          const takeId = path.split('/').at(-1);
          hostTakes.get(takesRoom).set(takeId, data);
          value = data;
          broadcast(takesPath(takesRoom), takesDataFor(takesPath(takesRoom)));
        } else {
          const current = hostRoomData.get(roomId) || {};
          value = op === 'set' ? data : { ...current, ...data };
          hostRoomData.set(roomId, value);
          broadcast(roomPath(roomId), value);
        }
      }
      send(connection, { requestId, data: value });
    } catch(error) {
      send(connection, { requestId, error: error.message });
    }
  }

  const videoDownloads = new Map();
  function handleGuestMessage(roomId, message){
    if(message.type === 'snapshot'){
      notify(message.path, message.data);
      return;
    }
    if(message.type === 'video-meta'){
      videoDownloads.set(message.requestId, { ...message, chunks: [] });
      return;
    }
    if(message.type === 'video-chunk'){
      const download = videoDownloads.get(message.requestId);
      if(!download) return;
      download.chunks[message.index] = message.data;
      if(download.chunks.filter(Boolean).length === download.total){
        videoDownloads.delete(message.requestId);
        const blob = new Blob(download.chunks, { type: download.type });
        const request = pending.get(message.requestId);
        pending.delete(message.requestId);
        request?.resolve(new File([blob], download.name, { type: download.type }));
      }
      return;
    }
    const request = pending.get(message.requestId);
    if(!request) return;
    pending.delete(message.requestId);
    if(message.error) request.reject(new Error(message.error));
    else request.resolve(message.data);
  }

  async function request(op, path, data){
    if(path === 'healthcheck') return null;
    const roomId = path.includes('/takes_') ? takesRoomFromPath(path) : roomIdFromPath(path);
    if(op === 'set' && path.includes('/rooms/')){
      await ensureHost(roomId);
      hostRoomData.set(roomId, data);
      broadcast(roomPath(roomId), data);
      return data;
    }
    if(hostRoomId === roomId && peerReady){
      if(op === 'get') return path.includes('/takes_') ? takesDataFor(path) : roomDataFor(path);
      if(op === 'subscribe') return path.includes('/takes_') ? takesDataFor(path) : roomDataFor(path);
      if(op === 'unsubscribe') return true;
      if(path.includes('/takes_')){
        if(!hostTakes.has(roomId)) hostTakes.set(roomId, new Map());
        hostTakes.get(roomId).set(path.split('/').at(-1), data);
        const value = data;
        broadcast(takesPath(roomId), takesDataFor(takesPath(roomId)));
        return value;
      }
      const current = hostRoomData.get(roomId) || {};
      const value = op === 'set' ? data : { ...current, ...data };
      hostRoomData.set(roomId, value);
      broadcast(roomPath(roomId), value);
      return value;
    }
    const connection = await ensureGuest(roomId);
    const requestId = makeId();
    if(op === 'update'){
      send(connection, { type: 'request', requestId, op, path, data });
      return data;
    }
    return new Promise((resolve, reject) => {
      pending.set(requestId, { resolve, reject });
      send(connection, { type: 'request', requestId, op, path, data });
    });
  }

  const api = {
    async signInAnonymously() {
      return { user: { uid: crypto.randomUUID() } };
    },
    async signInWithCustomToken() {
      return api.signInAnonymously();
    },
    doc(_db, ...parts) {
      return parts.join('/');
    },
    collection(_db, ...parts) {
      return parts.join('/');
    },
    setDoc(ref, data) {
      return request('set', ref, data);
    },
    updateDoc(ref, data) {
      return request('update', ref, data);
    },
    async getDoc(ref) {
      const data = await request('get', ref);
      return { exists: () => data !== null, data: () => data };
    },
    async uploadVideo(roomId, file) {
      await ensureHost(roomId);
      videoStore.set(roomId, { name: file.name, type: file.type || 'video/mp4', body: await file.arrayBuffer() });
    },
    async downloadVideo(roomId) {
      const connection = await ensureGuest(roomId);
      const requestId = makeId();
      return new Promise((resolve, reject) => {
        pending.set(requestId, { resolve, reject });
        send(connection, { type: 'video-request', requestId, roomId });
      });
    },
    async announcePlayer(roomId, player) {
      const connection = await ensureGuest(roomId);
      send(connection, { type: 'player-presence', roomId, player });
    },
    onSnapshot(ref, callback, onError) {
      const current = listeners.get(ref) || [];
      const listener = data => callback(snapshot(data));
      listeners.set(ref, [...current, listener]);
      request('subscribe', ref).then(data => callback(snapshot(data))).catch(onError);
      return () => {
        const remaining = (listeners.get(ref) || []).filter(item => item !== listener);
        if (remaining.length) listeners.set(ref, remaining);
        else listeners.delete(ref);
        if(connections.size) request('unsubscribe', ref).catch(() => {});
      };
    }
  };

  return { api, db: {} };
}
