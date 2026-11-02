// 書き込みの手順の自動の下書き（API の形 `api-scenario-autodraft.ts` とフォームの形 `form-scenario-autodraft.ts`）で共通の決まりの唯一の置き場所（PL-6b。
// 設計書 `2026-10-26-beaksight-plain-ui-design.md` 8 章、8.1 の「自動で決める項目」）。純粋な部品（管理データ・ファイル・画面に依らない。同じ入力に同じ出力）。
// - ID の区切りの選び方（`isAutoDraftRecordIdSegment`）: core の `isRecordIdLikePathSegment`（数字・UUID・値に見える区切り）。PL-6b: 前の API の下書きの
//   `isUsableRecordIdSegment`（レコードの ID の文字の形だけを見る。`members` も通る）は使わない（`members` を ID に数えた誤りがあった）。
// - ID の型の選び方（`autoDraftRecordIdTemplatesOf`）: 書き換えの候補（form）の画面の path と送信先の path の、同じ ID の区切りの組を `{id}` にした型（最後の組。
//   型の組の列挙は発見の部品 `pathTemplateOptionsOf`）。フォームの登録の ID の型（送信先の型と画面の型）と、フォームの書き換えの path の型に使う。
// - 下書きを作るフォームの形の行（`formAutoDraftRowsOf`）: 分類が登録・書き換えで、送信先を持つ候補（画面を通さない送信の行は API の部品）。
// - 答え合わせの見るだけの確かめの定義の選び方（`autoDraftDefinitionChoiceOf`）: 同じ定義が既にあれば使う、上限なら作らない、ほかは作る。
// - OP-2 の修正の 1 回目（判断 1）: 画面の一覧の行の「メールなどを送ることがある」の印（`autoDraftScreenMayNotifyOf`）。送る欄にメール・電話の欄があるか
//   （外部到達の語の owner `externalDeliveryKindsOf`・`externalDeliveryKindsOfName` の判定。副作用の確認 `NO_EXTERNAL_NOTIFICATION` に当たる欄）。
import { isRecordIdLikePathSegment } from '../../core/api-request-shape.js';
import type { DiscoveryCandidate } from '../../discovery/candidate-contracts.js';
import { pathTemplateOptionsOf, type PathTemplateOption } from '../../discovery/fingerprint.js';
import { submissionProbeWriteOf } from '../../discovery/submission-probe-contracts.js';
import { externalDeliveryKindsOf, externalDeliveryKindsOfName } from '../data-rules/external-delivery-words.js';
import { CREATE_SCENARIO_KIND, UPDATE_SCENARIO_KIND, type ReadCheckReference, type ScenarioKind } from './scenario-contracts.js';

/** 自動の下書きが ID とみなす path の区切りか（core の唯一の判定）。 */
export const isAutoDraftRecordIdSegment = (segment: string): boolean => isRecordIdLikePathSegment(segment);

/**
 * 書き換えの候補（form）から作る ID の型の組（画面の path の型と送信先の path の型。作れなければ null）。組が 2 つ以上あれば、最後の組（path の後ろの ID が
 * 書き換えるレコードの ID。作成の画面の既定の選び方と同じ）。
 */
export const autoDraftRecordIdTemplatesOf = (update: DiscoveryCandidate): PathTemplateOption | null =>
  pathTemplateOptionsOf(update, isAutoDraftRecordIdSegment).at(-1) ?? null;

/** フォームの形の、下書きを作る行 1 つ（登録か書き換えの候補）。 */
export interface FormAutoDraftRow {
  readonly kind: ScenarioKind;
  readonly candidate: DiscoveryCandidate;
}

/** 候補の分類が、書き込みの手順の種類（登録・書き換え）なら、その種類。 */
const scenarioKindOf = (candidate: DiscoveryCandidate): ScenarioKind | null => {
  if (candidate.classification === CREATE_SCENARIO_KIND) {
    return CREATE_SCENARIO_KIND;
  }
  return candidate.classification === UPDATE_SCENARIO_KIND ? UPDATE_SCENARIO_KIND : null;
};

/**
 * フォームの形の、下書きを作る行（作る順: 登録が先、書き換えが後。それぞれ候補の順。同じ識別の行は 1 つ。凍結）。分類が登録・書き換えで、送信先を持ち、
 * 画面を通さない送信の記録（書き込みの probe）を持たない候補。
 */
export const formAutoDraftRowsOf = (candidates: readonly DiscoveryCandidate[]): readonly FormAutoDraftRow[] => {
  const seen = new Set<string>();
  const rows = candidates.flatMap((candidate): readonly FormAutoDraftRow[] => {
    const kind = scenarioKindOf(candidate);
    const probe = candidate.submissionProbe;
    const apiWrite = probe === undefined ? null : submissionProbeWriteOf(probe.result);
    if (kind === null || candidate.action === null || apiWrite !== null || seen.has(candidate.identityDigest)) {
      return [];
    }
    seen.add(candidate.identityDigest);
    return [Object.freeze({ kind, candidate })];
  });
  return Object.freeze([...rows.filter(({ kind }) => kind === CREATE_SCENARIO_KIND), ...rows.filter(({ kind }) => kind === UPDATE_SCENARIO_KIND)]);
};

