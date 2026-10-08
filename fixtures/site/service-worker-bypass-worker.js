// DEF-049: `service-worker-bypass.html` が登録する Service Worker。install と activate のときに、fixture のサーバへ POST を試みる。
// 遮断が働いていれば、登録そのものが失敗し、この script は動かない。
self.addEventListener('install', (event) => {
  event.waitUntil(fetch('/__mutation', { method: 'POST', body: 'service-worker-install' }).catch(() => undefined));
  self.skipWaiting();
});
self.addEventListener('activate', (event) => {
  event.waitUntil(fetch('/__mutation', { method: 'POST', body: 'service-worker-activate' }).catch(() => undefined));
});
