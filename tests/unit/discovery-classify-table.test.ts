// T27R-fix-1（不具合台帳の「T27R の修正の設計」の 1〜3。DEF-086・DEF-088）: 発見の候補の分類の固定の表。
// - 送信ボタンの文言（probe が読んだ文字。ボタンの文字・`aria-label`・`title` をつないだもの）で決まる候補を多く含む表を、DEF-086 の修正
//   （候補が文言を持たず、分類の閉じた一覧の語だけを持つ）の前に書いて PASS させ、修正の後も同じ結果であることを確かめる。文言から候補を
//   組み立てるのは、テストの補助（`discovery-candidate-samples.ts` の `sampleForm`・`sampleButton`。修正の後は、本番と同じ関数で語に変える）。
// - DEF-088 の (a)（GET の form の欄の名前の危険な語）と 3（GET の form の `_method` の欄）で、意図して変わる行は、行に変える理由を書く。
// 例の値は、匿名の値（`127.0.0.1`、`example.invalid`）だけを使う。
import { describe, expect, it } from 'vitest';
import type { CandidateClassification, CandidateReasonCode, DiscoveredCandidate } from '../../src/discovery/candidate-contracts.js';
import { classifyCandidate } from '../../src/discovery/classify.js';
import {
  NO_JS_BINDING,
  SAMPLE_ALLOWED_ORIGINS,
  sampleAction,
  sampleButton,
  sampleField,
  sampleForm,
} from './discovery-candidate-samples.js';

type Row = readonly [name: string, candidate: DiscoveredCandidate, classification: CandidateClassification, reasonCode: CandidateReasonCode];

const post = (submitterText: string | null): DiscoveredCandidate => sampleForm({ submitterText });
const get = (submitterText: string | null): DiscoveredCandidate => sampleForm({ formMethod: 'GET', submitterText });
const button = (submitterText: string | null, jsBinding = NO_JS_BINDING): DiscoveredCandidate => sampleButton({ submitterText, jsBinding });