/** 取り消していない見るだけの確かめの定義 1 件（答え合わせの定義の選び方に要るものだけ）。 */
export interface AutoDraftDefinitionFact extends ReadCheckReference {
  /** 画面の path の定義の path（候補の定義は null）。 */
  readonly targetPagePath: string | null;
  /** PL-6b: 候補の定義の対象の候補の識別の digest（画面の path の定義・分からなければ省く）。 */
  readonly targetIdentityDigest?: string | null;
  /** PL-6b: 定義の送る値の名前（定義の順。分からなければ省く）。 */
  readonly parameterNames?: readonly string[];
}

/** 答え合わせの定義の選び方の結果（既にある定義を使う・作る・上限で作らない）。 */
export type AutoDraftDefinitionChoice<Definition> =
  | { readonly kind: 'EXISTING'; readonly reference: ReadCheckReference }
  | { readonly kind: 'CREATE'; readonly definition: Definition }
  | { readonly kind: 'LIMIT_REACHED' };

/**
 * 答え合わせの定義の選び方（API の `{id}` の型の定義とフォームの照合の専用の定義の共通）: 同じ定義（`isSame`）が既にあれば使う（同じ定義を 2 つ作らない）。
 * 定義の数が上限（`maxDefinitions`）に達していれば作らない。ほかは `definition` を作る。
 */
export const autoDraftDefinitionChoiceOf = <Definition>(input: {
  readonly definitions: readonly AutoDraftDefinitionFact[];
  readonly isSame: (fact: AutoDraftDefinitionFact) => boolean;
  readonly maxDefinitions: number;
  readonly definition: Definition;
}): AutoDraftDefinitionChoice<Definition> => {
  const existing = input.definitions.find(input.isSame);
  if (existing !== undefined) {
    return { kind: 'EXISTING', reference: { readCheckId: existing.readCheckId, revision: existing.revision } };
  }
  return input.definitions.length >= input.maxDefinitions ? { kind: 'LIMIT_REACHED' } : { kind: 'CREATE', definition: input.definition };
};

/**
 * OP-2 の修正の 1 回目（判断 1）: 画面の一覧の行に「メールなどを送ることがある」の 1 行を出すか。見える欄（hidden でない）にメール・電話の欄があるか、
 * 押して見た API の入力の欄の名前がメール・電話に当たるとき真。チェックの保存が副作用の確認を兼ねるので、その中身を行に出すための印（判定は変えない）。
 */
export const autoDraftScreenMayNotifyOf = (candidate: DiscoveryCandidate): boolean =>
  candidate.fields.some((field) => !field.hidden && externalDeliveryKindsOf(field).length > 0)
  || (candidate.submissionProbe?.inputFields ?? []).some(({ name }) => name !== null && externalDeliveryKindsOfName(name).length > 0);

/**
 * OP-F（安全のレビューの M-3。設計者の判断（案 b））: 画面の一覧の行に「知らせを送ることがある」の 1 行を出すか（判定の 1 か所。行の値と、チェックの保存と、点検の
 * 中の更新の自動の承認が使う）。登録の画面か、分かっている更新の画面（`updates`。候補が分かっているときだけ）のどれかが当たれば真。
 */
export const writeScreenMayNotifyOf = (create: DiscoveryCandidate, updates: readonly DiscoveryCandidate[]): boolean =>
  autoDraftScreenMayNotifyOf(create) || updates.some(autoDraftScreenMayNotifyOf);

/**
 * OP-F（M-3）: 更新の画面の副作用（知らせ）を、チェックが確かめたか。更新の画面が当たらないか、チェックしたときの行にその 1 行が出ていた（`lineShown`）ときだけ真。
 * 偽なら、その更新を承認しない（チェックの保存では登録だけ、点検の中では自動で承認しない）。
 * - チェックの保存: `lineShown` は、その行の今の値（`writeScreenMayNotifyOf(登録の画面, 分かっている更新の画面)`）。
 * - 点検の中の更新の自動の承認: `lineShown` は、チェックの保存のときの記録（チェックで承認した登録の版の画面）から `writeScreenMayNotifyOf(登録の画面, [])`。
 *   そのときに分かっていた更新の画面は、チェックの保存がいっしょに下書き・承認したので、ここに来るのは、その後に見つかった更新だけ。
 */
export const updateNotifyConfirmedByCheckOf = (lineShown: boolean, update: DiscoveryCandidate): boolean =>
  !autoDraftScreenMayNotifyOf(update) || lineShown;
