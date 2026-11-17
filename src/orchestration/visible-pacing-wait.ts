// DEF-236（設計書 `doc/design/2026-11-09-beaksight-visible-pacing-wait-design.md` 3.1・3.2）: 読み込みの間隔の待ちを、前の画面を閉じずに見せたまま行う部品。
// 監査（Page Auditor の Desktop・Mobile・幅の走査の各幅）と、1 画面の読み込み（`visitGuardedPage`。操作さがし・READ の確かめ・書き込みの段）が共有する唯一の口。
// - 証拠を集め終えた後、閉じる前に呼ぶ。Guard に待ちの印を付け（`announcePacingWait`）、pacer の目標の時刻まで待つ（`waitUntilNextNavigationDue`）。待ち終えて
//   から、呼ぶ側が閉じ、次のセッションを作る（同時に 2 つの Context は生かさない。DEF-191）。
// - 待ちの間の要求と止めた事象は、その画面の数（Guard の印）にも、Finding などの判定の入力（`withoutPacingWaitEvents`）にも入れない。記録（Safety Ledger）には残す。
//   安全の判定（DELETE・危険な語・資格情報などの止め）は、今のまま当たる。
// - 待ちは BeakSight 自身の間隔なので、進みの見張りの「反応なし」に数えない（呼ぶ側の見張りの口に、待つ間も中身の進みの印を付ける）。
// - 待ちの失敗（pacer の reject）は飲み込む（閉じることを妨げない。次の `beforeNavigation()` が、今どおり失敗を返す）。
import type { Page } from 'playwright';
import { SAFETY_EVENT_KINDS, type SafetyEventKind, type SafetyEventsEvidence } from '../core/evidence-types.js';
import { PRODUCTION_OBSERVATION_WINDOWS } from '../core/observation-windows.js';
import type { ProgressSignals } from '../core/progress-watch.js';
import type { NavigationPacer } from '../crawl/navigation-pacer.js';
import { announcePacingWait } from '../safety/passive-request-guard.js';
import type { SafetyLedger, SafetyLedgerSnapshot } from '../safety/safety-ledger.js';

/** 待つ間に、見張りの口へ中身の進みの印を付ける間隔（ms。見張りの反応なしの長さより十分に短い。RB-2: 観察の窓の一式の `watch.pacingMarkIntervalMs`）。 */
export const PACING_WAIT_PROGRESS_MARK_INTERVAL_MS = PRODUCTION_OBSERVATION_WINDOWS.watch.pacingMarkIntervalMs;

/** Ledger の、事象の一覧ごとの件数と、止めた読み取りでない要求の数の合計（待ちの始まりと終わりに数える）。 */
interface LedgerEventCounts {
  readonly events: Readonly<Record<SafetyEventKind, number>>;
  readonly blockedRequestsByMethod: number;
}

/** 1 つの Ledger の、見せたままの待ちの範囲（待ちの始まりと終わりの件数）。 */
export interface PacingWaitWindow {
  readonly ledger: SafetyLedger;
  readonly start: LedgerEventCounts;
  readonly end: LedgerEventCounts;
}

const eventCountsOf = (snapshot: Pick<SafetyLedgerSnapshot, SafetyEventKind | 'blockedRequestsByMethod'>): LedgerEventCounts => Object.freeze({
  events: Object.freeze(Object.fromEntries(SAFETY_EVENT_KINDS.map((kind) => [kind, snapshot[kind].length])) as Record<SafetyEventKind, number>),
  blockedRequestsByMethod: Object.values(snapshot.blockedRequestsByMethod).reduce((total, count) => total + count, 0),
});

/** `waitWithPageShown` の入力。 */
export interface PacingWaitOptions {
  /** 見せたままの page（閉じる前）。 */
  readonly page: Page;
  /** その page の Context の Ledger（待ちの範囲を数える）。 */
  readonly ledger: SafetyLedger;
  readonly pacer: Pick<NavigationPacer, 'waitUntilNextNavigationDue'>;
  /** 呼ぶ側の段を包む見張りの口（あれば、待つ間も中身の進みの印を付ける）。 */
  readonly signals?: Pick<ProgressSignals, 'mark'> | null | undefined;
}

/**
 * 前の画面を閉じずに見せたまま、次の読み込みの目標の時刻まで待つ（ファイルの先頭の説明）。page が閉じていたら待たずに `null`。待った範囲（Ledger の件数）を返す。
 * 例外を投げない。
 */
export async function waitWithPageShown(options: PacingWaitOptions): Promise<PacingWaitWindow | null> {
  const { page, ledger, pacer, signals } = options;
  if (page.isClosed()) {
    return null;
  }
  announcePacingWait(page);
  const start = eventCountsOf(ledger.snapshot());
  signals?.mark('BROWSER_RESPONSE');
  const marker = signals === null || signals === undefined
    ? undefined
    : setInterval(() => signals.mark('BROWSER_RESPONSE'), PACING_WAIT_PROGRESS_MARK_INTERVAL_MS);
  try {
    await pacer.waitUntilNextNavigationDue();
  } catch {
    // 待ちの失敗で、閉じることを妨げない（次の `beforeNavigation()` が、今どおり失敗を返す）。
  } finally {
    if (marker !== undefined) {
      clearInterval(marker);
    }
    signals?.mark('BROWSER_RESPONSE');
  }
  return Object.freeze({ ledger, start, end: eventCountsOf(ledger.snapshot()) });
}

/**
 * safety の Evidence（Ledger の snapshot から作ったもの）から、見せたままの待ちの間に記録した事象を除く（判定の入力にする写し。記録には全部を残す）。
 * 一覧は記録の順なので、待ちの始まりと終わりの件数の間の事象を除く。
 */
export function withoutPacingWaitEvents(payload: SafetyEventsEvidence, window: PacingWaitWindow): SafetyEventsEvidence {
  const filtered = Object.fromEntries(SAFETY_EVENT_KINDS.map((kind) => {
    const events = payload[kind] as readonly unknown[];
    const from = window.start.events[kind];
    const to = Math.max(from, window.end.events[kind]);
    return [kind, Object.freeze([...events.slice(0, from), ...events.slice(to)])];
  }));
  return Object.freeze({ ...payload, ...filtered }) as SafetyEventsEvidence;
}

/** 見せたままの待ちの間に止めた、読み取りでない要求の数（1 画面の読み込みの、止めた要求の数から除く）。 */
export function blockedRequestsDuringPacingWait(window: PacingWaitWindow): number {
  return Math.max(0, window.end.blockedRequestsByMethod - window.start.blockedRequestsByMethod);
}
