// 送らずに観察する probe の操作の部品（T37c。Task 37 の設計書 3.2 の「どこで」「対象」「入力」「押下」、4 章、5 章）。ページを操作してよいファイルの
// 閉じた一覧（`tests/architecture/worker-login-hooks.test.ts` の (q)）の 1 つ。`src/discovery/` はページを操作しない（同じ Gate の (w)）ので、押す操作は
// このファイルに置き、発見の流れ（`src/worker/discovery-run.ts`）が、1 画面の流れの最後（候補の分類と `discoverLinks` の後）に呼ぶ。
// 1. 前提: 凍結した PRIMARY の Context（`activateInteractionFreeze` の後。凍結の後は、ページの JS の送信を含むすべての要求を Guard が止める）と、factory が
//    その Context に渡した観察の口（`SubmissionObservation`。T37b）。押す前に、Guard が凍結の段にあることを確かめる（`interactionFreezeHolds`。凍結の段でなければ
//    押さずに `PRESS_FAILED`）。読み込み直しはしない（1 画面 1 読み込みのまま）。
// 2. 対象（`isSubmissionProbeTarget`。契約は `src/discovery/submission-probe-contracts.ts`）を、押す前に isolated world でもう一度読み（発見の probe
//    `probePageCandidates`）、同じ識別の digest（`probedCandidateIdentityDigestOf`。送信ボタンの語を含むので、削除の語に変わったボタンは別の候補）で
//    同じ候補を探し、押す順（`submissionProbePressOrderOf`。DEF-142: 登録・更新の語のあるもの、文字のあるそのほか、文字のないもの、の順。同じ段の中は
//    送信ボタンの位置の文書の順）に並べ、1 画面 `MAX_SUBMISSION_PROBE_PRESSES_PER_PAGE` 回まで押す（残りは `PRESS_LIMIT_REACHED`）。
//    見つからない・送信ボタンがない候補は `TARGET_NOT_FOUND`。DEF-142: 押す前に送信ボタンが見えない（か範囲を読めない）候補も `TARGET_NOT_FOUND` で、
//    押す回数を使わずに次の候補へ進む。T44c（Task 44 の設計書 P1-3）: 押す順に並べる前に、見つけた対象の送信ボタンが見えるかを 1 回で読み、見えない対象を
//    除く（`TARGET_NOT_FOUND`。押す数の上限の後に並んでいても `PRESS_LIMIT_REACHED` にしない）。押す順と上限は、見える対象だけで数える。
// 3. 入力: 押す前に、その候補の範囲の欄（`FORM` はその form の欄、`BUTTON` は画面の form の外の欄）を isolated world で読み（要素の橋渡しの部品
//    `readElementsInIsolatedWorld`。標準の getter で読む）、見えて編集できる text 系の欄に欄ごとに違う目印（`submissionProbeMarkerOf`。1 画面で 32 まで）を
//    入れ、`select` は空でない最初の選択肢を選ぶ。password・file・hidden・checkbox・radio とほかの型、見えない・編集できない欄、目印の上限を超えた欄は
//    触らない（数を記録する）。目印の値は、観察の口に渡すほかは、どこにも記録しない。
//    T38a（Task 38 の設計書 3.1）: 目印の値は押下ごとに新しく作り（前の押下の目印と同じ値を使わない）、番号は押下ごとに 0 から振る（型の digest が前の押下に
//    左右されない）。入れた欄ごとに、`name`、その画面で一意な CSS（T43c の組み立て `entrySelectorCandidatesOf` を `src/discovery/selector-count.ts` で数えて
//    選ぶ）、種類、目印の番号を `inputFields` に記録する（`BUTTON` の候補では、これが候補の欄の範囲。値は記録しない）。
// 4. 押下: 観察の口を有効にして（`begin`。画面の path（query なし）と、その画面で使ったすべての目印）、合図つきの Locator（`withSignaledElements` と
//    `elementPathSelectorOf`。位置の要素が読んだ要素のときだけ要素を返す）で入れて押し（`click`）、静まるまで名前つきの時間（既定
//    `SUBMISSION_PROBE_QUIET_WAIT_MS`）待ってから、口を閉じる（`end`）。Guard は、承認した API の Origin への事前確認を満たし、本番の要求を止めて型を口に渡す
//    （サーバへは何も届かない）。結果は T37b の分類で写す（`observedSubmissionProbeOf`）。入れるか押す操作が失敗したら `PRESS_FAILED`。
// 5. 押した後に main frame の URL が変わったら（画面を移る保存。止めた移動のために Chromium の誤りの画面に替わることもある）、その押下は `PAGE_CHANGED`
//    にし、その画面の残りの対象は押さない（`PAGE_CHANGED`）。
// 6. DEF-144（設計書 `2026-10-20-beaksight-probe-external-scheme-design.md` 2.1・2.3）: 押す前の読み直しで、送信ボタンと祖先の `<a>`・`<area>` の `href`、
//    `formaction`、form の `action` を読み、外部スキーム（Guard の判定 `externalNavigationScheme`。`javascript:` は今の扱いのまま）を指す対象は押さずに
//    `NOT_EXECUTABLE`・`EXTERNAL_SCHEME`（押す回数を使わない）。Guard が Context を閉じ始めた後の対象は `CONTEXT_CLOSED_BY_GUARD`（`PAGE_CHANGED` と分ける）。
//    読み込み直した画面では、指定の対象（`onlyCandidates`）だけを、残りの回数（`maxPresses`）まで押す。
// 7. DEF-145（設計書 `2026-10-21-beaksight-probe-navigation-and-dialog-design.md` 2.2）: 押下が何も送らず（`NO_REQUEST`）回数が残っていれば、押す前は見えな
//    かった（かなかった）登録・更新の語の対象を読み直し、押下で開いたダイアログなどで見つかったものを先に押す（1 対象 1 回まで。回数は合わせて 1 画面 3 回）。
//    結果は元の候補に記録する。読み込み直しはしない。
// 例外を投げない（予期しない誤りは、残りの対象を `PRESS_FAILED` にする）。Playwright の誤りの文は値を含みうるので捨てる。
import type { Page } from 'playwright';
import { MAX_API_SHAPE_MARKERS } from '../core/api-request-shape.js';
import { MAX_URL_LENGTH } from '../core/limits.js';
import { wait } from '../core/deadline.js';
import { isRecord } from '../core/guards.js';
import { VISIBILITY_CHECK_OPTIONS } from '../core/visibility.js';
import { elementPathSelectorOf } from '../browser/element-path-engine.js';
import { composeInPage, type StandardReaders } from '../browser/in-page-readers.js';
import {
  CANDIDATE_FIELD_TYPES,
  MAX_CANDIDATE_FIELDS,
  MAX_FIELD_NAME_LENGTH,
  SELECT_FIELD_TYPES,
  type CandidateFieldType,
  type CandidateLocation,
} from '../discovery/candidate-contracts.js';
import { probedCandidateIdentityDigestOf } from '../discovery/discover-page.js';
import type { DiscoveryReadPageRecord } from '../discovery/discovery-result.js';
import { entrySelectorCandidatesOf, uniqueEntrySelectorOf, type EntryElementFacts } from '../discovery/entry-check-selectors.js';
import { readElementsInIsolatedWorld, readInIsolatedWorld, withSignaledElements, type InPageElementsResult } from '../discovery/isolated-read.js';
import { probePageCandidates, type ProbedCandidate } from '../discovery/probe.js';
import { countReadingOf, countSelectorsInPage } from '../discovery/selector-count.js';
import {
  MAX_SUBMISSION_PROBE_FIELD_SELECTOR_LENGTH,
  MAX_SUBMISSION_PROBE_PRESSES_PER_PAGE,
  SUBMISSION_PROBE_FILL_FIELD_TYPES,
  SUBMISSION_PROBE_QUIET_WAIT_MS,
  externalSchemeSubmissionProbeOf,
  hasSubmissionProbePriorityWord,
  isSubmissionProbeTarget,
  notObservedSubmissionProbeOf,
  observedSubmissionProbeOf,
  submissionProbeMarkerOf,
  submissionProbePressOrderOf,
  withSubmissionProbes,
  type SubmissionProbeFieldCounts,
  type SubmissionProbeInputField,
  type SubmissionProbeNotObservedReason,
  type SubmissionProbePressEntry,
  type SubmissionProbeRecord,
  type SubmissionProbeTargetPolicy,
} from '../discovery/submission-probe-contracts.js';
import { externalNavigationScheme, isClosingOrInvalidatingPhase, passiveRequestGuardStageOf } from '../safety/passive-request-guard.js';
import type { SubmissionObservation, SubmissionObservationResult } from '../safety/submission-observation.js';

