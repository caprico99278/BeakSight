/**
 * PL-2（設計書 `doc/design/2026-10-26-beaksight-plain-ui-design.md` 3 章の 5、13 章の最後の段落）: 作業が成功で終わって、作業の画面から次の画面
 * （サイトの詳細、書き込みの手順の詳細）へ自動で移したときに、移った先の search に付ける印。
 * - 移ったこと（`ARRIVAL_SEARCH`。PL-V。h1 にフォーカスを置く）と、どの作業から移ったか（`fromJob` に作業の ID）の 2 つを付ける。
 * - 移った先の要点の 1 行目（「入口の確かめが終わりました。ログインの画面が見つかりました。」など）は、移った先が `arrivedFromJobOf` で作業の ID を読み、
 *   その作業の詳細（`getAuditJobFn`）の `summary.result` を、カタログ `LOCAL_UI_JOB_SUMMARY_TEXT.finished` で文にする（作業の ID は画面に出さない。
 *   作業のサイトが移った先のサイトと同じかを確かめてから出す）。印は URL の search なので、作り直されても、読んだ作業の記録の事実だけを出す。
 * - 移す側は作業の画面（`routes/jobs/$jobId.tsx` の `useAutoAdvance`）だけ。
 */
import { ARRIVAL_SEARCH } from './PageFrame';

/** どの作業から移ったかを示す search の鍵。 */
export const ARRIVED_FROM_JOB_SEARCH_KEY = 'fromJob';

/** 移した先の search（移った印と、作業の ID）。 */
export const arrivedFromJobSearch = (jobId: string): { readonly arrived: 'auto'; readonly fromJob: string } =>
  Object.freeze({ ...ARRIVAL_SEARCH, [ARRIVED_FROM_JOB_SEARCH_KEY]: jobId } as { readonly arrived: 'auto'; readonly fromJob: string });

/** 移った先の route で、どの作業から移ったかを読む（印がない、空のときは `null`）。 */
export const arrivedFromJobOf = (search: Readonly<Record<string, unknown>>): string | null => {
  const value = search[ARRIVED_FROM_JOB_SEARCH_KEY];
  return typeof value === 'string' && value !== '' ? value : null;
};
