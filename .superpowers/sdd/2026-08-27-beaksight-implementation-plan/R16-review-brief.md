# R16 指示書: Task 16（JSON の artifact、HTML レポート、ChatGPT 用バンドル）の独立レビュー

あなたは、BeakSight リポジトリ（`C:\Develop\github-repo\BeakSight`）の独立レビュー担当です。BeakSight は、Node.js 24、TypeScript strict、Playwright Library、Vitest、Ajv、fflate の CLI です。

実装タスク指示のチェックポイントは Task 18 です。ただし、Task 16 は表示と安全（エスケープ、危険な URL、artifact の書き出し）に関わります。そのため、実装計画に従って、Task 16 の後にも独立レビューを行います。Critical と Important がなければ、Task 17 に進みます。

## 厳守事項

- ファイルを一切、編集も作成もしないでください（読み取り専用）。
  - 検証用のスクリプトや出力は、リポジトリの外（一時ディレクトリ）に置いてください。
  - 一時ディレクトリに、リポジトリへのリンク（ジャンクション、シンボリックリンク）を作ってはいけません。`R-review-common.md` の末尾の「一時ディレクトリの扱い」を読んでから始めてください。
- Git は、表示だけのコマンドを使ってください。
  - 使ってよいのは、`git status`、`git diff`、`git log`、`git show`、`git blame` です。
  - commit、push、checkout、restore、reset、stash、switch、worktree は禁止です。
- テストの実行
  - `npm run build` は実行しないでください。
  - テストは、対象を絞って、`npx vitest run <対象ファイル>` で実行してください。
  - `npm run typecheck` は、実行してかまいません。
- `npx` は、導入済みのコマンドだけに使ってください。
- インターネット上のサイトには、アクセスしないでください。とくに 本来の監査対象のサイトへのアクセスは禁止です。
  - `local/` 配下のファイルは、使わないでください。
  - 検証は、ローカルの fixture と `127.0.0.1` のサーバだけで行ってください。

## 対象

- 設計書:
  - `doc/design/2026-09-23-beaksight-task-14-17-pipeline-report-cli-design.md` の第6章と 6.1〜6.1.10
    - 6.1.8〜6.1.10 は、U16b 以降の報告を受けた決定で、それより前の記述に優先する。
  - UI追補設計書 `doc/design/2026-09-23-beaksight-ui-ssot-design.md`
  - `doc/design/2026-09-24-beaksight-task-16-17-implementation-plan.md`（末尾の追補を含む）
- 上位の文書:
  - `doc/design/2026-08-27-beaksight-implementation-tasks.md`（ARCH05、ARCH08、A10、SSOT Owner Matrix、禁止事項）
  - `doc/design/2026-08-27-beaksight-implementation-plan.md` の Task 16（6.1.2 と 6.1.9 の読み替えに注意）
  - `doc/design/2026-08-27-beaksight-web-audit-design.md` の第18〜20章、第27章
- 共通部品台帳: `doc/design/beaksight-shared-components.md`
- 実装:
  - `src/presentation/catalog.ts`、`messages.ts`、`format.ts`
  - `src/report/view-model.ts`、`artifact-writer.ts`、`artifact-json.ts`、`html-tokens.ts`、`html-components.ts`、`html-report.ts`、`chatgpt-bundle.ts`
  - `src/core/artifact-layout.ts`、`src/core/status.ts`（`requiredArtifactInvalidReason`）、`src/core/ids.ts`（`createSha256FingerprintOfBytes`、`isRunId`、`isPageId`）、`src/core/evidence-types.ts`（`SAFETY_EVENT_KINDS`）
  - `src/core/contracts.ts`（`AuditRunResult.statusInput`）と、`src/orchestration/run-coordinator.ts`、`page-auditor.ts` の、配置と `statusInput` の部分
  - `src/evidence/screenshot-collector.ts`（パスの検証の部分）
  - `tests/architecture/ui-ssot.test.ts`、`tests/helpers/audit-run-fixture.ts`
- 報告（作業記録置き場 `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/`）:
  - `U16a-report.md`、`U16b-report.md`、`C16a-report.md`、`C16b-report.md`、`U16c-report.md`、`U16d-report.md`、`C16c-report.md`、`C16d-report.md`、`C16e-report.md`
  - 報告の中の「設計者の判断」は、設計者が承認した事項です。

## とくに確かめること

1. **HTML の安全**
   - 利用者に見せるすべての値（Evidence、Finding の文言、URL、理由の detail、Interaction の名前）が、エスケープされていること。
   - 属性の値に入る値も、エスケープされていること。
   - `href="mailto:`、`href="tel:`、`href="javascript:` などが出ないこと。
   - リンクにするかどうかが、`classifyUrl` だけで決まること（設計書 6.1.6）。
   - アンカーとファイルへのリンクが、安全な文字だけであること。
   - `style=""` の属性、スクリプト、外部の資源の読み込みがないこと。
   - HTML を組み立てる経路が、部品を通らずに文字列をつなぐ所がないこと（UI03）。
   - 可能なら、`edgeCaseAuditRun` などの危険な値を入れた Run を実際に描き、出力を調べてください。
2. **完了の正直さと ARCH05・ARCH08・A10**
   - スキーマに合わない artifact がある場合に、`COMPLETE` にならないこと。
   - Run Status を決めるのが、`deriveRunStatus` だけであること。
   - 最終の書き出しの owner が、`ArtifactWriter` だけであること。ほかに、artifact を書く所がないこと。
   - HTML、バンドル、CLI の件数が、表示用モデルの1か所から来ていること。数え直しがないこと（UI04）。
   - 未観測の値が、0 や空文字にならないこと。
   - 再試行の前の記録が、件数と Finding の参照に混ざらないこと。
3. **artifact の配置と書き出し**
   - 配置が、設計書 6.1.2 と 6.1.9 のとおりであること。
   - UTF-8 と LF であること。
   - 一時ファイルと rename で書くこと。
   - 途中で失敗した場合の振る舞い（例外、一時ファイルの後始末）。
   - パスの検証（CC-027）で、Run のディレクトリの外に書けないこと。
   - ID の形の検証（C16d）が、C16c の前と同じ振る舞いに戻っていること。
4. **ChatGPT 用バンドル**
   - 中身、順、決定論（時計と時間帯）が、設計書 6.1.9 のとおりであること。
   - 生のレスポンス本文を含まないこと。
   - `evidence-index.json` から、一次の証拠（page.json）にたどれること。
   - `manifest.json` の `files` と `omittedFiles` が、事実と一致すること。
   - 読めなかったファイルの扱い。
5. **SSOT と共通部品**
   - 同じ意味のものが、2か所にないこと。
     - 対象: カタログ、文言、書式、配置、JSON の書式、パスの検証、ID の形、スクリーンショットの関係づけ
   - report が orchestration を import しないこと。
   - 共通部品台帳が、実装と合っていること。
6. **UI Gate**
   - UI01〜UI05 が、誤りを実際に検出できること。
     - 可能なら、リポジトリの中で対象を絞ったテストの実行と、読み取りだけで判断してください。
     - ファイルを変えて確かめる方法は、使わないでください。
   - 各ファイルが1秒以内に終わること。
7. **テストの質**
   - テストが、実装の誤りを検出できる形であること。
   - 見本（`audit-run-fixture.ts`）が、スキーマに合う現実的な形であること。

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
