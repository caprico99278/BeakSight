# C18o 実装報告（CC-010 の残りの2: Interaction の理由の日本語の説明と表示）

## 結論
完了。Interaction の理由（69個）と lifecycle の理由（4個）に日本語の説明を置き、HTML レポートで、ページの未完了の理由と同じ部品により、コード、説明、詳細として示すようにした。C18n で一時的に替えた `HOSTILE_TEXT` のエスケープの確かめを戻した。

## 変更したファイル
| パス | 変更の内容 |
| --- | --- |
| `src/presentation/messages.ts` | `INTERACTION_REASON_DESCRIPTIONS`・`describeInteractionReason`、`INTERACTION_LIFECYCLE_REASON_DESCRIPTIONS`・`describeInteractionLifecycleReason` を追加（`deepFreeze`、`as const satisfies Record<…>`）。Interaction の表の列の見出しを「理由（技術的な詳細）」から「理由」に直した。冒頭の「CC-010 は保留中」の記述を直した |
| `src/report/view-model.ts` | `ReasonView` を `ReasonView<TCode extends string = IncompleteReasonCode>` に広げた。`InteractionView` の `reason` と `reasonDetail` を `reason: ReasonView<InteractionReasonCode>` にまとめた。lifecycle の理由は、今も表示用モデルに出していないので出さないままにした |
| `src/report/html-report.ts` | 1つの理由を描く内側の関数 `reasonParts` を置き、`reasonTable`、`reasonList`、Interaction の表の理由の列がこれを使う。`html-components.ts` に新しい部品は作っていない |
| `tests/unit/presentation-messages.test.ts` | 説明の網羅、日本語であること、重ならないこと、凍結を確かめる（Interaction と lifecycle で3件ずつ） |
| `tests/unit/view-model.test.ts` | 期待値を新しい形に。すべての Interaction の理由が Evidence のコードと詳細と説明に一致することを確かめる1件を追加 |
| `tests/unit/html-report.test.ts` | `escapeHtml(HOSTILE_TEXT)` の確かめを戻した。生の `<script>` が無いことの確かめも残した。理由の列の中身がコード・説明・詳細の順で、未完了の理由と同じ形であることを確かめる1件を追加 |

`tests/helpers/audit-run-fixture.ts` と chatgpt-bundle のテストは変えていない。

## 説明の文
- 一覧は `src/presentation/messages.ts` が正（この報告には書き写さない）。
- 実装者の報告に、全73個のコードと説明の表がある（REJECTED_UNSAFE 9、VERIFIED 1、BLOCKED_BY_SAFETY 2、NOT_VERIFIABLE 55、EXECUTION_FAILED 2、lifecycle 4）。「確認の期限」は1つの候補を確かめる期限、「安全のために通信を止める」はクリックの前の Safety の凍結を指す、と言葉をそろえている。

## テスト（実装者）
- RED: 86件中8件が失敗（定数と関数が無い、列の見出しが違う）。「凍結されていること」の2件は、定数が無いと `Object.isFrozen(undefined)` が真になるため、最初の段階で PASS した。`messages.ts` だけの実装の後に、4件が assertion で失敗した（表示用モデルと HTML が未対応）。
- GREEN: 表示の3ファイル、`chatgpt-bundle`、`tests/architecture` → 7ファイル、180件 PASS。
- `tests/unit tests/component tests/architecture` → 70ファイル、2,419件 PASS。`report-generation`、`audit-run-fixture`、`cli`、`run-command` → 61件 PASS。`crawl-run` → 15件 PASS。
- `npm run typecheck`: PASS。Gate の所要時間は、どれも1秒以内（`ui-ssot` 約42ms）。
- 件数: `presentation-messages` 9→15、`view-model` 34→35、`html-report` 35→36。削除と skip はない。

## 発見事項
1. `GEOMETRY_ONLY_CHANGED_SCROLL_UNCOMPARABLE` の説明は、コードの意味が2つの条件の組み合わせなので、1つの文に2つの事実を並べた。
2. 旧の英文を読むために、`git diff` を表示だけに使った。

## 未実行項目（実装者）
- `npm run verify` と `npm run build`（並行作業のため）。
- `tests/integration/` の多く（C18m が並行で変更中のため）。

## 設計者の確認（2026-09-25）
- `html-report.test.ts:248-249` で、`escapeHtml(HOSTILE_TEXT)` が出ることと、生の `<script>` が出ないことの両方を確かめていることを見た。
- `reasonParts` が、未完了の理由と Interaction の理由で共有されていることを見た。
- 発見事項1: コードの意味に合っているので、そのままでよい。
- 全体の verify は、C18m の後に設計者が行う。

## 設計者の verify（2026-09-25。C18n・C18o・C18m の後）

- `npm run verify`: 終了コード 0。98ファイル、3,629件 PASS。ビルド PASS。
