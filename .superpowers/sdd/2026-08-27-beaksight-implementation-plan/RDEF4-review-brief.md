# RDEF4 指示書: DEF-004（Guard の変更）の独立レビュー

あなたは、BeakSight リポジトリ（`C:\Develop\github-repo\BeakSight`）の独立レビュー担当です。

## 厳守事項

- ファイルを一切、編集も作成もしないでください（読み取り専用）。
  - 検証用のスクリプトは、リポジトリの外（一時ディレクトリ）に置いてください。
- Git は、表示だけのコマンドを使ってください。使ってよいのは、`git status`、`git diff`、`git log`、`git show`、`git blame` です。
  - commit、push、checkout、restore、reset、stash、switch、worktree は禁止です。
- `npm run build` は実行しないでください。
  - テストは、対象を絞って、`npx vitest run <対象ファイル>` で実行してください。
  - `npm run typecheck` は、実行してかまいません。
- `npx` は、導入済みのコマンドだけに使ってください。
- インターネット上のサイトにアクセスしないでください。とくに 本来の監査対象のサイトへのアクセスは禁止です。
  - 名前解決の失敗を確かめる場合は、`.invalid` のドメインを使ってください。
  - 検証には、`127.0.0.1` のサーバを使ってください。
- 同時に、別の実装者が `src/orchestration/run-coordinator.ts` などを作っています。そのファイルは、レビューの対象外です。

## 対象

- 不具合台帳: 作業記録置き場（`.superpowers/sdd/2026-08-27-beaksight-implementation-plan/`）の `defects.md` の DEF-004
- 指示書と報告: `DEF-004-brief.md`（設計者の承認の節を含む）と `DEF-004-report.md`
- 変更したファイル:
  - `src/safety/network-layer-failure.ts`
  - `src/safety/passive-request-guard.ts`（`requestfailed` の処理）
  - `tests/integration/passive-request-guard.test.ts`
  - `tests/unit/network-layer-failure.test.ts`
  - `tests/integration/page-auditor.test.ts`
  - 差分は、`git diff` で見られます。
- 上位の文書:
  - `doc/design/2026-08-27-beaksight-implementation-tasks.md` の Safety Invariants と禁止事項
  - `doc/design/2026-09-23-beaksight-foundation-corrections-design.md`

## とくに確かめること

1. **安全の不変条件が後退していないこと**
   - GET 以外は、これまでどおり遮断され、この変更の経路に入らないこと。
   - 違反から外れるのは、ALLOW・メインフレーム・ナビゲーション・読み取り・一覧に載る失敗が、すべてそろう場合だけであること。
   - 一覧にない失敗は、これまでどおり違反になり、Context が無効になること。例えば、`ERR_ABORTED`、`ERR_FAILED`、`ERR_BLOCKED_BY_CLIENT`、Guard の中断による失敗である。
   - Guard 自身の中断（`Fetch.failRequest` など）で起きる失敗が、一覧のコードに化けて、見逃されることがないこと。
   - サブフレームのナビゲーションや、ナビゲーションでないリクエストの扱いが、変わらないこと。
2. **一覧の妥当性**
   - 一覧の各コードが、ネットワークの層の失敗で、Guard の不具合を示さないこと。
   - TLS と証明書の接頭辞で、Guard の不具合を示すコードを拾わないこと。
   - 一覧に入れるべきなのに、入っていないコードがあれば、指摘してください。ただし、入れないのは fail-closed の側なので、重大度は Minor とします。
3. **Interaction の凍結中の振る舞い**
   - 凍結中は、すべての通信を遮断する。この変更によって、凍結中の扱いが変わらないこと。
4. **テストの書き換えの妥当性**
   - 書き換えた9件のテストが、確かめる意図を保っていること。
   - 条件を弱めていないこと。
5. **Run Status への影響**
   - 接続拒否などのナビゲーションの失敗では、`ABORTED_BY_SAFETY` にならないこと。
   - その代わりに、ページが `FAILED` と `NAVIGATION_FAILED` で記録されること。

## 報告

意味の通る日本語で、次の形式で返してください。全体で2500字程度までにしてください。

- 総合判定: 承認 / 修正が必要
- 指摘: 各指摘に、次の項目を書いてください。
  - 重大度（Critical / Important / Minor）
  - 該当箇所（`パス:行`）
  - 問題の内容
  - 根拠（再現の手順）
  - 期待する状態
- 再実行したコマンドと結果（テスト数、失敗数、終了コード）
- 確認できなかった点

重大度の基準は、次のとおりです。

- Critical: 安全性の不変条件の違反
- Important: 仕様からの明確な逸脱、現実的に起きうる不具合、誤りを検出できないテスト
- Minor: それ以外

推測だけの指摘には、「推測」と明記してください。
