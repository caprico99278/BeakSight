// 書き換えの書き込みの手順の検証の指定を、台帳（作ったデータの一覧にした登録の書き込みの手順）から写す決まりの唯一の置き場所（PL-6b。設計書
// `2026-10-26-beaksight-plain-ui-design.md` 8.1 の「更新の検証」。MI-7 の一般化）。純粋な部品（管理データ・ファイル・画面に依らない。core と契約の値と型
// だけを使う）。API の形とフォームの形の両方で使う。
// - API の形: 台帳の照合の READ の `{id}` の型の定義（唯一の判定 `apiUpdateLedgerReadVerificationOf`）を写す。結び付けは 0 件（`{id}` に台帳の ID が入る）。
//   登録の ID の取り方は写さない（API の書き換えは求めない）。
// - フォームの形: 台帳の登録の ID の型と照合の READ（候補の定義。取り消していないもの）を写し、結び付けを変える欄に結び直す（変える欄でない欄に結んだ
//   結び付けは、最初の変える文字の欄へ）。照合の専用の印も写す。変える欄に文字の欄がなければ `CHANGED_FIELD_NOT_TEXT`（書き換えの後の照合はできる）。
// - 期待（両方）: 台帳の期待のうち、行の数の期待と、比べる欄が変える欄のもの。比べる欄の期待が残らなければ、最初の変える欄の「本文が含む」を足す
//   （書き換えで値が変わるのは変える欄だけなので、保つ欄とは比べない）。
// - 形の確かめと照合の READ の確かめは、今の保存の口（下書きの確かめ）と許可の発行。
// MI-C の設計者の判断のとおり、作成の画面のブラウザ側（`ScenarioApiFields.tsx` の `apiUpdateReadFillOf`）は、ここを import できない（`approval-view.ts` から
// 型だけ）。ブラウザ側の写しの扱いは、PL-6b の報告で設計者に諮った。
import { ROW_COUNT_EQUALS_EXPECTATION_KIND, TEXT_CONTAINS_EXPECTATION_KIND } from '../../core/read-check-expectation-kinds.js';
import { API_SCENARIO_TRANSPORT } from '../../core/scenario-transport.js';
import { apiUpdateLedgerReadVerificationOf, type ApiScenarioReadCheckFact } from './api-scenario-draft.js';
import type {
  ScenarioReadVerification,
  ScenarioTransport,
  ScenarioVerificationRecordId,
  VerificationExpectation,
} from './scenario-contracts.js';

/**
 * 台帳から写せない理由（閉じた一覧。画面の文言は `messages.ts` の `LOCAL_UI_AUTO_DRAFT_TEXT.updateCopyUnavailable`）。
 * - `LEDGER_READ_VERIFICATION_MISSING`: 台帳に照合の READ がない。
 * - `LEDGER_READ_CHECK_UNUSABLE`: 台帳の照合の READ の定義を使えない（取り消した、形が合わない）。
 * - `CHANGED_FIELD_NOT_TEXT`: フォームの形で、変える欄に文字の欄がない（作った値で探せない。書き換えの後の照合はできる）。
 */
export const UPDATE_VERIFICATION_COPY_UNAVAILABLE_REASONS = Object.freeze([
  'LEDGER_READ_VERIFICATION_MISSING',
  'LEDGER_READ_CHECK_UNUSABLE',
  'CHANGED_FIELD_NOT_TEXT',
] as const);
export type UpdateVerificationCopyUnavailableReason = (typeof UPDATE_VERIFICATION_COPY_UNAVAILABLE_REASONS)[number];

/** 写した結果。 */
export type UpdateVerificationCopy =
  | { readonly kind: 'NEEDS_CHANGED_FIELDS' }
  | { readonly kind: 'UNAVAILABLE'; readonly reason: UpdateVerificationCopyUnavailableReason }
  | { readonly kind: 'FILLED'; readonly recordId: ScenarioVerificationRecordId | null; readonly readVerification: ScenarioReadVerification };

