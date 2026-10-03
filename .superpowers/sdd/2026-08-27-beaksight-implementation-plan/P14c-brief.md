# P14c 指示書: Passive の段階の Page Auditor

最初に `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/implementer-common-rules.md` を読み、そのルールに従ってください。

## サブタスク

- ID: P14c
- 目的: 1つのページを、Desktop と Mobile の両方のビューポートで監査する `PageAuditor` を作る。このサブタスクでは、Interaction の段階を作らない。Interaction は、P14d で加える。
- 設計書: `doc/design/2026-09-23-beaksight-task-14-17-pipeline-report-cli-design.md`
  - 第3章
  - 4.2〜4.4
  - 4.5（とくに 4.5.1、4.5.2、4.5.4〜4.5.7）
- 実装計画:
  - `doc/design/2026-09-24-beaksight-task-14-implementation-plan.md` の P14c
  - 上位の計画 `doc/design/2026-08-27-beaksight-implementation-plan.md` の Task 14 の Step 1〜3
- 前の報告: 作業記録置き場の `P14a-report.md`、`P14b-report.md`。使う型と関数のシグネチャは、この2つにある。
- 共通部品台帳: `doc/design/beaksight-shared-components.md`
- 参考: `tests/unit/schema-validator.test.ts` の、Passive の収集を一式つないだ箇所。1754行目付近に、既存の組み立ての例がある。

これまでの変更は、作業ツリーにそのまま残っています。HEAD に戻す操作は禁止です。

同時に、別の実装者（DEF-002）が `src/core/ids.ts` とそのテストを変えています。担当のファイル以外は変更しないでください。

## 変更してよいファイル

- 新規: `src/orchestration/page-auditor.ts`
  - 内部の処理を分けたい場合は、`src/orchestration/` の下に新しいファイルを作ってよい。その場合は、分けた理由を報告する。
- 新規のテスト: `tests/integration/page-auditor.test.ts`
- `fixtures/site/` への新しいページの追加
- `src/audit/cross-page-rules.ts`（`CrossPageViewportResult` の別名が残っていれば、使う側に合わせる程度に限る）

## 作るもの

### 1. 入口

`PageAuditor.audit(url, pageId): Promise<PageAuditOutcome>` を作る。設計書 4.5.1 に従う。

- 依存するものは、コンストラクタで注入する。次のものが対象である。
  - `BrowserContextFactory`
  - `AuditConfig`
  - `IdAllocator`
  - 時計（`() => Date`）と、現在の時刻（`() => number`）
  - `RuleEngine` の作り方（採番器の連番から作る。4.5.3）
  - スクリーンショットの保存先の根のディレクトリ
  - 必要なら、collector の差し替え口（テストで例外を起こすため）
- Desktop のビューポートを監査し、次に Mobile のビューポートを監査する。
- ページの状態は、`derivePageAuditStatus` で決める。

### 2. ビューポートごとの処理

設計書 4.5.2 の 1〜8 のうち、Interaction を除いたものを行う。

1. Passive Context と page を作る。page は `createPassivePage` で作る。
2. collector を取り付ける。
   - performance の init script は、ナビゲーションの前に入れる。
   - network と console は、`attach` する。
3. `navigatePage` でナビゲーションする。
   - `OK` 以外の場合は、次のことを行い、6 に進む。
     - network と console の Evidence を記録する。
     - ビューポートの状態を `FAILED` にする。
     - 理由を `NAVIGATION_FAILED` にし、detail を結果の種類にする。
4. DOM の準備を待つ（`waitForPageSettled`）。次に、`controlledScroll` を行う。
   - どちらも、`PAGE_SETTLING_PACING`、`CONTROLLED_SCROLL_PACING`、`stageDeadline` を使う。
   - scroll の結果は、`scroll` の Evidence として記録する。
5. 収集を行う。
   - DOM、layout、color、accessibility、performance を集める。
     - Desktop では、layout の幅の走査も行う（4.5.6）。
     - 走査の幅は、`stressWidths` から、主要な2つのビューポートの幅を除いたものとする。
   - スクリーンショットを撮る。
   - Link を抽出する（Desktop だけ）。
   - 設定で無効な段階は、実行しない（4.5.5）。
6. Safety の Evidence を作る。
   - Passive の Ledger と、幅の走査の Ledger から作る（`safetyEventsEvidenceFromSnapshot`）。
   - `summarizePageSafety` の入力も集める。
