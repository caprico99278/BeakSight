// T27a（Task 27 の設計書 4.3）: 発見の候補の分類（表で駆動する純粋な関数）の検査。
// - T27 調査の fixture の候補の形（一覧・詳細・検索・登録・更新・削除・JS・SPA・委譲の画面の 17 件）が、表のとおりに分かれる。
// - 規則の各段の境界: 別 Origin、DELETE と `_method`、危険な語（日本語と英語、大文字小文字、全角、半角のカタカナ、区切りの違い、
//   percent-encode した path、query の名前）、`formmethod`、password の欄の GET、multipart の GET、POST の検索、`/graphql`、JS の結び付きと
//   委譲、form の外のボタン、`dialog`、更新と登録の語（語の境界）、状態の欄の印。
// - 理由のコードと分類の対応、規則の表が理由のコードのすべてを使うこと、発見の分類の危険な語が Task 25 の既定の危険な語を含むこと。
// 例の値は、匿名の値（`127.0.0.1`、`example.invalid`）だけを使う。
import { describe, expect, it } from 'vitest';
import { DEFAULT_EXCLUDED_URL_WORDS } from '../../src/control/auth/auth-setup-contracts.js';
import {
  CANDIDATE_CLASSIFICATIONS,
  CANDIDATE_REASON_CLASSIFICATIONS,
  CANDIDATE_REASON_CODES,
  type CandidateClassification,
  type CandidateReasonCode,
  type DiscoveredCandidate,
} from '../../src/discovery/candidate-contracts.js';
import { compareCodeUnits } from '../../src/core/text.js';
import {
  DISCOVERY_CREATE_WORDS,
  DISCOVERY_DESTRUCTIVE_WORDS,
  DISCOVERY_SEARCH_WORDS,
  DISCOVERY_STATE_FIELD_WORDS,
  DISCOVERY_SUBMITTER_WORDS,
  DISCOVERY_UPDATE_WORDS,
} from '../../src/discovery/classification-words.js';
import { CANDIDATE_CLASSIFICATION_RULES, classifyCandidate, fieldNameWordsOf, submitterWordsOf } from '../../src/discovery/classify.js';
import { DUPLICATE_IDENTITY_CONFLICT_REASON } from '../../src/discovery/discovery-result.js';
import {
  NO_JS_BINDING,
  OTHER_ORIGIN,
  SAMPLE_ALLOWED_ORIGINS,
  SAMPLE_ORIGIN,
  sampleAction,
  sampleButton,
  sampleField,
  sampleForm,
} from './discovery-candidate-samples.js';

const policy = { allowedOrigins: SAMPLE_ALLOWED_ORIGINS };

const classify = (candidate: DiscoveredCandidate) => classifyCandidate(candidate, policy);

const expectClassified = (
  candidate: DiscoveredCandidate,
  classification: CandidateClassification,
  reasonCode: CandidateReasonCode,
): void => {
  const result = classify(candidate);
  expect({ classification: result.classification, reasonCode: result.reasonCode }).toEqual({ classification, reasonCode });
};

const csrf = sampleField('csrf_token', 'hidden', { hasValue: true });

