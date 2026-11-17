const CACHE_NAME = 'pmcd-sugarbo-v47';
const ARQUIVOS = [
  './',
  './index.html',
  './andamento-quarteiroes.html',
  './andamento-quarteiroes-liraa.html',
  './pmcd-firebase-bridge.js',
  './public/andamento-quarteiroes.html',
  './public/andamento-quarteiroes-liraa.html',
  './public/pmcd-firebase-bridge.js',
  './firebase-applet-config.json',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  'https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js',
  'https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js',
  'https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js'
];
const ARQUIVOS_OPCIONAIS_PDF = [
  'https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.1/html2pdf.bundle.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js'
];

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      await Promise.allSettled(ARQUIVOS.map((u) => cache.add(u).catch(() => null)));
      await Promise.allSettled(ARQUIVOS_OPCIONAIS_PDF.map((u) => cache.add(u).catch(() => null)));
    })
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((chaves) =>
      Promise.all(chaves.map((k) => (k !== CACHE_NAME ? caches.delete(k) : null)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  // Chamadas do banco de dados Firestore e Firebase Auth continuam sempre na rede em tempo real
  if (
    e.request.url.includes('firestore.googleapis.com') ||
    e.request.url.includes('identitytoolkit.googleapis.com') ||
    e.request.url.includes('securetoken.googleapis.com') ||
    e.request.url.includes('firebase-applet-config.json')
  ) {
    return;
  }

  // Para páginas HTML e módulo da ponte Firebase: Network-First (sempre pega a versão mais recente quando online)
  if (
    e.request.mode === 'navigate' ||
    e.request.destination === 'document' ||
    e.request.url.includes('index.html') ||
    e.request.url.includes('andamento-quarteiroes') ||
    e.request.url.includes('pmcd-firebase-bridge.js')
  ) {
    e.respondWith(
      fetch(e.request)
        .then((networkResp) => {
          if (networkResp && networkResp.status === 200) {
            const clone = networkResp.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(e.request, clone));
          }
          return networkResp;
        })
        .catch(() => caches.match(e.request).then((cached) => cached || caches.match('./index.html')))
    );
    return;
  }

  // Demais recursos estáticos: Cache-first com fallback para rede
  e.respondWith(
    caches.match(e.request).then((resp) => {
      if (resp) return resp;
      return fetch(e.request).then((networkResp) => {
        if (networkResp && networkResp.status === 200 && e.request.method === 'GET') {
          const clone = networkResp.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(e.request, clone));
        }
        return networkResp;
      });
    })
  );
});
