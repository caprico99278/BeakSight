// 候補の入力の欄の型の値の一覧（PRE42-CC 組 UI-K2。台帳の CC-113）。純粋な定義だけのファイル（import を持たない）。
// - 発見の候補の契約の SSOT（`src/discovery/candidate-contracts.ts`）が、ここを同じ名前で公開し直す（定義は 1 か所。JSON Schema の enum との一致も、そこを
//   通して確かめる。部分の一覧（`SELECT_FIELD_TYPES` など）は、そこに置いたまま）。画面のブラウザ側（`apps/local-ui/src/` の `server/` の外）は、発見の
//   部品に触れずに値を読めるように、ここから読む（`audit-job-values.ts` と同じ置き方。Gate `tests/architecture/browser-list-values.test.ts`）。

/**
 * 入力の欄の型。`input` は HTML の `type` の正規の値（未知の値は、ブラウザが `text` として扱う）。送信ボタンとリセット
 * （`submit`・`image`・`reset`・`button`）は欄に含めない。`select` は `select-one`・`select-multiple`、`textarea` は `textarea`。
 */
export const CANDIDATE_FIELD_TYPES = Object.freeze([
  'text',
  'search',
  'email',
  'url',
  'tel',
  'password',
  'number',
  'range',
  'date',
  'month',
  'week',
  'time',
  'datetime-local',
  'color',
  'checkbox',
  'radio',
  'file',
  'hidden',
  'select-one',
  'select-multiple',
  'textarea',
] as const);
export type CandidateFieldType = (typeof CANDIDATE_FIELD_TYPES)[number];

/**
 * 連絡先の欄の型（メールアドレスと電話番号。Task 31 の判断 3）。画面の UPDATE の入力（form と API）が、既定で保つことを近くで知らせる欄の型
 * （T41e。`ScenarioUpdateFields.tsx`・`ScenarioApiFields.tsx`）。
 */
export const CONTACT_CANDIDATE_FIELD_TYPES = Object.freeze(['email', 'tel'] as const satisfies readonly CandidateFieldType[]);
