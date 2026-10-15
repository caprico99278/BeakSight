// DEF-099 fix: Guard を直接付けるテスト（書き込みの段）の、書き込みの送信の送り手の指定（テストの補助）。製品の中継（`startEgressProxy`。factory と
// 同じ PASS_THROUGH）を 127.0.0.1 で起動し、送り手がそこを通して送る指定（`PassiveRequestGuardOptions.writeSubmission`）を返す。
// Context そのものには中継を付けない（Guard の判定のテストのまま。送り手の送信だけが中継を通る）。
import { startEgressProxy } from '../../src/safety/egress-proxy.js';
import type { WriteSubmissionOptions } from '../../src/safety/write-submission-sender.js';

export interface WriteSubmissionProxy {
  readonly options: WriteSubmissionOptions;
  close(): Promise<void>;
}

/** 送り手の中継を起動する（`locale` は `Accept-Language` の値）。 */
export async function startWriteSubmissionProxy(locale = 'ja-JP'): Promise<WriteSubmissionProxy> {
  const proxy = await startEgressProxy({ upstreamFailureMode: 'PASS_THROUGH', onRejected: () => undefined, onError: () => undefined });
  return {
    options: Object.freeze({ proxy: Object.freeze({ host: new URL(proxy.server).hostname, port: proxy.port }), acceptLanguage: locale }),
    close: () => proxy.close(),
  };
}
