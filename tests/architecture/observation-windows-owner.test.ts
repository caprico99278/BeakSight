/**
 * RB-2（再構築の設計書 2 章 4。TEST-TIME-B の条件 1「待ちは、依存の注入か偽の時計で差し込む」）: 観察の窓の一式（`src/core/observation-windows.ts`）の外に、
 * 決め打ちの待ちを置かない Architecture Gate。判定は `source-scan.ts` の文字列の走査だけ（近似の検査）。
 * - (a) `wait(`・`sleep(`・`waitMs(`・`setTimeout(` の待つ長さに、数の literal を書かない。名前つきの例外は、時間の部品そのもの（`src/core/deadline.ts`）・
 *   Guard（`src/safety/`）・ジョブの管理（`src/control/job/`）・起動（`chromium-launch.ts`）・pacer（`navigation-pacer.ts`）。これらの待ちは一式に入れない
 *   （守りの値と上限。本番の値のまま）。
 * - (b) 一式の本番の値（`PRODUCTION_OBSERVATION_WINDOWS`）を owner の外で直に読む所は、移る途中の閉じた一覧（ファイル → 件数）だけ。差し込まれた一式
 *   （`observationWindows`）を読む形に替えた段は、一覧の件数を減らす。件数の違いと、使われない行も誤りにする。
 */
import { describe, expect, it } from 'vitest';
import {
  findCallSites,
  isPathUnderAny,
  judgeWithFileExceptions,
  loadSourceFiles,
  scanSource,
  splitTopLevelArguments,
  countIdentifier,
  type FileExceptions,
  type ScannedSource,
} from './source-scan.js';

const OWNER_PATH = 'src/core/observation-windows.ts';
const PRODUCTION_NAME = 'PRODUCTION_OBSERVATION_WINDOWS';

/** (a) 待つ長さが最初の引数の呼び出し。 */
const DELAY_FIRST_CALLS: readonly string[] = ['wait', 'sleep', 'waitMs'];
/** (a) 名前つきの例外（守りの値・上限・時間の部品そのもの）。 */
const LITERAL_DELAY_OWNERS: readonly string[] = [
  'src/core/deadline.ts', 'src/safety/', 'src/control/job/', 'src/browser/chromium-launch.ts', 'src/crawl/navigation-pacer.ts',
];
const NUMBER_LITERAL = /^\d[\d_]*(?:\.\d+)?$/u;

/**
 * (b) 移る途中の例外（ファイル → 件数）。今の定数の名前（別名）を一式から導く所と、差し込まれた一式がないときの既定。後の段（RB-8〜RB-12）が部品ごとに
 * 差し込みへ替えて減らす。
 */
const TRANSITIONAL_PRODUCTION_READERS: FileExceptions = {
  'src/browser/context-factory.ts': { count: 3, reason: '閉じる前の待ちの別名（差し込みは済み。別名を消す段で 0 に）' },
  'src/browser/form-submission-common.ts': { count: 2, reason: '書き込みの入力の 1 手を待つ長さの既定（見張りの反応なしの上限と同じ。呼ぶ側が `timeoutMs` で渡す）' },
  'src/browser/page-progress-signals.ts': { count: 6, reason: 'DOM の見張りの間隔と見張りの上限（RB-9）' },
  'src/browser/page-settling.ts': { count: 4, reason: '開いたままのデータの要求の静まりの既定（RB-9）' },
  'src/core/limits.ts': { count: 6, reason: '落ち着きとスクロールの待ち方の別名（RB-9・RB-10）' },
  'src/core/progress-watch.ts': { count: 4, reason: '見張りの反応なしの上限の別名（RB-9）' },
  'src/discovery/discover-page.ts': { count: 10, reason: '画面の見出しの待ちと発見の落ち着き（RB-8）' },
  'src/discovery/read-executor.ts': { count: 2, reason: 'READ の落ち着きの既定の引数（呼ぶ側の READ と書き込みは `settlePolicy` を渡す。差し込みは済み）' },
  'src/discovery/settle.ts': { count: 15, reason: '発見の落ち着きの別名（RB-8）' },
  'src/discovery/submission-probe-contracts.ts': { count: 3, reason: 'probe の押した後の最短の観察の別名（差し込みは済み。RB-13）' },
  'src/interaction/isolated-auditor.ts': { count: 3, reason: 'Interaction の落ち着き（RB-10）' },
  'src/interaction/notification-overlay.ts': { count: 6, reason: '操作さがしの知らせの枠の上限の別名と、発見の落ち着きの既定（RB-8。閉じる輪の待ちは RB-9 で差し込みへ）' },
  'src/interaction/submission-probe.ts': { count: 9, reason: '押した後の落ち着きと最短の観察の既定（RB-13）と、消えた要素を見放す確かめの窓（QUIET-1。落ち着きの静まりの窓と同じ値）' },
  'src/orchestration/page-auditor.ts': { count: 6, reason: '段の見張りの間隔・スクロールの量・見張りの上限（RB-10）' },
  'src/orchestration/visible-pacing-wait.ts': { count: 4, reason: '見せたまま待つ間の印の間隔（RB-10）' },
  'src/safety/passive-request-guard.ts': { count: 2, reason: 'Guard の閉じるときの作業の待ちの上限（factory の注入で替わる。RB-14）' },
  'src/worker/authenticated-login.ts': { count: 4, reason: '手動のログインの確かめの間隔（RB-12）' },
  'src/worker/automated-login.ts': { count: 7, reason: '自動ログインの確かめの間隔と送信の窓（RB-12）' },
  'src/worker/login-stage-checks.ts': { count: 5, reason: 'ログインの欄を待つ間隔（RB-12）' },
};

