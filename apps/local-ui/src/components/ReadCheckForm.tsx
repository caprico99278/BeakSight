/**
 * READ の確かめの定義のフォーム（Task 27 の設計書 4.5、4.7。T27f）。作成と変更の画面が共用する。
 * - 送る値の入力の欄は、対象の候補の値を送れる欄だけ（サーバが `isSendableReadCheckParameter` で選んで返したもの）。値を入れた欄だけを送る。
 *   秘密に見える名前の欄は、入力の欄に出すが、値を入れると保存のときにサーバが拒む（黙って落とさない。理由はその欄に出す）。
 * - 期待は、閉じた一覧（サーバが返した `expectationKinds`。表示の順はカタログ）から選ぶ。件数と長さの上限は、サーバが返した契約の値。
 * - 保存は、サーバの検証（`validateReadCheckDefinition`）と保存の部品が決める。拒まれたら、理由を項目ごとに日本語で出す（送る値の誤りはその欄に、
 *   ほかは上のお知らせに）。画面の確かめ（必須、数の範囲、長さ）は補助だけ。
 * - T37d（Task 37 の設計書 3.5）: 対象は「候補を読む」（送る値の欄）か「画面を読む」（画面の path の欄と、直近の発見の結果の画面から選ぶ一覧。一覧が
 *   なければ入力だけ。送る値はない）。path の誤りは、その欄にも出す。
 */
import { useState } from 'react';
import type { ReadCheckExpectation, ReadCheckExpectationKind } from '../../../../src/control/discovery-view.js';
// PRE42-CC 組 UI-K2（CC-113）: 期待の種類の値は、発見の部品に触れない純粋な core の owner から読む（書き写さない）。
import {
  ROW_COUNT_AT_LEAST_EXPECTATION_KIND,
  ROW_COUNT_EXPECTATION_KINDS,
  TEXT_CONTAINS_EXPECTATION_KIND,
} from '../../../../src/core/read-check-expectation-kinds.js';
import { READ_CHECK_EXPECTATION_KIND_CATALOG, sortByDisplayOrder } from '../../../../src/presentation/catalog.js';
import { formatCount, formatInteger } from '../../../../src/presentation/format.js';
import {
  LOCAL_UI_READ_CHECK_TEXT,
  LOCAL_UI_TEXT,
  READ_CHECK_DEFINITION_REJECTION_DESCRIPTIONS,
  listText,
} from '../../../../src/presentation/messages.js';
import { readCheckExpectationKindDisplay } from '../display/labels';
import type { ReadCheckCandidateView, ReadCheckFormView, ReadCheckSaveView } from '../server/read-check-functions';
import { FieldFrame } from './FieldFrame';
import { Notice } from './Notice';

const text = LOCAL_UI_READ_CHECK_TEXT;

/** 期待 1 件の入力の値（画面の文字のまま）。 */
interface ExpectationInput {
  readonly key: number;
  readonly kind: ReadCheckExpectationKind;
  readonly count: string;
  readonly text: string;
  readonly field: string;
  readonly value: string;
}

/** フォームの初めの値。 */
export interface ReadCheckFormInitial {
  readonly parameters: Readonly<Record<string, string>>;
  readonly expectations: readonly ReadCheckExpectation[];
}

/** 送る定義（サーバが確かめる）。T37d: 対象は、候補の識別の digest か画面の path のどちらか。 */
export type ReadCheckDefinitionInput =
  | {
    readonly targetIdentityDigest: string;
    readonly parameters: Readonly<Record<string, string>>;
    readonly expectations: readonly Readonly<Record<string, unknown>>[];
  }
  | {
    readonly targetPagePath: string;
    readonly parameters: Readonly<Record<string, never>>;
    readonly expectations: readonly Readonly<Record<string, unknown>>[];
  };

/**
 * フォームの対象（T37d。Task 37 の設計書 3.5）: 候補を読む（送る値の欄は候補の送れる欄）か、画面を読む（画面の path の欄と、直近の発見の結果の画面から
 * 選ぶ一覧。送る値はない）。
 */
export type ReadCheckFormTarget =
  | { readonly kind: 'CANDIDATE'; readonly candidate: ReadCheckCandidateView }
  | { readonly kind: 'PAGE'; readonly pagePaths: readonly string[]; readonly initialPath: string };

/** 画面の path の欄に出す、保存を拒む理由（T37d。それ以外の理由は上のお知らせだけに出す）。 */
const PAGE_PATH_REJECTIONS: ReadonlySet<ReadCheckSaveRejectionCode> = new Set<ReadCheckSaveRejectionCode>([
  'READ_PAGE_PATH_INVALID',
  'READ_PAGE_PATH_EXCLUDED',
  'READ_PAGE_PATH_DANGEROUS_WORD',
]);
type ReadCheckSaveRejectionCode = Extract<ReadCheckSaveView, { ok: false }>['reason'];