/** 押す前の読み直しと、欄の読み取りの、それぞれの時間の上限（ms）。 */
export const SUBMISSION_PROBE_READ_TIMEOUT_MS = 10_000;
/** 欄に入れる・選ぶ・押す操作の、それぞれの時間の上限（ms）。 */
export const SUBMISSION_PROBE_STEP_TIMEOUT_MS = 5_000;

/** 押す部品の指定。 */
export interface SubmissionProbeOptions {
  /** 対象の選び方（許可 Origin とログインの画面）。 */
  readonly targetPolicy: SubmissionProbeTargetPolicy;
  /** 押した後に静まるまで待つ時間（ms。省略すると `SUBMISSION_PROBE_QUIET_WAIT_MS`）。 */
  readonly quietWaitMs?: number | undefined;
  /**
   * DEF-144: 1 つの対象に入れて押す直前（欄の読み取りと、外部スキームの見分けの後。押す回数を使う押下だけ）に、記録の候補の位置（`record.candidates` の
   * 添字）で呼ぶ（安全の違反を、押した候補に結びつけるため）。省略すると呼ばない。
   */
  readonly onPress?: ((candidateIndex: number) => void) | undefined;
  /** DEF-144: 読み込み直した画面で、押してよい対象（記録の候補の位置）。省略すると、すべての対象。 */
  readonly onlyCandidates?: ReadonlySet<number> | undefined;
  /** DEF-144: この画面で押してよい回数（読み込み直しの前に使った分を引いた残り。`MAX_SUBMISSION_PROBE_PRESSES_PER_PAGE` を超えない）。 */
  readonly maxPresses?: number | undefined;
}

/** 押す対象（記録の候補の位置と、読み直した候補。DEF-142: 押す順を決める、送信ボタンの語と文字があるか）。 */
interface PressTarget extends SubmissionProbePressEntry {
  readonly index: number;
  readonly kind: ProbedCandidate['kind'];
  readonly formPath: readonly number[] | null;
}

/** 欄の読み取りの入力（ページの中の関数は外を参照できないので、値はすべてここで渡す）。 */
interface ScopeReadInput {
  readonly submitterPath: readonly number[];
  readonly formPath: readonly number[] | null;
  readonly kind: ProbedCandidate['kind'];
  readonly visibilityOptions: CheckVisibilityOptions;
  readonly maxFields: number;
  readonly fieldSelector: string;
  readonly fieldTypes: readonly string[];
  readonly fillTypes: readonly string[];
  readonly selectTypes: readonly string[];
  /** DEF-144: 読む移りうる先の数と長さの上限。 */
  readonly maxTargets: number;
  readonly maxTargetLength: number;
}

