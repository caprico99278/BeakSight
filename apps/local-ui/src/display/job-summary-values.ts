/**
 * OP-H（OP-G2 の一覧の置き場所。DEF-066 の境界）: 作業の画面の要点の値の閉じた一覧（ブラウザ側からも読める値だけ。`write-screen-values.ts` と同じ置き方）。
 * 画面のサーバ（`server/audit-job-functions.ts` の `jobSummaryOf`）と、表示のカタログの網羅（`catalog-coverage.ts`）が、ここから読む。
 * 値は、import を持たない core の名前つきの定数（`src/core/audit-job-values.ts`）から作る（IPC の契約 `worker-protocol.ts` は実行時に Node の部品を読むので、
 * ここからは型だけを読む）。IPC の契約の段の一覧（読み取りの段 `WORKER_CHAIN_STAGE_KINDS`、書き込みの段 `WORKER_WRITE_JOB_KINDS`）と同じ値であることは、
 * `catalog-coverage.ts` の型で確かめる。
 */
import {
  WORKER_AUDIT_JOB_KIND,
  WORKER_DISCOVERY_JOB_KIND,
  WORKER_READ_CHECK_JOB_KIND,
  WORKER_WRITE_CREATE_JOB_KIND,
  WORKER_WRITE_UPDATE_JOB_KIND,
} from '../../../../src/core/audit-job-values.js';

/**
 * OP-G2: 点検の画面にとどまる間の、今の段（閉じた一覧。文言はカタログ `LOCAL_UI_JOB_SUMMARY_TEXT.chainStage`。書き漏れと余分は `display/catalog-coverage.ts`）。
 * 読み取りの段（監査・発見・READ の確かめ）と、書き込みの段（登録・更新）と、段と段の間（`NEXT`。次の段を準備している）。
 */
export const JOB_SUMMARY_CHAIN_STAGES = Object.freeze([
  WORKER_AUDIT_JOB_KIND,
  WORKER_DISCOVERY_JOB_KIND,
  WORKER_READ_CHECK_JOB_KIND,
  WORKER_WRITE_CREATE_JOB_KIND,
  WORKER_WRITE_UPDATE_JOB_KIND,
  'NEXT',
] as const);
export type JobSummaryChainStage = (typeof JOB_SUMMARY_CHAIN_STAGES)[number];