/** 数の欄の値（0 以上の整数の文字だけを数にする。ほかは文字のまま送り、サーバの形の確かめが拒む）。 */
const NON_NEGATIVE_INTEGER = /^[0-9]+$/u;
const countValueOf = (value: string): number | string => (NON_NEGATIVE_INTEGER.test(value) ? Number(value) : value);

/** 期待の種類のうち、行の数を照らすもの（PRE42-CC 組 UI-K2: 一覧は core の `ROW_COUNT_EXPECTATION_KINDS` を読む）。 */
const ROW_COUNT_KINDS: ReadonlySet<ReadCheckExpectationKind> = new Set<ReadCheckExpectationKind>(ROW_COUNT_EXPECTATION_KINDS);
const TEXT_CONTAINS_KIND = TEXT_CONTAINS_EXPECTATION_KIND;

/** 期待の入力の値を、送る形にする（種類ごとの項目だけ）。 */
const expectationOf = (input: ExpectationInput): Readonly<Record<string, unknown>> => {
  if (ROW_COUNT_KINDS.has(input.kind)) {
    return { kind: input.kind, count: countValueOf(input.count) };
  }
  if (input.kind === TEXT_CONTAINS_KIND) {
    return { kind: input.kind, text: input.text };
  }
  return { kind: input.kind, field: input.field, value: input.value };
};

/** 保存してある期待を、入力の値にする。 */
const inputOf = (expectation: ReadCheckExpectation, key: number): ExpectationInput => ({
  key,
  kind: expectation.kind,
  count: 'count' in expectation ? String(expectation.count) : '',
  text: 'text' in expectation ? expectation.text : '',
  field: 'field' in expectation ? expectation.field : '',
  value: 'value' in expectation ? expectation.value : '',
});

