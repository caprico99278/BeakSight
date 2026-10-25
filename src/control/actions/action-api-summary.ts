// 書き込みの記録と報告（版 1.1）の API の要約の、組み立てと照らし合わせの唯一の owner（T40c。Task 40 の設計書 3.4、4 章、7 章の履歴）。純粋な関数。
// - 組み立て（`actionApiSummaryOf`）: 承認した API の指定（`ScenarioApiSpec`）と、Guard の照合が返したページが決める鍵の値から、要約を作る。ワーカーの
//   API の書き込みの流れ（T40b）は、この関数で `action-run.json` と `action-evidence.json` の `api` を 1 回だけ作る。ヘッダの値・応答の本文・欄に入れた
//   値は受けない（I22。受け取る口がない）。ページが決める鍵の値（Task 38 の判断 (1)）だけを、JSON の scalar を JSON の文字列にした形で残し、長さが
//   `MAX_SUBMITTED_VALUE_LENGTH` を超えたら値を残さずに null の印にする。
// - 手書きの確かめ（`actionRunRuleErrors`）: スキーマで書けない組の決まり（項目の有無、送り方と API の要約と成否の条件の組、名前の順と重なり、送った
//   値とページが決める鍵の値の鍵の集まり、送らなかった回の値なし）。送り方と要約と成否の条件の組は、スキーマでも縛る（両方で縛る）。誤りの文に値と
//   名前を入れない。
// - 親の照らし合わせ（`actionRunMatchesWriteStart`）: 記録の送り方と API の要約が、`START` の書き込みの指定（承認したもの）と同じか。FORM の `START`
//   には FORM の記録、API の `START` には同じ API の要約を持つ記録だけが合う（LG-4 で前の版 1.0 を捨てた）。ジョブの管理（`audit-job-manager.ts`）が呼び、
//   合わなければ今の食い違いと同じく `WRITE_RESULT_INVALID` にする（締めの判定は今の部品のまま）。
// - 置き場所: 記録の契約（`action-contracts.ts`）の隣。管理データ・画面・ブラウザ・ワーカーに触れない。
import { deepFreeze } from '../../core/immutable.js';
import type { JsonValueConversion } from '../../core/json-value.js';
import { sortedKeysJsonOf } from '../../core/sorted-keys-json.js';
import { compareCodeUnits } from '../../core/text.js';
import { API_SCENARIO_TRANSPORT, FORM_SCENARIO_TRANSPORT, type ScenarioApiSpec } from '../approval/scenario-contracts.js';
import {
  MAX_SUBMITTED_VALUE_LENGTH,
  NOT_SENT_SUBMISSION_STATE,
  type ActionApiSummary,
  type ActionRunDocument,
} from './action-contracts.js';

/** ページが決める鍵の値（Guard の照合が返す JSON の scalar。`src/core/json-value.ts` の変えた値と同じ型）。 */
export type ActionApiPageKeyValue = Extract<JsonValueConversion, { readonly ok: true }>['value'];

/** 1.1 で足した項目の名前（項目の有無の確かめ）。 */
const TRANSPORT_PROPERTY = 'transport';
const API_PROPERTY = 'api';

/** 名前の一覧を UTF-16 のコード単位の順に並べた凍結した写し。 */
const sortedNamesOf = (names: readonly string[]): readonly string[] => Object.freeze([...names].sort(compareCodeUnits));

/** 名前の一覧が、UTF-16 のコード単位の順で、重なりがないか。 */
const isStrictlySorted = (names: readonly string[]): boolean =>
  names.every((name, index) => index === 0 || compareCodeUnits(names[index - 1] ?? '', name) < 0);

/** 2 つの名前の一覧が、同じ名前を同じ順で持つか。 */
const sameNames = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((name, index) => name === right[index]);

/** ページが決める鍵の値を、残す文字列にする（JSON の文字列。長さが上限を超える値と、scalar でない値は null の印）。 */
const pageKeyValueTextOf = (value: ActionApiPageKeyValue): string | null => {
  if (typeof value === 'object' && value !== null) {
    return null;
  }
  const text = JSON.stringify(value);
  return typeof text === 'string' && text.length <= MAX_SUBMITTED_VALUE_LENGTH ? text : null;
};

/**
 * API の要約（凍結）。名前は鍵の順、ID の鍵は API の指定の応答の本文の鍵。`pageKeyValues` は、照合まで進まなかったら null。渡した値のうち、API の
 * 指定のページが決める鍵の値だけを残す（ほかの鍵の値は捨てる）。
 */
export const actionApiSummaryOf = (
  api: ScenarioApiSpec,
  pageKeyValues: Readonly<Record<string, ActionApiPageKeyValue>> | null,
): ActionApiSummary => {
  const pageKeyNames = sortedNamesOf(api.pageKeys.map(({ key }) => key));
  return deepFreeze({
    method: api.request.method,
    origin: api.request.origin,
    pathShape: api.request.pathShape,
    shapeDigest: api.shapeDigest,
    keyNames: sortedNamesOf(api.keyFields.map(({ key }) => key)),
    pageKeyNames,
    httpFieldNames: sortedNamesOf(api.headerNames),
    recordIdKey: api.recordId?.key ?? null,
    pageKeyValues: pageKeyValues === null
      ? null
      : Object.fromEntries(pageKeyNames.flatMap((key) => (Object.hasOwn(pageKeyValues, key)
        ? [[key, pageKeyValueTextOf(pageKeyValues[key] ?? null)] as const]
        : []))),
  });
};