7. page rule を評価する。
   - `RuleEngine` は、評価のたびに、採番器の連番で作る。
   - 評価が終わったら、`nextFindingSequence` を採番器に戻す。
   - Rule の評価が失敗した場合は、ビューポートを `PARTIAL` にし、理由を `RULE_EVALUATION_FAILED` にする。
8. `finally` で、page と Context を必ず閉じる。
   - 閉じる処理の失敗も、隠さない。理由として記録する。

### 3. 失敗の扱い

設計書 4.5.5 に従う。

- collector が PARTIAL を返した場合と、例外を投げた場合は、次のようにする。
  - ビューポートを `PARTIAL` にする。
  - 理由は、`collectorIncompleteReason(段階, 理由)` で作る。
  - 例外の場合の理由は、`pageFailureReason(page)` の値とする。
- スクリーンショットが失敗した場合は、途中まで書いたファイルを消す。
- 描画プロセスが落ちた場合（crash）は、ビューポートを `FAILED` にする。
- `AUDITED` になるのは、次の2つを満たす場合だけである。
  - 必須の段階が、すべて COMPLETE で終わった。
  - Rule の評価の失敗がない。

### 4. 結果

- `ViewportAuditResult` には、次のものを入れる。
  - `requestedUrl`、`finalUrl`、`httpStatus`、`navigationOutcome`、`status`、`incompleteReasons`
- `PageAuditResult` には、次のものを入れる。
  - 両方のビューポートの結果
  - すべての Evidence（ビューポートが付いたもの）
  - すべての Finding
  - ページ全体の理由
- `PageAuditOutcome.safety` は、`summarizePageSafety` の結果とする。
- 結果は、`validateArtifact` で `page` のスキーマに合うことを、統合テストで確かめる。
- 結果は、深く凍結する。

## テスト

`tests/integration/page-auditor.test.ts` を作り、fixture のサーバで確かめる。

1. **Task 14 Step 1**
   - 壊れた画像と、console のエラーがあるページを監査する。次のことを確かめる。
     - Evidence が先にそろっている。
     - Finding が、正しい Evidence の ID を参照している。
     - スクリーンショットのファイルがある。
     - 状態が `AUDITED` である。
2. **Task 14 Step 3**
   - Mobile でだけ横にはみ出すページを監査する。次のことを確かめる。
     - Desktop は `AUDITED` である。
     - Mobile に layout の Finding がある。
     - ページ全体の集計で、ビューポートの状態が隠れない。
3. **ナビゲーションの失敗**
   - 期限切れ（`/__slow`）と、外部へのリダイレクトを監査する。次のことを確かめる。
     - ビューポートが `FAILED` になる。
     - `navigationOutcome` が正しい。
     - network の Evidence が記録される（設計書 4.3.0）。
4. **collector の例外**
   - collector を差し替えて、例外を起こす。次のことを確かめる。
     - `COLLECTOR_INCOMPLETE` と `<段階>:<理由>` の理由が記録される。
     - Context が閉じられる。
5. **幅の走査**
   - Desktop の layout の Evidence に `stressSweep` がある。
   - Mobile の `stressSweep` は null である。
   - 主要な幅は、走査されない。
6. **大きさの指定のない SVG 画像**（T12b の未確認事項）
   - `IMAGE_LOAD_FAILED` が誤って出ないかを確かめる。
   - 誤って出る場合は、テストを書いたうえで止まり、報告する。直さない。
7. **スキーマ**
   - 結果が、`page` のスキーマに合う。
8. **後片付け**
   - テストの後に、ブラウザに残っている Context が0個である。

## 受け入れ条件

- 各テストが、修正前に RED、修正後に GREEN になる。
- 共通部品台帳にある部品を使い、同じ意味の処理を新しく書かない。
  - 対象の例: ID、状態の集計、理由の書式、URL の正規化、期限の計算、凍結、エラーの文字列。
- `npm run typecheck` と、担当のテストが PASS する。
- `npm run verify` は実行しない（並行作業のため）。全体の verify は、設計者が行う。

## 報告

共通ルールの形式で、日本語で報告してください。報告には、次のことを書いてください。

- `PageAuditor` のシグネチャと、注入するもの
- 実装で判断したこと
