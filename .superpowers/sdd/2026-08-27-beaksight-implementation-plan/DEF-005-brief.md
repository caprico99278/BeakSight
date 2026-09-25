# DEF-005 指示書: 外部へのリダイレクトの遮断と接続拒否の後に、Context を閉じる処理が止まる不具合の調査と修正

最初に `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/implementer-common-rules.md` を読み、そのルールに従ってください。

## サブタスク

- ID: DEF-005（既存不具合の調査と修正）
- 不具合台帳: 作業記録置き場の `defects.md` の DEF-005（現象と経緯がある）
- 関連する報告: `DEF-004-report.md`、`DEF-004b-report.md`、`R15d-report.md`

これまでの変更は、作業ツリーにそのまま残っています。HEAD に戻す操作は禁止です。不具合がいつからあったかを確かめるために、HEAD に戻すことも禁止です。

このサブタスクは単独で実行します。

## 変更してよいファイル

- 調査のための一時的な変更（ログなど）: 次のファイル。調査が終わったら、必ず元に戻す。
  - `src/safety/passive-request-guard.ts`
  - `src/browser/context-factory.ts`
  - `src/orchestration/page-navigation.ts`
  - `tests/helpers/passive-cleanup.ts`
- 修正:
  - 原因が製品のコードにある場合は、上のファイルのうち、原因のあるファイル
  - 原因がテストの後片付けにある場合は、`tests/helpers/passive-cleanup.ts` か `tests/integration/page-navigation.test.ts`
- 再現のテスト: `tests/integration/page-navigation.test.ts`、`tests/integration/passive-request-guard.test.ts`

## 進め方

1. **再現**
   - `npx vitest run tests/integration/page-navigation.test.ts` で、191行目のテストが失敗することを確かめる。
   - 191行目のテストだけを実行した場合と、直前のテストと続けた場合の違いも、確かめる。
2. **原因の特定**
   - 後片付けの、どの処理が止まっているかを特定する。次のどれに当たるかを、事実で示す。
     - `closePassivePage`
     - `closePassiveContext`
     - Guard の保留中の処理の待ち（drain）
     - サーバの close
     - そのほか
   - 止まっている原因が、製品のコードにあるのか、テストの補助やテストのサーバにあるのかを判断する。
     - 製品のコードの例: Guard が、リクエストを保留したまま解放しない。
     - テストの補助やサーバの例: keep-alive の接続が残る、サーバの close が接続を待つ。
   - DEF-004 と DEF-004b の変更との関係を、事実で示す。
     - 例えば、DEF-004 の条件を一時的に外すと、止まらなくなるか。
     - 一時的に外した場合は、必ず元に戻し、SHA-256 で元と一致することを確かめる。
3. **修正**
   - 原因が製品のコードにある場合:
     - まず、実際の Run で起きる形の再現のテストを書き、RED を確かめる。例: Guard の付いた page で、遮断と接続拒否の後に、page と Context を閉じる処理が、期限の中で終わること。
     - そのうえで、最小の修正で GREEN にする。
     - Guard の安全の性質（fail-closed、GET 以外の遮断、凍結）は、変えない。
     - 修正が Guard の設計に関わる場合は、止まって報告する。例えば、無効化の条件を変える場合である。
   - 原因がテストの補助やサーバにある場合:
     - テストの後片付けを直す。
     - テストの条件は、弱めない。
     - 製品のコードで、閉じる処理が止まらないことを、別のテストで確かめる。
       - 閉じる処理の所要時間を測る。
       - 止まらないことを確かめるのに、Page Auditor の既存のテストで足りるかどうかも、判断して報告する。

## 受け入れ条件

- 191行目のテストを含む `page-navigation.test.ts` が、3回続けて実行して、3回とも PASS する。
- 原因と、その根拠が、報告に書かれている。
- 修正が製品のコードにある場合は、修正前に RED、修正後に GREEN になる。
- 既存のテストは、すべて PASS する。
- `npm run typecheck` が PASS する。
- `npm run verify` が PASS する。このサブタスクでは build を実行してよい。

## 報告

共通ルールの形式で、日本語で報告してください。原因、根拠、修正の場所を、はっきり書いてください。
