# F08 実装報告（要約。設計者が保存）

## 結論

完了した。指示書の N1・N2・M1・M2・M3・V13 と、追加の指示の項目7〜10を実装した。

`npm run verify` は、39ファイル・1124件がすべて PASS し、build も成功した。

## 変更した Evidence の形

| 型 | 変更 |
| --- | --- |
| `DomEvidence` | `scrollPosition` と `unassociatedFields` を加えた。 |
| `FormFieldEvidence` | `visible` を加えた。 |
| `VisibleTextEvidence` | `nodeLimitReached` を加えた。`truncated` は、文字数による切り詰めだけを表す。 |
| `DomTruncationEvidence` | `omittedUnassociatedFieldCount` と `omittedLinkCount` を加えた。 |
| `AccessibilityEvidence` | `scrollPosition` を加えた（PARTIAL のときは null もありうる）。 |
| `LayoutIncompleteReason` | `LAYOUT_COMPARISON_LIMIT_REACHED` を加えた。 |
| `ScreenshotEvidence.viewport` | `ViewportProfile` にした。 |
| `collectDomEvidence()` の第3引数 | `LinkDiscoveryEvidence` にした。 |
| `discoverLinks()` | `LinkDiscoveryEvidence` を返すようにした。`discoverLinkEvidence()` は削除した。 |
| context-factory | ビューポートの値の確認に、`isPositiveSafeInteger` を使うようにした。 |

## 発見事項と、設計者の判断

1. 文書または body をたどった後、内側の領域の走査が上限に達しても COMPLETE にし、`innerScrollScan.scanLimitReached` に記録するだけにした。
   → 承認する。文書をたどったこと自体は完了している。上限に達した事実は Evidence に残るので、隠してはいない。これを PARTIAL にすると、要素の多い実サイトがすべて PARTIAL になる。設計書 5.1 に明記する。
2. 以前の振る舞いを固定していたテストを、仕様に合わせて変えた。→ 承認する。
3. M3 の近似（`position: fixed` の要素は、祖先による切り取りを受けないとみなす、など）。→ 承認する。
4. 見出しとラベルの `truncated` には、ノード数の上限に達した場合も含まれる。→ 許容する。型の説明に書いてある。
5. `readDocumentScrollPosition()` を共通部品台帳に登録する。→ 設計者が登録する。
6. DOM のスキーマの一部は、RED を見ていない。→ 記録の限界として許容する。