/** 欄の読み取りで、入れるか選ぶ欄の事実（値は持たない）。 */
interface ScopeField {
  readonly type: CandidateFieldType;
  /** select の、空でない最初の選択肢の位置（ほかの欄は null）。 */
  readonly optionIndex: number | null;
  /** T38a: CSS の組み立てに使う属性（要素の名前、`id`・`name`・`type` の属性。値は読まない。ないときは空文字列）。 */
  readonly facts: EntryElementFacts;
}

/** 欄の要素の名前。 */
const FIELD_SELECTOR = 'input, textarea, select';

/**
 * 候補の範囲の欄を読む（ページの中で動く。標準の getter とメソッドで読み、ページに何も書かない）。要素の参照は、送信ボタン、入れるか選ぶ欄の順。
 * 値は `{ fields, skipped }`（送信ボタンか form が見つからなければ null）。
 */
const readProbeScopeInPage = composeInPage((R: StandardReaders, input: ScopeReadInput): InPageElementsResult => {
  const getterOf = R.standardGetter;
  const localNameOf = getterOf<string>(Element.prototype, 'localName');
  const inputTypeOf = getterOf<string>(HTMLInputElement.prototype, 'type');
  const selectTypeOf = getterOf<string>(HTMLSelectElement.prototype, 'type');
  const inputFormOf = getterOf<unknown>(HTMLInputElement.prototype, 'form');
  const textAreaFormOf = getterOf<unknown>(HTMLTextAreaElement.prototype, 'form');
  const selectFormOf = getterOf<unknown>(HTMLSelectElement.prototype, 'form');
  const inputReadOnlyOf = getterOf<boolean>(HTMLInputElement.prototype, 'readOnly');
  const textAreaReadOnlyOf = getterOf<boolean>(HTMLTextAreaElement.prototype, 'readOnly');
  const formElementsOf = getterOf<unknown>(HTMLFormElement.prototype, 'elements');
  const collectionLengthOf = getterOf<number>(HTMLCollection.prototype, 'length');
  const nodeListLengthOf = getterOf<number>(NodeList.prototype, 'length');
  const selectOptionsOf = getterOf<unknown>(HTMLSelectElement.prototype, 'options');
  const optionValueOf = getterOf<string>(HTMLOptionElement.prototype, 'value');
  const optionDisabledOf = getterOf<boolean>(HTMLOptionElement.prototype, 'disabled');
  const submitter = R.elementAtPath(input.submitterPath);
  // DEF-142: 見えない送信ボタンは押さない（押す前に見えない対象は `TARGET_NOT_FOUND`。押す回数を使わない）。
  if (submitter === null || !Element.prototype.checkVisibility.call(submitter, input.visibilityOptions)) {
    return { value: null, elements: [] };
  }
  // DEF-144: 押すと移りうる先（送信ボタンと祖先の `<a>`・`<area>` の `href`、送信ボタンの `formaction`、form の `action`）。属性の書かれたままの値を読む
  // （外部スキームかの判定は Node の側。上限の数と長さで止める）。
  const parentOf = getterOf<Element | null>(Node.prototype, 'parentElement');
  const targets: string[] = [];
  const pushTarget = (element: Element | null, attribute: string): void => {
    if (element === null || targets.length >= input.maxTargets) return;
    const value: unknown = Element.prototype.getAttribute.call(element, attribute);
    if (typeof value === 'string') targets.push(value.slice(0, input.maxTargetLength));
  };
  for (let node: Element | null = submitter; node !== null; node = parentOf(node)) {
    const name = localNameOf(node);
    if (name === 'a' || name === 'area') pushTarget(node, 'href');
  }
  pushTarget(submitter, 'formaction');
  const ownerForm = input.formPath === null ? Element.prototype.closest.call(submitter, 'form') : R.elementAtPath(input.formPath);
  pushTarget(ownerForm, 'action');
  const controls: Element[] = [];
  let overflow = 0;
  const push = (element: Element | null): void => {
    if (element === null) return;
    const name = localNameOf(element);
    if (name !== 'input' && name !== 'textarea' && name !== 'select') return;
    if (controls.length >= input.maxFields) {
      overflow += 1;
      return;
    }
    controls.push(element);
  };
  if (input.kind === 'FORM') {
    const form = input.formPath === null ? null : R.elementAtPath(input.formPath);
    if (form === null || localNameOf(form) !== 'form') {
      return { value: null, elements: [] };
    }
    const collection = formElementsOf(form);
    const length = collectionLengthOf(collection);
    for (let index = 0; index < length; index += 1) {
      push(HTMLCollection.prototype.item.call(collection as HTMLCollection, index));
    }
  } else {
    const all = Document.prototype.querySelectorAll.call(document, input.fieldSelector);
    const length = nodeListLengthOf(all);
    for (let index = 0; index < length; index += 1) {
      const element = NodeList.prototype.item.call(all, index) as Element | null;
      if (element === null) continue;
      const name = localNameOf(element);
      const owner = name === 'input' ? inputFormOf(element) : (name === 'textarea' ? textAreaFormOf(element) : selectFormOf(element));
      if (owner === null) push(element);
    }
  }
  const fields: { type: string; optionIndex: number | null; facts: { tag: string; id: string; name: string; type: string } }[] = [];
  const elements: Element[] = [submitter];
  let skipped = overflow;
  // T38a: CSS の組み立てに使う属性（値は読まない）。
  const attributeOf = (element: Element, attribute: string): string => {
    const value: unknown = Element.prototype.getAttribute.call(element, attribute);
    return typeof value === 'string' ? value : '';
  };
  const factsOf = (element: Element) => ({
    tag: localNameOf(element), id: attributeOf(element, 'id'), name: attributeOf(element, 'name'), type: attributeOf(element, 'type'),
  });
  for (const element of controls) {
    const name = localNameOf(element);
    const type = name === 'input' ? inputTypeOf(element) : (name === 'textarea' ? 'textarea' : selectTypeOf(element));
    if (name === 'input' && !input.fieldTypes.includes(type)) {
      // 送信ボタンなどの形（欄でない）は数えない。
      continue;
    }
    const visible = Element.prototype.checkVisibility.call(element, input.visibilityOptions);
    const disabled = Element.prototype.matches.call(element, ':disabled');
    const readOnly = name === 'input' ? inputReadOnlyOf(element) : (name === 'textarea' ? textAreaReadOnlyOf(element) : false);
    if (!visible || disabled || readOnly) {
      skipped += 1;
      continue;
    }
    if (input.fillTypes.includes(type)) {
      fields.push({ type, optionIndex: null, facts: factsOf(element) });
      elements.push(element);
    } else if (input.selectTypes.includes(type)) {
      const options = selectOptionsOf(element);
      const length = collectionLengthOf(options);
      let optionIndex: number | null = null;
      for (let index = 0; index < length && optionIndex === null; index += 1) {
        const option = HTMLCollection.prototype.item.call(options as HTMLCollection, index);
        if (option !== null && optionValueOf(option) !== '' && !optionDisabledOf(option)) optionIndex = index;
      }
      if (optionIndex === null) {
        skipped += 1;
        continue;
      }
      fields.push({ type, optionIndex, facts: factsOf(element) });
      elements.push(element);
    } else {
      skipped += 1;
    }
  }
  return { value: { fields, skipped, targets }, elements };
});

