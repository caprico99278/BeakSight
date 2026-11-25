// RCA-4（検索の確かめの設計書 `doc/design/2026-11-18-beaksight-search-check-design.md` 2.2・2.3）: 見るだけの確かめの段（検索の確かめ）で確かめる組を、
// 最新の操作さがしの記録（`discovery.json`）から始める前に作る唯一の部品（純粋。同じ入力に同じ出力）。組の数が M（進み具合の分母。始めた後に増えない）。
// - GET の検索フォーム（`READ` の候補）: 基準の組（送れる欄のうち、選ぶ欄でも checkbox・radio でもない欄は空、select は最初の選択肢）と、1 つずつ変えた組
//   （文字の欄 text・search・textarea は半角の目印と全角の目印。値はワーカーが組ごとに作り、組は種類だけを持つ。select と radio の組は残りの選択肢のすべて、checkbox は入れる）。送れない欄（hidden・readonly・disabled・
//   password・file）は送らない（今の READ の確かめの決まり `isSendableField`）。トークンでない hidden の欄があるフォームの組には印 `unsentHiddenFields` を
//   付ける（基準の組が 5xx でも判定できないにする材料）。
// - スクリプトのきっかけ（`searchTriggers`）: 欄に入れた目印を運んだ読み取りを出した押下・入力 × 文字の値 3 通り（`SEARCH_CHECK_TEXT_VALUES`）。選択肢のきっかけは
//   操作さがしで全部試したので、組にしない。
// - 守り: 送る値の名前と値の危険な語（`readParametersHaveDestructiveWord`）、秘密に見える名前（`isSecretUrlQueryParameterName`）に当たる組は除き、数を
//   `excluded` に残す。REV-RCA の I-3: 値か表示の文字が削除の語に当たる選択肢（操作さがしの候補の印 `destructiveOptionIndexes`。判定は操作さがしの選び方と
//   同じ 1 か所）は基準の組に選ばず、その値を送る組も除く（除いた数に入れる）。
// - まとめ方（構造。数では切らない）: フォームは送信先と欄の形（名前・型・選択肢・送れるか）、きっかけは種類と欄の形と読み取りの形（path の型と query の名前）が
//   同じものを、最初に見つけた画面の 1 つにまとめる。
// - 並べ方: 画面の順、その中はフォーム → きっかけの順。選択肢の多い欄は、値の形（数字・英字・そのほか）の違うものを先に並べる（止めても違いの大きい組が先に済む）。
// - 組の鍵（`key`）は、組の中身（フォームは送る値と変え方）の digest（ログインし直しで、残りの組だけを渡すのに使う）。
import { createSha256Fingerprint } from '../core/ids.js';
import { isSecretUrlQueryParameterName } from '../core/secret-query-names.js';
import {
  READ_CANDIDATE_CLASSIFICATION,
  SEARCH_TEXT_FIELD_TYPES,
  SELECT_FIELD_TYPES,
  type CandidateField,
  type CandidateLocation,
  type DiscoveryCandidate,
} from './candidate-contracts.js';
import { readParametersHaveDestructiveWord } from './classify.js';
import { discoveryCandidatesOf, type DiscoveryDocument } from './discovery-result.js';
import { isPageIssuedTokenFieldName, isSendableField, type ReadCheckParameters } from './read-check-contracts.js';
import { SEARCH_CHECK_TEXT_VALUES, type SearchCheckTextValue } from './search-check-text-values.js';
import type { DiscoverySearchTrigger, DiscoverySearchTriggerRecord } from './search-read-contracts.js';

/** 文字の欄に入れる値の一覧（持ち主は `search-check-text-values.ts`。ここは公開し直す）。 */
export { SEARCH_CHECK_TEXT_VALUES, type SearchCheckTextValue };

/** 文字の欄の型（半角と全角の目印を入れる欄。持ち主は `candidate-contracts.ts`）。 */
const TEXT_FIELD_TYPES: ReadonlySet<string> = new Set(SEARCH_TEXT_FIELD_TYPES);
/** 選ぶ欄の型（select。持ち主は `candidate-contracts.ts`）。 */
const SELECT_TYPES: ReadonlySet<string> = new Set(SELECT_FIELD_TYPES);
const RADIO_FIELD_TYPE = 'radio';
const CHECKBOX_FIELD_TYPE = 'checkbox';
const HIDDEN_FIELD_TYPE = 'hidden';
/** `value` の属性のない checkbox がブラウザで送る値。 */
const CHECKBOX_DEFAULT_VALUE = 'on';

