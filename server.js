// Static file server + WebSocket room server (OTP rooms). Run: npm install && npm start
const http = require('http'), fs = require('fs'), path = require('path');
const { WebSocketServer } = require('ws');
const PORT = process.env.PORT || 3000;
const MIME = { '.html':'text/html; charset=utf-8', '.js':'text/javascript', '.css':'text/css', '.glb':'model/gltf-binary', '.json':'application/json', '.svg':'image/svg+xml', '.wasm':'application/wasm' };
const roots = [ ['/three/', path.join(__dirname, 'node_modules/three/')], ['/', path.join(__dirname, 'public/')] ];
const clean = s => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const server = http.createServer((req, res) => {
  let url = decodeURIComponent(req.url.split('?')[0]); if (url === '/') url = '/index.html';
  if (url.startsWith('/models/')) { // tolerant file names: "vecarz_com" == "vecarz.com" == "vecarz com (1)"
    try {
      const want = clean(path.basename(url)), real = fs.readdirSync(path.join(__dirname, 'public/models')).find(f => clean(f) === want);
      if (real) url = '/models/' + real;
    } catch {}
  }
  for (const [prefix, dir] of roots) {
    if (!url.startsWith(prefix)) continue;
    const file = path.normalize(path.join(dir, url.slice(prefix.length)));
    if (!file.startsWith(dir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) continue;
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Content-Length': fs.statSync(file).size, 'Cache-Control': 'no-cache' });
    return fs.createReadStream(file).pipe(res);
  }
  res.writeHead(404); res.end('Not found');
});
server.listen(PORT, () => console.log('Game running on http://localhost:' + PORT));

const wss = new WebSocketServer({ server, path: '/ws' });
const rooms = new Map(); let uid = 1;
const send = (ws, m) => ws.readyState === 1 && ws.send(JSON.stringify(m));
const lobby = r => ({ type: 'lobby', code: r.code, hostName: r.hostName, max: r.max, map: r.map,
  players: [...r.players.values()].map(p => ({ pid: p.pid, name: p.name, car: p.car })) });
const cast = (r, m, except) => r.players.forEach(p => p.ws !== except && send(p.ws, m));
wss.on('connection', ws => {
  const me = { ws, pid: uid++, room: null, name: 'Racer', car: 'rusty' };
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.type === 'host') {
      let code; do { code = String(Math.floor(100000 + Math.random() * 900000)); } while (rooms.has(code));
      const r = { code, hostPid: me.pid, hostName: m.name, max: Math.min(8, Math.max(1, m.max | 0)), map: m.map, players: new Map(), started: false, finished: [] };
      rooms.set(code, r); me.room = r; me.name = m.name; me.car = m.car; r.players.set(me.pid, me);
      send(ws, { type: 'joined', pid: me.pid, isHost: true }); cast(r, lobby(r));
    } else if (m.type === 'join') {
      const r = rooms.get(String(m.code));
      if (!r) return send(ws, { type: 'error', msg: 'Wrong code. Check the code and try again.' });
      if (r.started) return send(ws, { type: 'error', msg: 'This race already started.' });
      if (r.players.size >= r.max) return send(ws, { type: 'error', msg: 'This room is full.' });
      me.room = r; me.name = m.name; me.car = m.car; r.players.set(me.pid, me);
      send(ws, { type: 'joined', pid: me.pid, isHost: false }); cast(r, lobby(r));
    } else if (m.type === 'car' && me.room) {
      me.car = m.car; cast(me.room, lobby(me.room));
    } else if (m.type === 'start' && me.room && me.room.hostPid === me.pid) {
      const r = me.room; r.started = true; r.finished = [];
      cast(r, { type: 'start', order: [...r.players.keys()], map: r.map, laps: 3 });
    } else if (m.type === 'state' && me.room) {
      cast(me.room, { type: 'state', pid: me.pid, s: m.s }, ws);
    } else if (m.type === 'finish' && me.room) {
      const r = me.room; if (r.finished.includes(me.pid)) return;
      r.finished.push(me.pid);
      cast(r, { type: 'finished', pid: me.pid, place: r.finished.length, name: me.name });
    }
  });
  ws.on('close', () => {
    const r = me.room; if (!r) return; r.players.delete(me.pid);
    if (r.players.size === 0) rooms.delete(r.code); else cast(r, lobby(r));
  });
});
