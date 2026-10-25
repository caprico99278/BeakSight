/**
 * テストの既定の headless shell の起動の引数の置き場所（CC-098 で 1 か所にした）。`tests/helpers/chromium.ts` の `launchHeadlessChromium` と、子のプロセスの
 * 入口の本文（`test-login-worker-entry.ts`・`auto-login-worker-entry.ts`）の両方が、ここから読む。画面のテストの補助からも読まれるので、`vitest` を
 * 読み込まない。
 */
import {
  CHROMIUM_GOOGLE_SERVICES_DISABLED_ARGS,
  CHROMIUM_PRELOADING_DISABLED_ARGS,
  CHROMIUM_SHARED_WORKERS_DISABLED_ARGS,
  CHROMIUM_WEBRTC_NON_PROXIED_UDP_DISABLED_ARGS,
} from '../../src/browser/chromium-launch.js';

/**
 * テストの既定の headless shell に、既定で付ける起動の引数。CLI と同じ守りの引数のうち、headless shell に要るもの: WebRTC の中継を通らない UDP を
 * 止める引数（DEF-124）と、Shared Worker を無効にする引数（DEF-044）。BN-R0 の C-1 から、ページの先読みを止める引数（`--enable-features` と、
 * Playwright の既定の値を引き継いだ `--disable-features` の 1 つ。どちらも CLI と同じ値）も付ける（headless shell でも、speculation rules の先読みの文書の
 * 要求が Guard を通らずに届いたため）。
 */
export const TEST_DEFAULT_CHROMIUM_ARGS: readonly string[] = Object.freeze([
  ...CHROMIUM_PRELOADING_DISABLED_ARGS,
  ...CHROMIUM_GOOGLE_SERVICES_DISABLED_ARGS,
  ...CHROMIUM_WEBRTC_NON_PROXIED_UDP_DISABLED_ARGS,
  ...CHROMIUM_SHARED_WORKERS_DISABLED_ARGS,
]);

/**
 * 子のプロセスの入口の本文で、テストの既定の headless shell を起動する式。引数は `TEST_DEFAULT_CHROMIUM_ARGS` の値を、そのまま式に埋める
 * （子は `chromium` だけを読み込めばよい）。
 */
export const TEST_DEFAULT_CHROMIUM_LAUNCH_SOURCE = `chromium.launch({ headless: true, args: ${JSON.stringify(TEST_DEFAULT_CHROMIUM_ARGS)} })`;