/** フォームの組の変え方（表示に使う。値は持たない）。 */
export type SearchCheckFormChange =
  | { readonly kind: 'BASELINE' }
  | { readonly kind: 'TEXT'; readonly field: string; readonly text: SearchCheckTextValue }
  | { readonly kind: 'OPTION'; readonly field: string; readonly optionIndex: number }
  | { readonly kind: 'CHECK'; readonly field: string };

/** 確かめる組 1 つ。 */
export type SearchCheckCombo =
  | {
    readonly kind: 'FORM';
    readonly key: string;
    /** フォームのある画面（最初に見つけた画面）。 */
    readonly page: CandidateLocation;
    readonly targetIdentityDigest: string;
    readonly parameters: ReadCheckParameters;
    readonly change: SearchCheckFormChange;
    /** トークンでない hidden の欄がある（送らないので、基準の組が 5xx でも判定できない）。 */
    readonly unsentHiddenFields: boolean;
  }
  | {
    readonly kind: 'SCRIPT';
    readonly key: string;
    readonly page: CandidateLocation;
    /** 押下か入力のきっかけ（操作さがしの記録のまま）。 */
    readonly trigger: Extract<DiscoverySearchTrigger, { readonly kind: 'PRESS' | 'TYPED' }>;
    readonly text: SearchCheckTextValue;
  };

/** 組の計画（`combos` の数が M。`excluded` は守りに当たって除いた組の数）。 */
export interface SearchCheckPlan {
  readonly combos: readonly SearchCheckCombo[];
  readonly excluded: number;
}

/** 値の形の区分（数字だけ・英字と数字・そのほか）。 */
const valueShapeOf = (value: string): number => {
  if (/^[0-9]+$/u.test(value)) return 0;
  return /^[A-Za-z0-9_-]+$/u.test(value) ? 1 : 2;
};

/** 値の形の違うものを先に並べる（形ごとの最初の値を、出てきた順に先に。残りは元の順）。 */
const shapeFirst = (values: readonly string[]): readonly string[] => {
  const seen = new Set<number>();
  const first: string[] = [];
  const rest: string[] = [];
  for (const value of values) {
    const shape = valueShapeOf(value);
    if (seen.has(shape)) {
      rest.push(value);
    } else {
      seen.add(shape);
      first.push(value);
    }
  }
  return [...first, ...rest];
};

/** 欄の選択肢（重なりなし。元の順）。 */
const optionsOf = (field: CandidateField): readonly string[] => [...new Set(field.options ?? [])];

/** 守りに当たる送る値か（危険な語・秘密に見える名前）。 */
const isGuardedParameters = (parameters: ReadCheckParameters): boolean =>
  readParametersHaveDestructiveWord(parameters) || Object.keys(parameters).some((name) => isSecretUrlQueryParameterName(name));

/** フォームの見分け（送信先と欄の形）。 */
const formShapeKeyOf = (candidate: DiscoveryCandidate): string => JSON.stringify([
  candidate.action?.origin, candidate.action?.path,
  candidate.fields.map((field) => [field.name, field.type, field.options, isSendableField(field)]),
]);

/** 組の鍵（組の中身の digest）。 */
const comboKeyOf = (content: unknown): string => createSha256Fingerprint(JSON.stringify(content));

