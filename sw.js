// Decrypts this site's files on the fly. The key comes from the login page (IndexedDB);
// files live in _enc/ under keyed-hash names. Without a valid key, requests pass through,
// so the network serves the login page (index.html / 404.html).
const ROOT = new URL('./', self.location).pathname;
const DB = 'site-lock', STORE = 'keys', ID = 'v1';
const TEXT = { html: 'text/html', htm: 'text/html', css: 'text/css', js: 'text/javascript', mjs: 'text/javascript',
  json: 'application/json', md: 'text/markdown', txt: 'text/plain', py: 'text/plain', java: 'text/plain',
  cpp: 'text/plain', c: 'text/plain', svg: 'image/svg+xml', xml: 'application/xml', csv: 'text/csv',
  excalidraw: 'application/json', excalidrawlib: 'application/json' };
const BINARY = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  ico: 'image/x-icon', pdf: 'application/pdf', woff: 'font/woff', woff2: 'font/woff2', zip: 'application/zip',
  mp4: 'video/mp4' };
const enc = new TextEncoder();
let keys = null;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('message', e => { if (e.data === 'reload-keys') keys = null; });

function idb(mode, op) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DB, 1);
    open.onupgradeneeded = () => open.result.createObjectStore(STORE);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const tx = open.result.transaction(STORE, mode), req = op(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error);
    };
  });
}
const unhex = h => Uint8Array.from(h.match(/../g), x => parseInt(x, 16));
const hex = b => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');

// Opens a blob (mac + iv + ciphertext); returns null if it was not made with this key.
async function open(k, raw) {
  const mac = raw.slice(0, 32), iv = raw.slice(32, 48), ct = raw.slice(48);
  if (!await crypto.subtle.verify('HMAC', k.mac, mac, raw.slice(32))) return null;
  const packed = await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, k.aes, ct);
  return new Response(new Blob([packed]).stream().pipeThrough(new DecompressionStream('deflate'))).arrayBuffer();
}

async function getKeys() {
  if (keys) return keys;
  const h = await idb('readonly', s => s.get(ID)).catch(() => null);
  if (!h) return null;
  const b = unhex(h);
  const k = {
    aes: await crypto.subtle.importKey('raw', b.slice(0, 32), 'AES-CBC', false, ['decrypt']),
    mac: await crypto.subtle.importKey('raw', b.slice(32), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']),
  };
  const check = await fetch(ROOT + '_enc/check', { cache: 'no-cache' });
  if (!check.ok || !await open(k, new Uint8Array(await check.arrayBuffer()))) {
    await idb('readwrite', s => s.delete(ID)).catch(() => {});  // password changed: log in again
    return null;
  }
  return keys = k;
}

const nameOf = async (k, rel) => hex(await crypto.subtle.sign('HMAC', k.mac, enc.encode('name:' + rel.normalize('NFC')))).slice(0, 40);
const typeOf = rel => {
  const ext = (rel.match(/\.([^./]+)$/) || [])[1]?.toLowerCase() || '';
  return TEXT[ext] ? TEXT[ext] + '; charset=utf-8' : BINARY[ext] || 'application/octet-stream';
};

async function serve(request, url) {
  const k = await getKeys();
  if (!k) return fetch(request);
  let rel = decodeURIComponent(url.pathname.slice(ROOT.length));
  if (rel === '' || rel.endsWith('/')) rel += 'index.html';
  let res = await fetch(ROOT + '_enc/' + await nameOf(k, rel));
  if (res.status === 404 && !/\.[^./]+$/.test(rel)) {  // a folder without its trailing slash
    const idx = await fetch(ROOT + '_enc/' + await nameOf(k, rel + '/index.html'), { method: 'HEAD' });
    if (idx.ok) return Response.redirect(url.origin + url.pathname + '/' + url.search, 301);
  }
  if (!res.ok) return new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain' } });
  const body = await open(k, new Uint8Array(await res.arrayBuffer()));
  if (!body) return new Response('Could not decrypt this file', { status: 500 });
  return new Response(body, { headers: { 'Content-Type': typeOf(rel) } });
}

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || !url.pathname.startsWith(ROOT)) return;
  const rel = url.pathname.slice(ROOT.length);
  if (rel === 'sw.js' || rel.startsWith('_enc/')) return;
  e.respondWith(serve(e.request, url));
});
