# C18n 実装報告（CC-010 の残りの1: Interaction の理由をコードと詳細に分ける）

## 結論
完了（1回の Blocker の後）。Interaction の Evidence の `reason`（`work.reason` を含む）を閉じた一覧のコードにし、必須の `reasonDetail` を加えた。`lifecycle` と `InteractionOwnerCleanupError` の `lifecycle` も同じ形にした。実装者の `npm run verify`: 終了コード 0、98ファイル、3,621件 PASS、ビルド PASS。

## 経緯
- 1回目: Blocker で停止（ファイルの変更なし）。変えてよいファイルの一覧に無い4つのテスト（`run-coordinator`、`page-auditor`、`audit-run-fixture`、`schema-enum-consistency`）を直す必要があった。設計者が案1（4つを加える。確かめる内容を弱めない）を採り、再開させた。
- 洗い出しの結果で、設計書を訂正した（NOT_VERIFIABLE は55個。lifecycle に `OWNER_CLOSE_NON_TERMINAL`）。

## 変更したファイル
- `src/core/evidence-types.ts`: コードの一覧（`INTERACTION_REASON_CODES`（69個）、`INTERACTION_REASON_CODES_BY_STATUS`、`INTERACTION_NOT_VERIFIABLE_REASON_CODES`（55個）、`INTERACTION_LIFECYCLE_REASON_CODES`（4個））。`reason` をコードの型に、`reasonDetail: string | null` を必須に（Evidence、`work`、`lifecycle`）。
- `src/interaction/isolated-auditor.ts`: `INTERACTION_NOT_VERIFIABLE_REASONS` を区分の対応だけにした（`satisfies` で網羅を保証。55個の区分と順序が前と同じことをスクリプトで確認）。`outcome<S>` が status に合うコードだけを型で受け取る。`interactionFailureDetail`（`safeErrorMessage` と上限512）。Safety Ledger の文言は変えていない。
- `schemas/page.schema.json`: `$defs/interactionReasonCode`（69値）、`$defs/interactionStatusReason`（status とコードの組み合わせを if/then で表す）、`reasonDetail` を必須、`lifecycle.reason` を enum（4値と null）。版と長さの上限は変えていない。
- `src/interaction/discover-candidates.ts`: `domWork.exhausted` を消した。
- `src/report/view-model.ts`: `InteractionView` の `reason` をコードの型にし、`reasonDetail` を加えた（値は Evidence のまま）。
- `tests/helpers/audit-run-fixture.ts`: 見本の理由を、status に合う最初のコードに。詳細の既定は `reason <番号>`。`HOSTILE_TEXT` は `reasonDetail` に移した。
- `html-report.ts`、`page-auditor.ts`: 変更なし（型が通った）。

## コードの一覧（status ごと）
- VERIFIED: `OBSERVABLE_STATE_CHANGED`
- REJECTED_UNSAFE: `INTERACTION_REJECTION_REASONS` の9種
- BLOCKED_BY_SAFETY: `SAFETY_FREEZE_BLOCKED`、`OWNER_CLOSE_SAFETY_FAILURE`
- NOT_VERIFIABLE: 55個（前のキーのまま）
- EXECUTION_FAILED: `EXECUTION_FAILED`、`CLICK_FAILED`
- lifecycle: `SESSION_NOT_OPENED`、`OWNER_CLOSE_TIMED_OUT`、`OWNER_CLOSE_FAILED`、`OWNER_CLOSE_NON_TERMINAL`

## 経路ごとの対応（要点）
| 経路 | 新の `reason` / `reasonDetail` |
| --- | --- |
| 下準備の失敗（スクロール、hover、focus） | `*_PREPARATION_FAILED` / 整えた文言か null（前の英文の接頭辞は付けない） |
| 探し直しが完了しない | `CANDIDATE_REDISCOVERY_INCOMPLETE` / completeness の値 |
| 保持した対象の切断 | `RETAINED_IDENTITY_LOST` / identityStatus の値 |
| click の期限切れ | `CLICK_TIMED_OUT` / 整えた文言か null |
| そのほかの click の失敗 | `CLICK_FAILED` / 整えた文言か null（前は期限切れと見分けられなかった） |
| 包括的な catch | `EXECUTION_FAILED` / 整えた文言か null |
| 凍結の後の遮断 | `SAFETY_FREEZE_BLOCKED` / null |
| close の安全の失敗 | `OWNER_CLOSE_SAFETY_FAILURE` / null |
| VERIFIED | `OBSERVABLE_STATE_CHANGED` / null |
| lifecycle | null / null、`SESSION_NOT_OPENED` / null、`OWNER_CLOSE_FAILED` / 文言か null、`OWNER_CLOSE_TIMED_OUT` / null、`OWNER_CLOSE_NON_TERMINAL` / null |

- 最終の status を BLOCKED_BY_SAFETY に変えた場合、最上位の `reasonDetail` は null。`work` の理由と詳細は残る。

## テスト（実装者）
- RED: `isolated-interaction` で440件中265件が失敗（英文がコードの形に合わない）。スキーマの受け入れと enum の対応のテストも、スキーマの変更の前に失敗。
- `isolated-interaction` では、`auditInteraction` をラップして、すべての結果とクリーンアップのエラーで、理由が status に合うコードであること、詳細の形、最終の status と `work` の関係を確かめる。
- 件数の前と後: `isolated-interaction` 438→440、`schema-validator` 332→421、`schema-enum-consistency` 97→104、ほかは同じ。削除と skip はない。
- RED を単独で確かめていないテスト: `page-auditor`、`page-auditor-interaction`、`audit-run-fixture`、`view-model`、`html-report`（見本とテストを同じ段階で直したため。同じ経路の RED は `isolated-interaction` とスキーマで確かめた）。

## 発見事項
1. HTML は今も `renderCode(item.reason)` だけを示すので、詳細が C18o まで出ない。`html-report.test.ts:241` の `HOSTILE_TEXT` のエスケープの確かめは、コードの表示と、生の `<script>` が含まれないことの確かめに一時的に替えた。C18o で戻す必要がある。
2. 実装者が scratchpad 直下の `before.json`（C18e の比べ方の記録）を上書きした。リポジトリへの影響はない。C18e の比べ方の結果は報告に記録済みなので、影響はない。

## 設計者の確認（2026-09-25）
- 変更の範囲: `git status` で、指示と追補の範囲に収まっていることを確かめた。`src/` に、英文の理由（`Interaction activity was blocked…`、`Observable interaction state changed`）は残っていない。
- `npm run typecheck`: PASS。
- `tests/architecture`、`schema-validator`、`schema-enum-consistency`、`view-model`、`html-report`、`audit-run-fixture`、`run-coordinator`: 9ファイル、733件 PASS。
- 発見事項1: C18o の指示書に、詳細の表示と `HOSTILE_TEXT` のエスケープの確かめを戻すことを、受け入れ条件として加えた。
- 全体の verify は、C18o と C18m の後に設計者が行う。

## 設計者の verify（2026-09-25。C18n・C18o・C18m の後）

- `npm run verify`: 終了コード 0。98ファイル、3,629件 PASS。ビルド PASS。