/** API の要約の、スキーマで書けない決まりの誤り（値と名前を入れない）。 */
const apiSummaryRuleErrors = (api: ActionApiSummary, document: ActionRunDocument): readonly string[] => {
  const errors: string[] = [];
  const keys = new Set(api.keyNames);
  if (api.keyNames.length === 0 || !isStrictlySorted(api.keyNames)) {
    errors.push('/api/keyNames must have one or more names in code unit order, each once');
  }
  if (!isStrictlySorted(api.pageKeyNames) || api.pageKeyNames.some((name) => keys.has(name))) {
    errors.push('/api/pageKeyNames must be in code unit order, each once, and no key of a field');
  }
  if (!isStrictlySorted(api.httpFieldNames)) {
    errors.push('/api/httpFieldNames must be in code unit order, each once');
  }
  if (Object.keys(document.submittedValues).some((name) => !keys.has(name))) {
    errors.push('/submittedValues must have values of the keys of the fields only');
  }
  const values = api.pageKeyValues;
  if (values !== null) {
    if (document.submission === NOT_SENT_SUBMISSION_STATE) {
      errors.push('/api/pageKeyValues must be null for a run that was not sent');
    }
    // T41d（Task 41 の設計書 8 章の「T41a・T41c の報告と設計者の判断」の (3)）: 更新の記録（`update` を持つ）の値は空（前の値を記録に残さない）。
    const expectedNames = document.update === undefined ? api.pageKeyNames : [];
    if (!sameNames(sortedNamesOf(Object.keys(values)), expectedNames)) {
      errors.push('/api/pageKeyValues must have a value for each key of the page only, and none for an update');
    }
    if (Object.values(values).some((value) => value !== null && (typeof value !== 'string' || value.length > MAX_SUBMITTED_VALUE_LENGTH))) {
      errors.push('/api/pageKeyValues must have strings within the limit or the cut mark');
    }
  }
  return errors;
};

/**
 * `action-run.json` の、スキーマで書けない決まりの誤り（T40c。スキーマを通った文書に使う）。送り方と API の要約を必ず持つ。FORM は API の要約が null で
 * 成否の条件を持つ。API は成否の条件が null で、API の要約（`apiSummaryRuleErrors`）を持つ。誤りの文に値と名前を入れない。
 */
export const actionRunRuleErrors = (document: ActionRunDocument): readonly string[] => {
  const errors: string[] = [];
  if (![TRANSPORT_PROPERTY, API_PROPERTY].every((key) => Object.hasOwn(document, key))) {
    errors.push('/ must have the transport and the API summary');
  }
  const { api } = document;
  switch (document.transport) {
    // T40R-fix-B（M-2）: 送り方の値はシナリオの契約の名前つきの定数（自分で定義しない）。
    case FORM_SCENARIO_TRANSPORT:
      if (api !== null) {
        errors.push('/api must be null for a FORM run');
      }
      if (document.resultConditions === null) {
        errors.push('/resultConditions must be present for a FORM run');
      }
      break;
    case API_SCENARIO_TRANSPORT:
      if (document.resultConditions !== null) {
        errors.push('/resultConditions must be null for an API run');
      }
      if (api === null) {
        errors.push('/api must be present for an API run');
      } else {
        errors.push(...apiSummaryRuleErrors(api, document));
      }
      break;
  }
  return errors;
};

/**
 * 要約の、承認した API の指定から決まる項目（ページが決める鍵の値を除く。method、Origin の文字列、path の型、型の digest、3 つの名前の一覧、ID の鍵）が、
 * 指定から作った要約とそろって同じか（鍵を並べた JSON で比べる。Origin は承認した文字列と完全に同じであること）。
 */
const apiSummaryMatchesSpec = (summary: ActionApiSummary, api: ScenarioApiSpec): boolean =>
  sortedKeysJsonOf({ ...summary, pageKeyValues: null }) === sortedKeysJsonOf(actionApiSummaryOf(api, null));

/**
 * 記録が、`START` の書き込みの指定と同じ送り方と API の要約を持つか（T40c。親の照らし合わせ）。`startApi` は、API の `START` なら承認した API の指定、
 * FORM の `START` なら null。手書きの確かめ（`actionRunRuleErrors`）の誤りがある記録は合わない。
 */
export const actionRunMatchesWriteStart = (document: ActionRunDocument, startApi: ScenarioApiSpec | null): boolean => {
  if (actionRunRuleErrors(document).length > 0) {
    return false;
  }
  const { api } = document;
  if (startApi === null) {
    return document.transport === FORM_SCENARIO_TRANSPORT && api === null;
  }
  return document.transport === API_SCENARIO_TRANSPORT && api !== null && apiSummaryMatchesSpec(api, startApi);
};
