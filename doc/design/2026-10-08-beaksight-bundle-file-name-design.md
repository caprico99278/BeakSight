# BeakSight ChatGPT 用バンドルのファイル名に日時を加える 設計書

- 状態: ユーザーの指示（2026-10-08「出力ファイル beaksight-audit-bundle.zip を beaksight-audit-bundle_yyyyMMddhhmmss.zip として日時情報を加えて」）を反映した設計。
- 関係する文書: Task 14〜17 の設計書（`2026-09-23-beaksight-task-14-17-pipeline-report-cli-design.md`。5.6.7 の Run の ID、6.1.x のバンドル）、中断した Run の再開の設計書（`2026-10-01-beaksight-resumable-run-design.md`。4.8 の実行の記録）、実装タスク指示（ARCH08）、共通部品台帳
- この設計書は、上の文書のうち、バンドルのファイル名（`beaksight-audit-bundle.zip`）の部分だけを置き換える。

## 1. 目的

- バンドルを ChatGPT へ手で渡すとき、どの時点の結果のバンドルかを、ファイル名で見分けられるようにする。中断と再開をくり返す Run では、同じ Run のディレクトリのバンドルが、起動のたびに書き直されるため。

## 2. 決めたこと

### 2.1 ファイル名

- 形: `beaksight-audit-bundle_YYYYMMDDHHmmss.zip`（例: `beaksight-audit-bundle_20261008030930.zip`）。時は 24 時間制。
- 日時: その Run の最後の実行の終わりの時刻（`RunSummary.executions` の最後の `finishedAt`。`run.json` の `finishedAt` と同じ値だが、こちらは型の上で `null` にならない）。バンドルの中身が、いつの時点の結果かを示すため。書き出しの時刻（`Date.now()`）は使わない（同じ Run の結果からは同じ名前になるように。バンドルの中身の決定論と同じ考え）。
- 時刻の基準: UTC。Run の ID（`RUN-YYYYMMDDHHmmss`。UTC。5.6.7）と同じ書式と基準にそろえる。14 桁の書式の作り方は1か所にまとめ、Run の ID とバンドルの名前の両方がそれを使う（今は `src/orchestration/run-id.ts` の中にある。core に移すか、core の部品を作り、`run-id.ts` はそれを使う形にする。core から orchestration を参照しない）。
- 名前を作る関数と、バンドルの名前かどうかを見分ける関数は、置き場所の owner の `src/core/artifact-layout.ts` に置く。見分ける関数は、新しい形と、前の形（`beaksight-audit-bundle.zip`）の両方を、バンドルの名前とみなす。

### 2.2 書き出しと片付け（`ArtifactWriter.writePresentation`。ARCH08）

- 新しい名前でバンドルを書く（今の書き方。一時ファイルと rename）。書き終えた後に、Run のディレクトリの直下にある、ほかのバンドルの名前のファイル（前の形、日時の違う新しい形）を消す。Run のディレクトリには、最新のバンドルを1つだけ残す。
- 消すのは、Run のディレクトリの直下の、リンクでない普通のファイルで、名前がバンドルの名前の形に一致するものだけ。リンク（symlink、junction）はたどらず、消さない。ほかのファイルには触れない。消す前に、パスが Run のディレクトリの中にあることを確かめる（既存の `cleanUpForResume` と同じ考え）。
- 新しいバンドルを書けなかった場合は、古いバンドルを消さない。古いバンドルを消せなかった場合は、`ArtifactWriteError` を投げる（今の書き出しの失敗と同じ扱い）。
- 書いたファイルの一覧（戻り値）には、新しい名前を入れる。

### 2.3 表示

- CLI の結果の「ChatGPT 用のバンドル」の行は、新しい名前のパスを示す（名前は 2.1 の関数で作る。CLI で日時の書式を作り直さない）。
- README: 出力の構成の図、バンドルの説明の節、CLI の結果の例を、新しい名前に直す。名前の日時の意味（最後の実行の終わり、UTC、Run の ID と同じ書式）と、再開のたびに名前が変わり、前のバンドルは消えることを書く。
- HTML レポート、`run.json`、`audit.json`、バンドルの中身（`manifest.json` など）は変えない。

## 3. SSOT と安全性への影響

| 項目 | owner | 扱い |
| --- | --- | --- |
| バンドルのファイル名と、その見分け | `src/core/artifact-layout.ts` | 変更（定数 `RUN_ARTIFACT_FILE_NAMES.bundle` を、名前を作る関数と見分ける関数にする） |
| UTC の 14 桁の日時の書式 | core の1か所 | 新設か移設（Run の ID と共用） |
| バンドルの書き出しと古いバンドルの片付け | `src/report/artifact-writer.ts` | 変更（ARCH08） |

- 安全の不変条件: 変えない。消すのは Run のディレクトリの直下のバンドルの名前のファイルだけ。
- 今の途中の Run（`RUN-20261006010240`）: 次に再開して書き出すと、新しい名前のバンドルができ、前の形の `beaksight-audit-bundle.zip` は消える。保存の形は変えないので、再開に影響しない。

## 4. テスト設計

- 名前: 時刻から 14 桁の名前を作る（UTC。月日時分秒の 0 埋め）。Run の ID と同じ書式になる（同じ時刻から作った Run の ID の数字の部分と一致）。不正な時刻は `RangeError`。見分ける関数が、新しい形と前の形を受け、似た名前（拡張子違い、桁違い、前後の文字つき）を受けない。
- 書き出し: 新しい名前で書く。前の形と、日時の違う新しい形のバンドルが消え、ほかのファイル（`report.html`、似た名前のファイル）は残る。リンクは消さない。新しいバンドルの書き出しに失敗したら、古いものが残る。
- CLI: 結果の行が、新しい名前のパスを示す。
- 結合: Run の後、Run のディレクトリに新しい形のバンドルが1つだけある。再開の後も1つだけ（名前は、最後の実行の終わりの時刻）。

## 5. 設計変更履歴

| 日付 | 契機 | 変更内容 | 影響範囲 |
| --- | --- | --- | --- |
| 2026-10-08 | 初版（ユーザーの指示） | - | `artifact-layout.ts`、`artifact-writer.ts`、`run-id.ts`、CLI の結果、README |
| 2026-10-08 | BN1 の報告 | 14 桁の書式の owner は `src/core/utc-timestamp.ts`（`formatCompactUtcTimestamp`）。`writePresentation` は、バンドルを `RunPresentationBundle`（`bytes`、`lastExecutionFinishedAt`）で受ける。`RUN_ARTIFACT_FILE_NAMES.bundle` は除き、前の形は `LEGACY_BUNDLE_FILE_NAME`。古い文書（2026-08-27 の計画と設計書、Task 14〜17 の設計書）の `beaksight-audit-bundle.zip` の記述は、この設計書で置き換える（書き換えない）。`src/report/chatgpt-bundle.ts` の冒頭のコメントの名前は、次にこのファイルを変えるときに直す | なし（記述） |