/** GET の検索フォーム 1 つの組（守りに当たる組の数も返す）。 */
const formCombosOf = (candidate: DiscoveryCandidate): { readonly combos: readonly SearchCheckCombo[]; readonly excluded: number } => {
  const sendable = candidate.fields.filter(isSendableField);
  // REV-RCA の I-3: 値か表示の文字が削除の語に当たる選択肢（操作さがしが印を付けた位置）の、欄ごとの値。基準の組は選ばず、その値を送る組は除く。
  const destructiveValues = new Map<string, Set<string>>();
  for (const field of sendable) {
    for (const index of field.destructiveOptionIndexes ?? []) {
      const value = field.options?.[index];
      if (value !== undefined) destructiveValues.set(field.name, new Set([...(destructiveValues.get(field.name) ?? []), value]));
    }
  }
  const isDestructiveChoice = (field: string, value: string): boolean => destructiveValues.get(field)?.has(value) === true;
  const baseline: Record<string, string> = {};
  const radios = new Map<string, string[]>();
  const checkboxes: string[] = [];
  const selectRests: { readonly field: string; readonly values: readonly string[] }[] = [];
  for (const field of sendable) {
    if (field.type === RADIO_FIELD_TYPE) {
      radios.set(field.name, [...(radios.get(field.name) ?? []), ...optionsOf(field)]);
    } else if (field.type === CHECKBOX_FIELD_TYPE) {
      if (!checkboxes.includes(field.name)) checkboxes.push(field.name);
    } else if (SELECT_TYPES.has(field.type)) {
      const options = optionsOf(field);
      const first = options.find((value) => !isDestructiveChoice(field.name, value));
      if (first !== undefined && !(field.name in baseline)) {
        baseline[field.name] = first;
        selectRests.push({ field: field.name, values: options.filter((value) => value !== first) });
      }
    } else if (!(field.name in baseline)) {
      baseline[field.name] = '';
    }
  }
  const textFields = [...new Set(sendable.filter((field) => TEXT_FIELD_TYPES.has(field.type)).map(({ name }) => name))];
  const changes: { readonly parameters: ReadCheckParameters; readonly change: SearchCheckFormChange }[] = [
    { parameters: baseline, change: { kind: 'BASELINE' } },
    // REV-RCA fix round 2: 文字の欄の値（目印）はワーカーが組ごとに作る。組の送る値は空のままにし、変え方（`change`）で欄と値の種類を示す。
    ...textFields.flatMap((field) => SEARCH_CHECK_TEXT_VALUES.filter((text) => text !== 'EMPTY')
      .map((text) => ({ parameters: { ...baseline, [field]: '' }, change: { kind: 'TEXT' as const, field, text } }))),
    ...selectRests.flatMap(({ field, values }) => {
      const all = candidate.fields.find((entry) => entry.name === field)?.options ?? [];
      return shapeFirst(values).map((value) => ({
        parameters: { ...baseline, [field]: value }, change: { kind: 'OPTION' as const, field, optionIndex: all.indexOf(value) },
      }));
    }),
    ...[...radios.entries()].flatMap(([field, values]) => {
      const unique = [...new Set(values)];
      return shapeFirst(unique).map((value) => ({
        parameters: { ...baseline, [field]: value }, change: { kind: 'OPTION' as const, field, optionIndex: unique.indexOf(value) },
      }));
    }),
    ...checkboxes.map((field) => {
      const box = sendable.find((entry) => entry.name === field && entry.type === CHECKBOX_FIELD_TYPE);
      const value = (box === undefined ? undefined : optionsOf(box)[0]) ?? CHECKBOX_DEFAULT_VALUE;
      return { parameters: { ...baseline, [field]: value }, change: { kind: 'CHECK' as const, field } };
    }),
  ];
  const unsentHiddenFields = candidate.fields.some((field) => (field.type === HIDDEN_FIELD_TYPE || field.hidden)
    && field.name.length > 0 && !isPageIssuedTokenFieldName(field.name));
  const kept = changes.filter(({ parameters }) => !isGuardedParameters(parameters)
    && !Object.entries(parameters).some(([field, value]) => isDestructiveChoice(field, value)));
  const page = Object.freeze({ origin: candidate.page.origin, path: candidate.page.path });
  return {
    excluded: changes.length - kept.length,
    combos: kept.map(({ parameters, change }) => Object.freeze({
      kind: 'FORM' as const,
      key: comboKeyOf(['FORM', formShapeKeyOf(candidate), parameters, change]),
      page,
      targetIdentityDigest: candidate.identityDigest,
      parameters: Object.freeze({ ...parameters }),
      change: Object.freeze(change),
      unsentHiddenFields,
    })),
  };
};

