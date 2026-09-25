# RC18a 指示書: DEF-012（外部スキームへの移動）の修正の、Guard の独立レビュー

あなたは、BeakSight リポジトリ（`C:\Develop\github-repo\BeakSight`）の独立レビュー担当です。BeakSight は、Node.js 24、TypeScript strict、Playwright Library、Vitest の、読み取り専用の Web サイト監査 CLI です。

このレビューは、安全の境界（Guard）の変更のレビューです。Critical と Important がなければ、Task 19 の前の整理の残りに進みます。

## 厳守事項

- ファイルを一切、編集も作成もしないでください（読み取り専用）。
  - 検証用のスクリプトや出力は、リポジトリの外（一時ディレクトリ）に置いてください。
  - 一時ディレクトリに、リポジトリへのリンク（ジャンクション、シンボリックリンク）を作ってはいけません。`R-review-common.md` の末尾の「一時ディレクトリの扱い」を読んでから始めてください。
- **Chromium は headless だけで起動してください。headed（`headless: false`）で起動してはいけません。** この PC で、電話や通話やメールのアプリが実際に起動するおそれがあるためです。headed の扱いは、headless のブラウザで設定を `headed: true` にして確かめてください。
- 外部スキームの URL には、実在する宛先を使わないでください（例: `tel:+10000000000`、`mailto:nobody@example.invalid`、`beaksight-test-app:probe`）。
- Git は、表示だけのコマンドを使ってください。
  - 使ってよいのは、`git status`、`git diff`、`git log`、`git show`、`git blame` です。
  - commit、push、checkout、restore、reset、stash、switch、worktree は禁止です。
- テストの実行
  - `npm run build` は、実行しないでください。
  - テストは、対象を絞って、`npx vitest run <対象ファイル>` で実行してください。
  - `npm run typecheck` は、実行してかまいません。
- インターネット上のサイトには、アクセスしないでください。とくに 本来の監査対象のサイトへの接続は、ユーザーの明示の承認があるまで禁止です。
  - `config/targets/` の実サイトの設定と、`local/` 配下のファイルは、使わないでください。
  - 検証は、ローカルの fixture と `127.0.0.1` のサーバだけで行ってください。

## 対象

- 設計書: `doc/design/2026-09-25-beaksight-pre-task-19-cleanup-design.md` の第4章
- 不具合台帳: 作業記録置き場の `defects.md` の DEF-012
- 上位の文書: `doc/design/2026-08-27-beaksight-implementation-tasks.md`（Safety Invariants、SSOT Owner Matrix の Passive HTTP authority、完了の意味）
- 実装:
  - `src/safety/passive-request-guard.ts`（`onRequest` と、headed の扱い）
  - `src/safety/safety-ledger.ts`（`recordExternalSchemeNavigation`）
  - `src/browser/context-factory.ts`（headed の受け渡し）
  - `src/core/evidence-types.ts`（`NON_EXTERNAL_NAVIGATION_SCHEMES` と事象の型）
  - `schemas/page.schema.json`
  - `src/audit/safety-rules.ts`（新しい Rule）
  - `src/interaction/isolated-auditor.ts`（`hasFreezeEvent`）
  - `src/presentation/catalog.ts`、`messages.ts`、`src/report/view-model.ts`
- テスト:
  - `tests/integration/external-scheme-navigation.test.ts`
  - `tests/integration/passive-request-guard.test.ts`（C18a の分）
  - `tests/integration/safety-gates.test.ts`（C18b で広げた S03 と S08）
  - `tests/integration/gate-fixtures.test.ts` と、新しい fixture
- 報告（作業記録置き場 `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/`）:
  - `C18a-report.md`、`C18b-report.md`
  - 参考: 調査の実験の記録 `C:\Users\ocean\AppData\Local\Temp\claude\C--Develop-github-repo-BeakSight\c7d3723a-f7c4-4979-913c-ece0b3289778\scratchpad\s03\`
  - 報告の中の「設計者の判断」は、設計者が承認した事項です。

## とくに確かめること

1. **検出の網羅**
   - 外部スキームへの移動の試みが、すべての経路で検出されること。
     - 経路: `location.href`、`location.assign`、meta refresh、iframe の src、スクリプトによる anchor の click、form の action、本物の click、`window.open`
     - 段階: Passive、Interaction の凍結の前と後
   - 見落としの経路がないか。例えば、次のものも確かめてください。
     - `location.replace`
     - `history` の API
     - 入れ子の iframe
     - `srcdoc`
     - Worker や Service Worker からの移動
     - `<a target="_blank">` の click
   - `request` の事象が来ない経路があれば、挙げてください。
2. **headed の扱い**
   - headed の値が、設定の1か所から Guard まで届くこと。
   - headed で検出したら、違反が記録され、Context が閉じること。
   - 値がない場合や不正な場合に、fail-closed になること。
3. **既存の安全の境界が緩んでいないこと**
   - 既存の判定と違反の扱いが、変わっていないこと。
   - とくに、`window.open` の `FRAME_CLASSIFICATION_FAILED` の違反が、そのまま残ること。
4. **誤検知**
   - 正しい http(s) の移動、`about:blank`、`data:`、`blob:`、エラーのページ（`chrome-error://`）を、外部スキームとして検出しないこと。
   - とくに headed で、誤って違反にして Run を止めないこと。
5. **記録と表示**
   - 記録の上限、伏せ字、スキーマ、カタログ、Rule、表示用モデル、HTML が、一貫していること。
   - Interaction の結果の `BLOCKED_BY_SAFETY` への反映が、凍結の後の事象だけであること。
6. **Gate の質**
   - GATE-S03 と GATE-S08 の新しい確認が、空振りしていないこと。
   - 対照の確認が、本当に対照になっていること。
7. **headed で残る危険の説明が、正直であること**
   - 設計書 4.3 と DEF-012 の説明が、実装と合っていること。
     - headed では、起動そのものは防げない。起きたことを記録して止める。

## 報告

意味の通る日本語で、次の形式で返してください。全体で3000字程度までとし、重要度の高いものを優先してください。

- 総合判定: 承認 / 修正が必要
- 指摘: 各指摘に、次の項目を書いてください。
  - 重大度（Critical / Important / Minor）
  - 該当箇所（`パス:行`）
  - 問題の内容
  - 根拠（仕様のどの記述か、再現の手順）
  - 期待する状態
- 再実行したコマンドと結果（テスト数、失敗数、終了コード、所要時間）
- 確認できなかった点

重大度の基準は、次のとおりです。

- Critical: 安全性の不変条件の違反、または仕様の中核の欠落
- Important: 仕様からの明確な逸脱、現実的に起きうる不具合、誤りを検出できないテスト
- Minor: それ以外

設計者が報告の中で承認した事項は、それ自体を指摘しなくてかまいません。ただし、その判断が仕様に反すると考える場合は、根拠とともに指摘してください。推測だけの指摘には、「推測」と明記してください。