/** T44c: 送信ボタンが見えるかの読み取りの入力（送信ボタンの位置の並びと、見え方の確かめの指定）。 */
interface SubmitterVisibilityInput {
  readonly paths: readonly (readonly number[])[];
  readonly visibilityOptions: CheckVisibilityOptions;
}

/**
 * T44c（Task 44 の設計書 P1-3）: 送信ボタンの位置ごとに、見えるか（`readProbeScopeInPage` と同じ確かめ。要素がなければ偽）を読む（ページの中で動く。
 * 標準のメソッドで読み、ページに何も書かない）。押す数を数える前に、見えない候補を除くために使う。
 */
const readSubmitterVisibilityInPage = composeInPage((R: StandardReaders, input: SubmitterVisibilityInput): boolean[] => input.paths.map((path) => {
  const element = R.elementAtPath(path);
  return element !== null && Element.prototype.checkVisibility.call(element, input.visibilityOptions);
}));

/**
 * T44c: 押す対象のうち、今の画面で送信ボタンが見えるものと見えないものに分ける（1 回の読み取り）。読めなければ、すべてを見えるものに入れる（押す部品が、
 * 押す前に 1 つずつ確かめる。今までの振る舞い）。
 */
async function splitByVisibility(
  page: Page,
  targets: readonly PressTarget[],
): Promise<{ readonly visible: readonly PressTarget[]; readonly invisible: readonly PressTarget[] }> {
  if (targets.length === 0) {
    return { visible: targets, invisible: [] };
  }
  const outcome = await readInIsolatedWorld(page, readSubmitterVisibilityInPage, {
    paths: targets.map(({ path }) => path),
    visibilityOptions: VISIBILITY_CHECK_OPTIONS,
  } satisfies SubmitterVisibilityInput, Date.now() + SUBMISSION_PROBE_READ_TIMEOUT_MS);
  const flags: unknown = outcome.status === 'READ' ? outcome.value : null;
  if (!Array.isArray(flags) || flags.length !== targets.length || flags.some((flag) => typeof flag !== 'boolean')) {
    return { visible: targets, invisible: [] };
  }
  return {
    visible: targets.filter((_target, index) => flags[index] === true),
    invisible: targets.filter((_target, index) => flags[index] !== true),
  };
}

/** DEF-144: 押す前に読む、移りうる先の数の上限（祖先のリンクの段数を含む。超えた分は読まない）。 */
const MAX_SUBMISSION_PROBE_NAVIGATION_TARGETS = 16;
/** DEF-144: 押してよい、http(s) でないスキーム（設計書 2.1。`javascript:` は今の扱いのまま押す）。 */
const PRESSABLE_SCRIPT_SCHEME = 'javascript:';

/** 欄の読み取りの入力の決まった部分。 */
const SCOPE_READ_BASE = Object.freeze({
  visibilityOptions: VISIBILITY_CHECK_OPTIONS,
  maxFields: MAX_CANDIDATE_FIELDS,
  fieldSelector: FIELD_SELECTOR,
  fieldTypes: CANDIDATE_FIELD_TYPES,
  fillTypes: SUBMISSION_PROBE_FILL_FIELD_TYPES,
  selectTypes: SELECT_FIELD_TYPES,
  maxTargets: MAX_SUBMISSION_PROBE_NAVIGATION_TARGETS,
  maxTargetLength: MAX_URL_LENGTH,
});

/**
 * DEF-144（設計書 `2026-10-20-beaksight-probe-external-scheme-design.md` 2.1）: 移りうる先（属性の書かれたままの値）のどれかが、外部スキーム（Guard の判定
 * `externalNavigationScheme`。http(s)・about・data・blob のほか）を指すか。値は画面の URL を基準に解く（相対の URL は今の扱いのまま）。`javascript:` と、解けない
 * 値は、今の扱いのまま（押す）。
 */
