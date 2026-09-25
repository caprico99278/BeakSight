# U16b 実装報告（要約。設計者が保存）

## 結論

完了した。実装者の報告では、`npm run verify` は PASS した（79ファイル、2688件。todo 1件は U17a の UI06）。

作ったものは、次の4つである。

- `AuditRunResult.statusInput`
- 表示用モデル（`buildReportViewModel`）
- 書き出し（`ArtifactWriter.writeRun`、`writePresentation`）
- UI Gate の UI04 と、UI01 の `src/report/**` の分

UI Gate のファイルは、23ms で終わった。

範囲外のテストの変更が、1件ある。`tests/unit/schema-validator.test.ts` の `satisfies AuditRunResult` を、`satisfies Omit<AuditRunResult, 'statusInput'>` に直した。

## 後続が使う型とシグネチャ（要点）

- `ArtifactWriter`
  - `writeRun(result, { outputDirectory })` は、`ArtifactWriteResult` を返す。中身は、`result`、`runDirectory`、`files`、`schemaValid`、`invalidArtifacts` である。
  - `writePresentation(written, { reportHtml?, bundle?: Uint8Array })` は、HTML とバンドルを書く。
- `ArtifactWriteError` は、`path` と `cause` を持つ。
- ファイルの名前とパス
  - `RUN_ARTIFACT_FILE_NAMES`、`PAGE_ARTIFACT_FILE_NAMES`、`AUDIT_ARTIFACT_SCHEMA_VERSION`
  - `pageArtifactRelativePath`
- ページの記録を取り出す関数: `retryRecordsOf`、`earlierAttemptEvidenceIds`、`visibleTextOf`
- `buildReportViewModel(result): ReportViewModel`
  - 持つもの: `summary`、`findings`、`criticalFindings`、`categorySections`、`interactions`、`safety`、`pages`、`evidence`
  - ラベルは持たない。値だけを持ち、ラベルは描く側がカタログで引く。
- 呼ぶ順序（CLI が行う）
  1. `writeRun`
  2. `buildReportViewModel(written.result)`
  3. HTML とバンドルを描く。
  4. `writePresentation`

## 実装者の判断と、設計者の判断

1. HTML とバンドルは、CLI から順に呼び、`writePresentation` で書く。→ 承認する。
   - 理由は2つある。
     - import の循環を避けられる。
     - 表示用モデルを、Run Status を導き直した後の Run から組み立てられる。
   - 書き出しの owner は、`ArtifactWriter` だけのままである（ARCH08）。
   - `createChatGptBundle` は、`Uint8Array` を返す。`outputPath` の引数は、なくす。設計書 6.1.8 と、実装計画を直した。
2. 表示用モデルには、値を入れる。ラベルは、描く側がカタログで引く。→ 承認する。
3. 「重大な指摘」を、色のトーン `critical` で選んだ。→ **承認しない。C16a で直す。**
   - 色は表示の属性であり、節への振り分けの根拠にしてはいけない。
   - 直し方: `SEVERITY_CATALOG` に、明示の属性 `criticalSection: boolean` を加える。
4. `writeRun` のそのほかの振る舞い（検証の単位、detail の形、`structuredClone`、例外の種類、改行）。→ 承認する。
5. UI04 の近似での検出と、理由を付けた除外。→ 承認する。
6. `evidenceOfType` を `src/report` から使った。→ 承認する。
   - 純粋な補助の関数なので、使ってよい。
   - 共通部品台帳の「使ってよい場所」に、report を加えた。

## 発見事項と、設計者の判断

1. 範囲外のテストを、1行だけ直した。→ 承認する。
   - 型を合わせるだけの変更である。
   - テストの条件は、弱めていない。
2. `relatedFindingIds` が、今の Rule では常に空になる。→ **関係づけの規則を広げる**（設計書 6.1.8。C16a で直す）。
   - 最終の試行のスクリーンショットは、次のどちらかの Finding に関係づける。
     - スクリーンショットの Evidence を直接参照する Finding
     - 同じページ・同じビューポートの Evidence（最終の試行のもの）を参照する Finding
   - 再試行の前の試行のスクリーンショットは、直接の参照だけで関係づける。
3. 重複が2つある。→ 共通化候補の CC-022 と CC-023 として登録し、C16a で直す。
   - `REQUIRED_ARTIFACT_INVALID` の detail の組み立て
   - `'pages'` のディレクトリの名前
4. `artifact-writer.ts` が `run-coordinator.ts` を import している。→ **直す**（C16a）。
   - artifact のパスの組み立ては、`src/core/artifact-layout.ts` の1か所に移す。
   - report は orchestration を import しない形にする。
5. 共通部品台帳への登録。→ 設計者が行った。C16a の後に、置き場所を更新する。
