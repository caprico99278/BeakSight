// DEF-040（NP3）: http の script の Worker が、blob の script の入れ子の Worker を作り、その中で同じサーバの /socket へ WebSocket の接続を開く。
const script = [
  'try {',
  "  const socket = new WebSocket(self.location.origin.replace(/^http/, 'ws') + '/socket');",
  '  socket.addEventListener("error", () => undefined);',
  '} catch {',
  '  // 接続できない場合の例外は、Worker の失敗にしない。',
  '}',
].join('\n');
const nested = new Worker(URL.createObjectURL(new Blob([script], { type: 'text/javascript' })));
nested.addEventListener('error', () => undefined);
