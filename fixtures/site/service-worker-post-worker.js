// Worker 自身が、install の時に、fixture のサーバへ POST を試みる（Task 18 の S08）。
// 遮断が働いていれば、この POST はサーバに届かない。
self.addEventListener('install', (event) => {
  event.waitUntil(fetch('/__mutation', { method: 'POST', body: 'service-worker' }).catch(() => undefined));
});
