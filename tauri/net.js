// fetch der Tauri-Version: Anfragen an fremde Server gehen über Rust (reqwest) statt über die
// WebView. Damit gibt es wie bei Nodes fetch im Electron-Hauptprozess keine CORS-Grenzen und keine
// gesperrten Header (Rapla, my-mensa, OpenAI …). Antworten werden gestreamt (KI-Antworten live).
const nativeFetch = globalThis.fetch.bind(globalThis);
const { invoke, Channel } = window.__TAURI__.core;

let nextId = 1;
const NULL_BODY = new Set([101, 204, 205, 304]);

const isRemote = (u) => (u.protocol === 'https:' || u.protocol === 'http:') && u.hostname !== 'localhost' && !u.hostname.endsWith('.localhost');

async function bodyOf(body, headers) {
  if (body == null) return {};
  if (typeof body === 'string') return { bodyText: body, type: 'text/plain;charset=UTF-8' };
  // URLSearchParams, FormData, Blob, ArrayBuffer, Streams: wie der Browser serialisieren
  const r = new Response(body);
  const type = r.headers.get('content-type');
  const buf = new Uint8Array(await r.arrayBuffer());
  if (body instanceof URLSearchParams) return { bodyText: new TextDecoder().decode(buf), type };
  return { bodyB64: Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength).toString('base64'), type };
}

async function remoteFetch(input, init = {}) {
  const isReq = typeof Request !== 'undefined' && input instanceof Request;
  const url = new URL(isReq ? input.url : String(input instanceof URL ? input.href : input), location.href);
  const method = String(init.method || (isReq ? input.method : 'GET')).toUpperCase();
  // Eigenes Headers-Objekt: ohne „request“-Wächter gehen auch Header wie Origin/Referer durch
  const headers = new Headers(isReq ? input.headers : undefined);
  if (init.headers) new Headers(init.headers).forEach((v, k) => headers.set(k, v));
  let body = init.body;
  if (body === undefined && isReq && method !== 'GET' && method !== 'HEAD') body = await input.clone().arrayBuffer();
  const signal = init.signal || (isReq ? input.signal : undefined);
  if (signal && signal.aborted) throw signal.reason;

  const { bodyText, bodyB64, type } = await bodyOf(body, headers);
  if (type && !headers.has('content-type')) headers.set('content-type', type);

  const id = nextId++;
  let controller;
  let pendingErr = null;
  const queued = [];
  let ended = false;
  const stream = new ReadableStream({
    start(c) {
      controller = c;
      for (const q of queued) c.enqueue(q);
      if (pendingErr) c.error(pendingErr);
      else if (ended) c.close();
    },
    cancel() {
      invoke('http_abort', { id }).catch(() => {});
    },
  });
  const push = (chunk) => (controller ? controller.enqueue(chunk) : queued.push(chunk));
  const ch = new Channel();
  ch.onmessage = (m) => {
    if (m instanceof ArrayBuffer) return push(new Uint8Array(m));
    if (Array.isArray(m)) return push(Uint8Array.from(m));
    if (m && m.end) {
      ended = true;
      try {
        controller && controller.close();
      } catch {}
      return;
    }
    if (m && m.error) {
      const e = signal && signal.aborted ? signal.reason : Object.assign(new TypeError('terminated'), { cause: new Error(m.error) });
      pendingErr = e;
      try {
        controller && controller.error(e);
      } catch {}
    }
  };

  const onAbort = () => invoke('http_abort', { id }).catch(() => {});
  if (signal) signal.addEventListener('abort', onAbort, { once: true });

  let head;
  try {
    head = await invoke('http_request', {
      req: { id, method, url: url.href, headers: [...headers.entries()], bodyText, bodyB64, redirect: init.redirect || (isReq ? input.redirect : 'follow') },
      onBody: ch,
    });
  } catch (e) {
    if (signal) signal.removeEventListener('abort', onAbort);
    if (signal && signal.aborted) throw signal.reason;
    // Wie Node („fetch failed“), damit die Module Offline-Fehler erkennen
    throw Object.assign(new TypeError('fetch failed'), { cause: new Error(String(e)) });
  }
  const status = head.status < 200 ? 200 : head.status > 599 ? 599 : head.status;
  const res = new Response(NULL_BODY.has(status) || method === 'HEAD' ? null : stream, {
    status,
    statusText: head.statusText,
    headers: head.headers.filter(([k]) => !/^set-cookie2?$/i.test(k)),
  });
  if (NULL_BODY.has(status) || method === 'HEAD') stream.cancel().catch(() => {});
  // Wie Nodes fetch: Set-Cookie nur über getSetCookie() (der Browser-Response verwirft sie)
  const setCookies = head.headers.filter(([k]) => /^set-cookie$/i.test(k)).map(([, v]) => v);
  res.headers.getSetCookie = () => setCookies.slice();
  Object.defineProperty(res, 'url', { value: head.url });
  Object.defineProperty(res, 'redirected', { value: head.redirected });
  return res;
}

globalThis.fetch = function fetch(input, init) {
  let u;
  try {
    u = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.href);
  } catch {
    return nativeFetch(input, init);
  }
  if (!isRemote(u)) return nativeFetch(input, init);
  return remoteFetch(input, init);
};

module.exports = { nativeFetch };
