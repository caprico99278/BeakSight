# C18h 指示書: DEF-013 遅いリダイレクトの偽の違反（リダイレクトの対応付けの期限）

最初に `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/implementer-common-rules.md` を読み、そのルールに従ってください。末尾の「一時ディレクトリの扱い」も守ってください。

## サブタスク

- ID: C18h
- 目的: サーバが1秒を超えてからリダイレクトを返すと、`REDIRECT_PREDECESSOR_MISSING` の偽の違反になる不具合（DEF-013）を直す。
- 設計書: `doc/design/2026-09-25-beaksight-pre-task-19-cleanup-design.md` の 4.6
- 実装計画: `doc/design/2026-09-25-beaksight-pre-task-19-cleanup-implementation-plan.md` の C18h
- 不具合台帳: 作業記録置き場の `defects.md` の DEF-013
- 前の報告: 作業記録置き場の `C18g-report.md`（再現の事実と原因）
- 上位の文書: `doc/design/2026-08-27-beaksight-implementation-tasks.md` の Safety Invariants と、SSOT Owner Matrix の Passive HTTP authority
- 共通部品台帳: `doc/design/beaksight-shared-components.md`

これまでの変更は、作業ツリーにそのまま残っています。HEAD に戻す操作は禁止です。

このサブタスクは単独で実行します。

## 変更してよいファイル

- `src/safety/passive-request-guard.ts`（`RedirectPredecessorRegistry` と、その登録と消去の時点に限る。既存の判定と違反の扱いは、変えない）
- `src/core/limits.ts`（登録の件数の上限や期限の定数を加える場合に限る）
- テスト:
  - `tests/integration/passive-request-guard.test.ts`
  - `tests/integration/external-scheme-navigation.test.ts`
  - 新規のテスト（例: `tests/integration/slow-redirect.test.ts`）
- `fixtures/server.ts` の `/__slow-redirect` は、C18g で加えた。変える必要がある場合は、止まって報告する。

## 直すもの（設計書 4.6）

1. **期限の数え始めを変える**
   - リダイレクトの対応付けの登録の期限を、リクエストの開始から数えるのをやめる。
   - 代わりに、リダイレクトの応答（3xx）を受けた時点から数える。
     - Guard は、C18g で、Document の応答の段階（CDP の `Fetch` の Response stage）を見られるようになった。そこで登録する（または、登録を更新する）。
   - Document 以外のリクエスト、応答の段階を見られないリクエストの扱いを確かめて、報告する。
     - 例: subresource は、リダイレクトの対応付けを使うのか。
2. **登録を消す時点**
   - リダイレクトの後のリクエストで使われたとき（今と同じ）
   - 元のリクエストが終わったとき（完了か失敗）
   - Context が閉じたとき
3. **件数の上限**
   - 登録が無制限に増えないように、件数の上限を設ける。
   - 上限を超えた場合は、既存の fail-closed の扱い（違反と invalidation）に合わせる。
4. **変えないこと**
   - 対応付けが見つからない場合に、違反にする扱い（fail-closed）
   - `expectedCdpFailures` の期限（1秒）。Guard 自身が失敗させた直後に使うものなので、変えなくてよい。そのことを確かめて、報告する。

## テスト

- `/__slow-redirect`（1.5秒）で、main frame と iframe の両方について確かめる。
  - 違反が0件であること
  - リダイレクト先まで読み込めること
  - 修正の前に RED になること。C18g の再現では、`REDIRECT_PREDECESSOR_MISSING` の違反が出た。
- 対照:
  - 対応付けの本当の欠落（例: 登録のない requestId の、リダイレクトの後のリクエスト）は、今までどおり違反になること。
  - 件数の上限を超えた場合の扱い。
- 既存の Guard のテストと、すべての Gate（S、A、ARCH、UI）が、PASS すること。
- 実時間の待ちは、1件あたり数秒以内にする。

## 厳守事項（このサブタスクに固有のもの）

- **Chromium は headless だけで起動する。** headed（`headless: false`）で起動してはいけない。この PC で、電話や通話やメールのアプリが実際に起動するおそれがあるためである。
- 外部スキームの URL には、実在する宛先を使わない。

## 受け入れ条件

- 各テストが、修正前に RED、修正後に GREEN になる。
- 既存のテストのケースと期待値を、弱めない。既存の違反の扱いを、緩めない（偽の違反を直すことだけにする）。
- `npm run typecheck` が PASS する。
- `npm run verify` が PASS する。

## 報告

共通ルールの形式で、日本語で報告してください。報告には、次のものを入れてください。

- 登録と消去の時点（ファイル:行）
- 件数の上限と、上限を超えた場合の扱い
- Document 以外のリクエストの扱い
- `expectedCdpFailures` の期限を変えなくてよいことの確認

これらは、Guard の独立レビュー（RC18b）で使います。