export const pointsToExternalScheme = (targets: readonly string[], baseUrl: string): boolean => targets.some((raw) => {
  const value = raw.trim();
  if (value === '' || !URL.canParse(value, baseUrl)) {
    return false;
  }
  const url = new URL(value, baseUrl);
  if (url.protocol === PRESSABLE_SCRIPT_SCHEME) {
    return false;
  }
  try {
    return externalNavigationScheme(url.href) !== null;
  } catch {
    return false;
  }
});

/**
 * 読んだ範囲（送信ボタンと欄の要素の参照、入れるか選ぶ欄、触らなかった欄の数）。読めなければ null。T38a: 欄ごとの、その画面で一意な CSS
 * （`selectors`。欄の順。作れなければ null）。
 */
interface ReadScope {
  readonly backendNodeIds: readonly number[];
  readonly paths: readonly (readonly number[])[];
  readonly fields: readonly ScopeField[];
  readonly selectors: readonly (string | null)[];
  readonly skipped: number;
  /** DEF-144: 押すと移りうる先（属性の書かれたままの値。`pointsToExternalScheme` で判定する）。 */
  readonly targets: readonly string[];
}

const isCandidateFieldType = (value: unknown): value is CandidateFieldType =>
  typeof value === 'string' && (CANDIDATE_FIELD_TYPES as readonly string[]).includes(value);

/** 属性の事実の形（文字列の 4 つ）。 */
const elementFactsOf = (value: unknown): EntryElementFacts | null =>
  isRecord(value) && typeof value['tag'] === 'string' && typeof value['id'] === 'string' && typeof value['name'] === 'string'
    && typeof value['type'] === 'string'
    ? { tag: value['tag'], id: value['id'], name: value['name'], type: value['type'] }
    : null;

/**
 * T38a: 欄ごとの、その画面でちょうど 1 つの欄に当たる CSS（T43c の組み立て `entrySelectorCandidatesOf` の候補を、isolated world で数えた結果
 * `uniqueEntrySelectorOf`。長すぎる CSS は使わない）。読めなければ、どの欄も null（欄の識別は `name` に任せる）。
 */
async function uniqueSelectorsOf(
  page: Page,
  fields: readonly ScopeField[],
  paths: readonly (readonly number[])[],
): Promise<readonly (string | null)[]> {
  const plans = fields.map((field, index) => ({
    path: paths[index + 1] ?? null,
    selectors: entrySelectorCandidatesOf(field.facts).filter((selector) => selector.length <= MAX_SUBMISSION_PROBE_FIELD_SELECTOR_LENGTH),
  }));
  if (plans.every(({ selectors }) => selectors.length === 0)) {
    return fields.map(() => null);
  }
  const outcome = await readInIsolatedWorld(page, countSelectorsInPage, { checks: plans }, Date.now() + SUBMISSION_PROBE_READ_TIMEOUT_MS);
  const counts = outcome.status === 'READ' ? countReadingOf(outcome.value, plans.map(({ selectors }) => selectors.length)) : null;
  return plans.map(({ selectors }, index) => (counts === null
    ? null
    : uniqueEntrySelectorOf(selectors.map((selector, at) => ({
      selector,
      matches: counts[index]?.[at]?.matches ?? 0,
      matchesElement: counts[index]?.[at]?.matchesElement ?? false,
    })))));
}

/** 候補の範囲の欄を読む（形が違う・位置のない要素があれば null）。 */
async function readScope(page: Page, target: PressTarget): Promise<ReadScope | null> {
  const outcome = await readElementsInIsolatedWorld(page, readProbeScopeInPage, {
    ...SCOPE_READ_BASE,
    submitterPath: target.path,
    formPath: target.formPath,
    kind: target.kind,
  }, Date.now() + SUBMISSION_PROBE_READ_TIMEOUT_MS);
  if (outcome.status !== 'READ' || !isRecord(outcome.value) || !Array.isArray(outcome.value['fields'])) {
    return null;
  }
  const skipped = outcome.value['skipped'];
  const targets: unknown = outcome.value['targets'];
  if (!Array.isArray(targets) || targets.some((value) => typeof value !== 'string')) {
    return null;
  }
  const fields: ScopeField[] = [];
  for (const raw of outcome.value['fields'] as readonly unknown[]) {
    const facts = isRecord(raw) ? elementFactsOf(raw['facts']) : null;
    if (!isRecord(raw) || !isCandidateFieldType(raw['type']) || !(raw['optionIndex'] === null || Number.isSafeInteger(raw['optionIndex']))
      || facts === null) {
      return null;
    }
    fields.push({ type: raw['type'], optionIndex: raw['optionIndex'] as number | null, facts });
  }
  const paths = outcome.elements.map(({ path }) => path);
  if (typeof skipped !== 'number' || !Number.isSafeInteger(skipped) || skipped < 0 || outcome.elements.length !== fields.length + 1
    || paths.some((path) => path === null)) {
    return null;
  }
  const knownPaths = paths as readonly (readonly number[])[];
  return {
    backendNodeIds: outcome.elements.map(({ backendNodeId }) => backendNodeId),
    paths: knownPaths,
    fields,
    selectors: await uniqueSelectorsOf(page, fields, knownPaths),
    skipped,
    targets: targets as readonly string[],
  };
}

/**
 * Guard が凍結の段にあるか（Guard の段階を読む口 `passiveRequestGuardStageOf` で、段階が `FROZEN_ACTIVE` かを直接確かめる。T37R-fix-A の M-4）。
 * 凍結の段でない（閉じる途中・無効化を含む）、Guard がない、page が閉じた、読めないときは偽（押さない）。
 */
