# F05 指示書: 型の定義元を1か所にする、Run Status の入力の構造化

最初に `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/implementer-common-rules.md` を読み、そのルールに従ってください。

## サブタスク

- ID: F05
- 目的: C8 で core にもう一度定義された、ほかの owner の型の定義を1か所にする（SSOT）。あわせて、`deriveRunStatus()` の入力の `incompleteReasons` を構造化した形にする。
- 背景: 作業記録置き場の `C8-report.md`（C8 の実装報告）の発見事項2と5

同時に、ほかの実装者が DEF-001（`src/evidence/accessibility-collector.ts` とそのテスト）を修正しています。これらのファイルは変更しないでください。

## 変更してよいファイル

- `src/core/evidence-types.ts`、`src/core/contracts.ts`、`src/core/status.ts`
- `src/crawl/normalize-url.ts`、`src/crawl/admission-policy.ts`
- `src/safety/interaction-policy.ts`
- `src/config/types.ts`
- テスト: `tests/unit/core-contracts.test.ts`、`tests/unit/status.test.ts`、および型の変更に伴う最小限の import の修正

## 修正する内容

1. **型の定義を1か所にする**:
   - C8 で `src/core/evidence-types.ts` に定義された次の型は、元の owner の型と同じ意味である。
     - `NormalizedHttpUrlEvidence`（と brand）
     - `LinkNormalizationEvidence`
     - `LinkAdmissionEvidence`
     - `InteractionCandidateEvidence`（矩形と href の種類を含む）
     - `EffectiveAuditConfig`
   - core はほかのディレクトリを import できない。そのため、定義は core に置く。元の owner のファイル（`normalize-url.ts`、`admission-policy.ts`、`interaction-policy.ts`、`config/types.ts`）は、core の型を import し、自分の型としてその型を使う（型の別名、または re-export）。
   - 同じ形の型を2か所で定義している状態をなくす。owner の関数の振る舞いは変えない。
   - `core-contracts.test.ts` の、2つの型が等しいことを確かめるテストは、定義が1か所になった後は不要になる。owner の型が core の型そのものであることを確かめるテストに置き換える。
2. **Run Status の入力の構造化**:
   - `src/core/status.ts` の `RunStatusInput.incompleteReasons` を、`readonly IncompleteReason[]`（`src/core/contracts.ts` の型）にする。
   - `deriveRunStatus()` の判定の意味は変えない。
   - `tests/unit/status.test.ts` を、新しい型に合わせる。

## 受け入れ条件

- 上の5つの型の定義が、`src/core/evidence-types.ts` の1か所だけにある（`grep` で確かめて報告する）。
- `npm run typecheck` と、変更したファイルに関係するテストが PASS する。
- 振る舞いを変えていない。

## 報告

共通ルールの形式で報告してください。
