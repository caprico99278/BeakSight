/**
 * EV-3（設計書 `doc/design/2026-11-16-beaksight-finding-evidence-design.md` 3.3）: 画面の準備の状態の、唯一の決め方と、準備が終わらないときに保留にする
 * 内容の規則の一覧（1 か所）。
 * - 準備が終わった: 見える読み込み中の表示がない。読み込み中の表示は、`aria-busy="true"` の要素と、値のない進みの表示（値のない `progress` と、
 *   `aria-valuenow` のない `role="progressbar"`）。値のある進みの表示（手順の段の表示など、完成した画面に残るもの）は、読み込み中に数えない。
 *   前の版の記録（数がない）は、終わったものとして扱う。
 * - 落ち着きの待ち（`src/browser/page-settling.ts`）は、頼まれたら、終わるまで落ち着きにしない（残ったまま何も動かなくなったら、
 *   `LOADING_INDICATOR_REMAINED` で終える。中身が止まって、まだ届いていないデータの要求が残ったまま終えたら `DATA_STILL_LOADING`）。指摘の画像の参照（`src/core/finding-image-regions.ts`）は、終わらないまま集めた状態（`stateReadyOf`）の、内容の
 *   規則の指摘を、保留の理由 `PAGE_NOT_READY` で出す。
 */
import type { LoadingIndicatorEvidence } from './evidence-types.js';

/**
 * 準備が終わらないまま集めたら保留にする、内容に関わる規則（読み込み中の画面で欠けて見えるもの）。最上位の見出し・main の目印・繰り返しを飛ばす手段の
 * 欠け（axe）と、見える本文の欠け。
 */
export const PAGE_READINESS_RULE_IDS: ReadonlySet<string> = new Set(Object.freeze([
  'A11Y_PAGE_HAS_HEADING_ONE',
  'A11Y_LANDMARK_ONE_MAIN',
  'A11Y_BYPASS',
  'EMPTY_VISIBLE_CONTENT',
]));

/** 見える読み込み中の表示の数から、画面の準備が終わったか。 */
export const pageReadyOf = (indicators: LoadingIndicatorEvidence | undefined): boolean =>
  indicators === undefined || (indicators.ariaBusyCount === 0 && indicators.indeterminateProgressCount === 0);

/** 落ち着きの待ちが、読み込み中の表示が残ったまま終えた理由（`src/browser/page-settling.ts` の結果の `reason`）。 */
export const LOADING_INDICATOR_REMAINED = 'LOADING_INDICATOR_REMAINED';

/**
 * REV-WSO（DEF-283 の直しの続き。設計者の判断 2026-11-16）: 落ち着きの待ちが、中身の進みが止まったので、まだ届いていないデータの要求が残ったまま終えた理由
 * （`src/browser/page-settling.ts` の結果の `reason`）。その状態は準備が終わっていない（読み込み中の表示の数によらない）。
 */
export const DATA_STILL_LOADING = 'DATA_STILL_LOADING';

/**
 * REV-EV3 の M-2: 状態の準備が終わったか。その状態の落ち着きの待ちが表示の残ったまま終え（`LOADING_INDICATOR_REMAINED`）、かつ、その後に読んだ DOM にも
 * 表示が残っていたときだけ、終わっていない。落ち着いた後に一瞬だけ出た表示（DOM を読んだ瞬間の数）では、終わっていないとしない。
 * REV-WSO: データが届く前に終えた（`DATA_STILL_LOADING`）ときも、終わっていない。
 */
export const stateReadyOf = (settlingReason: string | null | undefined, indicators: LoadingIndicatorEvidence | undefined): boolean =>
  settlingReason !== DATA_STILL_LOADING && (settlingReason !== LOADING_INDICATOR_REMAINED || pageReadyOf(indicators));
