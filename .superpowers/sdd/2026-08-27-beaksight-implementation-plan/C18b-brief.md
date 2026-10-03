# C18b 指示書: GATE-S03 の拡張（外部スキームへの移動）と、GATE-S08 の click の確認

最初に `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/implementer-common-rules.md` を読み、そのルールに従ってください。末尾の「一時ディレクトリの扱い」も守ってください。

## サブタスク

- ID: C18b
- 目的:
  - Safety の Gate の S03 を、ページのスクリプトによる外部スキームへの移動（DEF-012）まで広げる。
  - GATE-S08 の Interaction の確認に、click が行われたことを加える（R18 の M2）。
- 設計書: `doc/design/2026-09-25-beaksight-pre-task-19-cleanup-design.md` の 4.2（Gate を広げる）と第5章（R18-M2）
- 実装計画: `doc/design/2026-09-25-beaksight-pre-task-19-cleanup-implementation-plan.md` の C18b
- 前の報告: 作業記録置き場の次のもの
  - `C18a-report.md`（Ledger の記録の形と、`window.open` の扱い）
  - `T18b-report.md`（今の Safety の Gate）
  - `R18-review-result.md`
- 共通部品台帳: `doc/design/beaksight-shared-components.md`（`tests/helpers/gate-harness.ts` の行）

これまでの変更は、作業ツリーにそのまま残っています。HEAD に戻す操作は禁止です。

**このサブタスクは、C18c（`tests/architecture/`、`src/audit/safety-rules.ts` の名前の変更、`src/orchestration/preflight.ts`、`page-auditor.ts` か `layout-collector.ts`、`tests/unit/text.test.ts`）と並行で実行します。**

- 下の「変更してよいファイル」の外は、変更しないでください。
- `npm run verify` と `npm run build` は、実行しないでください。全体の verify は、設計者が行います。
- 担当のテストと `npm run typecheck` は、実行してかまいません。
  - ほかの実装者の作業中のファイルから、型のエラーやテストの失敗が出た場合は、自分のファイルのものでないことを確かめて、報告に書いてください。

## 変更してよいファイル

- `tests/integration/safety-gates.test.ts`（S03 と S08 に限る。ほかの Gate の条件は変えない）
- `tests/helpers/gate-harness.ts`（補助を加えることに限る。既存の振る舞いは変えない）
- `fixtures/site/`（外部スキームへの移動を試みるページを加えることに限る。既存のファイルは変えない）
- `tests/integration/gate-fixtures.test.ts`（新しい fixture の対照の確認を加えることに限る）

`src/` は、変更しません。Gate が今のコードで FAIL した場合は、止まって事実を報告してください。

## 作るもの

1. **外部スキームへの移動を試みる fixture**
   - 経路ごとのページ、または1つのページで経路を選べる形にする。
     - 経路: `location.href`、`location.assign`、meta refresh、iframe の src、スクリプトによる anchor の click、form の action、ボタンの click による移動
   - スキーム: `tel:`、`mailto:`、独自のスキーム
   - 宛先は、実在しないものにする（例: `tel:+10000000000`、`mailto:nobody@example.invalid`、`beaksight-test-app:probe`）。
   - Interaction の段階で使うため、ボタンの click で移動するページも置く。
     - このページは、Interaction の候補の方針で拒否されない形にする。例えば、`href` を持たない `button` の `onclick` で移動させる。
   - 対照の確認を、`gate-fixtures.test.ts` に加える。Guard のない Context で、Playwright の `request` の事象に、その外部スキームの URL が来ることを確かめる。
2. **GATE-S03 の拡張**
   - 既存の S03 のテスト（候補の方針による拒否）は、残す。
   - 新しいテストを加える。テストの名前は、`GATE-S03` で始める。
     - Passive の段階: Guard の付いた Passive の page で、各経路と各スキームの fixture を開く。次のことを確かめる。
       - Ledger の `externalSchemeNavigations` に、そのスキームと経路の記録がある（`phase: 'PASSIVE'`）。
       - 違反がない（headless）。
       - page の URL が変わらない。
       - サーバには、そのページの GET だけが届く（`openServerWindow` の差分）。
     - Interaction の段階: ボタンの click で外部スキームへ移動するページで、本物の `createInteractionSession` の上で `auditInteraction` を行う。次のことを確かめる。
       - click が行われる（候補が拒否されていない）。
       - `externalSchemeNavigations` に `phase: 'INTERACTION'` の記録がある。
       - 結果が `BLOCKED_BY_SAFETY` になる。
       - サーバには、そのページの GET だけが届く。
     - headed の扱い:
       - headless のブラウザで、設定を `headed: true` にして factory を作る。そのうえで、Passive の page で外部スキームへの移動を試みる。
       - 違反 `EXTERNAL_SCHEME_NAVIGATION_IN_HEADED_MODE` が記録され、Context が閉じることを確かめる。
       - **実際の headed のブラウザは、起動しない。**
     - Run の段階:
       - fixture を開始の URL にした Run（同じプロセスの中の `runCli`。headless）を1件行う。
       - Run の artifact の Safety の Evidence に、外部スキームへの移動の記録が残ることを確かめる。
       - Run Status が `ABORTED_BY_SAFETY` にならないこと（headless）も確かめる。
   - 数え方は、今の Gate と同じく、サーバの境界の差分とする。Ledger は、記録の確認として使う。
   - 経路とスキームの組み合わせが多い場合は、`it.each` などで、テストを分けてよい。
3. **GATE-S08 の click の確認**（R18 の M2）
   - S08 の Interaction の確認に、`result.status` が `REJECTED_UNSAFE` でないこと（click が行われたこと）を加える。
   - Passive の側でも、登録の試みが起きたことを確かめる。
     - 例: ページの中で `navigator.serviceWorker.register` が呼ばれたことを、初期化のスクリプトで数える。
   - Gate の条件は、弱めない。
4. **実行時間**
   - `safety-gates.test.ts` の全体が、1分程度までに収まることを目安にする。所要時間を報告に書く。

## 厳守事項（このサブタスクに固有のもの）

- **Chromium は headless だけで起動する。** headed（`headless: false`）で起動してはいけない。この PC で、電話や通話やメールのアプリが実際に起動するおそれがあるためである。
- 外部スキームの URL には、実在する宛先を使わない。

## 受け入れ条件

- 新しい fixture の対照の確認が、fixture がない状態で RED、置いた後に GREEN になる。
- `GATE-S03` の新しいテストと `GATE-S08` の追加の確認が、PASS する。
  - Gate のテストは、`src/` を変えないので、実装を壊して RED を作ることはできない。代わりに、各 Gate の対照の確認を置く。
- 既存のテストのケースと期待値を、弱めない。
- `npm run typecheck` が PASS する。
- `npm run verify` は実行しない（並行作業のため）。

## 報告

共通ルールの形式で、日本語で報告してください。経路とスキームごとの確認の結果の表と、対照の確認の有無を書いてください。
