# C18a 実装報告（要約。設計者が保存）

## 結論

完了した。実装者の報告では、`npm run verify` は PASS した（95ファイル、3319件）。

- Guard は、Playwright の `request` の事象で、外部スキームへの移動の試みを検出する（`passive-request-guard.ts:1343-1387` の `onRequest`）。
  - 検出したものは、Safety Ledger の `externalSchemeNavigations` に記録する。
  - 許可するスキームの一覧: `src/core/evidence-types.ts:1533` の `NON_EXTERNAL_NAVIGATION_SCHEMES`（`http:`、`https:`、`about:`、`data:`、`blob:`）
- headed の値の経路:
  1. `config.browser.headed`
  2. `BrowserContextFactory`
  3. `installPassiveRequestGuard(…, { headed })`
  - 値がない場合や真偽値でない場合は、`GUARD_INSTALLATION_FAILED` にする。
- 新しい違反のコード:
  - `EXTERNAL_SCHEME_NAVIGATION_IN_HEADED_MODE`: headed の時だけ記録し、invalidation を始める。
  - `EXTERNAL_SCHEME_DETECTION_FAILED`: 検出が例外を投げた場合と、URL を解析できない場合に記録し、invalidation を始める。
- 新しい Rule: `SAFETY_EXTERNAL_SCHEME_NAVIGATION_ATTEMPTED`
- `hasFreezeEvent` に、`phase: 'INTERACTION'` の `externalSchemeNavigations` を加えた。凍結の後の外部スキームへの移動の試みは、`BLOCKED_BY_SAFETY` になる。
- HTML の Safety の事象の表の見出しを、「Safety の事象の一覧」に直した。
- テスト: `tests/integration/external-scheme-navigation.test.ts`（新規）
  - 7経路 × 3スキームを、Passive と Interaction で確かめた。
  - headed の注入、`window.open`、対照も確かめた。
  - すべて headless である。
- 範囲外のテスト2ファイルの件数の期待値を、承認を得て更新した。条件は変えていない。
  - listener の数: 2 から 3 へ
  - 見本の件数: 12 から 13 へ

## Ledger の記録の形（C18b 向け）

```ts
snapshot.externalSchemeNavigations: readonly {
  url: string;        // redactUrlCredentials で伏せ字にし、2048 文字までに切り詰める。form の GET は末尾に "?" が付く
  scheme: string;     // 末尾の ":" を除いた形。'tel'、'mailto'、'beaksight-test-app' など
  frame: 'MAIN' | 'SUB';               // iframe の src だけが 'SUB'
  phase: 'PASSIVE' | 'INTERACTION';    // Guard の段階（凍結の前か後か）
  reason: 'EXTERNAL_SCHEME_NAVIGATION';
}[]
```

- Interaction の Context でも、凍結の前の試みは `phase: 'PASSIVE'` になる。
- `window.open` の場合は、`externalSchemeNavigations` に記録されない。
  - headless では、`FRAME_CLASSIFICATION_FAILED` の違反になり、Context が閉じる。
  - headed では、さらに `EXTERNAL_SCHEME_NAVIGATION_IN_HEADED_MODE` が加わる。
  - `FRAME_CLASSIFICATION_FAILED` は、2件になることがある。完全一致ではなく、含むかどうかで確かめる。

## 実装者の判断と、設計者の判断

1. 事象に `reason` の項目を加えた。→ 承認する。既存の事象と形がそろう。
2. 許可するスキームの一覧と、事象の閉じた一覧を、core の `evidence-types.ts` に置いた。→ 承認する。事象の意味を決めるものである。
3. `window.open` の場合は、`externalSchemeNavigations` に記録しない。→ 承認する。
   - frame ができる前にリクエストが出るので、frame の種類が分からない。
   - 既存の違反で、Context は閉じる。
4. Ledger の中で、`redactUrlCredentials` で伏せ字にする。→ 承認する。
5. CLOSED 以外のすべての段階で記録し、headed なら invalidation にする。→ 承認する。
6. Rule の名前と文言。→ 承認する。

## 発見事項と、設計者の判断

1. `hasFreezeEvent` が、新しい一覧を見ない。→ 直した（上のとおり）。
2. HTML の見出しが、実態と合わない。→ 直した（上のとおり）。
3. `run-aggregation.ts` の `blockedActions` は、新しい一覧を数えない。→ そのままでよい。
   - Guard が遮断したものではないので、遮断の件数に入れないのが正しい。
4. HTML の事象の表に、scheme、frame、段階の列がない。→ 今は、そのままにする。
   - URL と理由から、どの試みかは分かる。
   - 列を加えるかどうかは、Task 19 の README を書くときに見直す。
5. Vitest のワーカーの異常終了が、1回あった（2回目以降は起きていない）。→ 設計者の verify で、再発するかを見る。
6. 共通部品台帳の更新。→ 設計者が行った。
