# Loop Booth

Loop Booth is a browser-based collaborative dubbing studio. Split a video into lines, assign lines to players, record takes, review them together, and export the finished dub.

## Run locally

Requirements: Node.js 18 or newer.

```bash
npm install
npm run dev
```

Open [http://localhost:5173](http://localhost:5173) in your browser. Use `npm run check` to run the JavaScript syntax checks.

## Multiplayer

1. One person selects **Create Room** and uploads the video.
2. Share the five-character room code with the other players.
3. Guests enter their name and join the room.
4. The host video downloads automatically for each guest. Guests do not need their own copy of the file.
5. Once everyone is ready, the host starts the studio.

The local server supports up to four players and accepts videos up to 250 MB. Uploaded room videos are kept in server memory, so they are lost when the server restarts.

Microphone access is requested when entering the studio or recording a take. Allow it in the browser for recording to work.

## Single-player

Select **Play Singleplayer**, choose a video, and start the studio without creating a room or starting multiplayer.

## Project files

- `index.html` - main app entrypoint
- `src/app.js` - studio, lobby, recording, and export logic
- `src/network.js` - WebSocket-backed room synchronization client
- `server.js` - static server, room sync, take sync, and room video transfer
- `loop_booth.html` - legacy entrypoint that redirects to the main app