// T32f（Task 32 の設計書 6 章の「変更容易性」）: 書き込みの結果や理由を 1 つ足すとき、変えるのが契約の配列、スキーマの enum、カタログの 3 か所だけで、
// 報告の表示用モデル・HTML・バンドルのコードを変えなくてよいことを確かめる。
// - カタログは、契約の閉じた一覧の値をすべて、余分なく持つ（型と実行時の両方。`src/presentation/` は `src/control/` を読めないので、両方を読める
//   テストの側で確かめる。`apps/local-ui/src/display/catalog-coverage.ts` と同じ考え方）。足し忘れは、ここで落ちる。
// - 報告のコード（`action-view-model.ts`・`action-report.ts`・`action-bundle.ts`）は、それらの値を文字列リテラルで書かない（値で分岐しない。表示は
//   カタログと文言の表を引くだけ）。値を足しても、コードを変えずに描ける。
// - どの結果と理由も、カタログのラベルで描ける。
import { describe, expect, it } from 'vitest';
import {
  ACTION_BLOCK_REASONS,
  ACTION_OUTCOME_REASONS,
  ACTION_RESULTS,
  AUTOMATED_ACTIONS,
  HUMAN_DECISIONS,
  RESPONSE_JUDGEMENTS,
  SETTLED_RESERVATION_STATES,
  SUBMISSION_STATES,
} from '../../src/control/actions/action-contracts.js';
import { SCENARIO_KINDS, SIDE_EFFECT_CONFIRMATIONS } from '../../src/control/approval/scenario-contracts.js';
import {
  ACTION_BLOCK_REASON_CATALOG,
  ACTION_OUTCOME_REASON_CATALOG,
  ACTION_RESULT_CATALOG,
  AUTOMATED_ACTION_CATALOG,
  HUMAN_DECISION_CATALOG,
  RESPONSE_JUDGEMENT_CATALOG,
  SCENARIO_KIND_CATALOG,
  SETTLED_RESERVATION_STATE_CATALOG,
  SIDE_EFFECT_CONFIRMATION_CATALOG,
  SUBMISSION_STATE_CATALOG,
} from '../../src/presentation/catalog.js';
import { escapeHtml } from '../../src/report/html-components.js';
import { renderActionReport } from '../../src/report/action-report.js';
import { buildActionViewModel } from '../../src/report/action-view-model.js';
import { loadSourceFiles } from '../architecture/source-scan.js';
import { verifiedCreateDocuments } from '../helpers/action-report-samples.js';

/** 型の確かめ: 2 つの型が同じ（足し忘れと余分の両方で落ちる）。 */
type Equal<Left, Right> = [Left] extends [Right] ? ([Right] extends [Left] ? true : false) : false;
const sameKeys = <Left, Right>(value: Equal<Left, Right>): Equal<Left, Right> => value;
sameKeys<keyof typeof ACTION_RESULT_CATALOG, (typeof ACTION_RESULTS)[number]>(true);
sameKeys<keyof typeof ACTION_OUTCOME_REASON_CATALOG, (typeof ACTION_OUTCOME_REASONS)[number]>(true);
sameKeys<keyof typeof RESPONSE_JUDGEMENT_CATALOG, (typeof RESPONSE_JUDGEMENTS)[number]>(true);
sameKeys<keyof typeof SUBMISSION_STATE_CATALOG, (typeof SUBMISSION_STATES)[number]>(true);
sameKeys<keyof typeof ACTION_BLOCK_REASON_CATALOG, (typeof ACTION_BLOCK_REASONS)[number]>(true);
sameKeys<keyof typeof SETTLED_RESERVATION_STATE_CATALOG, (typeof SETTLED_RESERVATION_STATES)[number]>(true);
sameKeys<keyof typeof HUMAN_DECISION_CATALOG, (typeof HUMAN_DECISIONS)[number]>(true);
sameKeys<keyof typeof AUTOMATED_ACTION_CATALOG, (typeof AUTOMATED_ACTIONS)[number]>(true);
sameKeys<keyof typeof SCENARIO_KIND_CATALOG, (typeof SCENARIO_KINDS)[number]>(true);
sameKeys<keyof typeof SIDE_EFFECT_CONFIRMATION_CATALOG, (typeof SIDE_EFFECT_CONFIRMATIONS)[number]>(true);

/** 契約の閉じた一覧と、その表示のカタログ。 */
const LISTS: readonly (readonly [string, readonly string[], object])[] = [
  ['ACTION_RESULTS', ACTION_RESULTS, ACTION_RESULT_CATALOG],
  ['ACTION_OUTCOME_REASONS', ACTION_OUTCOME_REASONS, ACTION_OUTCOME_REASON_CATALOG],
  ['RESPONSE_JUDGEMENTS', RESPONSE_JUDGEMENTS, RESPONSE_JUDGEMENT_CATALOG],
  ['SUBMISSION_STATES', SUBMISSION_STATES, SUBMISSION_STATE_CATALOG],
  ['ACTION_BLOCK_REASONS', ACTION_BLOCK_REASONS, ACTION_BLOCK_REASON_CATALOG],
  ['SETTLED_RESERVATION_STATES', SETTLED_RESERVATION_STATES, SETTLED_RESERVATION_STATE_CATALOG],
  ['HUMAN_DECISIONS', HUMAN_DECISIONS, HUMAN_DECISION_CATALOG],
  ['AUTOMATED_ACTIONS', AUTOMATED_ACTIONS, AUTOMATED_ACTION_CATALOG],
  ['SCENARIO_KINDS', SCENARIO_KINDS, SCENARIO_KIND_CATALOG],
  ['SIDE_EFFECT_CONFIRMATIONS', SIDE_EFFECT_CONFIRMATIONS, SIDE_EFFECT_CONFIRMATION_CATALOG],
];

/** 報告のコード（値で分岐しないファイル）。 */
const REPORT_FILES: readonly string[] = ['src/report/action-view-model.ts', 'src/report/action-report.ts', 'src/report/action-bundle.ts'];

describe('the write report can take a new result or reason without a code change (T32f)', () => {
  it.each(LISTS.map(([name, values, catalog]) => [name, values, catalog] as const))('the catalog of %s has every value and no other', (_name, values, catalog) => {
    expect(Object.keys(catalog).sort()).toEqual([...values].sort());
  });

  it('the report code writes none of the values as a string literal (it only looks them up in the catalogs and the texts)', () => {
    const files = loadSourceFiles().filter((file) => REPORT_FILES.includes(file.path));
    expect(files.map((file) => file.path).sort()).toEqual([...REPORT_FILES].sort());
    const values = new Set(LISTS.flatMap(([, list]) => list));
    expect(files.flatMap((file) => file.wholeLiterals.filter((literal) => values.has(literal.slice(1, -1))).map((literal) => `${file.path}: ${literal}`)))
      .toEqual([]);
  });

  it.each(ACTION_RESULTS.flatMap((result) => ACTION_OUTCOME_REASONS.map((reason) => [result, reason] as const)))(
    'renders the result %s with the reason %s by the catalog labels',
    (result, reason) => {
      const documents = verifiedCreateDocuments();
      const html = renderActionReport(buildActionViewModel({ ...documents, evidence: { ...documents.evidence, result, reason } }));
      expect(html).toContain(`data-value="${result}">${escapeHtml(ACTION_RESULT_CATALOG[result].label)}</span>`);
      expect(html).toContain(`data-value="${reason}">${escapeHtml(ACTION_OUTCOME_REASON_CATALOG[reason].label)}</span>`);
    },
  );
});