async function interactionFreezeHolds(page: Page): Promise<boolean> {
  // T37R-fix-A（M-4）: 例外に頼らず、Guard の段階を読む口（読み取りだけ）で `FROZEN_ACTIVE` を直接確かめる。口がない・読めないときは押さない（fail-closed）。
  try {
    return !page.isClosed() && passiveRequestGuardStageOf(page) === 'FROZEN_ACTIVE';
  } catch {
    return false;
  }
}

/**
 * 押す前の読み直しで、記録の対象の候補を探す（同じ識別の digest の、同じ順番の候補）。見つからない・送信ボタンがない・位置が shadow root の中の対象は
 * `missing` に入れる。
 */
function pressTargetsOf(
  location: CandidateLocation,
  record: DiscoveryReadPageRecord,
  indices: readonly number[],
  reread: readonly ProbedCandidate[],
): { readonly found: readonly PressTarget[]; readonly missing: readonly number[] } {
  const rereadDigests = reread.map((probed) => probedCandidateIdentityDigestOf(location, probed));
  const found: PressTarget[] = [];
  const missing: number[] = [];
  for (const index of indices) {
    const digest = record.candidates[index]?.identityDigest;
    const ordinal = record.candidates.slice(0, index).filter((candidate) => candidate.identityDigest === digest).length;
    const matches = reread.filter((_probed, rereadIndex) => rereadDigests[rereadIndex] === digest);
    const probed = matches[ordinal];
    const path = probed?.submitter?.path;
    if (probed === undefined || path === undefined || path.some((step) => step < 0)) {
      missing.push(index);
      continue;
    }
    const formPath = probed.form?.path ?? null;
    found.push({
      index,
      kind: probed.kind,
      path,
      formPath: formPath !== null && formPath.some((step) => step < 0) ? null : formPath,
      submitterWords: probed.submitterWords,
      hasSubmitterText: probed.hasSubmitterText,
      // T44c: 押す順だけの送信の語の印。
      hasSubmitWord: probed.hasSubmitWord,
    });
  }
  return { found, missing };
}

/** 1 回の押下の結果（URL が変わったかは呼ぶ側が見る）。 */
type PressOutcome =
  | { readonly kind: 'OBSERVED'; readonly record: SubmissionProbeRecord }
  /** DEF-144: 押す前に、外部スキームを指すと見分けた（押していない。押す回数を使わない）。 */
  | { readonly kind: 'EXTERNAL_SCHEME' }
  | {
    readonly kind: 'NOT_OBSERVED';
    readonly reason: SubmissionProbeNotObservedReason;
    readonly fields: SubmissionProbeFieldCounts;
    readonly inputFields: readonly SubmissionProbeInputField[];
  };

/** T38a: 欄の `name`（ないか空、長すぎれば null）。 */
const fieldNameOf = (name: string): string | null => (name.length === 0 || name.length > MAX_FIELD_NAME_LENGTH ? null : name);

/**
 * 1 つの対象に入れて押し、静まるのを待って、観察の結果を返す（ファイルの先頭の 3・4）。T38a: 目印は押下ごとに新しく作り、番号は押下ごとに 0 から振る
 * （型の digest が前の押下に左右されない）。`earlierMarkers` は、その画面の前の押下で使った目印（同じ値を使わないために渡す。この押下の目印を足す）。
 * 入れた欄の識別（`name`・一意な CSS・種類・目印の番号）を `inputFields` に記録する（値は記録しない）。
 */
async function pressOne(
  page: Page,
  observation: SubmissionObservation,
  pagePath: string,
  target: PressTarget,
  earlierMarkers: string[],
  quietWaitMs: number,
  onPress: ((candidateIndex: number) => void) | undefined,
): Promise<PressOutcome> {
  const scope = await readScope(page, target);
  if (scope === null) {
    return { kind: 'NOT_OBSERVED', reason: 'TARGET_NOT_FOUND', fields: { filledFieldCount: 0, skippedFieldCount: 0 }, inputFields: [] };
  }
  // DEF-144: 押すと外部スキームへ移りうる対象は、押さない（欄にも入れない）。
  if (pointsToExternalScheme(scope.targets, page.mainFrame().url())) {
    return { kind: 'EXTERNAL_SCHEME' };
  }
  /** 入れる操作（位置と、目印か選択肢の位置）。 */
  const operations: { readonly path: readonly number[]; readonly marker: string | null; readonly optionIndex: number | null }[] = [];
  /** この押下の目印（番号は 0 から）。 */
  const markers: string[] = [];
  const inputFields: SubmissionProbeInputField[] = [];
  let skipped = scope.skipped;
  for (const [index, field] of scope.fields.entries()) {
    const path = scope.paths[index + 1] ?? [];
    const identity = { name: fieldNameOf(field.facts.name), selector: scope.selectors[index] ?? null, type: field.type };
    if (field.optionIndex !== null) {
      operations.push({ path, marker: null, optionIndex: field.optionIndex });
      inputFields.push({ ...identity, marker: null });
    } else if (markers.length < MAX_API_SHAPE_MARKERS) {
      const marker = submissionProbeMarkerOf(field.type, markers, undefined, earlierMarkers);
      inputFields.push({ ...identity, marker: markers.length });
      markers.push(marker);
      operations.push({ path, marker, optionIndex: null });
    } else {
      skipped += 1;
    }
  }
  earlierMarkers.push(...markers);
  const fields: SubmissionProbeFieldCounts = { filledFieldCount: operations.length, skippedFieldCount: skipped };
  const submitterPath = scope.paths[0] ?? [];
  // DEF-144: これから押す（入れて押す）対象を知らせる（安全の違反を、押した候補に結びつけるため）。
  onPress?.(target.index);
  observation.begin({ pagePath, markers: [...markers] });
  let pressed = false;
  let result: SubmissionObservationResult;
  try {
    const outcome = await withSignaledElements(page, scope.backendNodeIds, Date.now() + SUBMISSION_PROBE_READ_TIMEOUT_MS, async (signals) => {
      const locate = (path: readonly number[]) => {
        const position = scope.paths.findIndex((candidate) => candidate.length === path.length && candidate.every((step, at) => step === path[at]));
        const signal = signals[position];
        if (position < 0 || signal === undefined) {
          throw new Error('the probed element is not tracked');
        }
        return page.locator(elementPathSelectorOf(path, signal));
      };
      for (const operation of operations) {
        if (operation.marker !== null) {
          await locate(operation.path).fill(operation.marker, { timeout: SUBMISSION_PROBE_STEP_TIMEOUT_MS });
        } else if (operation.optionIndex !== null) {
          await locate(operation.path).selectOption({ index: operation.optionIndex }, { timeout: SUBMISSION_PROBE_STEP_TIMEOUT_MS });
        }
      }
      await locate(submitterPath).click({ timeout: SUBMISSION_PROBE_STEP_TIMEOUT_MS, noWaitAfter: true });
      return true;
    });
    pressed = outcome.status === 'DONE';
    // 押したかが分からないときも、遅れて出る要求を口が受けるように、静まるまで待ってから閉じる。
    await wait(quietWaitMs);
  } finally {
    // 例外の経路でも口を閉じる（次の押下と次の画面で口を使えるようにする）。
    result = observation.end();
  }
  return pressed
    ? { kind: 'OBSERVED', record: observedSubmissionProbeOf(result, fields, inputFields) }
    : { kind: 'NOT_OBSERVED', reason: 'PRESS_FAILED', fields, inputFields };
}