describe('T27a: the candidate shapes of the T27 investigation fixture', () => {
  // T27 調査の fixture（scratchpad の `t27/server.mjs`）の、画面 A の候補 17 件の形。listener の種類は、調査の CDP の結果のとおり。
  const shapes: readonly (readonly [string, DiscoveredCandidate, CandidateClassification, CandidateReasonCode, boolean])[] = [
    ['detail: POST delete form', sampleForm({
      page: { origin: SAMPLE_ORIGIN, path: '/items/1' }, action: sampleAction('/items/1/delete'), fields: [csrf], submitterText: '削除',
    }), 'NOT_EXECUTABLE', 'DESTRUCTIVE', false],
    ['search: GET search form', sampleForm({
      page: { origin: SAMPLE_ORIGIN, path: '/search' }, formMethod: 'GET', action: sampleAction('/search/results'),
      fields: [
        sampleField('q', 'search', { required: true }),
        sampleField('category', 'select-one', { options: ['', 'fruit', 'veg'], hasValue: true }),
        sampleField('max_price', 'number'),
        sampleField('in_stock', 'checkbox', { options: ['1'], hasValue: true }),
        csrf,
        sampleField('disabled_field', 'text', { disabled: true, hasValue: true }),
        sampleField('readonly_field', 'text', { readonly: true, hasValue: true }),
        sampleField('in_disabled_fieldset', 'text', { disabled: true, hasValue: true }),
        sampleField('state', 'text', { hasValue: true }),
      ],
      submitterText: '検索',
      // T27R-fix-1（DEF-088 の (a)）で GET の form の欄の名前も危険な語の比べの対象になったが、英語の語は語の単位で比べる（T27R-fix-2）ので、
      // 欄 `disabled_field`（`disabled`・`field`）は危険な語 `disable` に当たらず、READ のまま。
    }), 'READ', 'READ_GET_FORM', true],
    ['search: POST search form', sampleForm({
      page: { origin: SAMPLE_ORIGIN, path: '/search' }, action: sampleAction('/search/post'), fields: [sampleField('q')], submitterText: '検索',
    }), 'UNSUPPORTED_READ_TRANSPORT', 'POST_SEARCH', false],
    ['new: POST create form', sampleForm({
      page: { origin: SAMPLE_ORIGIN, path: '/items/new' }, action: sampleAction('/items'),
      fields: [csrf, sampleField('name', 'text', { required: true }), sampleField('email', 'email'), sampleField('pw', 'password')],
      submitterText: '登録',
    }), 'CREATE', 'CREATE_WORD', false],
    ['new: draft save button (formaction)', sampleForm({
      page: { origin: SAMPLE_ORIGIN, path: '/items/new' }, action: sampleAction('/items/draft'), fields: [csrf, sampleField('name')],
      submitterText: '下書き保存',
    }), 'UPDATE', 'UPDATE_WORD', false],
    ['edit: PATCH update form (_method)', sampleForm({
      page: { origin: SAMPLE_ORIGIN, path: '/items/1/edit' }, methodOverride: 'PATCH', action: sampleAction('/items/1'),
      fields: [sampleField('_method', 'hidden', { hasValue: true }), csrf, sampleField('name', 'text', { hasValue: true }),
        sampleField('active', 'select-one', { options: ['true', 'false'], hasValue: true })],
      submitterText: '更新',
    }), 'UPDATE', 'UPDATE_METHOD', true],
    ['edit: cancel the reservation', sampleForm({
      page: { origin: SAMPLE_ORIGIN, path: '/items/1/edit' }, action: sampleAction('/items/1/cancel'), submitterText: '予約を取り消す',
    }), 'NOT_EXECUTABLE', 'DESTRUCTIVE', false],
    ['edit: bulk update', sampleForm({
      page: { origin: SAMPLE_ORIGIN, path: '/items/1/edit' }, action: sampleAction('/items/bulk-update'), submitterText: '一括更新',
    }), 'NOT_EXECUTABLE', 'DESTRUCTIVE', false],
    ['edit: GET delete form', sampleForm({
      page: { origin: SAMPLE_ORIGIN, path: '/items/1/edit' }, formMethod: 'GET', action: sampleAction('/items/1/delete'), submitterText: '削除する',
    }), 'NOT_EXECUTABLE', 'DESTRUCTIVE', false],
    ['edit: archive', sampleForm({
      page: { origin: SAMPLE_ORIGIN, path: '/items/1/edit' }, action: sampleAction('/items/1/archive'), submitterText: 'アーカイブ',
    }), 'NOT_EXECUTABLE', 'DESTRUCTIVE', false],
    ['js: form with an inline submit handler', sampleForm({
      page: { origin: SAMPLE_ORIGIN, path: '/js' }, formMethod: 'GET', action: sampleAction('/js'), fields: [sampleField('title')],
      jsBinding: { ...NO_JS_BINDING, inlineHandler: true },
    }), 'NEEDS_BINDING', 'JS_BOUND', false],
    ['js: DOM-clobbered form', sampleForm({
      page: { origin: SAMPLE_ORIGIN, path: '/js' }, action: sampleAction('/real-action'),
      fields: [sampleField('action', 'text', { hasValue: true }), sampleField('method', 'text', { hasValue: true })], submitterText: '確定',
    }), 'DISPLAY_ONLY', 'UNCLASSIFIED', false],
    ['js: button with a click listener', sampleButton({
      page: { origin: SAMPLE_ORIGIN, path: '/js' }, submitterText: '保存', jsBinding: { ...NO_JS_BINDING, submitter: ['click'] },
    }), 'NEEDS_BINDING', 'JS_BOUND', false],
    ['js: role=button with a click listener', sampleButton({
      page: { origin: SAMPLE_ORIGIN, path: '/js' }, submitterText: '申し込む', jsBinding: { ...NO_JS_BINDING, submitter: ['click'] },
    }), 'NEEDS_BINDING', 'JS_BOUND', false],
    ['spa: form rendered later with a submit listener', sampleForm({
      page: { origin: SAMPLE_ORIGIN, path: '/spa' }, formMethod: 'GET', action: sampleAction('/spa'),
      fields: [sampleField('guest', 'text', { required: true }), sampleField('day', 'date')], submitterText: '予約する',
      jsBinding: { ...NO_JS_BINDING, form: ['submit'] },
    }), 'NEEDS_BINDING', 'JS_BOUND', false],
    ['delegated: add button (document click listener)', sampleButton({
      page: { origin: SAMPLE_ORIGIN, path: '/delegated' }, submitterText: '追加', jsBinding: { ...NO_JS_BINDING, document: ['click'] },
    }), 'NEEDS_BINDING', 'JS_DELEGATED', false],
    ['delegated: show button (document click listener)', sampleButton({
      page: { origin: SAMPLE_ORIGIN, path: '/delegated' }, submitterText: '表示', jsBinding: { ...NO_JS_BINDING, document: ['click'] },
    }), 'NEEDS_BINDING', 'JS_DELEGATED', false],
  ];

  it.each(shapes.map(([name, candidate, classification, reasonCode, hasStateField]) =>
    [name, candidate, classification, reasonCode, hasStateField] as const))(
    '%s',
    (_name, candidate, classification, reasonCode, hasStateField) => {
      expect(classify(candidate)).toEqual({ classification, reasonCode, hasStateField });
    },
  );
});

