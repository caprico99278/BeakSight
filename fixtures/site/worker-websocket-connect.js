// DEF-040（NP3）: Worker の中で、同じサーバの /socket へ WebSocket の接続を開く script。
// classic の Worker（`new Worker('/worker-websocket-connect.js')`）、Shared Worker、module の Worker（`import` で読む）で共用する。
try {
  const socket = new WebSocket(self.location.origin.replace(/^http/, 'ws') + '/socket');
  socket.addEventListener('error', () => undefined);
} catch {
  // 接続できない場合の例外は、Worker の失敗にしない。
}
