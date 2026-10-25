// API のシナリオの欄の識別の契約（CC-102。T39d の後）。純粋な定義だけのファイル。シナリオの契約（`src/control/approval/scenario-contracts.ts` の
// `ScenarioApiFieldIdentity`・`SCENARIO_API_FIELD_IDENTITY_KINDS`）と、書き込みの入力の部品（`src/browser/api-write-submitter.ts` の
// `ApiWriteFieldIdentity`）が、ここを公開し直して使う（同じ形を 2 か所に書かない。ブラウザの部品は `src/control/` を参照できないため、core に置く）。
// - 欄の識別は、probe が記録した欄の `name` があれば名前（`NAME`）、なければその画面で一意な CSS（`SELECTOR`）。値は持たない。

/** 欄の識別の種類（閉じた一覧）。 */
export const API_FIELD_IDENTITY_KINDS = Object.freeze(['NAME', 'SELECTOR'] as const);
export type ApiFieldIdentityKind = (typeof API_FIELD_IDENTITY_KINDS)[number];

/** 欄の識別（値は持たない）。 */
export type ApiFieldIdentity =
  | { readonly kind: 'NAME'; readonly name: string }
  | { readonly kind: 'SELECTOR'; readonly selector: string };

/**
 * 欄の識別の値（`NAME` なら名前、`SELECTOR` なら CSS。PRE42-CC の組 2。CC-102 の気づき）。承認の digest（`approval-digest.ts`）と、鍵と欄の対応の
 * digest（`scenario-contracts.ts` の `apiKeyFieldsDigestOf`）が、識別の種類と並べて使う。取り出す形は、ここだけに書く
 * （`tests/architecture/owner-constant-reuse.test.ts` の (e)）。
 */
export const apiFieldIdentityValueOf = (field: ApiFieldIdentity): string => (field.kind === 'NAME' ? field.name : field.selector);
