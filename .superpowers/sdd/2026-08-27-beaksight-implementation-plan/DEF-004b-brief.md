# DEF-004b 指示書: ネットワークの層の失敗を違反から外すのを、凍結中でない場合に限る

最初に `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/implementer-common-rules.md` を読み、そのルールに従ってください。

## サブタスク

- ID: DEF-004b（DEF-004 の追加の修正）
- 目的: Guard の独立レビュー RDEF4 の Minor-1 を直す。
- レビューの結果: 作業記録置き場の `RDEF4-review-result.md`
- 前の報告: `DEF-004-report.md`

これまでの変更は、作業ツリーにそのまま残っています。HEAD に戻す操作は禁止です。

同時に、別の実装者（R15d）が、`src/orchestration/` と、そのテストを作っています。担当のファイル以外は変更しないでください。`npm run verify` は実行しないでください。

Guard は安全の中核です。変更は最小限にしてください。

## 変更してよいファイル

- `src/safety/passive-request-guard.ts`（DEF-004 で加えた条件の1か所に限る）
- `tests/integration/passive-request-guard.test.ts`

## 修正する内容

- DEF-004 で加えた条件に、Guard の状態の確認を加える。
  - 条件は、`isReadMethod(request.method()) && isNetworkLayerFailure(message)` である。
  - 加える確認は、`!isFrozenPhase(guardState.phase)` である。
  - 凍結中（`isFrozenPhase` が真）は、これまでどおり、違反として記録し、Context を無効にする。
- テストで、次のことを確かめる。
  - 凍結中に、許可した GET のメインフレームのナビゲーションが、一覧に載る失敗で終わった場合に、違反が記録され、Context が無効になること。
    - 修正前に RED、修正後に GREEN になること。
    - RDEF4 の再現の手順を参考にしてよい。手順は、次のとおり。
      1. `/` を読み込む。
      2. `location.href='/hang'` を実行する。
      3. サーバが受け取った後に、凍結する。
      4. サーバがソケットを切る。
    - ハーネスを使ってもよい。
  - 凍結の前（Passive）の同じ失敗は、これまでどおり違反にならないこと。
  - 既存の Guard のテストは、すべて PASS のまま。

## 受け入れ条件

- 修正前に RED、修正後に GREEN になる。
- 既存のテストは、すべて PASS する。
- `npm run typecheck` と、担当のテストが PASS する。

## 報告

共通ルールの形式で、日本語で報告してください。
