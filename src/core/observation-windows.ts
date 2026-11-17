/**
 * 観察の窓の一式（RB-2。再構築の設計書 2 章 4。SSOT）。落ち着き・静まり・観察・閉じる前・確かめの間隔の、決め打ちの待ちの本番の値は、ここにだけ置く。
 * - 部品は、差し込まれた一式（`observationWindows`）を読み、なければ本番の値（`PRODUCTION_OBSERVATION_WINDOWS`）を使う。差し込めるのはテストだけで、本番の
 *   入口（CLI・ワーカーの入口・画面のサーバ）は渡さない（TEST-TIME-B の 3 つの条件。Gate は `production-wait-values`、`worker-login-hooks` の (n)・(p)、
 *   `observation-windows-owner`）。
 * - 守りの値（自分の移動の間隔、自動ログインの間隔と回数、サイトの不調の確かめ直し、Guard の中の判定の窓、起動と閉じるの上限）は入れない。型にないので、
 *   テストの口からも変えられない。
 */
import { deepFreeze } from './immutable.js';

/** 観察の窓の一式（ms。どれも正の安全な整数）。 */
export interface ObservationWindows {
  /** ページの落ち着き（`waitForPageSettled`）: 測る間隔、高さが変わらない時間、開いたままのデータの要求を届いたとみなす静まり。 */
  readonly pageSettle: { readonly pollIntervalMs: number; readonly stableWindowMs: number; readonly openDataRequestQuietMs: number };
  /** controlled scroll: 1 回のスクロールの後の待ち、最下部で高さが変わらない時間。 */
  readonly scroll: { readonly stepWaitMs: number; readonly stableWindowMs: number };
  /** 発見と READ の落ち着き: 上限、要求の静まり、確かめの間隔、読み取りの間隔、本文の猶予、忙しい画面の上限。 */
  readonly discoverySettle: {
    readonly timeoutMs: number;
    readonly networkQuietMs: number;
    readonly pollIntervalMs: number;
    readonly probeIntervalMs: number;
    readonly responseBodyGraceMs: number;
    readonly busyTimeoutMs: number;
  };
  /** 発見の画面の見出しの待ち。 */
  readonly screenHeading: { readonly waitMs: number; readonly pollMs: number };
  /** 知らせの枠を閉じる押下の待ち。 */
  readonly notification: { readonly dismissWaitMs: number; readonly dismissPollIntervalMs: number; readonly discoveryBudgetMs: number };
  /** 押した後: probe の最短の観察、書き込みの押した後の静まりの窓。 */
  readonly afterPress: { readonly probeQuietWaitMs: number; readonly pressQuietWindowMs: number };
  /** 閉じる前: 監査の段の送信の扱いで、ページの監査の読み込みの Context を閉じる前に待つ時間。 */
  readonly beforeClose: { readonly auditSendCloseSettleMs: number };
  /** 書き込み: 押す前の送信の窓、結果の確かめの間隔、API の欄の値の落ち着きの間隔、欄が描かれるのを確かめる間隔。 */
  readonly write: {
    readonly submissionWindowSettleMs: number;
    readonly resultPollIntervalMs: number;
    readonly apiValueSettleIntervalMs: number;
    readonly apiInputAppearPollMs: number;
  };
  /** ログイン: 押す前の送信の窓、自動ログインと手動のログインの結果の確かめの間隔、欄を待つ間隔。 */
  readonly login: {
    readonly submissionWindowSettleMs: number;
    readonly automatedPollIntervalMs: number;
    readonly manualPollIntervalMs: number;
    readonly fieldsPollMs: number;
  };
  /** 見張り: 反応なしの上限、DOM の見張りの間隔、見せたまま待つ間の印の間隔。 */
  readonly watch: { readonly quietLimitMs: number; readonly domPollIntervalMs: number; readonly pacingMarkIntervalMs: number };
}

/** テストが差し込む一式（組ごと・値ごとに省略できる。省略した値は本番の値）。 */
export type ObservationWindowsOverrides = { readonly [Group in keyof ObservationWindows]?: Partial<ObservationWindows[Group]> };

/** 本番の値（ここだけに書く。値を変えるのは設計者の判断で、`production-wait-values` の表も書き換える）。 */
export const PRODUCTION_OBSERVATION_WINDOWS: ObservationWindows = deepFreeze<ObservationWindows>({
  pageSettle: { pollIntervalMs: 100, stableWindowMs: 500, openDataRequestQuietMs: 5_000 },
  scroll: { stepWaitMs: 250, stableWindowMs: 500 },
  discoverySettle: { timeoutMs: 5_000, networkQuietMs: 500, pollIntervalMs: 50, probeIntervalMs: 250, responseBodyGraceMs: 2_000, busyTimeoutMs: 3_000 },
  screenHeading: { waitMs: 2_000, pollMs: 100 },
  notification: { dismissWaitMs: 1_000, dismissPollIntervalMs: 100, discoveryBudgetMs: 15_000 },
  afterPress: { probeQuietWaitMs: 2_000, pressQuietWindowMs: 5_000 },
  beforeClose: { auditSendCloseSettleMs: 1_000 },
  write: { submissionWindowSettleMs: 300, resultPollIntervalMs: 250, apiValueSettleIntervalMs: 500, apiInputAppearPollMs: 100 },
  login: { submissionWindowSettleMs: 300, automatedPollIntervalMs: 250, manualPollIntervalMs: 500, fieldsPollMs: 100 },
  watch: { quietLimitMs: 180_000, domPollIntervalMs: 1_000, pacingMarkIntervalMs: 1_000 },
});

/** 部品が受けた一式（なければ本番の一式）。受け口の既定の 1 か所。 */
export const observationWindowsOrProduction = (injected: ObservationWindows | undefined): ObservationWindows =>
  injected ?? PRODUCTION_OBSERVATION_WINDOWS;

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * 差し込まれた一式を、本番の値に重ねる（なければ本番の一式そのもの）。一式にない組や値の名前、正の安全な整数でない値は `RangeError`（書き誤りで本番の値の
 * まま流れるのを防ぐ）。
 */
export function observationWindowsOf(overrides: ObservationWindowsOverrides | undefined): ObservationWindows {
  if (overrides === undefined) {
    return PRODUCTION_OBSERVATION_WINDOWS;
  }
  if (!isRecord(overrides)) {
    throw new RangeError('the observation windows must be an object');
  }
  const production = PRODUCTION_OBSERVATION_WINDOWS as unknown as Readonly<Record<string, Readonly<Record<string, number>>>>;
  const merged: Record<string, Record<string, number>> = {};
  for (const [group, values] of Object.entries(production)) {
    merged[group] = { ...values };
  }
  for (const [group, values] of Object.entries(overrides)) {
    const target = merged[group];
    if (target === undefined || !isRecord(values)) {
      throw new RangeError(`the observation windows have no group ${group}`);
    }
    for (const [name, value] of Object.entries(values)) {
      if (!(name in target)) {
        throw new RangeError(`the observation windows have no ${group}.${name}`);
      }
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
        throw new RangeError(`the observation window ${group}.${name} must be a positive safe integer`);
      }
      target[name] = value;
    }
  }
  return deepFreeze(merged as unknown as ObservationWindows);
}