/** (a) 待つ長さに数の literal を書いた呼び出し（`<名前>(<literal>)`）。 */
const findLiteralDelays = (source: ScannedSource): readonly string[] => [
  ...DELAY_FIRST_CALLS.flatMap((name) => findCallSites(source.bare, name)
    .map(({ argumentText }) => splitTopLevelArguments(argumentText)[0] ?? '')
    .filter((delay) => NUMBER_LITERAL.test(delay)).map((delay) => `${name}(${delay})`)),
  ...findCallSites(source.bare, 'setTimeout')
    .map(({ argumentText }) => splitTopLevelArguments(argumentText)[1] ?? '')
    .filter((delay) => NUMBER_LITERAL.test(delay)).map((delay) => `setTimeout(…, ${delay})`),
];

/**
 * (b) 一式の本番の値の別名（RB-2 の前からの定数の名前。値は一式から導く）。知らせの枠の決まりは、待ちの 2 つの値だけを数える（押す数などは待ちでない）。
 */
const PRODUCTION_ALIASES: readonly string[] = [
  'PAGE_SETTLING_PACING', 'CONTROLLED_SCROLL_PACING', 'OPEN_DATA_REQUEST_QUIET_MS', 'PRESS_QUIET_WINDOW_MS',
  'DISCOVERY_SETTLE_POLICY', 'DISCOVERY_NETWORK_QUIET_MS', 'DISCOVERY_SETTLE_TIMEOUT_MS', 'DISCOVERY_SETTLE_POLL_INTERVAL_MS',
  'DISCOVERY_SETTLE_PROBE_INTERVAL_MS', 'DISCOVERY_RESPONSE_BODY_GRACE_MS', 'BUSY_PAGE_CANDIDATE_SETTLE_POLICY', 'API_WRITE_VALUE_QUIET_POLICY',
  'API_WRITE_VALUE_QUIET_TIMEOUT_MS', 'DISCOVERY_SCREEN_HEADING_WAIT_MS', 'DISCOVERY_SCREEN_HEADING_POLL_MS', 'DISCOVERY_NOTIFICATION_BUDGET_MS',
  'SUBMISSION_PROBE_QUIET_WAIT_MS', 'AUDIT_SEND_CLOSE_SETTLE_MS', 'WRITE_SUBMISSION_WINDOW_SETTLE_MS', 'WRITE_RESULT_POLL_INTERVAL_MS',
  'SUBMISSION_WINDOW_SETTLE_MS', 'API_WRITE_VALUE_SETTLE_INTERVAL_MS', 'API_WRITE_INPUT_APPEAR_POLL_MS', 'API_WRITE_REFILL_SETTLE_MS',
  'AUTOMATED_LOGIN_POLL_INTERVAL_MS', 'LOGIN_POLL_INTERVAL_MS', 'LOGIN_FIELDS_WAIT_POLL_MS', 'PROGRESS_WATCH_QUIET_LIMIT_MS',
  'PAGE_PROGRESS_DOM_POLL_INTERVAL_MS', 'PACING_WAIT_PROGRESS_MARK_INTERVAL_MS',
];
const NOTIFICATION_WAIT_READ = /(?<![\w$])NOTIFICATION_DISMISSAL_LIMITS\s*\.\s*(?:dismissWaitMs|dismissPollIntervalMs)\b/gu;

/** (b) 一式の本番の値を、差し込みを通さずに読む所（本番の一式とその別名の出現。import の行も 1 つと数える）。 */
const findProductionReads = (source: ScannedSource): readonly string[] => [
  ...[PRODUCTION_NAME, ...PRODUCTION_ALIASES].flatMap((name) => Array.from({ length: countIdentifier(source.bare, name) }, () => name)),
  ...[...source.bare.matchAll(NOTIFICATION_WAIT_READ)].map((match) => match[0]),
];

const SOURCE_FILES = loadSourceFiles();

describe('RB-2: no fixed wait outside the observation windows', () => {
  it('reads the owner of the observation windows', () => {
    expect(SOURCE_FILES.map(({ path }) => path)).toContain(OWNER_PATH);
  });

  it('(a) writes no number literal as the length of a wait, except the named owners of the guard values and the limits', () => {
    const found = SOURCE_FILES
      .filter(({ path }) => !isPathUnderAny(path, LITERAL_DELAY_OWNERS))
      .flatMap((file) => findLiteralDelays(file).map((call) => `${file.path}: ${call}`));
    expect(found).toEqual([]);
  });

  it('(b) reads the production windows directly only in the owner and the closed transitional list', () => {
    const judgement = judgeWithFileExceptions(SOURCE_FILES.filter(({ path }) => path !== OWNER_PATH), findProductionReads, TRANSITIONAL_PRODUCTION_READERS);
    expect(judgement).toEqual({ found: [], countMismatches: [], unusedExceptions: [] });
  });

  it('detects the patterns (detector self-check)', () => {
    for (const line of ['await wait(300);', 'await sleep(1_000);', 'setTimeout(resolve, 250);', 'await this.waitMs(2.5);']) {
      expect(findLiteralDelays(scanSource(line)), line).toHaveLength(1);
    }
    for (const line of ['await wait(windows.write.resultPollIntervalMs);', 'setTimeout(check, Math.max(0, at));', 'await sleep(ms);', 'function wait(delayMs: number) {}']) {
      expect(findLiteralDelays(scanSource(line)), line).toEqual([]);
    }
    expect(findProductionReads(scanSource(`const a = ${PRODUCTION_NAME}.write; // ${PRODUCTION_NAME}`))).toHaveLength(1);
  });
});