/** きっかけの見分け（種類と欄の形と読み取りの形。画面と段は入れない）。 */
const triggerShapeKeyOf = (record: DiscoverySearchTriggerRecord): string => {
  const { trigger } = record;
  const fields = trigger.kind === 'PRESS'
    ? trigger.inputFields.map(({ name, selector, type, marker }) => [name, selector, type, marker !== null])
    : trigger.kind === 'TYPED' ? [[trigger.field.name, trigger.field.selector, trigger.field.type]] : [];
  return JSON.stringify([trigger.kind, trigger.kind === 'PRESS' ? trigger.identityDigest : null, fields,
    record.reads.map(({ method, pathShape, queryNames }) => [method, pathShape, queryNames])]);
};

/** きっかけが入れる欄の名前（守りの確かめに使う）。 */
const triggerFieldNamesOf = (trigger: DiscoverySearchTrigger): readonly string[] => {
  if (trigger.kind === 'PRESS') return trigger.inputFields.flatMap(({ name, marker }) => (marker !== null && name !== null ? [name] : []));
  if (trigger.kind === 'TYPED') return trigger.field.name === null ? [] : [trigger.field.name];
  return [];
};

/**
 * 組の計画を作る（純粋。最新の操作さがしの記録から）。DEF-300（REV-RCA の判断「読まない URL の組は始める前に除く」）: `isExcludedPath` を渡すと、行き先
 * （GET のフォームの action の path・きっかけが出した GET の読み取りの path の形）がそれに当たる組を除き、数を `excluded` に残す（判定は呼ぶ側の今の 1 か所）。
 */
export const searchCheckPlanOf = (document: Pick<DiscoveryDocument, 'pages'>, isExcludedPath: (path: string) => boolean = () => false): SearchCheckPlan => {
  const combos: SearchCheckCombo[] = [];
  let excluded = 0;
  const seenForms = new Set<string>();
  const seenTriggers = new Set<string>();
  for (const page of document.pages) {
    if (page.state !== 'READ' || page.record.location === null) continue;
    const location = Object.freeze({ origin: page.record.location.origin, path: page.record.location.path });
    for (const candidate of discoveryCandidatesOf({ pages: [page] })) {
      if (candidate.classification !== READ_CANDIDATE_CLASSIFICATION || candidate.action === null) continue;
      const shape = formShapeKeyOf(candidate);
      if (seenForms.has(shape)) continue;
      seenForms.add(shape);
      const made = formCombosOf(candidate);
      if (isExcludedPath(candidate.action.path)) {
        excluded += made.excluded + made.combos.length;
        continue;
      }
      combos.push(...made.combos);
      excluded += made.excluded;
    }
    // AIW: 操作さがしで AI の操作と覚えた候補（記録の印 `submissionProbe.aiAction`）の識別。その押下と、その押下を前に含むきっかけは、始める前に除く。
    const aiActions = new Set(page.record.candidates.flatMap((candidate) => (candidate.submissionProbe?.aiAction === true ? [candidate.identityDigest] : [])));
    for (const record of page.record.searchTriggers ?? []) {
      const { trigger } = record;
      if ((trigger.kind !== 'PRESS' && trigger.kind !== 'TYPED') || !record.reads.some(({ markerQueryNames }) => markerQueryNames.length > 0)) continue;
      const shape = triggerShapeKeyOf(record);
      if (seenTriggers.has(shape)) continue;
      seenTriggers.add(shape);
      if ((trigger.kind === 'PRESS' && aiActions.has(trigger.identityDigest)) || trigger.priorPresses.some(({ identityDigest }) => aiActions.has(identityDigest))) {
        excluded += SEARCH_CHECK_TEXT_VALUES.length;
        continue;
      }
      // REV-RCA fix round 2: 入れる値は目印（危険な語を含まない）なので、欄の名前だけを照らす。
      const guarded = triggerFieldNamesOf(trigger).some((name) => isSecretUrlQueryParameterName(name))
        || readParametersHaveDestructiveWord(Object.fromEntries(triggerFieldNamesOf(trigger).map((name) => [name, ''])))
        || record.reads.some(({ method, pathShape }) => method === 'GET' && isExcludedPath(pathShape));
      if (guarded) {
        excluded += SEARCH_CHECK_TEXT_VALUES.length;
        continue;
      }
      for (const text of SEARCH_CHECK_TEXT_VALUES) {
        combos.push(Object.freeze({ kind: 'SCRIPT' as const, key: comboKeyOf(['SCRIPT', shape, text]), page: location, trigger, text }));
      }
    }
  }
  return Object.freeze({ combos: Object.freeze(combos), excluded });
};