/** 写す入力。 */
export interface UpdateVerificationCopyInput {
  readonly transport: ScenarioTransport;
  /** 台帳の今の版の検証の指定（台帳がなければ null）。 */
  readonly ledger: { readonly recordId: ScenarioVerificationRecordId | null; readonly readVerification: ScenarioReadVerification | null } | null;
  /** 取り消していない見るだけの確かめの定義（同じプロファイル）。 */
  readonly readChecks: readonly ApiScenarioReadCheckFact[];
  /** 変える欄（欄・鍵の順）。 */
  readonly changedFieldNames: readonly string[];
  /** フォームの形で、変える欄のうち文字の欄（欄の順）。API の形は見ない。 */
  readonly changedTextFieldNames?: readonly string[];
}

/** 台帳の期待のうち、行の数と変える欄の期待。比べる欄の期待が残らなければ、最初の変える欄の「本文が含む」を足す。 */
const copiedExpectationsOf = (expectations: readonly VerificationExpectation[], changed: readonly string[], first: string): readonly VerificationExpectation[] => {
  const kept = expectations.filter((expectation) => expectation.kind === ROW_COUNT_EQUALS_EXPECTATION_KIND || changed.includes(expectation.fieldName));
  const compared = kept.some((expectation) => expectation.kind !== ROW_COUNT_EQUALS_EXPECTATION_KIND);
  return compared ? kept.map((expectation) => ({ ...expectation })) : [...kept.map((expectation) => ({ ...expectation })), { kind: TEXT_CONTAINS_EXPECTATION_KIND, fieldName: first }];
};

/** 書き換えの検証の指定を、台帳から写す（両方の形の唯一の決まり）。 */
export const updateVerificationCopyOf = (input: UpdateVerificationCopyInput): UpdateVerificationCopy => {
  const [firstChanged] = input.changedFieldNames;
  if (firstChanged === undefined) {
    return { kind: 'NEEDS_CHANGED_FIELDS' };
  }
  const ledgerRead = input.ledger?.readVerification ?? null;
  if (input.transport === API_SCENARIO_TRANSPORT) {
    const seed = apiUpdateLedgerReadVerificationOf(ledgerRead, input.readChecks);
    return seed.status === 'UNAVAILABLE'
      ? { kind: 'UNAVAILABLE', reason: seed.reason }
      : {
        kind: 'FILLED',
        recordId: null,
        readVerification: {
          readCheckId: seed.readCheckId,
          revision: seed.revision,
          bindings: [],
          expectations: copiedExpectationsOf(seed.expectations, input.changedFieldNames, firstChanged),
        },
      };
  }
  if (ledgerRead === null) {
    return { kind: 'UNAVAILABLE', reason: 'LEDGER_READ_VERIFICATION_MISSING' };
  }
  const definition = input.readChecks.find(({ readCheckId }) => readCheckId === ledgerRead.readCheckId);
  if (definition === undefined || definition.targetPagePath !== null || ledgerRead.bindings.length === 0) {
    return { kind: 'UNAVAILABLE', reason: 'LEDGER_READ_CHECK_UNUSABLE' };
  }
  const [firstText] = input.changedTextFieldNames ?? [];
  if (firstText === undefined) {
    return { kind: 'UNAVAILABLE', reason: 'CHANGED_FIELD_NOT_TEXT' };
  }
  const textChanged = input.changedTextFieldNames ?? [];
  return {
    kind: 'FILLED',
    recordId: input.ledger?.recordId ?? null,
    readVerification: {
      readCheckId: definition.readCheckId,
      revision: definition.revision,
      // 結び付けは、変える文字の欄に結んだものはそのまま、ほかは最初の変える文字の欄へ（作った新しい値で探す）。
      bindings: ledgerRead.bindings.map(({ parameterName, fieldName }) => ({ parameterName, fieldName: textChanged.includes(fieldName) ? fieldName : firstText })),
      expectations: copiedExpectationsOf(ledgerRead.expectations, textChanged, firstText),
      ...(ledgerRead.verificationOnly === true ? { verificationOnly: true } : {}),
    },
  };
};
