/**
 * 外部スキームへの移動の fixture が使う、外部スキームの宛先の値（C18k。CC-031）。このファイルは、ほかのファイルを import しない。
 *
 * - 宛先は、どれも実在しないものだけである（`tel:+10000000000`、`mailto:nobody@example.invalid`、`beaksight-test-app:probe`）。
 * - 値の定義は、ここの1か所だけにある。`fixtures/server.ts` と、テストの補助 `tests/helpers/external-scheme-fixture.ts` は、
 *   ここから import する（`fixtures/` は、テストの補助より下の層なので、`tests/` を import しない）。
 * - `fixtures/site/external-scheme-navigation.html` と `fixtures/site/external-scheme-button.html` のスクリプトは、
 *   値を import できないので複製（`const destinations = { ... };`）を持つ。同じ値であることは、
 *   `tests/unit/external-scheme-fixture.test.ts` で確かめる。
 */

/**
 * 移動を試みる、外部スキームの宛先。どれも実在しない宛先である。
 * `scheme` は、Safety Ledger の `externalSchemeNavigations` の `scheme`（末尾の `:` を除いた形）。
 */
export const EXTERNAL_SCHEME_TARGETS = Object.freeze({
  tel: Object.freeze({ url: 'tel:+10000000000', scheme: 'tel' }),
  mailto: Object.freeze({ url: 'mailto:nobody@example.invalid', scheme: 'mailto' }),
  custom: Object.freeze({ url: 'beaksight-test-app:probe', scheme: 'beaksight-test-app' }),
} as const);
export type ExternalSchemeKey = keyof typeof EXTERNAL_SCHEME_TARGETS;
export const EXTERNAL_SCHEME_KEYS = Object.freeze(Object.keys(EXTERNAL_SCHEME_TARGETS) as ExternalSchemeKey[]);