/**
 * 画面の様子（押す前と押した後に見る）。DEF-144: Guard が Context を閉じ始めた（page が閉じたか、Guard の段階が閉じる途中・無効化・閉じた後）は
 * `CLOSED_BY_GUARD`（`PAGE_CHANGED` と分ける）。main frame の URL が押す前と違えば `CHANGED`。
 */
const pageStateOf = (page: Page, startUrl: string): 'CLOSED_BY_GUARD' | 'CHANGED' | 'SAME' => {
  if (guardClosedContext(page)) {
    return 'CLOSED_BY_GUARD';
  }
  return page.mainFrame().url() === startUrl ? 'SAME' : 'CHANGED';
};

/** DEF-144: Guard が Context を閉じ始めたか（page が閉じた、か Guard の段階が閉じる途中・無効化・閉じた後）。読めなければ閉じた側に倒す。 */
const guardClosedContext = (page: Page): boolean => {
  try {
    if (page.isClosed()) {
      return true;
    }
    const stage = passiveRequestGuardStageOf(page);
    return stage !== null && isClosingOrInvalidatingPhase(stage);
  } catch {
    return true;
  }
};

/**
 * DEF-145（設計書 `2026-10-21-beaksight-probe-navigation-and-dialog-design.md` 2.2）: 押下の後に読み直して、指定の対象（押す前は見えなかったか、なかった
 * 登録・更新の語の対象）のうち、今の画面で同じ識別の候補として見つかるものを、押す順に並べる（見えるかは、押す部品が押す前に確かめる）。読めなければ空。
 */
async function revealedPriorityTargetsOf(
  page: Page,
  location: CandidateLocation,
  record: DiscoveryReadPageRecord,
  indices: readonly number[],
): Promise<readonly PressTarget[]> {
  if (indices.length === 0) {
    return [];
  }
  const reread = await probePageCandidates(page, Date.now() + SUBMISSION_PROBE_READ_TIMEOUT_MS);
  return reread.status === 'READ' ? submissionProbePressOrderOf(pressTargetsOf(location, record, indices, reread.candidates).found) : [];
}

/**
 * 1 画面の候補に、送らずに観察する probe の結果を付ける（ファイルの先頭の説明）。対象がない・画面の場所がない記録は、そのまま返す。例外を投げない。
 */
