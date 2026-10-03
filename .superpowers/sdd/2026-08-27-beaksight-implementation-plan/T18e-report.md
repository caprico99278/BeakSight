# T18e 実装報告（要約。設計者が保存）

## 結論

完了した。実装者の報告では、`npm run verify` は PASS した（94ファイル、3234件）。

1. ARCH04
   - `cross-page-rules.ts` の `originOf()` を消した。
   - 3か所の判定を、`classifyUrl` の結果（`INTERNAL_NAVIGABLE` か `EXTERNAL_RECORD_ONLY`）で行う形にした。
   - 除外の一覧には、何も加えずに PASS した。
   - 前と同じ結果になることは、次の順で確かめた。
     1. 置き換えの前に、境界の例のテスト（5件）を書いて PASS させた。
     2. 置き換えの後も、同じテストが変更なしで PASS した。
   - 判定の関数は、加えていない。
     - 入力は、どれも `normalizeUrl` で正規化した URL である。
     - そのため、`classifyUrl` の結果と、前の判定の意味は、ずれない。
2. DEF-011
   - UI Gate も、`source-scan.ts` の走査（`loadSourceFiles()`、走査の結果の `code`、`findImportSpecifiers`）を使う形にした。
   - 検査の規則は、変えていない。
3. `fixtures/site/delete-request.html` を加えた。S02 の Interaction の DELETE は、この fixture を使う形にした。

Gate の所要時間:

| ファイル | 所要時間 |
| --- | --- |
| ui-ssot | 411ms |
| semantic-ownership | 390ms |
| target-isolation | 306ms |

## 実装者の判断と、設計者の判断

1. `INCONSISTENT_ORIGIN` の文言に示す Origin は、`new URL(url).origin` で取り出す。→ 承認する。
   - 外かどうかの判定は、`classifyUrl` が行う。
   - Origin の取り出しは、文言のためだけである。判定の別の実装には、当たらない。
2. `classifyUrl` は、呼び出しのたびに、許可 Origin を正規化し直す。→ 承認する。今の上限では、重さは問題にならない。
3. UI Gate の文字列リテラルの取り出しには、前と同じ正規表現を、走査の結果の `code` にかける形を残した。→ 承認する。
   - 規則を変えないためである。
   - 走査の `literals` に移すかどうかは、Task 18 の後の整理で検討する。

## 発見事項と、設計者の判断

1. DEF-011 で、実際に検査から抜け落ちていた範囲について。→ 不具合台帳の記述を直した。
   - T18d の報告は、「`passive-request-guard.ts` の1385〜1481行が抜け落ちる」としていた。しかし、今のソースでは、そうなっていなかった。
     - その `'**/*'` の後ろには、閉じる `*/` がない。
   - 実際に抜け落ちていたのは、`src/crawl/normalize-url.ts:161` の1行だけだった。
   - 修正の後の UI Gate では、どちらの範囲も検査され、違反はない。
2. 範囲外で直す必要のある不具合は、見つからなかった。
