// Minimaler Service Worker, damit das Spiel als App installiert werden kann. Alles kommt live aus dem Netz.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});