describe('T27a: the boundaries of each step of the classification table', () => {
  it('1: an action outside the allowed origins is BLOCKED_EXTERNAL, before the destructive words', () => {
    expectClassified(sampleForm({ action: sampleAction('/items/1/delete', [], OTHER_ORIGIN), submitterText: '削除' }),
      'BLOCKED_EXTERNAL', 'ACTION_OUTSIDE_ALLOWED_ORIGINS');
    expectClassified(sampleForm({ formMethod: 'GET', action: sampleAction('/search', [], OTHER_ORIGIN), submitterText: '検索' }),
      'BLOCKED_EXTERNAL', 'ACTION_OUTSIDE_ALLOWED_ORIGINS');
    // `javascript:` の action などの Origin（`null`）と、解析できない Origin は、許可 Origin の外として扱う（fail-closed）。
    for (const origin of ['null', 'not a url', '', 'https://user:pass@127.0.0.1:4173']) {
      expectClassified(sampleForm({ action: sampleAction('/x', [], origin) }), 'BLOCKED_EXTERNAL', 'ACTION_OUTSIDE_ALLOWED_ORIGINS');
    }
    // 許可 Origin の正規化（大文字のホスト名、既定のポート）は、URL の受け入れの owner（`classifyUrl`）に任せる。
    expectClassified(
      sampleForm({ formMethod: 'GET', action: sampleAction('/search', [], 'http://127.0.0.1:4173') }),
      'READ', 'READ_GET_FORM',
    );
    expect(classifyCandidate(
      sampleForm({ formMethod: 'GET', action: sampleAction('/search', [], 'https://app.example.invalid') }),
      { allowedOrigins: new Set(['https://APP.example.invalid:443']) },
    ).classification).toBe('READ');
  });

  it('2: DELETE (also by _method) and the destructive words are NOT_EXECUTABLE', () => {
    expectClassified(sampleForm({ methodOverride: 'DELETE', submitterText: '実行' }), 'NOT_EXECUTABLE', 'DESTRUCTIVE');
    // GET の form に `_method=DELETE` があっても、送られる method にかかわらず実行できないものにする（fail-closed）。
    expectClassified(sampleForm({ formMethod: 'GET', methodOverride: 'DELETE', submitterText: '表示' }), 'NOT_EXECUTABLE', 'DESTRUCTIVE');
    for (const submitterText of [
      'Delete', 'DELETE', 'remove item', 'Sign out', 'Log-Out', 'logout', 'Cancel', 'Deactivate', 'Unsubscribe', 'Reset',
      'ＤＥＬＥＴＥ', 'ｄｅｌｅｔｅ', '削除', '削 除', '取り消し', '取消', '一括で変更', '無効にする', '解約', '退会', 'アーカイブ',
      'ｱｰｶｲﾌﾞ', '廃止', '停止', 'キャンセル', 'ｷｬﾝｾﾙ', '破棄', 'ログアウト',
    ]) {
      expectClassified(sampleForm({ submitterText }), 'NOT_EXECUTABLE', 'DESTRUCTIVE');
    }
    // 送信先の path（percent-encode した日本語、区切りの違い）と query の名前。
    for (const action of [
      sampleAction('/items/1/destroy'),
      sampleAction('/items/%E5%89%8A%E9%99%A4'),
      sampleAction('/account/sign_out'),
      sampleAction('/items/BulkUpdate'),
      sampleAction('/items', ['delete']),
      sampleAction('/items', ['Remove_Id']),
    ]) {
      expectClassified(sampleForm({ action, submitterText: '送信' }), 'NOT_EXECUTABLE', 'DESTRUCTIVE');
    }
    // form の外のボタンも、文言で決める（listener の有無より先）。
    expectClassified(sampleButton({ submitterText: '削除', jsBinding: { ...NO_JS_BINDING, submitter: ['click'] } }), 'NOT_EXECUTABLE', 'DESTRUCTIVE');
    expectClassified(sampleButton({ submitterText: 'Delete' }), 'NOT_EXECUTABLE', 'DESTRUCTIVE');
    // 欄の名前は、危険な語の対象ではない（状態の欄の印の対象）。
    expectClassified(sampleForm({ fields: [sampleField('delete_flag', 'checkbox', { options: ['1'] })], submitterText: '送信' }),
      'DISPLAY_ONLY', 'UNCLASSIFIED');
  });

  it('3: GET is READ, unless it has a password field, is multipart or is bound to JS', () => {
    expectClassified(sampleForm({ formMethod: 'GET', submitterText: 'Go' }), 'READ', 'READ_GET_FORM');
    expectClassified(sampleForm({ formMethod: 'GET', submitterText: null }), 'READ', 'READ_GET_FORM');
    // GET の form は、更新や登録の語があっても READ（送られるのは GET）。
    expectClassified(sampleForm({ formMethod: 'GET', submitterText: '新規' }), 'READ', 'READ_GET_FORM');
    expectClassified(sampleForm({ formMethod: 'GET', fields: [sampleField('user'), sampleField('pass', 'password')] }),
      'UNSUPPORTED_READ_TRANSPORT', 'GET_WITH_PASSWORD_FIELD');
    expectClassified(sampleForm({ formMethod: 'GET', enctype: 'multipart/form-data', fields: [sampleField('file', 'file')] }),
      'UNSUPPORTED_READ_TRANSPORT', 'GET_WITH_MULTIPART');
    // 扱えない読み取りは、JS の結び付きより先（結び付きが分かっても READ にできない）。
    expectClassified(sampleForm({
      formMethod: 'GET', fields: [sampleField('pass', 'password')], jsBinding: { ...NO_JS_BINDING, form: ['submit'] },
    }), 'UNSUPPORTED_READ_TRANSPORT', 'GET_WITH_PASSWORD_FIELD');
    for (const jsBinding of [
      { ...NO_JS_BINDING, inlineHandler: true },
      { ...NO_JS_BINDING, form: ['submit' as const] },
      { ...NO_JS_BINDING, form: ['formdata' as const] },
      { ...NO_JS_BINDING, form: ['change' as const] },
      { ...NO_JS_BINDING, submitter: ['click' as const] },
      { ...NO_JS_BINDING, submitter: ['keydown' as const] },
    ]) {
      expectClassified(sampleForm({ formMethod: 'GET', jsBinding }), 'NEEDS_BINDING', 'JS_BOUND');
    }
    for (const jsBinding of [
      { ...NO_JS_BINDING, document: ['click' as const] },
      { ...NO_JS_BINDING, document: ['submit' as const] },
      { ...NO_JS_BINDING, window: ['pointerdown' as const] },
      { ...NO_JS_BINDING, ancestor: ['click' as const] },
    ]) {
      expectClassified(sampleForm({ formMethod: 'GET', jsBinding }), 'NEEDS_BINDING', 'JS_DELEGATED');
    }
    // document・window・祖先の、押す・送る以外の listener（キーの操作、入力の変化）は、委譲に数えない。
    expectClassified(sampleForm({ formMethod: 'GET', jsBinding: { ...NO_JS_BINDING, window: ['keydown'], document: ['input', 'change'] } }),
      'READ', 'READ_GET_FORM');
  });

  it('formmethod: the method of each submit button decides its own candidate', () => {
    // 同じ form の 2 つのボタン（片方に `formmethod=get`）は、それぞれの method で分かれる（probe が `formmethod` を `formMethod` に入れる）。
    const fields = [sampleField('q')];
    expectClassified(sampleForm({ formMethod: 'POST', fields, submitterText: '確定' }), 'DISPLAY_ONLY', 'UNCLASSIFIED');
    expectClassified(sampleForm({ formMethod: 'GET', fields, submitterText: '確定' }), 'READ', 'READ_GET_FORM');
  });

  it('4: POST with a search word, and POST to a /graphql endpoint, are UNSUPPORTED_READ_TRANSPORT', () => {
    for (const submitterText of ['Search', 'SEARCH', 'Filter', 'Find', '検索する', '絞り込み', '絞込', 'ＳＥＡＲＣＨ']) {
      expectClassified(sampleForm({ submitterText }), 'UNSUPPORTED_READ_TRANSPORT', 'POST_SEARCH');
    }
    expectClassified(sampleForm({ action: sampleAction('/items/search'), submitterText: '送信' }), 'UNSUPPORTED_READ_TRANSPORT', 'POST_SEARCH');
    expectClassified(sampleForm({ action: sampleAction('/items/searchResults'), submitterText: '送信' }), 'UNSUPPORTED_READ_TRANSPORT', 'POST_SEARCH');
    // POST の検索は、JS の結び付きより先。
    expectClassified(sampleForm({ submitterText: '検索', jsBinding: { ...NO_JS_BINDING, form: ['submit'] } }),
      'UNSUPPORTED_READ_TRANSPORT', 'POST_SEARCH');
    for (const path of ['/graphql', '/api/graphql', '/API/GraphQL']) {
      expectClassified(sampleForm({ action: sampleAction(path), submitterText: '送信' }), 'UNSUPPORTED_READ_TRANSPORT', 'GRAPHQL_ENDPOINT');
    }
    // 語の境界: `research` は `search` ではない。`graphqlx` は `graphql` ではない。
    expectClassified(sampleForm({ submitterText: 'Research' }), 'DISPLAY_ONLY', 'UNCLASSIFIED');
    expectClassified(sampleForm({ action: sampleAction('/graphqlx'), submitterText: '送信' }), 'DISPLAY_ONLY', 'UNCLASSIFIED');
  });

  it('5: JS bindings make the rest NEEDS_BINDING, and a button without a listener is DISPLAY_ONLY', () => {
    expectClassified(sampleForm({ submitterText: '保存', jsBinding: { ...NO_JS_BINDING, submitter: ['click'] } }), 'NEEDS_BINDING', 'JS_BOUND');
    expectClassified(sampleForm({ methodOverride: 'PATCH', jsBinding: { ...NO_JS_BINDING, inlineHandler: true } }), 'NEEDS_BINDING', 'JS_BOUND');
    expectClassified(sampleForm({ submitterText: '登録', jsBinding: { ...NO_JS_BINDING, document: ['click'] } }), 'NEEDS_BINDING', 'JS_DELEGATED');
    // 要素の listener と委譲の両方がある場合は、委譲（画面の全体に効く）を理由にする。
    expectClassified(sampleButton({ jsBinding: { ...NO_JS_BINDING, submitter: ['click'], document: ['click'] } }), 'NEEDS_BINDING', 'JS_DELEGATED');
    expectClassified(sampleButton({ submitterText: '保存' }), 'DISPLAY_ONLY', 'NO_KNOWN_ACTION');
    expectClassified(sampleButton({ submitterText: '新規登録' }), 'DISPLAY_ONLY', 'NO_KNOWN_ACTION');
    // document の、押す・送る以外の listener だけなら、ボタンは何もしないものとして扱う。
    expectClassified(sampleButton({ jsBinding: { ...NO_JS_BINDING, document: ['keydown'] } }), 'DISPLAY_ONLY', 'NO_KNOWN_ACTION');
  });

  it('dialog forms and unrecognized _method values are DISPLAY_ONLY', () => {
    expectClassified(sampleForm({ formMethod: 'DIALOG', submitterText: '保存' }), 'DISPLAY_ONLY', 'DIALOG_METHOD');
    // `_method` の hidden の欄があるのに、値が閉じた一覧（PUT・PATCH・DELETE）に当たらない POST は、実際の method が決まらない。
    expectClassified(sampleForm({ fields: [sampleField('_method', 'hidden', { hasValue: true })], submitterText: '更新' }),
      'DISPLAY_ONLY', 'METHOD_OVERRIDE_UNRECOGNIZED');
    expectClassified(sampleForm({ fields: [sampleField('_METHOD', 'hidden', { hasValue: true })], submitterText: '登録' }),
      'DISPLAY_ONLY', 'METHOD_OVERRIDE_UNRECOGNIZED');
    // 見える欄の `_method` は、method の上書きではない。
    expectClassified(sampleForm({ fields: [sampleField('_method')], submitterText: '登録' }), 'CREATE', 'CREATE_WORD');
  });

  it('6 and 7: PATCH and PUT, and the update and create words, are UPDATE and CREATE (display only)', () => {
    expectClassified(sampleForm({ methodOverride: 'PUT', submitterText: '登録' }), 'UPDATE', 'UPDATE_METHOD');
    expectClassified(sampleForm({ methodOverride: 'PATCH', submitterText: null }), 'UPDATE', 'UPDATE_METHOD');
    for (const submitterText of ['Update', 'SAVE', 'Edit profile', 'Save changes', '更新', '保存', '編集する', '変更']) {
      expectClassified(sampleForm({ submitterText }), 'UPDATE', 'UPDATE_WORD');
    }
    expectClassified(sampleForm({ action: sampleAction('/items/1/edit'), submitterText: '送信' }), 'UPDATE', 'UPDATE_WORD');
    // 更新の語は、登録の語より先（表の順）。
    expectClassified(sampleForm({ submitterText: '新規保存' }), 'UPDATE', 'UPDATE_WORD');
    for (const submitterText of ['Create', 'Add item', 'New', 'Register', 'REGISTER', '登録', '追加', '作成', '新規']) {
      expectClassified(sampleForm({ submitterText }), 'CREATE', 'CREATE_WORD');
    }
    expectClassified(sampleForm({ action: sampleAction('/items/addItem'), submitterText: '送信' }), 'CREATE', 'CREATE_WORD');
    expectClassified(sampleForm({ action: sampleAction('/items/new'), submitterText: '送信' }), 'CREATE', 'CREATE_WORD');
    // 英語の語は語の境界で比べる（`address`・`newsletter`・`credit` は、`add`・`new`・`edit` ではない）。
    for (const submitterText of ['Address', 'Newsletter', 'Credit', 'Renewal', 'Unsaved']) {
      expectClassified(sampleForm({ submitterText }), 'DISPLAY_ONLY', 'UNCLASSIFIED');
    }
  });

  it('8: everything else is DISPLAY_ONLY (UNCLASSIFIED)', () => {
    expectClassified(sampleForm({ submitterText: 'OK' }), 'DISPLAY_ONLY', 'UNCLASSIFIED');
    expectClassified(sampleForm({ submitterText: null }), 'DISPLAY_ONLY', 'UNCLASSIFIED');
  });

  it('marks the candidates that have a state field (by the name of the field, at word boundaries)', () => {
    const marked = (name: string): boolean => classify(sampleForm({ fields: [sampleField(name)] })).hasStateField;
    for (const name of ['active', 'is_active', 'isActive', 'STATUS', 'statusCode', 'deleted_at', 'isDeleted', 'enabled', 'archived',
      'published', 'state', 'user[status]', '状態', '公開設定', '有効']) {
      expect(marked(name), name).toBe(true);
    }
    for (const name of ['estate', 'name', 'stated_reason', 'activity', 'q', '']) {
      expect(marked(name), name).toBe(false);
    }
    expect(classify(sampleButton()).hasStateField).toBe(false);
  });
});