export async function probeDiscoveredSubmissions(
  page: Page,
  observation: SubmissionObservation,
  record: DiscoveryReadPageRecord,
  options: SubmissionProbeOptions,
): Promise<DiscoveryReadPageRecord> {
  const { location } = record;
  if (location === null) {
    return record;
  }
  // DEF-144: 読み込み直した画面では、指定の対象（残りの候補）だけを押す。
  const { onlyCandidates } = options;
  const indices = record.candidates.flatMap((candidate, index) => (isSubmissionProbeTarget(candidate, options.targetPolicy)
    && (onlyCandidates === undefined || onlyCandidates.has(index)) ? [index] : []));
  if (indices.length === 0) {
    return record;
  }
  const maxPresses = Math.min(options.maxPresses ?? MAX_SUBMISSION_PROBE_PRESSES_PER_PAGE, MAX_SUBMISSION_PROBE_PRESSES_PER_PAGE);
  const probes = new Map<number, SubmissionProbeRecord>();
  const markAll = (targets: readonly number[], reason: SubmissionProbeNotObservedReason): void => {
    for (const index of targets) {
      if (!probes.has(index)) probes.set(index, notObservedSubmissionProbeOf(reason));
    }
  };
  try {
    if (observation.active || !(await interactionFreezeHolds(page))) {
      markAll(indices, 'PRESS_FAILED');
      return withSubmissionProbes(record, probes);
    }
    const startUrl = page.mainFrame().url();
    const reread = await probePageCandidates(page, Date.now() + SUBMISSION_PROBE_READ_TIMEOUT_MS);
    if (reread.status !== 'READ') {
      markAll(indices, 'TARGET_NOT_FOUND');
      return withSubmissionProbes(record, probes);
    }
    const { found, missing } = pressTargetsOf(location, record, indices, reread.candidates);
    markAll(missing, 'TARGET_NOT_FOUND');
    // T44c（Task 44 の設計書 P1-3）: 見えない対象は、押す数を数える前に除く（`TARGET_NOT_FOUND`。押す数の上限の後に並んでいても `PRESS_LIMIT_REACHED` に
    // しない）。押す順は、見える対象だけで決める。DEF-145 の読み直しは、ここで除いた対象も、押下で見えるようになったかを見る。
    const { visible, invisible } = await splitByVisibility(page, found);
    markAll(invisible.map(({ index }) => index), 'TARGET_NOT_FOUND');
    const markers: string[] = [];
    const quietWaitMs = options.quietWaitMs ?? SUBMISSION_PROBE_QUIET_WAIT_MS;
    /** DEF-142: この画面で使った押す回数（押す前に見えない・読めない対象は数えない）。 */
    let presses = 0;
    /** 押す順の待ち行列（DEF-145: 押下で開いたダイアログの中の送信ボタンを、先頭に足す）。 */
    const queue: PressTarget[] = [...submissionProbePressOrderOf(visible)];
    /** DEF-145: 押下で新しく見えるようになったので、もう一度押しにかかった対象（1 対象 1 回まで）。 */
    const revisited = new Set<number>();
    for (let target = queue.shift(); target !== undefined; target = queue.shift()) {
      if (presses >= maxPresses) {
        probes.set(target.index, notObservedSubmissionProbeOf('PRESS_LIMIT_REACHED'));
        continue;
      }
      const before = pageStateOf(page, startUrl);
      if (before !== 'SAME') {
        // DEF-144: Guard が Context を閉じ始めたことは、画面が移ったことと分ける。
        probes.set(target.index, notObservedSubmissionProbeOf(before === 'CLOSED_BY_GUARD' ? 'CONTEXT_CLOSED_BY_GUARD' : 'PAGE_CHANGED'));
        continue;
      }
      if (!(await interactionFreezeHolds(page))) {
        if (guardClosedContext(page)) {
          probes.set(target.index, notObservedSubmissionProbeOf('CONTEXT_CLOSED_BY_GUARD'));
          continue;
        }
        // 今までどおり、押す回数の 1 つに数える（凍結の段でなければ、続く対象も押せない）。
        presses += 1;
        probes.set(target.index, notObservedSubmissionProbeOf('PRESS_FAILED'));
        continue;
      }
      const outcome = await pressOne(page, observation, location.path, target, markers, quietWaitMs, options.onPress);
      // DEF-144: 押す前に外部スキームを指すと見分けた対象は、押さずに `EXTERNAL_SCHEME`（押す回数を使わない）。
      if (outcome.kind === 'EXTERNAL_SCHEME') {
        probes.set(target.index, externalSchemeSubmissionProbeOf());
        continue;
      }
      // DEF-142: 押す前に見えない（か読めない）対象（`TARGET_NOT_FOUND`。観察の口を開く前に返る）は、押していないので、押す回数を使わずに次の対象へ進む。
      if (outcome.kind === 'OBSERVED' || outcome.reason !== 'TARGET_NOT_FOUND') {
        presses += 1;
      }
      const fields = outcome.kind === 'OBSERVED'
        ? { filledFieldCount: outcome.record.filledFieldCount, skippedFieldCount: outcome.record.skippedFieldCount }
        : outcome.fields;
      const inputFields = outcome.kind === 'OBSERVED' ? outcome.record.inputFields ?? [] : outcome.inputFields;
      const after = pageStateOf(page, startUrl);
      if (after !== 'SAME') {
        probes.set(target.index, notObservedSubmissionProbeOf(after === 'CLOSED_BY_GUARD' ? 'CONTEXT_CLOSED_BY_GUARD' : 'PAGE_CHANGED', fields, inputFields));
        continue;
      }
      probes.set(target.index, outcome.kind === 'OBSERVED' ? outcome.record : notObservedSubmissionProbeOf(outcome.reason, fields, inputFields));
      // DEF-145（設計書 `2026-10-21-beaksight-probe-navigation-and-dialog-design.md` 2.2）: 押下が何も送らず（`NO_REQUEST`）、回数が残っていれば、押す前は
      // 見えなかった（かなかった）登録・更新の語の送信ボタン（`TARGET_NOT_FOUND` の対象）が、押下で開いたダイアログなどで見えるようになったかを読み直し、
      // 見つかった対象を先に押す（結果は元の候補に記録する。押す前の見分けは、ほかの対象と同じく `pressOne` が行う）。
      if (outcome.kind === 'OBSERVED' && outcome.record.result === 'NO_REQUEST' && presses < maxPresses) {
        const revealed = await revealedPriorityTargetsOf(page, location, record, indices.filter((index) => !revisited.has(index)
          && probes.get(index)?.reason === 'TARGET_NOT_FOUND'
          && hasSubmissionProbePriorityWord(record.candidates[index]?.submitterWords ?? [])));
        for (const next of revealed) revisited.add(next.index);
        queue.unshift(...revealed);
      }
    }
  } catch {
    // 予期しない誤り（文は値を含みうるので捨てる）。まだ結果のない対象は、押したかが分からない。
    if (observation.active) {
      try {
        observation.end();
      } catch {
        // 閉じられなければ、口は次の画面の Context では使わない（Context ごとの口）。
      }
    }
    // DEF-144: Guard が Context を閉じ始めた後の誤りは、その理由で記録する。
    markAll(indices, guardClosedContext(page) ? 'CONTEXT_CLOSED_BY_GUARD' : 'PRESS_FAILED');
  }
  return withSubmissionProbes(record, probes);
}