export function ReadCheckForm({ target, form, initial, onSave, onSaved, onReload }: Readonly<{
  target: ReadCheckFormTarget;
  form: ReadCheckFormView;
  initial: ReadCheckFormInitial | null;
  onSave: (definition: ReadCheckDefinitionInput) => Promise<ReadCheckSaveView>;
  onSaved: () => void;
  onReload: () => void;
}>) {
  const kinds = sortByDisplayOrder(form.expectationKinds, READ_CHECK_EXPECTATION_KIND_CATALOG);
  const [firstKind] = kinds;
  const blankExpectation = (key: number): ExpectationInput => ({ key, kind: firstKind ?? ROW_COUNT_AT_LEAST_EXPECTATION_KIND, count: '', text: '', field: '', value: '' });
  const [parameters, setParameters] = useState<Readonly<Record<string, string>>>(initial?.parameters ?? {});
  const [expectations, setExpectations] = useState<readonly ExpectationInput[]>(
    initial === null || initial.expectations.length === 0 ? [blankExpectation(0)] : initial.expectations.map(inputOf),
  );
  const [nextKey, setNextKey] = useState(expectations.length);
  const [saving, setSaving] = useState(false);
  const [rejection, setRejection] = useState<Extract<ReadCheckSaveView, { ok: false }> | null>(null);
  const [pagePath, setPagePath] = useState(target.kind === 'PAGE' ? target.initialPath : '');
  const candidate = target.kind === 'CANDIDATE' ? target.candidate : null;
  const pagePathErrors = rejection === null
    ? []
    : rejection.errors.filter((error) => PAGE_PATH_REJECTIONS.has(error.code)).map((error) => READ_CHECK_DEFINITION_REJECTION_DESCRIPTIONS[error.code].description);

  const parameterErrors = (name: string): readonly string[] =>
    rejection === null
      ? []
      : rejection.errors.filter((error) => error.parameter === name).map((error) => READ_CHECK_DEFINITION_REJECTION_DESCRIPTIONS[error.code].description);
  const generalCodes = rejection === null ? [] : [...new Set(rejection.errors.filter((error) => error.parameter === null).map((error) => error.code))];
  const updateExpectation = (key: number, change: Partial<ExpectationInput>): void => {
    setExpectations((current) => current.map((expectation) => (expectation.key === key ? { ...expectation, ...change } : expectation)));
  };

  return (
    <form
      className="form-grid"
      data-testid="read-check-form"
      onSubmit={(event) => {
        event.preventDefault();
        setSaving(true);
        const sent = Object.fromEntries(
          (candidate?.fields ?? []).flatMap((field) => {
            const value = parameters[field.name] ?? '';
            return value === '' ? [] : [[field.name, value] as const];
          }),
        );
        const definition: ReadCheckDefinitionInput = candidate === null
          ? { targetPagePath: pagePath, parameters: {}, expectations: expectations.map(expectationOf) }
          : { targetIdentityDigest: candidate.identityDigest, parameters: sent, expectations: expectations.map(expectationOf) };
        void onSave(definition)
          .then((result) => {
            if (result.ok) {
              setRejection(null);
              onSaved();
            } else {
              setRejection(result);
            }
          })
          .finally(() => setSaving(false));
      }}
    >
      {rejection === null ? null : (
        <Notice kind="critical" heading={text.saveRejectedHeading}>
          <div data-testid="read-check-rejection" data-reason={rejection.reason}>
            {(generalCodes.length === 0 ? [rejection.reason] : generalCodes).map((code) => (
              <div key={code} data-code={code}>
                <p>{READ_CHECK_DEFINITION_REJECTION_DESCRIPTIONS[code].description}</p>
                <p>{READ_CHECK_DEFINITION_REJECTION_DESCRIPTIONS[code].action}</p>
              </div>
            ))}
          </div>
          <div className="button-row">
            <button type="button" className="button" onClick={onReload}>{LOCAL_UI_TEXT.reload}</button>
          </div>
        </Notice>
      )}

      {target.kind === 'PAGE' ? (
        <fieldset className="field-group" data-testid="read-check-page">
          <legend className="field-group-heading">{text.page.pagePath}</legend>
          <p className="field-hint">{text.page.note}</p>
          {target.pagePaths.length === 0 ? <p className="field-hint" data-testid="read-check-no-page-paths">{text.page.noPagePaths}</p> : (
            <FieldFrame label={text.page.choosePath} errors={[]}>
              {({ id, describedBy }) => (
                <select
                  id={id}
                  name="page-path-choice"
                  className="input"
                  data-testid="read-check-page-path-choice"
                  value={target.pagePaths.includes(pagePath) ? pagePath : ''}
                  aria-describedby={describedBy}
                  onChange={(event) => {
                    if (event.target.value !== '') {
                      setPagePath(event.target.value);
                    }
                  }}
                >
                  <option value="">{text.page.chooseNone}</option>
                  {target.pagePaths.map((path) => <option key={path} value={path}>{path}</option>)}
                </select>
              )}
            </FieldFrame>
          )}
          <FieldFrame label={text.page.pagePath} hint={text.page.pagePathHint} errors={pagePathErrors}>
            {({ id, describedBy, invalid }) => (
              <input
                id={id}
                name="page-path"
                className="input"
                type="text"
                required
                autoComplete="off"
                maxLength={form.maxPagePathLength}
                value={pagePath}
                aria-describedby={describedBy}
                aria-invalid={invalid}
                data-testid="read-check-page-path"
                onChange={(event) => setPagePath(event.target.value)}
              />
            )}
          </FieldFrame>
          {/* T38f: `{id}` つきの型の案内（API で送るシナリオの照合の READ に使える。印はサーバが返す契約の値）。 */}
          <p className="field-hint" data-testid="read-check-page-template-hint">{text.page.pageTemplateHint(form.pageTemplatePlaceholder)}</p>
        </fieldset>
      ) : null}

      {candidate === null ? null : (
      <fieldset className="field-group" data-testid="read-check-parameters">
        <legend className="field-group-heading">{text.parametersHeading}</legend>
        <p className="field-hint">{text.parametersNote}</p>
        <p className="field-hint">{text.valuesNote}</p>
        {candidate.fields.length === 0 ? <p>{text.noSendableFields}</p> : candidate.fields.map((field) => {
          const hints = [
            field.options === null ? null : text.optionsHint(listText(field.options.map((option) => JSON.stringify(option)))),
            field.secretLike ? text.secretLikeHint : null,
          ].filter((hint): hint is string => hint !== null);
          return (
            <FieldFrame key={field.name} label={field.name} {...(hints.length === 0 ? {} : { hint: hints.join(' ') })} errors={parameterErrors(field.name)}>
              {({ id, describedBy, invalid }) => (
                <input
                  id={id}
                  name={`parameter-${field.name}`}
                  className="input"
                  type="text"
                  autoComplete="off"
                  maxLength={form.maxParameterValueLength}
                  value={parameters[field.name] ?? ''}
                  aria-describedby={describedBy}
                  aria-invalid={invalid}
                  data-parameter={field.name}
                  onChange={(event) => setParameters({ ...parameters, [field.name]: event.target.value })}
                />
              )}
            </FieldFrame>
          );
        })}
      </fieldset>
      )}

      <fieldset className="field-group" data-testid="read-check-expectations">
        <legend className="field-group-heading">{text.expectationsHeading}</legend>
        <p className="field-hint">{text.expectationsNote(formatCount(form.maxExpectations))}</p>
        {expectations.map((expectation, index) => (
          <fieldset key={expectation.key} className="field-group" data-testid="read-check-expectation" data-index={String(index)}>
            <legend className="field-group-subheading">{text.expectationNumber(formatInteger(index + 1))}</legend>
            <FieldFrame
              label={text.expectationKind}
              {...(readCheckExpectationKindDisplay(expectation.kind).description === null ? {} : { hint: readCheckExpectationKindDisplay(expectation.kind).description ?? '' })}
              errors={[]}
            >
              {({ id, describedBy }) => (
                <select
                  id={id}
                  name={`expectation-${String(expectation.key)}-kind`}
                  className="input"
                  value={expectation.kind}
                  aria-describedby={describedBy}
                  onChange={(event) => {
                    const kind = kinds.find((value) => value === event.target.value);
                    if (kind !== undefined) {
                      updateExpectation(expectation.key, { kind });
                    }
                  }}
                >
                  {kinds.map((kind) => <option key={kind} value={kind}>{readCheckExpectationKindDisplay(kind).label}</option>)}
                </select>
              )}
            </FieldFrame>
            {ROW_COUNT_KINDS.has(expectation.kind) ? (
              <FieldFrame label={text.expectationCount} errors={[]}>
                {({ id, describedBy }) => (
                  <input
                    id={id}
                    name={`expectation-${String(expectation.key)}-count`}
                    className="input"
                    type="number"
                    required
                    min={0}
                    max={form.maxRowCount}
                    step={1}
                    value={expectation.count}
                    aria-describedby={describedBy}
                    onChange={(event) => updateExpectation(expectation.key, { count: event.target.value })}
                  />
                )}
              </FieldFrame>
            ) : expectation.kind === TEXT_CONTAINS_KIND ? (
              <FieldFrame label={text.expectationText} errors={[]}>
                {({ id, describedBy }) => (
                  <input
                    id={id}
                    name={`expectation-${String(expectation.key)}-text`}
                    className="input"
                    type="text"
                    required
                    autoComplete="off"
                    maxLength={form.maxExpectedTextLength}
                    value={expectation.text}
                    aria-describedby={describedBy}
                    onChange={(event) => updateExpectation(expectation.key, { text: event.target.value })}
                  />
                )}
              </FieldFrame>
            ) : (
              <>
                <FieldFrame label={text.expectationField} errors={[]}>
                  {({ id, describedBy }) => (
                    <input
                      id={id}
                      name={`expectation-${String(expectation.key)}-field`}
                      className="input"
                      type="text"
                      required
                      autoComplete="off"
                      maxLength={form.maxDetailFieldLength}
                      value={expectation.field}
                      aria-describedby={describedBy}
                      onChange={(event) => updateExpectation(expectation.key, { field: event.target.value })}
                    />
                  )}
                </FieldFrame>
                <FieldFrame label={text.expectationValue} errors={[]}>
                  {({ id, describedBy }) => (
                    <input
                      id={id}
                      name={`expectation-${String(expectation.key)}-value`}
                      className="input"
                      type="text"
                      required
                      autoComplete="off"
                      maxLength={form.maxExpectedTextLength}
                      value={expectation.value}
                      aria-describedby={describedBy}
                      onChange={(event) => updateExpectation(expectation.key, { value: event.target.value })}
                    />
                  )}
                </FieldFrame>
              </>
            )}
            {expectations.length > 1 ? (
              <div className="button-row">
                <button
                  type="button"
                  className="button"
                  onClick={() => setExpectations((current) => current.filter((value) => value.key !== expectation.key))}
                >
                  {text.removeExpectation}
                </button>
              </div>
            ) : null}
          </fieldset>
        ))}
        {expectations.length < form.maxExpectations ? (
          <div className="button-row">
            <button
              type="button"
              className="button"
              data-testid="read-check-add-expectation"
              onClick={() => {
                setExpectations((current) => [...current, blankExpectation(nextKey)]);
                setNextKey(nextKey + 1);
              }}
            >
              {text.addExpectation}
            </button>
          </div>
        ) : null}
      </fieldset>

      <div className="button-row">
        <button type="submit" className="button button--primary" disabled={saving} data-testid="read-check-save">
          {saving ? text.saving : text.save}
        </button>
      </div>
    </form>
  );
}