describe('T27a: the classification table and the word lists', () => {
  it('maps every reason code to exactly one classification, and every classification has a reason code', () => {
    expect(Object.keys(CANDIDATE_REASON_CLASSIFICATIONS).sort()).toEqual([...CANDIDATE_REASON_CODES].sort());
    expect(Object.isFrozen(CANDIDATE_REASON_CLASSIFICATIONS)).toBe(true);
    expect(new Set(Object.values(CANDIDATE_REASON_CLASSIFICATIONS))).toEqual(new Set(CANDIDATE_CLASSIFICATIONS));
  });

  it('uses every reason code in the rule table, ends with the fallback rule, and is frozen', () => {
    // T27d: 表の外の理由（同じ識別の digest の候補のまとめ `DUPLICATE_IDENTITY_CONFLICT`）は、表に入れず、ほかの理由はすべて表にある。
    expect(new Set([...CANDIDATE_CLASSIFICATION_RULES.map((rule) => rule.reasonCode), DUPLICATE_IDENTITY_CONFLICT_REASON]))
      .toEqual(new Set(CANDIDATE_REASON_CODES));
    expect(CANDIDATE_CLASSIFICATION_RULES.map((rule) => rule.reasonCode)).not.toContain(DUPLICATE_IDENTITY_CONFLICT_REASON);
    expect(CANDIDATE_CLASSIFICATION_RULES.at(-1)?.reasonCode).toBe('UNCLASSIFIED');
    expect(Object.isFrozen(CANDIDATE_CLASSIFICATION_RULES)).toBe(true);
  });

  it('includes the default dangerous words of Task 25 in the destructive words of the discovery (without changing them)', () => {
    expect(DISCOVERY_DESTRUCTIVE_WORDS).toEqual(expect.arrayContaining([...DEFAULT_EXCLUDED_URL_WORDS]));
    expect(DEFAULT_EXCLUDED_URL_WORDS).toEqual(['logout', 'signout', 'sign-out', 'log-out', 'delete', 'remove', 'destroy', 'cancel']);
  });

  it('keeps the word lists closed, frozen, folded and without duplicates', () => {
    for (const words of [DISCOVERY_DESTRUCTIVE_WORDS, DISCOVERY_SEARCH_WORDS, DISCOVERY_UPDATE_WORDS, DISCOVERY_CREATE_WORDS,
      DISCOVERY_STATE_FIELD_WORDS]) {
      expect(Object.isFrozen(words)).toBe(true);
      expect(new Set(words).size).toBe(words.length);
      for (const word of words) {
        expect(word.length, word).toBeGreaterThan(0);
        expect(word.normalize('NFKC').toUpperCase().toLowerCase(), word).toBe(word);
      }
    }
    expect(DISCOVERY_DESTRUCTIVE_WORDS).toEqual(expect.arrayContaining(['削除', '取り消', '取消', '一括', '無効', '解約', '退会', 'アーカイブ', '廃止', '停止']));
    expect(DISCOVERY_SEARCH_WORDS).toEqual(expect.arrayContaining(['検索', 'search', '絞り込', 'filter']));
    expect(DISCOVERY_UPDATE_WORDS).toEqual(expect.arrayContaining(['更新', '保存', '編集', '変更', 'update', 'save', 'edit']));
    expect(DISCOVERY_CREATE_WORDS).toEqual(expect.arrayContaining(['登録', '追加', '作成', '新規', 'create', 'add', 'new', 'register']));
    expect(DISCOVERY_STATE_FIELD_WORDS).toEqual(expect.arrayContaining(['active', 'status', 'deleted']));
  });

  it('does not change its input', () => {
    const candidate = sampleForm({ fields: [sampleField('q')] });
    const before = JSON.stringify(candidate);
    classify(candidate);
    expect(JSON.stringify(candidate)).toBe(before);
  });
});