/** 送信ボタンの文言で決まる行（POST・GET・`dialog` の form と、form の外のボタン）。 */
const BUTTON_TEXT_ROWS: readonly Row[] = [
  // 2: 危険な語（英語と日本語、大文字小文字、全角、半角のカタカナ、区切りの違い、文の中の語）。
  ['POST Delete', post('Delete'), 'NOT_EXECUTABLE', 'DESTRUCTIVE'],
  ['POST DELETE', post('DELETE'), 'NOT_EXECUTABLE', 'DESTRUCTIVE'],
  ['POST remove item', post('remove item'), 'NOT_EXECUTABLE', 'DESTRUCTIVE'],
  ['POST Sign out', post('Sign out'), 'NOT_EXECUTABLE', 'DESTRUCTIVE'],
  ['POST sign_out', post('sign_out'), 'NOT_EXECUTABLE', 'DESTRUCTIVE'],
  ['POST Log-Out', post('Log-Out'), 'NOT_EXECUTABLE', 'DESTRUCTIVE'],
  ['POST Cancel order', post('Cancel order'), 'NOT_EXECUTABLE', 'DESTRUCTIVE'],
  ['POST Reset password', post('Reset password'), 'NOT_EXECUTABLE', 'DESTRUCTIVE'],
  ['POST full-width delete', post('ＤＥＬＥＴＥ'), 'NOT_EXECUTABLE', 'DESTRUCTIVE'],
  ['POST 削除', post('削除'), 'NOT_EXECUTABLE', 'DESTRUCTIVE'],
  ['POST 削 除 (spaced)', post('削 除'), 'NOT_EXECUTABLE', 'DESTRUCTIVE'],
  ['POST 予約を取り消す', post('予約を取り消す'), 'NOT_EXECUTABLE', 'DESTRUCTIVE'],
  ['POST 一括更新', post('一括更新'), 'NOT_EXECUTABLE', 'DESTRUCTIVE'],
  ['POST 半角のアーカイブ', post('ｱｰｶｲﾌﾞ'), 'NOT_EXECUTABLE', 'DESTRUCTIVE'],
  ['POST ログアウト', post('ログアウト'), 'NOT_EXECUTABLE', 'DESTRUCTIVE'],
  ['POST row label with delete', post('山田 太郎 を削除'), 'NOT_EXECUTABLE', 'DESTRUCTIVE'],
  ['POST aria-label joined with the text', post('× Delete row 3'), 'NOT_EXECUTABLE', 'DESTRUCTIVE'],
  ['POST save and delete', post('Save & Delete'), 'NOT_EXECUTABLE', 'DESTRUCTIVE'],
  ['GET 削除する', get('削除する'), 'NOT_EXECUTABLE', 'DESTRUCTIVE'],
  ['GET Unsubscribe', get('Unsubscribe'), 'NOT_EXECUTABLE', 'DESTRUCTIVE'],
  ['DIALOG 削除 (the destructive word is before the dialog step)', sampleForm({ formMethod: 'DIALOG', submitterText: '削除' }), 'NOT_EXECUTABLE', 'DESTRUCTIVE'],
  ['BUTTON 削除 with a click listener', button('削除', { ...NO_JS_BINDING, submitter: ['click'] }), 'NOT_EXECUTABLE', 'DESTRUCTIVE'],
  ['BUTTON Delete without a listener', button('Delete'), 'NOT_EXECUTABLE', 'DESTRUCTIVE'],
  ['BUTTON row label with 取消', button('注文 A-1 を取消'), 'NOT_EXECUTABLE', 'DESTRUCTIVE'],
  // 3: GET は語にかかわらず READ。
  ['GET 検索', get('検索'), 'READ', 'READ_GET_FORM'],
  ['GET 新規', get('新規'), 'READ', 'READ_GET_FORM'],
  ['GET 保存', get('保存'), 'READ', 'READ_GET_FORM'],
  ['GET Search', get('Search'), 'READ', 'READ_GET_FORM'],
  ['GET without a button', get(null), 'READ', 'READ_GET_FORM'],
  ['GET row label', get('山田 太郎 の詳細'), 'READ', 'READ_GET_FORM'],
  // 4: POST の検索の語（語の境界、camelCase、複数形の `s`、日本語の部分一致）。
  ['POST Search', post('Search'), 'UNSUPPORTED_READ_TRANSPORT', 'POST_SEARCH'],
  ['POST 検索する', post('検索する'), 'UNSUPPORTED_READ_TRANSPORT', 'POST_SEARCH'],
  ['POST 絞り込み', post('絞り込み'), 'UNSUPPORTED_READ_TRANSPORT', 'POST_SEARCH'],
  ['POST filterBy (camelCase)', post('filterBy'), 'UNSUPPORTED_READ_TRANSPORT', 'POST_SEARCH'],
  ['POST Filters (plural)', post('Filters'), 'UNSUPPORTED_READ_TRANSPORT', 'POST_SEARCH'],
  ['POST full-width SEARCH', post('ＳＥＡＲＣＨ'), 'UNSUPPORTED_READ_TRANSPORT', 'POST_SEARCH'],
  ['POST 検索して保存 (the search step is before the update step)', post('検索して保存'), 'UNSUPPORTED_READ_TRANSPORT', 'POST_SEARCH'],
  ['POST Research (not search)', post('Research'), 'DISPLAY_ONLY', 'UNCLASSIFIED'],
  ['POST Searches (not search + s)', post('Searches'), 'DISPLAY_ONLY', 'UNCLASSIFIED'],
  // 5: 結び付きと form の外のボタン。
  ['POST 保存 with a submitter listener', sampleForm({ submitterText: '保存', jsBinding: { ...NO_JS_BINDING, submitter: ['click'] } }), 'NEEDS_BINDING', 'JS_BOUND'],
  ['POST 登録 with a delegated listener', sampleForm({ submitterText: '登録', jsBinding: { ...NO_JS_BINDING, document: ['click'] } }), 'NEEDS_BINDING', 'JS_DELEGATED'],
  ['BUTTON 保存 without a listener', button('保存'), 'DISPLAY_ONLY', 'NO_KNOWN_ACTION'],
  ['BUTTON row label with 編集', button('山田 太郎 を編集'), 'DISPLAY_ONLY', 'NO_KNOWN_ACTION'],
  ['BUTTON 追加 with a delegated listener', button('追加', { ...NO_JS_BINDING, document: ['click'] }), 'NEEDS_BINDING', 'JS_DELEGATED'],
  ['DIALOG 保存', sampleForm({ formMethod: 'DIALOG', submitterText: '保存' }), 'DISPLAY_ONLY', 'DIALOG_METHOD'],
  // 6・7: 更新と登録の語（書き込みの method の form だけ。英語は語の境界）。
  ['POST Update', post('Update'), 'UPDATE', 'UPDATE_WORD'],
  ['POST Save changes', post('Save changes'), 'UPDATE', 'UPDATE_WORD'],
  ['POST Edits (plural)', post('Edits'), 'UPDATE', 'UPDATE_WORD'],
  ['POST 下書き保存', post('下書き保存'), 'UPDATE', 'UPDATE_WORD'],
  ['POST 編集する', post('編集する'), 'UPDATE', 'UPDATE_WORD'],
  ['POST row label with 編集', post('山田 太郎 を編集'), 'UPDATE', 'UPDATE_WORD'],
  ['POST 新規保存 (update before create)', post('新規保存'), 'UPDATE', 'UPDATE_WORD'],
  ['POST Create', post('Create'), 'CREATE', 'CREATE_WORD'],
  ['POST Add item', post('Add item'), 'CREATE', 'CREATE_WORD'],
  ['POST AddItem (camelCase)', post('AddItem'), 'CREATE', 'CREATE_WORD'],
  ['POST REGISTER', post('REGISTER'), 'CREATE', 'CREATE_WORD'],
  ['POST 新規登録', post('新規登録'), 'CREATE', 'CREATE_WORD'],
  ['POST 追加', post('追加'), 'CREATE', 'CREATE_WORD'],
  ['PUT 登録 (the method decides)', sampleForm({ methodOverride: 'PUT', submitterText: '登録' }), 'UPDATE', 'UPDATE_METHOD'],
  // 8: 語のない文言。
  ['POST Address (not add)', post('Address'), 'DISPLAY_ONLY', 'UNCLASSIFIED'],
  ['POST Newsletter (not new)', post('Newsletter'), 'DISPLAY_ONLY', 'UNCLASSIFIED'],
  ['POST Credit (not edit)', post('Credit'), 'DISPLAY_ONLY', 'UNCLASSIFIED'],
  ['POST Unsaved (not save)', post('Unsaved'), 'DISPLAY_ONLY', 'UNCLASSIFIED'],
  ['POST 確定', post('確定'), 'DISPLAY_ONLY', 'UNCLASSIFIED'],
  ['POST 送信', post('送信'), 'DISPLAY_ONLY', 'UNCLASSIFIED'],
  ['POST GraphQL in the button text (only the path is the endpoint)', post('GraphQL'), 'DISPLAY_ONLY', 'UNCLASSIFIED'],
  ['POST without a button', post(null), 'DISPLAY_ONLY', 'UNCLASSIFIED'],
  ['POST empty text', post(''), 'DISPLAY_ONLY', 'UNCLASSIFIED'],
  ['POST row label without a word', post('山田 太郎'), 'DISPLAY_ONLY', 'UNCLASSIFIED'],
];

