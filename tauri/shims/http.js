// Ersatz für Nodes „http“ (nur createServer): lokale Rückruf-Server für die ChatGPT- und
// Passkey-Anmeldung. Den Socket öffnet Rust (tiny_http), Anfragen beantwortet dieser Code.
const { EventEmitter } = require('events');
const invoke = (...a) => window.__TAURI__.core.invoke(...a);

class ServerResponse {
  constructor(server, req) {
    this.server = server;
    this.req = req;
    this.statusCode = 200;
    this.headers = {};
    this.chunks = [];
    this.finished = false;
  }
  setHeader(k, v) {
    this.headers[k] = v;
  }
  writeHead(status, headers) {
    this.statusCode = status;
    Object.assign(this.headers, headers || {});
    return this;
  }
  write(chunk) {
    if (chunk != null) this.chunks.push(String(chunk));
    return true;
  }
  end(body) {
    if (this.finished) return;
    this.finished = true;
    if (body != null) this.chunks.push(String(body));
    if (this.server.id == null) return;
    invoke('server_respond', {
      id: this.server.id,
      req: this.req,
      status: this.statusCode,
      headers: Object.entries(this.headers).map(([k, v]) => [k, String(v)]),
      body: this.chunks.join(''),
    }).catch(() => {});
  }
}

class Server extends EventEmitter {
  constructor() {
    super();
    this.id = null;
    this.port = null;
    this.closed = false;
  }
  listen(port, host, cb) {
    if (typeof host === 'function') [cb, host] = [host, undefined];
    const ch = new window.__TAURI__.core.Channel();
    ch.onmessage = (m) => {
      const req = { method: m.method, url: m.url, headers: Object.fromEntries(m.headers) };
      this.emit('request', req, new ServerResponse(this, m.req));
    };
    invoke('server_listen', { port: Number(port) || 0, host: host || '127.0.0.1', onRequest: ch })
      .then((r) => {
        this.id = r.id;
        this.port = r.port;
        if (this.closed) return invoke('server_close', { id: r.id });
        this.emit('listening');
        if (cb) cb();
      })
      .catch((e) => {
        const msg = String(e && e.message ? e.message : e);
        this.emit('error', Object.assign(new Error(msg), { code: msg.startsWith('EADDRINUSE') ? 'EADDRINUSE' : 'EIO' }));
      });
    return this;
  }
  address() {
    return { port: this.port, address: '127.0.0.1', family: 'IPv4' };
  }
  close(cb) {
    if (!this.closed) {
      this.closed = true;
      if (this.id != null) invoke('server_close', { id: this.id }).catch(() => {});
      setTimeout(() => {
        this.emit('close');
        if (cb) cb();
      });
    }
    return this;
  }
  closeAllConnections() {}
}

function createServer(handler) {
  const s = new Server();
  if (handler) s.on('request', handler);
  return s;
}

module.exports = { createServer, Server };
