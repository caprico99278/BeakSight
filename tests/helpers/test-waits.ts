/**
 * TEST-TIME-B・RB-2: テストが差し込む、本物の時計で待つ観察の長さ（1 か所）。本番の値は観察の窓の一式（`src/core/observation-windows.ts`）で、
 * `tests/unit/production-wait-values.test.ts` が値を確かめる。本番の入口が口を渡さないことは `tests/architecture/worker-login-hooks.test.ts` の (n)・(p)。
 * - 同じ process のテストは、流れの依頼の `observationWindows` に `TEST_OBSERVATION_WINDOWS` を渡す。
 * - fork のテストは、テストだけの入口の `runAuditWorkerProcess` の口の組に `TEST_WAITS_HOOK_SOURCE` を足す（`additionalHooks`）。
 * - 押した後に遅れて動くページの fixture は、遅れをこの窓より短くする（窓の中で動きを見て、届いた数 0 の確かめを残す）。
 */
import { observationWindowsOf, type ObservationWindows, type ObservationWindowsOverrides } from '../../src/core/observation-windows.js';

/** 押した後の静まりの窓（ms。本番は 5 秒）。落ち着きの待ちの静まりの窓（500ms）より長くし、押した後に遅れて動くページの fixture の遅れより長い。 */
export const TEST_PRESS_QUIET_WINDOW_MS = 1_500;

/** probe の押した後の最短の観察（ms。本番は 2 秒）。 */
export const TEST_PROBE_QUIET_WAIT_MS = 500;

/**
 * SLIM-2（X5b）: 監査の段の送信の扱い `PASS_EXCEPT_DELETE` で、ページの監査の読み込みの Context を閉じる前に待つ時間（ms。本番は `AUDIT_SEND_CLOSE_SETTLE_MS` の
 * 1 秒）。ループバックの fixture では、ページを離れるときの送信は数 ms で届く。本番の値の確かめは `production-wait-values` と、口を渡さない結合
 * （`guard-unload-requests`・`guard-audit-send-revisit-close`・`audit-send-worker-fork`）。
 */
export const TEST_AUDIT_SEND_CLOSE_SETTLE_MS = 200;

/**
 * REV-RB8911 M-3（DEF-280）: 書き込みの流れの結合が渡す、押した後の結果の待ちの反応なしの長さ（ms。依頼の `resultTimeoutMs`。本番は見張りの上限 180 秒）。
 * 混んだ端末でも、ループバックの fixture の応答と送った後の画面の落ち着きを待てる長さ（前の 3 秒では、混んだときに見張りが先に終えた）。
 */
export const TEST_WRITE_RESULT_QUIET_LIMIT_MS = 30_000;

/** テストが差し込む一式の差分（上の 3 つ。ほかは本番の値）。 */
const TEST_OBSERVATION_WINDOW_OVERRIDES: ObservationWindowsOverrides = Object.freeze({
  afterPress: { pressQuietWindowMs: TEST_PRESS_QUIET_WINDOW_MS, probeQuietWaitMs: TEST_PROBE_QUIET_WAIT_MS },
  beforeClose: { auditSendCloseSettleMs: TEST_AUDIT_SEND_CLOSE_SETTLE_MS },
});

/** 同じ process のテストが流れの依頼に渡す一式。 */
export const TEST_OBSERVATION_WINDOWS = observationWindowsOf(TEST_OBSERVATION_WINDOW_OVERRIDES);

/**
 * RB-fix-456: 書き込みの段を 1 回だけ流す場面の一式（上の一式に、候補の画面と照合の READ を読む前の落ち着きの待ちの短い値を足す。ループバックの fixture で、
 * 要求は数 ms で終わる）。押した後の静まりの窓は、この落ち着きの待ちの静まりより長いまま短くする。
 */
export const TEST_SHORT_SETTLE_OBSERVATION_WINDOWS = observationWindowsOf({
  ...TEST_OBSERVATION_WINDOW_OVERRIDES,
  discoverySettle: { networkQuietMs: 100, pollIntervalMs: 20, probeIntervalMs: 50 },
  afterPress: { ...TEST_OBSERVATION_WINDOW_OVERRIDES.afterPress, pressQuietWindowMs: 600 },
});

/**
 * RB-10: Page Auditor を本物の口で 1 回流す場面の一式（上の一式に、落ち着き・スクロール・知らせの枠の待ちの短い値を足す）。ループバックの fixture の
 * 画面は数 ms で描かれる。遅れて描く fixture の遅れは、この窓より短くする。
 */
export const TEST_SHORT_AUDIT_OBSERVATION_WINDOWS = observationWindowsOf({
  ...TEST_OBSERVATION_WINDOW_OVERRIDES,
  pageSettle: { pollIntervalMs: 50, stableWindowMs: 200 },
  scroll: { stepWaitMs: 50, stableWindowMs: 200 },
  notification: { dismissWaitMs: 300 },
});

/** probe の押した後の最短の観察だけをテストの値 `probeQuietWaitMs` に替えた一式（同じ process の発見のテストが、自分の長さで流すとき）。 */
export const probeQuietWindowsOf = (probeQuietWaitMs: number): ObservationWindows => observationWindowsOf({ afterPress: { probeQuietWaitMs } });

/** fork のテストだけの入口に足す、観察の窓の一式の口（`runAuditWorkerProcess` の口の組の項目。`,` で終える）。 */
export const TEST_WAITS_HOOK_SOURCE = `
  observationWindows: ${JSON.stringify(TEST_OBSERVATION_WINDOW_OVERRIDES)},`;
