# C18a 指示書: DEF-012 外部スキームへの移動の検出と記録（Guard）

最初に `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/implementer-common-rules.md` を読み、そのルールに従ってください。末尾の「一時ディレクトリの扱い」も守ってください。

## サブタスク

- ID: C18a
- 目的: ページのスクリプトによる外部スキームへの移動を、Guard が検出して Safety Ledger に記録する。headed では、不変条件の違反として Context を閉じる。
- 設計書: `doc/design/2026-09-25-beaksight-pre-task-19-cleanup-design.md` の第4章（とくに 4.1 と 4.2）
- 実装計画: `doc/design/2026-09-25-beaksight-pre-task-19-cleanup-implementation-plan.md` の C18a
- 不具合台帳: 作業記録置き場の `defects.md` の DEF-012
- 調査の実験の記録: `C:\Users\ocean\AppData\Local\Temp\claude\C--Develop-github-repo-BeakSight\c7d3723a-f7c4-4979-913c-ece0b3289778\scratchpad\s03\`（`exp.ts`、`out-*.txt`。読むだけにする）
- 上位の文書: `doc/design/2026-08-27-beaksight-implementation-tasks.md` の Safety Invariants と、SSOT Owner Matrix の Passive HTTP authority
- 共通部品台帳: `doc/design/beaksight-shared-components.md`（`SafetyLedger`、`SAFETY_EVENT_KINDS`、`SAFETY_EVENT_KIND_CATALOG` の行）

これまでの変更は、作業ツリーにそのまま残っています。HEAD に戻す操作は禁止です。

このサブタスクは単独で実行します。

## 変更してよいファイル

- `src/safety/passive-request-guard.ts`（外部スキームへの移動の検出と記録、headed の扱いに限る。既存の判定と違反の扱いは、変えない）
- `src/safety/safety-ledger.ts`（新しい事象の一覧の記録に限る）
- `src/browser/context-factory.ts`（Guard の取り付けに、headed かどうかを渡すことに限る）
- `src/core/evidence-types.ts`（`SafetyEventsEvidence` と `SAFETY_EVENT_KINDS` に、新しい事象の一覧を加えることに限る）
- `src/core/limits.ts`（記録の上限を加える場合に限る）
- `schemas/`（新しい事象の一覧を加えることに限る）
- `src/presentation/catalog.ts`、`src/presentation/messages.ts`（新しい事象の種類のラベルと文言に限る）
- `src/audit/safety-rules.ts`（新しい事象の Finding の扱いに限る。今の Rule の振る舞いは変えない）
- `src/report/view-model.ts`（新しい事象の一覧が、Safety の事象の一覧に自動で入らない場合に限る）
- テスト:
  - Guard、Ledger、context-factory、evidence の型、スキーマ、カタログ、Safety の Rule、表示用モデルの、対応する既存のテスト
  - 新規のテスト（例: `tests/integration/external-scheme-navigation.test.ts`）
  - `tests/helpers/audit-run-fixture.ts`（新しい事象の見本を加えることに限る）

`tests/integration/safety-gates.test.ts` は、C18b で広げるので、変えません。ただし、この変更で既存の Gate が FAIL した場合は、止まって報告してください。

## 作るもの

1. **検出**（設計書 4.2）
   - Guard は、Playwright の `request` の事象で、navigation のリクエスト（`request.isNavigationRequest()`）のうち、URL のスキームが次の一覧にないものを、外部スキームへの移動の試みとして検出する。
     - 一覧: `http:`、`https:`、`about:`、`data:`、`blob:`
     - この一覧は、1か所の定数にする。置き場所は、Passive HTTP authority の owner の中か core とし、実装者が決めて報告する。
   - 対象: main frame と subframe、Passive の段階と Interaction の段階（凍結の前と後）のすべて。
   - 検出の処理が例外を投げても、Guard の既存の fail-closed の扱い（違反と invalidation）に合わせる。
2. **記録**
   - Safety Ledger に、新しい事象の一覧 `externalSchemeNavigations` を加える。
     - 各事象が持つもの: URL（伏せ字の規則に従う。長さの上限あり）、スキーム、frame の種類（main か sub）、段階（Passive か Interaction）
   - `SafetyEventsEvidence`、`SAFETY_EVENT_KINDS`、スキーマ、`SAFETY_EVENT_KIND_CATALOG`、`messages.ts` に、同じ一覧を加える。
     - 型の検査（書き漏れと余分）と、UI05 が、自動で対象にすること。
   - 記録の上限は、既存の事象の一覧と同じ扱いにする。上限を超えた場合は、`recordLimits` に反映する。
3. **headed の扱い**
   - factory から Guard の取り付けに、headed かどうかを渡す。値の出どころは、設定（`config.browser.headed`）の1つだけにする。
   - headed で、外部スキームへの移動を検出したら、次のようにする。
     - 不変条件の違反（例: `EXTERNAL_SCHEME_NAVIGATION_IN_HEADED_MODE`）を記録する。
     - Context を閉じる（既存の invalidation の経路を使う）。
   - headless では、違反にしない。記録だけにする。
4. **既存の違反の扱いは、緩めない**
   - `window.open` による外部スキームは、今は `FRAME_CLASSIFICATION_FAILED` の違反になる。これは、そのまま残す。
   - あわせて `externalSchemeNavigations` にも記録できる場合は、記録する。記録できない場合は、その理由を報告する。
5. **Finding**
   - 新しい事象の Finding の扱いは、既存の `blockedExternalActions` と同じ考え方にする（`safety-rules.ts`）。
   - 新しい Rule を加える場合は、`RULE_CATALOG` への登録と、Rule のテストを加える。
   - 今の Rule の振る舞いは、変えない。

## テスト

- 各経路（`location.href`、`location.assign`、meta refresh、iframe の src、スクリプトによる anchor の click、form の action、本物の click による移動）と、3つのスキーム（`tel:`、`mailto:`、独自のスキーム）で確かめる。
  - Guard の付いた Context（headless）で、`externalSchemeNavigations` に記録されること。
  - 違反がないこと。
  - page の URL が変わらないこと。
- Interaction の段階（凍結の後）でも、記録されること。
- headed の扱い: 実際の headed のブラウザは起動しない。
  - headless のブラウザで、Guard に「headed である」と注入する。
  - 違反が記録され、Context が閉じることを確かめる。
- 既存の違反（`window.open` の `FRAME_CLASSIFICATION_FAILED`）が、そのまま残ること。
- 記録の上限、スキーマ、カタログ、UI05、型の検査。
- 既存のすべてのテストと Gate が、PASS すること。
- 修正の前に RED になること。
  - 例: 今の Guard では、`externalSchemeNavigations` が存在しないか、空であること。

## 厳守事項（このサブタスクに固有のもの）

- **Chromium は headless だけで起動する。** headed（`headless: false`）で起動してはいけない。実際に電話や通話やメールのアプリが、この PC で起動するおそれがあるためである。
- 外部スキームの URL は、テストのページの中だけで使う。実在する宛先（電話番号、メールアドレス）は使わない。
  - 例: `tel:+10000000000`、`mailto:nobody@example.invalid`、`beaksight-test-app:probe`

## 受け入れ条件

- 各テストが、修正前に RED、修正後に GREEN になる。
- 既存のテストのケースと期待値を、弱めない。既存の違反の扱いを、緩めない。
- すべての Gate（S、A、ARCH、UI）が PASS する。
- `npm run typecheck` が PASS する。
- `npm run verify` が PASS する。

## 報告

共通ルールの形式で、日本語で報告してください。報告には、次のものを入れてください。

- 検出の場所（ファイル:行）
- 許可するスキームの一覧の置き場所
- headed の値の受け渡しの経路
- 新しい違反のコード
- C18b（Gate の拡張）の実装者が使う、Ledger の記録の形

これらは、Guard の独立レビュー（RC18a）で使います。
