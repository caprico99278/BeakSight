# U16d 指示書: ChatGPT 用バンドル

最初に `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/implementer-common-rules.md` を読み、そのルールに従ってください。末尾の「一時ディレクトリの扱い」も守ってください。

## サブタスク

- ID: U16d
- 目的: 表示用モデルから、ChatGPT に渡すための ZIP（`beaksight-audit-bundle.zip`）の中身を作る。
- 設計書:
  - `doc/design/2026-09-23-beaksight-task-14-17-pipeline-report-cli-design.md` の 6.1.2、6.1.3、6.1.8、6.1.9（とくに 6.1.9 の `createChatGptBundle` の形）
  - 上位の設計書 `doc/design/2026-08-27-beaksight-web-audit-design.md` の第19章
- 実装計画:
  - `doc/design/2026-09-24-beaksight-task-16-17-implementation-plan.md` の U16d
  - 上位の計画 `doc/design/2026-08-27-beaksight-implementation-plan.md` の Task 16 の Step 5
- 前の報告: 作業記録置き場の次の3つ
  - `U16b-report.md`（表示用モデルの型と `writePresentation`）
  - `C16a-report.md`（配置）
  - `C16b-report.md`（テストの見本の補助）
- 共通部品台帳: `doc/design/beaksight-shared-components.md`

これまでの変更は、作業ツリーにそのまま残っています。HEAD に戻す操作は禁止です。

**このサブタスクは、U16c（HTML レポート）と並行で実行します。** U16c の実装者は、次のファイルを変更します。

- `src/report/html-report.ts`、`html-components.ts`、`html-tokens.ts`
- `src/presentation/messages.ts`
- `tests/helpers/audit-run-fixture.ts`（見本を加える）

守ってほしいことは、次の3つです。

- 下の「変更してよいファイル」の外は、変更しないでください。
- `npm run verify` と `npm run build` は、実行しないでください。U16c の作業と干渉するためです。全体の verify は、設計者が行います。
- 担当のテストと `npm run typecheck` は、実行してかまいません。
  - 型のエラーが U16c の作業中のファイルから出ている場合は、自分のファイルのエラーでないことを確かめてください。そのうえで、報告に書いてください。

## 変更してよいファイル

- 新規: `src/report/chatgpt-bundle.ts`、`tests/unit/chatgpt-bundle.test.ts`
- `src/core/ids.ts`（バイト列の SHA-256 を `sha256:<16進64桁>` の形で返す関数を加えることに限る。既存の関数の振る舞いは、変えない）
- `tests/unit/core-contracts.test.ts`（上の関数のテストを加えることに限る。`createSha256Fingerprint` のテストがあるファイルである）

`tests/helpers/audit-run-fixture.ts` は、U16c が変更するので、変更しません。

- 見本が足りない場合は、補助の関数の上書きの引数で作ってください。
- それでも作れない場合は、テストのファイルの中で補助の結果を加工してください。
- 加工で済まない場合は、止まって報告してください。

次のファイルも変更しません。止まって Blocker として報告してください。

- `src/report/view-model.ts`
- `src/report/artifact-writer.ts`
- `src/presentation/**`

## 作るもの

1. **`createChatGptBundle(viewModel, result, readArtifactFile): Promise<Uint8Array>`**（設計書 6.1.9）
   - `readArtifactFile(relativePath: string): Promise<Uint8Array | null>` は、Run のディレクトリからの相対パスで、書き出し済みのファイルを読む。ファイルがなければ、`null` を返す。
   - ファイルは書かない（ARCH08）。
   - ZIP に入れるものと順は、次のとおりにする。
     1. `manifest.json`
     2. `run.json`（`readArtifactFile` で読んだものを、そのまま入れる）
     3. `summary.json`
     4. `findings.json`
     5. `pages.json`
     6. `evidence-index.json`
     7. 関係するスクリーンショット（パスの順）
   - `manifest.json` の中身は、設計書 6.1.9 のとおりにする。
     - `bundleSchemaVersion: 'chatgpt-bundle/1.0'`
     - `runId`、`runStatus`、`toolVersion`
     - `generatedAt`（Run の `finishedAt`）
     - `files`（`path`、`byteLength`、`sha256`）
     - `omittedFiles`（`path`、`reason`）
   - `files` の対象は、`manifest.json` 自身を除く、ZIP の中のすべてのファイルとする。
   - `sha256` は、`src/core/ids.ts` に加える関数で作る。ハッシュの書式を、ほかの場所に書かない（CC-006）。
   - 関係するスクリーンショットは、`ScreenshotView.relatedFindingIds` が空でないものとする。
     - 再試行の前の試行のものも、関係づいていれば入れる。
     - `null` が返ったものは入れず、`omittedFiles` に書く。
     - `run.json` が `null` の場合は、`run.json` を入れず、`omittedFiles` に書く。
   - `evidence-index.json` には、`EvidenceLocationView`（直接の参照の `relatedFindingIds`）を使う。
   - JSON は、字下げ2文字、末尾に LF、UTF-8 にする。値は、英数字のコードのままとする。日本語のラベルは入れない。
   - 決定論:
     - fflate の `zipSync` を使う。
     - 各項目の時刻は、固定の値にする。
     - 同じ入力からは、同じバイト列を作る。
   - 生のレスポンス本文は、入れない。
   - ファイルの名前は、UTF-8 にする。
   - パスは `/` の区切りにし、`..` や、絶対パスを含まない。
     - 入力のパスが不正な場合は、例外を投げる。
     - その検証は、`src/core/artifact-layout.ts` の関数や、既存の検証を使えるなら使う。
     - 使えない場合は、`chatgpt-bundle.ts` の中の1か所で行い、報告する。
2. **テスト（`tests/unit/chatgpt-bundle.test.ts`）**。見本は、C16b の補助で作る。
   - 次の4点を、fflate の `unzipSync` で展開して確かめる。
     - ZIP の中身のパスと順
     - `manifest.json` の `files` と、実際の中身の対応（バイト数と SHA-256）
     - `run.json` が、読んだバイト列と同じであること
     - 関係するスクリーンショットだけが、入ること
   - 同じ入力から、同じバイト列ができる。
   - 読めなかったスクリーンショットは、`omittedFiles` に書かれ、ZIP に入らない。
   - `evidence-index.json` から、各 Evidence の `path` と `pointer` をたどれる。
     - 見本の page.json の中身で、`pointer` の先が同じ Evidence の ID であることを確かめる。
   - 日本語を含むパスや値が、UTF-8 で正しく入る。
   - 生のレスポンス本文にあたる文字列（見本に入れた、本文らしい値）が、ZIP のどこにもない。

## 受け入れ条件

- 各テストが、修正前に RED、修正後に GREEN になる。
- 担当のテストと、`npm run typecheck`（自分のファイルについて）が PASS する。
- `npm run verify` は実行しない（並行作業のため）。

## 報告

共通ルールの形式で、日本語で報告してください。U17a の実装者が CLI から呼ぶので、`createChatGptBundle` のシグネチャと、CLI が渡す `readArtifactFile` の作り方の例を書いてください。
