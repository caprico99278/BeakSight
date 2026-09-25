# U16d 実装報告（要約。設計者が保存）

## 結論

完了した。

- `createChatGptBundle(viewModel, result, readArtifactFile): Promise<Uint8Array>` を作った。ファイルは書かない。
- バイト列の SHA-256 を返す `createSha256FingerprintOfBytes` を、`src/core/ids.ts` に加えた。
- テストは25件で、担当のテストと `npm run typecheck` は PASS した。
- 並行作業のため、`npm run verify` と `npm run build` は、実行していない。

## CLI（U17a）への引き継ぎ

- `ReadArtifactFile = (relativePath) => Promise<Uint8Array | null>`
  - CLI は、`artifactFilePath(written.runDirectory, relativePath)` と `readFile` で作る。
  - `ENOENT` は `null` にし、ほかの例外はそのまま投げる。
- `createChatGptBundle(viewModel, written.result, readArtifactFile)` の結果を、`writer.writePresentation(written, { reportHtml, bundle })` に渡す。

## 実装者の判断と、設計者の判断

1. `result` と表示用モデルの Run（runId か Run Status）が違う場合は、`RangeError` を投げる。→ 承認する。
2. `summary.json` と `pages.json` の理由には、日本語の説明を入れず、`{code, detail}` だけにした。→ 承認する。設計書 6.1.9 の「日本語のラベルは入れない」に合う。
3. `pages.json` の Finding と、再試行の前の記録の Evidence は、ID で参照する形にした。→ 承認する。ZIP の中に、同じ内容を2つ持たないためである。
4. `findings.json` の形（`{ finding, evidence: [{evidenceId, path, pointer}], screenshotPaths }`）。3つの一覧の JSON は、最上位を配列にした。→ 承認する。
5. パスの検証を、`chatgpt-bundle.ts` の1か所で行った。→ 承認する。ただし、同じ規則の検証が3か所にあるので、CC-027 として C16c でまとめる。
6. ZIP の固定の時刻は、時差の表記のない文字列にした。→ 承認する。どの時間帯でも、同じバイト列になる。
7. バンドルの中のファイルの名前は、`chatgpt-bundle.ts` に置いた。→ 承認する。Run のディレクトリの配置ではないためである。
8. `distinctSorted` を report から使った。→ 承認する。共通部品台帳を更新した。

## 発見事項と、設計者の判断

1. JSON の書式（字下げ2文字、末尾に LF）の組み立てが、`artifact-writer.ts` と `chatgpt-bundle.ts` の2か所にある。→ CC-026 として登録し、C16c で直す。
2. 相対パスの検証が、3か所にある。→ CC-027 として登録し、C16c で直す。
   - `src/evidence/screenshot-collector.ts` の `portableRelativeArtifactPath`
   - `src/report/artifact-writer.ts` の `SAFE_PATH_SEGMENT`
   - `src/report/chatgpt-bundle.ts` の `assertScreenshotEntryPath`
3. 設計書 6.1.8 に、引数が2つの古い呼び方が残っている。→ 設計者が直した。
