# C3 実装報告（要約。設計者が保存）

## 結論

完了した。修正した項目は、I2・I3・Q1・Q2・M1・M2・Q4・Q6、5.5（discover-candidates の可視判定）、追加の指示（Passive フェーズのダウンロードでは BLOCKED にしない）である。

- 各項目で、先に RED になることを確かめてから GREEN にした。
- 対象の5ファイル・352件と、テスト全体の37ファイル・851件が PASS した。typecheck も PASS した。

## 主な変更

- `hasFreezeEvent` は、`reason === 'INTERACTION_FROZEN'` のダウンロードだけを見て判定する。
- `InteractionAuditResult.lifecycle` の型を、CLOSED だけを取る型にした。NON_TERMINAL の分岐は削除した（I2）。
- 作業フェーズのブラウザ内の評価を、すべて期限付きで待つ（`awaitBrowserWork`）。期限を過ぎてから届いた handle は破棄する（Q1）。無限ループを起こすページでも、約1.1秒で NOT_VERIFIABLE になる。
- 可視判定を `checkVisibility` に置き換えた。1回の呼び出しで、DOM作業量を1消費する（5.5）。
- `boundingBox` は、ページ座標で記録する（Q2）。
- `TEXT_NODE_LIMIT_REACHED` を加えた（M1）。
- 除外した候補を、`excludedInteractionCandidates` に記録する。記録先は `interactionRejectionLedgerRecord` で振り分ける（M2）。
- 不正な `boundingBox` を、上限付きのメッセージで拒否する（Q6）。

## I3（brief の RED 1〜7 とテストの対応）

| brief | テスト（`tests/integration/isolated-interaction.test.ts`） |
| --- | --- |
| 1 | `:3527` never-settling real Guard close |
| 2 | `:3597` rechecks terminal Guard truth after the timeout macrotask yield |
| 3 | `:3643`（rejected の場合）、`:4011`（fulfilled の場合。今回追加） |
| 4 | `:3676`（Q4 で強化） |
| 5 | `:3730` |
| 6 | `:3777` |
| 7 | `:3827` |

brief の当時の RED は、取り戻せない記録の逸脱として扱う（設計書 4.2）。

## 是正した既存のテスト

- M1: 9か所。
- 5.5 の作業量の数え方の変更に合わせて4件。境界の値を1つずらすと失敗することを、実際に確かめた。

## 発見事項と、設計者の判断

1. 描画される要素の入れ子が約199段になると、Chromium の描画プロセスが落ちる（EXECUTION_FAILED になる）。→ 許容する。Task 14 で、ページを FAILED として扱う。
2. 大きさが0の要素を、visible=false のままにした（interaction-policy の不変条件を保つため）。→ 承認する。
3. `MALFORMED_CANDIDATE` は、Safety Ledger に記録しない。→ 承認する。安全のための遮断ではなく、Interaction の Evidence に残るため。
4. 期限の後に届いた handle の破棄に失敗した記録が、結果を返した後で Ledger に加わる場合がありうる。→ 許容する。記録は失われない。
5. 共通部品台帳への登録。→ 設計者が行う。
6. 無限ループを起こすページでも、close は約1秒で終端に達した。
7. `busy-loop-button` のテストは、修正前に RED になることを確かめていない（HEAD に戻す操作が禁止されているため）。→ 記録の限界として許容する。
