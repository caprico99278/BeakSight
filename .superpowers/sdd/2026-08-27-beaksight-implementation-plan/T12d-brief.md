# T12d 指示書: safety rule

最初に `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/implementer-common-rules.md` を読み、そのルールに従ってください。

## 共通の前提

- 設計書: `doc/design/2026-09-23-beaksight-task-12-13-rules-design.md`
- 実装計画: `doc/design/2026-09-23-beaksight-task-12-13-rules-implementation-plan.md`
- 上位の計画: `doc/design/2026-08-27-beaksight-implementation-plan.md` の Task 12・13
- Rule の契約: T12a で作った `src/audit/rule.ts`、`src/audit/rule-catalog.ts`、`src/audit/rule-engine.ts`。作業記録置き場の `T12a-report.md` と `T12a2-report.md` に、シグネチャの一覧がある。T12a2 の後の型を正とする。
- 本物の Rule は、Evidence がない入力でも、例外を投げてはいけない（T12a の既定の Engine のテストが、これを確かめる）。
- 下書きの ruleId は、Rule の ruleId と一致させる。同一性の要素の名前に、予約名 `viewport` を使わない（設計書 第6章）。
- Evidence の型: `src/core/evidence-types.ts`、`src/core/contracts.ts`
- Rule は、Evidence だけを入力にする。ブラウザを操作しない。意味的な判断や美的な判断を、Finding にしない。
- Finding の `message` は、日本語で書く。文言には、判定に使った事実（URL、ステータス、値としきい値など）を含める。
- 観測できなかった値（`NOT_OBSERVED`、`UNSUPPORTED`、null）から Finding を作らない。
- 判定に使う定数は、その Rule のファイルの中に、名前付きの定数として置く。
- 各 Rule について、成立する Evidence と成立しない Evidence の両方でテストする。テストは、`tests/component/<ファイル名>.test.ts` に書く。
- Rule の登録は、自分の担当のファイルが export する配列に加えるだけにする。`rule-catalog.ts` は変更しない。

同時に、ほかの実装者が別の Rule のファイルを実装しています。担当のファイル以外は変更しないでください。

## 変更してよいファイル

- `src/audit/safety-rules.ts`（`SAFETY_RULES`）と `tests/component/safety-rules.test.ts`

T12d0 の変更は、作業ツリーにそのまま残っています。HEAD に戻す操作は禁止です。

## 実装する内容

設計書 5.4 の Safety の Finding の Rule を実装する。入力の Evidence と Rule との対応は、設計書 5.4.1 に従う。

- 入力は、種類が `safety` の Evidence（`SafetyEventsEvidence`）である。これは T12d0 で加えた。シグネチャは、作業記録置き場の `T12d0-report.md` にある。
- テストの見本は、`safetyEventsEvidenceFromSnapshot` を使って、本物の Ledger の snapshot から作ってよい。
- 対応する事象が1つのページとビューポートで多数ある場合は、ページとビューポートと Rule の組ごとに、1つの Finding にまとめる。
  - Finding には、件数と、元になった Evidence の参照を持たせる。
  - 1つのビューポートの入力に Passive と Interaction の2つの Evidence がある場合も、まとめて1つの Finding にする。
- `recordLimits.truncated` が真の Evidence から作る Finding では、次のことを文言に書く: 実際の件数は、書いた件数より多い可能性がある。
- 凍結中に遮断した GET・HEAD のリクエストと、`blockedInteractionNavigations` は、Finding にしない（設計書 5.4.1）。
- 不変条件の違反は、Finding にしない。違反は Evidence にも含まれない。

## 受け入れ条件

- 担当の Rule が、すべて実装され、登録されている。
- 各 Rule について、成立する場合と成立しない場合のテストがある。修正前（実装前）に RED、実装後に GREEN になる。
- `npm run typecheck` と、担当のテストが PASS する。

## 報告

共通ルールの形式で報告してください。実装した Rule の一覧（ruleId、version、category、severity、判定の要点）を書いてください。