describe('T27R-fix-1 (DEF-086): the classification words of the submitter text', () => {
  it('keeps only the words of the closed lists that the text hits, sorted and without duplicates', () => {
    expect(submitterWordsOf('山田 太郎 を編集')).toEqual(['編集']);
    expect(submitterWordsOf('注文 A-1 を取消')).toEqual(['取消']);
    expect(submitterWordsOf('Save & Delete')).toEqual(['delete', 'save']);
    expect(submitterWordsOf('ＤＥＬＥＴＥ')).toEqual(['delete']);
    expect(submitterWordsOf('検索して保存')).toEqual(['保存', '検索']);
    expect(submitterWordsOf('Sign out')).toEqual(['sign-out', 'signout']);
    expect(submitterWordsOf('filterBy')).toEqual(['filter']);
    // 語のない文言は、空の一覧（語の境界: `address` は `add` ではない）。
    for (const text of ['', '山田 太郎', 'Address', 'Research', '確定', '送信', 'GraphQL']) {
      expect(submitterWordsOf(text), text).toEqual([]);
    }
  });

  it('returns only words of the closed list of the submitter words, never the text itself', () => {
    const marker = 'row-marker-t27r';
    const listed: ReadonlySet<string> = new Set(DISCOVERY_SUBMITTER_WORDS);
    for (const text of [`${marker} を削除`, `${marker} Edit`, `Delete ${marker} 一括更新 search add new`, marker]) {
      const words = submitterWordsOf(text);
      expect(words.every((word) => listed.has(word)), text).toBe(true);
      expect(JSON.stringify(words)).not.toContain(marker);
      expect([...words].sort(compareCodeUnits)).toEqual(words);
      expect(new Set(words).size).toBe(words.length);
    }
  });

  it('classifies the words the same way as the text (the same comparison; the fixed table checks the results)', () => {
    for (const text of ['一括更新', 'Sign out', '検索して保存', 'Edits', 'AddItem', 'Unsaved', '山田 太郎 を編集']) {
      const fromWords = classify(sampleForm({ submitterText: text }));
      const words = submitterWordsOf(text);
      expect(classify(sampleForm({ submitterText: words.join(' ') })), text).toEqual(fromWords);
    }
  });

  it('lists the submitter words as the destructive, search, update and create words, closed, frozen and without duplicates', () => {
    expect([...DISCOVERY_SUBMITTER_WORDS].sort()).toEqual([
      ...DISCOVERY_DESTRUCTIVE_WORDS, ...DISCOVERY_SEARCH_WORDS, ...DISCOVERY_UPDATE_WORDS, ...DISCOVERY_CREATE_WORDS,
    ].sort());
    expect(new Set(DISCOVERY_SUBMITTER_WORDS).size).toBe(DISCOVERY_SUBMITTER_WORDS.length);
    expect(Object.isFrozen(DISCOVERY_SUBMITTER_WORDS)).toBe(true);
  });
});

describe('T27R-fix-2: the words of a field name (the dangerous words of GET form fields, word by word)', () => {
  it('splits at separators, letter and digit boundaries and case boundaries, and folds the words', () => {
    expect(fieldNameWordsOf('include_disabled')).toEqual(['include', 'disabled']);
    expect(fieldNameWordsOf('deleteFlag')).toEqual(['delete', 'flag']);
    expect(fieldNameWordsOf('user[remove]')).toEqual(['user', 'remove']);
    expect(fieldNameWordsOf('item.delete-2 x')).toEqual(['item', 'delete', '2', 'x']);
    expect(fieldNameWordsOf('delete2nd')).toEqual(['delete', '2', 'nd']);
    expect(fieldNameWordsOf('XMLDelete')).toEqual(['xml', 'delete']);
    expect(fieldNameWordsOf('ＤＥＬＥＴＥ')).toEqual(['delete']);
    expect(fieldNameWordsOf('削除フラグ')).toEqual(['削除フラグ']);
    expect(fieldNameWordsOf('')).toEqual([]);
  });
});
