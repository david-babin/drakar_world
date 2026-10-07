// ws-mini.js — serveur WebSocket minimal (RFC 6455), texte seulement, sans dépendance.
// Suffisant pour quelques dizaines de visiteurs ; pour des milliers, prendre `ws`.
import { createHash } from 'node:crypto';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_MESSAGE = 4 * 1024 * 1024;

export function attachWebSocket(server, path, onConnection, { pingMs = 25_000 } = {}) {
  const clients = new Set();

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://x');
    const key = req.headers['sec-websocket-key'];
    if (url.pathname !== path || !key || !/websocket/i.test(req.headers.upgrade || '')) { socket.destroy(); return; }
    const accept = createHash('sha1').update(key + GUID).digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.setNoDelay(true);

    const ws = {
      req, socket, alive: true, open: true, handlers: { message: [], close: [] },
      on(ev, f) { this.handlers[ev].push(f); return this; },
      send(data) { if (this.open) socket.write(frame(1, Buffer.from(typeof data === 'string' ? data : JSON.stringify(data)))); },
      close(code = 1000) { if (!this.open) return; this.open = false; try { socket.end(frame(8, Buffer.from([code >> 8, code & 255]))); } catch {} },
    };
    clients.add(ws);

    let buf = head.length ? Buffer.from(head) : Buffer.alloc(0), frag = null;
    const emitClose = () => { if (!clients.has(ws)) return; clients.delete(ws); ws.open = false; for (const f of ws.handlers.close) f(); };

    socket.on('data', chunk => {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      for (;;) {
        if (buf.length < 2) return;
        const b0 = buf[0], b1 = buf[1], fin = !!(b0 & 0x80), op = b0 & 0x0f, masked = !!(b1 & 0x80);
        let len = b1 & 0x7f, off = 2;
        if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
        else if (len === 127) { if (buf.length < 10) return; const big = buf.readBigUInt64BE(2); if (big > BigInt(MAX_MESSAGE)) { ws.close(1009); socket.destroy(); return; } len = Number(big); off = 10; }
        if (len > MAX_MESSAGE) { ws.close(1009); socket.destroy(); return; }
        if (!masked) { ws.close(1002); socket.destroy(); return; }      // un client doit masquer
        if (buf.length < off + 4 + len) return;
        const mask = buf.subarray(off, off + 4), payload = Buffer.allocUnsafe(len);
        for (let i = 0; i < len; i++) payload[i] = buf[off + 4 + i] ^ mask[i & 3];
        buf = buf.subarray(off + 4 + len);

        if (op === 0x8) { ws.close(1000); socket.end(); emitClose(); return; }
        if (op === 0x9) { if (ws.open) socket.write(frame(0xA, payload)); continue; }
        if (op === 0xA) { ws.alive = true; continue; }
        if (op === 0x1 || op === 0x2 || op === 0x0) {
          if (op !== 0x0) frag = { op, parts: [payload], size: len }; else if (frag) { frag.parts.push(payload); frag.size += len; } else continue;
          if (frag.size > MAX_MESSAGE) { ws.close(1009); socket.destroy(); return; }
          if (fin) { const msg = Buffer.concat(frag.parts); frag = null; if (op !== 0x2) for (const f of ws.handlers.message) f(msg.toString('utf8')); }
        }
      }
    });
    socket.on('close', emitClose); socket.on('error', emitClose); socket.on('end', emitClose);
    onConnection(ws);
  });

  const timer = setInterval(() => {
    for (const ws of clients) {
      if (!ws.alive) { ws.close(1001); ws.socket.destroy(); clients.delete(ws); for (const f of ws.handlers.close) f(); continue; }
      ws.alive = false;
      try { ws.socket.write(frame(0x9, Buffer.alloc(0))); } catch {}
    }
  }, pingMs);
  timer.unref();

  return {
    clients,
    broadcast(data, except = null) { const f = frame(1, Buffer.from(typeof data === 'string' ? data : JSON.stringify(data))); for (const ws of clients) if (ws !== except && ws.open) ws.socket.write(f); },
    get size() { return clients.size; },
  };
}

function frame(op, payload) {
  const len = payload.length;
  let head;
  if (len < 126) head = Buffer.from([0x80 | op, len]);
  else if (len < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | op; head[1] = 126; head.writeUInt16BE(len, 2); }
  else { head = Buffer.alloc(10); head[0] = 0x80 | op; head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2); }
  return Buffer.concat([head, payload]);
}
