# RC18 レビュー結果（Task 19 の前の整理の全体の確認）

## 総合判定
承認。Critical 0件、Important 0件、Minor 8件。レビュー担当の意見: Task 19 に進んでよい。

## 前提の確認（レビュー担当）
- Guard の製品のコードは、RC18c の後に変わっていない（更新時刻で確かめた）。
- `isolated-auditor.ts` を HEAD と比べ、`INTERACTION_NOT_VERIFIABLE_REASONS` の55個のコード・区分・並び順、結果を作る呼び出し86か所の順序と status とコードの組、Safety Ledger の文言が、すべて同じ。
- `interactionCandidateProbe` が関数の外で参照する名前は型だけ。3つのモードの作業量の数え方と打ち切りの状態は、旧コードと1行ずつ比べて同じ。
- テストの確かめる内容は弱まっていない（`expect` が減った3ファイルは、まとめと補助への移し替えで説明がつく）。`fixtures/` は `tests/` を import していない。

## 指摘（Minor）
| ID | 場所 | 内容 | 直し方の案 |
| --- | --- | --- | --- |
| M1 | `src/presentation/messages.ts:105-106` | `SAFETY_FREEZE_BLOCKED` の説明「作用を遮断しました」は、止められない外部スキームへの移動の試みにも付く（`isolated-auditor.ts:533`）。headed では誤解を招く。`OWNER_CLOSE_SAFETY_FAILURE` の説明も、実際の条件（閉じる処理の失敗、期限切れ、終わりの状態に達しない）とずれている | 実際の条件に合わせた文にする |
| M2 | `evidence-types.ts:1513`、`:1534`、`isolated-auditor.ts:541` | Evidence の型では、status とコードが独立した組で、どの組でも型が通る | status で見分ける union 型にするか、設計書に制限の方法を明記する |
| M3 | `discover-candidates.ts:122`、`:345`、`:428` | page 用の型の別名が `INSPECT` の入力も受け付ける。誤って呼ぶと、例外にならずに `DISCONNECTED` を返す（今の呼び出し元は正しい） | 型を分けるか、関数の中で例外にする |
| M4 | `tests/helpers/gate-harness.ts:165` → `passive-cleanup.ts:42` | `isolated-interaction` の探索のテストは、前は Guard が Context を無効にすると閉じる処理で失敗した。今は閉じる処理の失敗を捨てるので、探索の途中や後の Guard の違反を見逃す | 補助に、終わった後に違反が0件であることを確かめる指定を加え、探索のテストで使う |
| M5 | `tests/integration/cli.test.ts:194` | 別のプロセスの CLI のテストが `--headless` を付けず、設定の既定値に頼っている（変更の前から） | `--headless` を付けて固定する |
| M6 | `commonization-candidates.md:114` | CC-008 が完了なのに、`selectorFor` の複製と、同じ項目の矩形の型が残っている | 新しい候補に分けるか、共通化しない理由を書く |
| M7 | `beaksight-shared-components.md:68`、`:104`、`:125` | `INTERACTION_NOT_VERIFIABLE_REASONS` の説明が古い。`useHeadlessChromium` が2行にある。`InteractionReasonCodeFor` と status ごとの一覧が載っていない | 台帳を直す |
| M8 | 設計書 第8章、CC-031、`messages.ts:187` | 完了条件の欄が空。CC-031 に古い記述。lifecycle の説明がどこからも使われていない | 文書を更新する。lifecycle の説明の扱いを決める |

## 再実行したコマンド（レビュー担当）
- `tests/architecture` と unit の7ファイル: 10ファイル、685件 PASS
- `tests/architecture`: 50件 PASS、472ms
- `safety-gates`、`auditor-gates`、`gate-fixtures`: 142件 PASS
- `isolated-interaction`、`page-auditor-interaction`、`external-scheme-navigation`、`oopif-guard`: 551件 PASS
- `npm run typecheck`: PASS

## 設計者の対応（2026-09-25）
- M2: 設計書 5.1.2 に、制限は組み立てる関数の型（`outcome<S>`）とスキーマで行うことを明記した。Evidence の型を union にすると、Evidence を読むすべての場所に影響するためである。
- M6: CC-033 として登録した。`selectorFor` は共通化しない（別々の `page.evaluate` の関数の中にあり、共通化の仕組みが得られるものより複雑。layout の側は速さの工夫がある）。矩形の型は C18p で型の別名にする。CC-008 の状態の記述を直した。
- M7: 共通部品台帳を直した。
- M8: 設計書 第8章の欄と CC-031 の記述を更新した。lifecycle の説明は、表示していないので C18p で消す（製品のコードに使われない部品を置かない）。
- M1、M3、M4、M5、M6（矩形の型）、M8（lifecycle の説明を消す）: C18p で直す。