/** 文言と送信先の path・query の名前の組み合わせ（文言は語なしでも、送信先で決まる）。 */
const ACTION_ROWS: readonly Row[] = [
  ['POST OK to /items/1/edit', sampleForm({ action: sampleAction('/items/1/edit'), submitterText: 'OK' }), 'UPDATE', 'UPDATE_WORD'],
  ['POST 送信 to /items/new', sampleForm({ action: sampleAction('/items/new'), submitterText: '送信' }), 'CREATE', 'CREATE_WORD'],
  ['POST 送信 to /items/search', sampleForm({ action: sampleAction('/items/search'), submitterText: '送信' }), 'UNSUPPORTED_READ_TRANSPORT', 'POST_SEARCH'],
  ['POST 送信 to /api/graphql', sampleForm({ action: sampleAction('/api/graphql'), submitterText: '送信' }), 'UNSUPPORTED_READ_TRANSPORT', 'GRAPHQL_ENDPOINT'],
  ['POST 送信 with a query name remove', sampleForm({ action: sampleAction('/items', ['remove']), submitterText: '送信' }), 'NOT_EXECUTABLE', 'DESTRUCTIVE'],
  ['POST 保存 to a percent-encoded 削除', sampleForm({ action: sampleAction('/items/%E5%89%8A%E9%99%A4'), submitterText: '保存' }), 'NOT_EXECUTABLE', 'DESTRUCTIVE'],
  ['GET 検索 to /search with a query name delete', sampleForm({ formMethod: 'GET', action: sampleAction('/search', ['delete']), submitterText: '検索' }), 'NOT_EXECUTABLE', 'DESTRUCTIVE'],
];

