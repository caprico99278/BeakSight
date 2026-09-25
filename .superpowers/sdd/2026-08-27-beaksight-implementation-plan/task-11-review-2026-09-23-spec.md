# Task 11 仕様適合レビュー（2026-09-23、独立レビュー担当）

総合判定: 修正が必要（Critical 0 / Important 3 / Minor 3）

fail-closed の中核（候補ごとの使い捨てContext、freeze後の network / navigation / popup / download / WebSocket の遮断と記録、危険な候補の機械的除外、`maxDomWork = 16_384`、single-flight close、invalidation の優先、CLOSED のときだけ所有を解放、work と lifecycle の2軸の不変な結果、受け入れ判定のSSOT、Target Isolation）は成立している。

## 指摘

- **I1**（`src/browser/context-factory.ts:136-141`）: 1回目の raw close が失敗して invalidating に昇格した後、`session.close()` を再試行して CLOSED に達すると、invalidated の reject を握りつぶして正常終了する。9-20設計 §4.3 と plan Step 6 に反する。factory 側の再試行は正しく reject する（`context-factory.test.ts:431`）。`context-factory.test.ts:382` と `isolated-interaction.test.ts:2505` は、逆に `.resolves` を検証して仕様違反を固定している。
- **I2**（`src/interaction/isolated-auditor.ts:55-58, 637-689`）: close の自動再試行（2回）、期限の半分で打ち切るタイマー、`InteractionOwnerCleanupError` の throw は、9-20設計 §3「No automatic timed retry loop」、§10、§6.2・§6.4 と矛盾する。ユーザー承認は brief にしかなく、`doc/design` に追補がない。`finalizeInteractionOutcome` の NON_TERMINAL 分岐（208-213行）は到達しないコードになっている。
- **I3**（記録と実コードのずれ）: auditor の現ハッシュ `8D3DBDD4…` は、progress.md に記録された `0A030F…` と一致しない。cleanup-deadline / interaction-wide DOM budget の brief の修正が反映済みだが、その report が存在せず、progress にも記録がない。RED の証拠も検証記録もない。
- **M1**（`src/interaction/discover-candidates.ts:403, 560-563, 682`）: `maxTextNodes = 512` に達すると、`domWorkUsed < 16,384` でも completeness が `DOM_WORK_BUDGET_REACHED` になり、reason が実際の原因と合わない（9-20設計 §5.3 はテキストの上限を二次的な上限としている）。
- **M2**（`isolated-auditor.ts:426-434`）: 同一Originの `NAVIGATION_HREF` を `blockedExternalActions` に記録している（名前と中身が合わない）。`SUBMISSION_CONTROL`、`RESET_CONTROL`、`FORM_ASSOCIATED` を Safety Ledger に記録していない（tasks 第7章）。
- **M3**（`context-factory.ts:83-88`、`passive-request-guard.ts:1206-1209`）: `acceptDownloads: false` を指定していないため、passive フェーズでページ自身が起こした download は実行され、記録されない（tasks 第7章）。

## 再実行

`npx vitest run tests/integration/isolated-interaction.test.ts tests/integration/passive-request-guard.test.ts tests/component/context-factory.test.ts tests/unit/interaction-policy.test.ts` → 4ファイル / 290件 PASS、終了コード0。skip / only / todo なし。