/** 欄の名前と `_method` の欄（DEF-088 の (a) と 3 で意図して変わる行を含む）。 */
const FIELD_ROWS: readonly Row[] = [
  // POST の form の欄の名前は、危険な語の対象ではない（DEF-088 の (a) は GET の form だけ。状態の欄の印の対象）。
  ['POST 送信 with a field delete_flag', sampleForm({ fields: [sampleField('delete_flag', 'checkbox', { options: ['1'] })], submitterText: '送信' }), 'DISPLAY_ONLY', 'UNCLASSIFIED'],
  ['POST 送信 with a field named 削除', sampleForm({ fields: [sampleField('削除')], submitterText: '送信' }), 'DISPLAY_ONLY', 'UNCLASSIFIED'],
  // POST の form の見える `_method` の欄は、method の上書きではない（DEF-088 の 3 は GET の form だけ）。
  ['POST 登録 with a visible _method field', sampleForm({ fields: [sampleField('_method')], submitterText: '登録' }), 'CREATE', 'CREATE_WORD'],
  ['POST 更新 with a hidden _method of an unknown value', sampleForm({ fields: [sampleField('_method', 'hidden', { hasValue: true })], submitterText: '更新' }), 'DISPLAY_ONLY', 'METHOD_OVERRIDE_UNRECOGNIZED'],
  // GET の form の、危険な語でない欄の名前は、今までどおり READ。
  ['GET 検索 with the fields q and state', sampleForm({ formMethod: 'GET', fields: [sampleField('q', 'search'), sampleField('state')], submitterText: '検索' }), 'READ', 'READ_GET_FORM'],
  ['GET 検索 with a field address', sampleForm({ formMethod: 'GET', fields: [sampleField('address')], submitterText: '検索' }), 'READ', 'READ_GET_FORM'],
  // DEF-088 の (a)（意図して変えた行）: GET の form の欄の名前も、危険な語の判定の対象（`name="削除"` の GET の form は、送ると削除になり
  // うるので READ にしない。理由のコードは今の閉じた一覧の `DESTRUCTIVE`。理由のコードを足すと管理データの表の CHECK が変わるため）。
  // 修正の前は `READ`・`READ_GET_FORM` だった。
  ['GET 検索 with a field named 削除', sampleForm({ formMethod: 'GET', fields: [sampleField('削除')], submitterText: '検索' }), 'NOT_EXECUTABLE', 'DESTRUCTIVE'],
  ['GET 表示 with a field delete_flag', sampleForm({ formMethod: 'GET', fields: [sampleField('delete_flag', 'checkbox', { options: ['1'] })], submitterText: '表示' }), 'NOT_EXECUTABLE', 'DESTRUCTIVE'],
  ['GET without a button with a field cancel_reason', sampleForm({ formMethod: 'GET', fields: [sampleField('cancel_reason')], submitterText: null }), 'NOT_EXECUTABLE', 'DESTRUCTIVE'],
  // T27R-fix-2（設計書 11 章の 2026-10-12 の行の (4)）: 欄の名前の英語の語は、語の単位で比べる（`_`・`-`・`.`・`[`・`]`・空白・数字との境・
  // 大文字の切れ目で分けた語と一致するときだけ）。絞り込みの欄（`include_disabled` など）は当たらない。日本語の語は部分一致のまま。
  ['GET 検索 with a field include_disabled (disabled is not disable)', sampleForm({ formMethod: 'GET', fields: [sampleField('include_disabled', 'checkbox', { options: ['1'] })], submitterText: '検索' }), 'READ', 'READ_GET_FORM'],
  ['GET 検索 with a field show_archived', sampleForm({ formMethod: 'GET', fields: [sampleField('show_archived', 'checkbox', { options: ['1'] })], submitterText: '検索' }), 'READ', 'READ_GET_FORM'],
  ['GET 検索 with a field status_cancelled', sampleForm({ formMethod: 'GET', fields: [sampleField('status_cancelled', 'checkbox', { options: ['1'] })], submitterText: '検索' }), 'READ', 'READ_GET_FORM'],
  // `bulk_size` は、語の単位で分けても `bulk` が危険な語 `bulk` と一致するので当たる（指示書の例では「当たらない」だったが、語の単位の比べの
  // 規則どおりでは当たる。T27R-fix-2 の報告の発見事項 1）。
  ['GET 検索 with a field bulk_size (the word bulk is a dangerous word)', sampleForm({ formMethod: 'GET', fields: [sampleField('bulk_size', 'number')], submitterText: '検索' }), 'NOT_EXECUTABLE', 'DESTRUCTIVE'],
  ['GET 検索 with a field filter[deleted]', sampleForm({ formMethod: 'GET', fields: [sampleField('filter[deleted]')], submitterText: '検索' }), 'READ', 'READ_GET_FORM'],
  ['GET 検索 with a field deleteFlag (camelCase)', sampleForm({ formMethod: 'GET', fields: [sampleField('deleteFlag', 'checkbox', { options: ['1'] })], submitterText: '検索' }), 'NOT_EXECUTABLE', 'DESTRUCTIVE'],
  ['GET 検索 with a field item.delete', sampleForm({ formMethod: 'GET', fields: [sampleField('item.delete')], submitterText: '検索' }), 'NOT_EXECUTABLE', 'DESTRUCTIVE'],
  ['GET 検索 with a field user[remove]', sampleForm({ formMethod: 'GET', fields: [sampleField('user[remove]')], submitterText: '検索' }), 'NOT_EXECUTABLE', 'DESTRUCTIVE'],
  ['GET 検索 with a field delete2 (a digit boundary)', sampleForm({ formMethod: 'GET', fields: [sampleField('delete2')], submitterText: '検索' }), 'NOT_EXECUTABLE', 'DESTRUCTIVE'],
  ['GET 検索 with a field DELETE (folded)', sampleForm({ formMethod: 'GET', fields: [sampleField('ＤＥＬＥＴＥ')], submitterText: '検索' }), 'NOT_EXECUTABLE', 'DESTRUCTIVE'],
  ['GET 検索 with a field sign-out (a word of two parts)', sampleForm({ formMethod: 'GET', fields: [sampleField('sign-out')], submitterText: '検索' }), 'NOT_EXECUTABLE', 'DESTRUCTIVE'],
  ['GET 検索 with a field 削除フラグ (Japanese, a partial match)', sampleForm({ formMethod: 'GET', fields: [sampleField('削除フラグ', 'checkbox', { options: ['1'] })], submitterText: '検索' }), 'NOT_EXECUTABLE', 'DESTRUCTIVE'],
  // DEF-088 の 3（意図して変えた行）: GET の form に `_method` の欄（型を問わない。畳み込みで比べる）があれば、送るとサーバが method の上書き
  // として扱いうる（`_method=PUT` を送れる）ので、実行できないもの（`DESTRUCTIVE`）にする。修正の前は `READ`・`READ_GET_FORM` だった（見える
  // 欄も、hidden で値が閉じた一覧の外のものも、`PUT` も）。
  ['GET 検索 with a visible _method field', sampleForm({ formMethod: 'GET', fields: [sampleField('q'), sampleField('_method')], submitterText: '検索' }), 'NOT_EXECUTABLE', 'DESTRUCTIVE'],
  ['GET 検索 with a visible _METHOD select', sampleForm({ formMethod: 'GET', fields: [sampleField('_METHOD', 'select-one', { options: ['PUT'] })], submitterText: '検索' }), 'NOT_EXECUTABLE', 'DESTRUCTIVE'],
  ['GET 検索 with a hidden _method of an unknown value', sampleForm({ formMethod: 'GET', fields: [sampleField('_method', 'hidden', { hasValue: true })], submitterText: '検索' }), 'NOT_EXECUTABLE', 'DESTRUCTIVE'],
  ['GET 検索 with a hidden _method=PUT', sampleForm({ formMethod: 'GET', methodOverride: 'PUT', fields: [sampleField('_method', 'hidden', { hasValue: true })], submitterText: '検索' }), 'NOT_EXECUTABLE', 'DESTRUCTIVE'],
  // GET の `_method=DELETE` は、修正の前から実行できない（2 段の DELETE）。
  ['GET 検索 with a hidden _method=DELETE', sampleForm({ formMethod: 'GET', methodOverride: 'DELETE', fields: [sampleField('_method', 'hidden', { hasValue: true })], submitterText: '検索' }), 'NOT_EXECUTABLE', 'DESTRUCTIVE'],
];

const classifiedOf = (candidate: DiscoveredCandidate): readonly [CandidateClassification, CandidateReasonCode] => {
  const result = classifyCandidate(candidate, { allowedOrigins: SAMPLE_ALLOWED_ORIGINS });
  return [result.classification, result.reasonCode];
};

describe('T27R-fix-1: the fixed classification table (the same before and after DEF-086, except the rows changed on purpose by DEF-088)', () => {
  it.each([...BUTTON_TEXT_ROWS, ...ACTION_ROWS, ...FIELD_ROWS].map(([name, candidate, classification, reasonCode]) =>
    [name, candidate, classification, reasonCode] as const))('%s', (_name, candidate, classification, reasonCode) => {
    expect(classifiedOf(candidate)).toEqual([classification, reasonCode]);
  });

  it('has many rows decided by the button text', () => {
    expect(BUTTON_TEXT_ROWS.length).toBeGreaterThanOrEqual(60);
  });
});
