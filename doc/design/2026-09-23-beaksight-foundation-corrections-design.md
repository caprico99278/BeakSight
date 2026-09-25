# BeakSight 基盤修正と共通化 設計書

作成日: 2026-09-23
状態: ユーザー承認済みの範囲内で設計者が確定（2026-09-23 のユーザー指示「記載の範囲においては全て承認済として扱ってよい」「それ以前のタスクについてもレビューの上、必要な修正事項があればこのタスクで修正せよ」「既存の共通化候補の修正と実装計画も本作業の中で検討し、実装タイミングも決定の上、修正をすすめよ」に基づく）
対象範囲: Task 1〜11 の独立レビューで見つかった指摘の修正、共通化候補 CC-001〜CC-012 の実施時期と方針、Task 12 に進む前の型とスキーマの整備

## 1. 目的

2026-09-23 に、Task 1〜11 を4つの観点で独立レビューした。結果は次の4つの記録にある（作業記録置き場 `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/`）。

- `task-11-review-2026-09-23-spec.md`（Task 11 仕様。I1〜I3、M1〜M3）
- `task-11-review-2026-09-23-quality.md`（Task 11 品質。Q1〜Q6）
- `task-01-05-review-2026-09-23.md`（Task 1〜5。R1〜R9）
- `task-06-10-review-2026-09-23.md`（Task 6〜10。V1〜V14）

Critical はなかった。一方、Important には安全不変条件の違反（Passive Context でのダウンロード実行）、偽のCOMPLETE、未観測値の0記録、敵対的なページでの無制限な処理が含まれる。これらは、Task 12 以降の Rule・完了状態・レポートの正しさを直接損なう。

この設計書は、Task 12 に進む前に、これらの指摘を修正する方針を定める。あわせて、保留していた共通化候補の実施時期を決める。共通化で作る部品を修正作業が使えるように、共通化を先に行う。

## 2. 根拠となる文書と優先順位

- 従う文書: 実装タスク指示（`2026-08-27-beaksight-implementation-tasks.md`）、実装計画（`2026-08-27-beaksight-implementation-plan.md`）、設計書（`2026-08-27-beaksight-web-audit-design.md`）、Task 11 追補（`2026-08-31-...-architecture-recovery-design.md`、`2026-09-20-...-terminal-recovery-dom-budget-outcome-design.md`）、UI追補（`2026-09-23-beaksight-ui-ssot-design.md`）、共通部品台帳（`beaksight-shared-components.md`）
- この設計書が置き換える箇所:
  - `2026-09-20-...-terminal-recovery-dom-budget-outcome-design.md` の §3「No automatic timed retry loop」、§10 の再試行回数・タイマーを非目標とする記述、§6.2・§6.4 のうち「再試行を使い果たした非終端の場合」の扱い。第4.2節で置き換える。
- 引き続き守る不変条件: SSOT Owner Matrix の既存の行、Safety Invariants、Evidence before Finding、Completion Semantics、Target Isolation、依存パッケージを追加しないこと、実サイトにアクセスしないこと。

## 3. 共通化候補の実施時期と方針

| 候補 | 実施時期 | 方針 |
| --- | --- | --- |
| CC-001 期限付き待機 | 今回（F01・F02） | `src/core/deadline.ts` を作り、3つの複製と手書きのタイムアウトを置き換える |
| CC-002 エラーの文字列化 | 今回（F01・F02） | `src/core/errors.ts` を作る。正とする振る舞いは、例外を投げず、`Reflect.get` で安全に読み、呼び出し側が指定した長さで切り詰める（passive-request-guard の実装）。network-collector は、この変更で上限と防御を得る |
| CC-003 小さな判定・補助関数 | 今回（F01・F02） | `src/core/guards.ts`（`isRecord`、数値の述語）、`src/core/immutable.ts`（`deepFreeze`）、`src/core/text.ts`（`normalizeWhitespace`、切り詰め、`compareCodeUnits`）を作る。Node側だけが対象。ブラウザ内の空白正規化は CC-008 と同じ方式で扱わない（第3.1節） |
| CC-004 許可Originの正規化 | 今回（F02c） | URLの意味のowner `src/crawl/normalize-url.ts` に `canonicalizeAllowedOrigins` を置き、admission-policy と request-policy はそれを使う。2つの実装が同じ結果を返すことは、レビューで確認済み |
| CC-005 http/https の判定 | 今回（F02c） | `src/crawl/normalize-url.ts` に `isHttpProtocol` を置き、Node側の9か所をそれに置き換える。ブラウザ内の判定はそのまま（第3.1節） |
| CC-006 採番とハッシュの書式 | 今回（F02c） | `REQ-` の採番と `sha256:` の書式を `src/core/ids.ts` に移す |
| CC-007 上限値 | 今回（F01・F02・C7） | `src/core/limits.ts` に、複数のownerで同じ意味を持つ上限（URLの最大長、エラーメッセージの最大長、HTTPメソッドの最大長、selectorの長さと深さ）と、複数の collector で共有する Evidence の収集の上限（console・network・Resource Timing の件数や長さ）を置く。1つの collector だけが使う収集の上限（`DOM_LIMITS`、`LAYOUT_THRESHOLDS` など）と、特定のownerが意味を決める上限（Interaction 候補の上限など）は、そのownerに置く（2026-09-23 C7・C6 の報告を受けて改訂） |
| CC-008 ブラウザ内のDOM走査と可視判定 | 可視判定は今回（C5）。`discover-candidates.ts` の中の複製の整理は Task 18 の後、Task 19 の前 | 第5.5節 |
| CC-009 状態と理由のコード | 今回（F02・C8） | 部分失敗の理由と観測状態を `src/core/contracts.ts` で1回だけ定義する。型とスキーマの整備（C8）で `incompleteReasons` を構造化する |
| CC-010 利用者向けの文言 | Task 16・17 | UI追補設計書のとおり `src/presentation/messages.ts` に集める |
| CC-011 テストの準備処理 | 今回（F03） | `tests/helpers/` を作る |
| CC-012 CLIの終了コード | Task 17 | UI追補設計書のとおり `src/cli/exit-codes.ts` に置く |

### 3.1 ブラウザ内の処理の扱い

`page.evaluate` に渡す関数は import できない。ブラウザ内の処理の共通化は、次の方針にとどめる。

- **値の共有**: 上限値や判定の設定（例: `checkVisibility` に渡すオプション）は、Node側の定数を `evaluate` の引数として渡す。
- **標準APIの使用**: 可視判定は Chromium の標準 `Element.checkVisibility()` を使い、各collectorが同じオプションで呼ぶ。自前の判定関数を複製しない。
- **関数の注入はしない**: `selectorFor` のような関数の共通化のためのスクリプト注入は、今回は行わない。注入の失敗時の扱いなど新しい設計が必要になるうえ、今回の修正の目的（正しさ）に対して効果が小さいため。

### 3.2 振る舞いの変化

共通化で振る舞いが変わるのは次の箇所だけとする。ほかは振る舞いを保つ。

- network-collector のエラーの文字列化に、上限と防御が加わる。
- isolated-auditor のエラーの文字列化は、Error 以外のオブジェクトを `String(error)` で文字列にしていたが、正とする振る舞い（`Reflect.get` による安全な読み取り）に変わる（2026-09-23 F01 の報告を受けて追加）。上限（512）はそのまま。
- `canonicalizeAllowedOrigins` と `isHttpProtocol` の置き換えは、同じ結果を返すことをテストで確かめる。

CC-001 のうち、`isolated-auditor.ts` の `awaitInitialRender` と `observeCloseUntil`、`passive-request-guard.ts` の `drainGuardTasks` は、共通部品に置き換えない（2026-09-23 F02b の報告を受けて決定）。これらは、期限を過ぎた時刻であっても、タイマーより先に届いた決着を正とする意味を持っており、置き換えると、期限ちょうどでの安全判定（close の成否、drain の完了）が変わるためである。

エラーを文字列にできなかったときの代替文言は、場所ごとに既存の文言を保つ（`safeErrorMessage` に代替文言を引数で渡せるようにする）。Evidence に記録される文言を変えないためである。

## 4. Task 11 の修正

### 4.1 `session.close()` の意味を factory と揃える（I1、Q3）

Guard が invalidation を経て終端（`CLOSED`）に達した場合、`InteractionGuardedSession.close()` は、`BrowserContextFactory.closePassiveContext()` と同じく、invalidated を表すエラーで reject する。所有の解放は `CLOSED` に達した時点で行う。前回の close が非終端で失敗していたかどうかで、この振る舞いを変えない。

理由: 入口によって意味が違うと、2回の試行の間に起きた本物の安全イベントが、session 経由の入口でだけ隠れる。これは実装タスク指示 第9章（blocked を隠さない）に反する。

- `tests/component/context-factory.test.ts:382` と `tests/integration/isolated-interaction.test.ts:2505` は、仕様違反を固定しているテストなので、reject を期待する形に直す。これはテストの弱体化ではなく、仕様への是正である。
- 呼び出し側（Task 14 の page-auditor）は、`close()` が reject しても `isClosed()` が真なら「閉じられたが、安全上の異常があった」として扱い、記録する。

### 4.2 クリーンアップの自動再試行と期限の正式化（I2、I3）

2026-09-22 にユーザーが承認した設計（作業記録 `task-11-cleanup-deadline-interaction-dom-budget-brief.md`、`task-11-owner-retention-requestfailed-brief.md`）を、ここで正式な設計とする。

- 作業の結果が確定した後、`cleanupDeadlineAtMs = Date.now() + input.timeoutMs` を1つだけ決める。
- `session.close()` の呼び出しは最大2回（`INTERACTION_OWNER_CLOSE_ATTEMPT_LIMIT = 2`）。1回目は期限の前半だけを使う。2回目は残りを使う。期限は延ばさない。
- 1回目が非終端で終わったら、マクロタスクを1回譲ってから `session.isClosed()` を確かめ直す。終端なら2回目を呼ばない。
- 2回目は、1回目の物理的な close がまだ終わっていなければ、同じ Guard の `closeAttempt` に合流する。raw の `BrowserContext.close()` は1回だけ。
- 期限に達しても非終端なら、`InteractionAuditResult` を返さず、`InteractionOwnerCleanupError` を投げる。このエラーは session を保持し、構造化された `InteractionCleanupFailure` を持つ。
- DOM作業量の上限（`maxDomWork = 16_384`）は、1回の `auditInteraction()` の作業全体で共有する。

この結果、`finalizeInteractionOutcome` の `NON_TERMINAL` の分岐は到達しない。到達しない分岐は削除する。`NON_TERMINAL` が公開の型の値として使われている場合は、型から除く。型から除くと外部への影響が出る場合は、実装者が止まって報告する。

cleanup deadline の修正には、実装時の report とREDの記録がない（I3）。当時のREDは取り戻せないので、記録のない逸脱として台帳に残す。今回、各振る舞い（brief の RED 1〜7）を確かめるテストが存在してPASSすることを、改めて検証して記録する。

### 4.3 作業フェーズのブラウザ内評価に期限を付ける（Q1）

作業フェーズのすべてのブラウザ内評価（`page.evaluate`、`evaluateHandle`、`handle.evaluate`、`getProperties`、`jsonValue`）を、`effectiveDeadlineAtMs` までの期限付きで待つ（`src/core/deadline.ts` を使う）。期限を過ぎたら、その候補を `NOT_VERIFIABLE`（理由は期限切れ）としてクリーンアップに進む。期限切れで放置した Promise が後で reject しても、unhandledRejection にならないようにする。

可視判定でインライン style を検査するときは、style 文字列を `INTERACTION_CANDIDATE_LIMITS.maxAttributeLength` までに切り詰めてから検査する。可視判定そのものは、第5.5節の方針で `checkVisibility()` に置き換える。

### 4.4 click と関係のない変化で VERIFIED にしない（Q2、R2-N1、R'1-N1'、R''1）

この節は、2026-09-23 に4回改訂した。経緯は第10章の設計変更履歴にある。現在の設計は次のとおりである。

#### 4.4.1 VERIFIED の根拠（2026-09-23 R''' を受けた最終の方針）

設計書 7.3 は、検証できる変化として「ARIA、または DOM の visibility・state・layout の変化」を挙げている。しかし、対象の要素の位置と大きさ（`boundingBox`）の変化は、click の結果かどうかを区別できない。平行移動も大きさの変化も、click と関係のない理由で起きるためである。そうした理由には、上にある内容の遅れた読み込み、ボタンの中や隣の遅延読み込みの画像、hover のスタイル、スクロール、アニメーションがある。

そのため、次のように決める。

- **対象の位置と大きさの変化だけでは、VERIFIED の根拠にしない。** 変化は Evidence（before・after の `boundingBox`）には記録する。
- **VERIFIED の根拠にするのは、次の変化とする。**
  - 対象の ARIA の状態の変化（`aria-expanded`、`aria-pressed`、`aria-checked`、`aria-selected` など）
  - 対象自身の属性の変化（class、style、open、data-* など。対象の要素そのものの属性に限り、子孫は含めない）。値が空白だけの class と style は、属性がないものとみなす（`class=""` が残るだけの変化を根拠にしないため。F16）。変わった属性の名前は、上限を付けて Evidence に残す
  - `aria-controls` で結ばれた要素の表示の状態の変化
  - これまで根拠にしてきた、位置と大きさ以外の変化
- **hover と focus の状態を、観測の前にそろえる。** 凍結の前の下準備（4.4.2）で、対象に hover し、focus する。そのうえで、ページが落ち着くのを待つ。こうすると、CSS の `:hover`、JavaScript の hover の処理、focus で付く class（UI の部品集でよく使われる）による変化は、観測の前後の差に出ない。hover と focus を凍結の前に行うのは、それで始まる先読みの通信を、Passive の通信として扱うためである。
- **安定性の確認（2026-09-23 R5 の N-1 を受けて追加）。** 落ち着くのを待った後、凍結の前に、一定の時間（安定性の確認の時間）観測を続ける。この間に変わった項目（属性、ARIA、文字、`aria-controls` の先の表示など）は「不安定」とし、click の後の根拠にしない。観測の前の状態は、この時間の終わりに取る。
- **持続の確認（R5 の N-3 を受けて追加）。** click の後に根拠となる変化を見つけても、すぐには VERIFIED にしない。一定の時間（持続の確認の時間）観測を続け、その変化がその時間の終わりにも続いている場合だけ、根拠にする。押し下げたときの ripple のように、すぐ元に戻る変化を除くためである。
- **`<details>` の開閉（R5 の N-2 を受けて追加）。** 対象が `details` の `summary` の場合は、親の `details` の `open` 属性を、対象の開閉の状態として記録し、根拠にする。
- 安定性の確認の時間と持続の確認の時間は、`src/core/limits.ts` に、名前を付けた定数として置く。設定の Interaction の期限の下限も、この2つの時間から導く。どちらの時間も、Interaction の期限の内側で行う（F17b）。
- **Interaction の期限の数え始め（R6 の I-2 を受けて追加）。** Interaction の期限は、隔離された Context での読み込みと初期描画が終わった時点から数える。読み込みには、設定のナビゲーションの期限（`navigationTimeoutMs`）を使う。こうしないと、読み込みの遅いページで、動くボタンが NOT_VERIFIABLE になるからである。`auditInteraction` の入力には、必須の `navigationTimeoutMs` を持たせ、呼び出す側（Task 14 の Page Auditor）が設定の値を渡す。読み込みの期限切れは、確かめられなかったことを表すので、NOT_VERIFIABLE にする（F18）。
- **CSS の変数だけの style の変化（R6 の I-1）。** style の変化が、CSS のカスタムプロパティ（`--` で始まる名前）の追加・変更・削除だけの場合は、根拠にしない。押したときの ripple などが、変数を style に残すことがあるためである。
- **根拠にしない属性（R7 の Important-1）。** 次の属性は、押したことで変わったまま残ることがある。tooltip や入力の種類（hover、focus、pointer）を表す属性だからである。そのため、これらの変化は根拠にしない。
  - 対象: `aria-describedby`、`data-state`、`data-focus-visible`、`data-focused`、`data-focus`、`data-focus-within`、`data-hovered`、`data-hover`、`data-pressed`、`data-active`
  - 定義: 名前を付けた定数（`INTERACTION_NON_EVIDENCE_ATTRIBUTES`）で、1か所に定義する。
  - 見落とさない理由: 本物の開閉やタブの切り替えでは、ARIA の状態（`aria-expanded`、`aria-selected` など）も変わる。そのため、`data-state` を除いても、見落とさない。
  - 追加（R8 の Important-1）: 一覧に `data-headlessui-state` を加える。これは Headless UI v2 が、hover や focus の状態を1つの値にまとめて出す属性である。
  - 名前の決まり（R8 の Important-1）: 名前に `focus` か `hover` を含む `data-*` 属性と class の名前も、根拠にしない。大文字と小文字は区別しない。
    - 例: `data-focus-ring`、MUI の `Mui-focusVisible`、`is-focused`、`is-hovered`
    - 決まりは、名前を付けた定数（`INTERACTION_NON_EVIDENCE_NAME_PATTERN`）で、1か所に定義する。
    - `active` は、class の決まりに含めない。`.active` はトグルの状態を表すことが多いためである。
- **focus をしない要素と、focus による状態の変化（R8 の Important-2）。**
  - `role="tab"` を明示した要素には、下準備の focus をしない。自動で切り替わるタブ（WAI-ARIA APG の「選択が focus に従う」の形。Radix や shadcn の既定）は、focus だけで切り替わるためである。この場合も、click のときに focus が起きて `aria-selected` が変わるので、VERIFIED になる。focus で付く class や属性は、上の決まりで根拠から外れる。
  - `role="tab"` を明示した要素では、対象の属性の変化（`attributes`）を根拠にしない（R9 の Important-1）。
    - 理由: focus をしないので、focus で変わる属性が、click の後の差に出る。例えば、roving tabindex による `tabindex`、`data-` の付かない `focused`、inline の style である。
    - 根拠にするのは、ARIA の状態、`aria-controls` の先の表示、文字、disabled、visible に限る。属性の変化のうち、ARIA の状態の属性（`INTERACTION_ARIA_STATE_ATTRIBUTES`。`aria-expanded`、`aria-pressed`、`aria-checked`、`aria-selected`）の変化だけは根拠に残す（F21 の実装者の判断を承認）。
    - 見落とさない理由: 本物のタブの切り替えでは、必ず `aria-selected` が変わる。
    - すでに選ばれているタブを押した場合は、何も起きないので、NOT_VERIFIABLE になる。
  - それ以外の要素で、下準備の focus によって、対象の ARIA の状態か `aria-controls` の先の表示が変わった場合は、NOT_VERIFIABLE にする。理由は、区別できる文字列にする。この状態の変化は、click で起きる変化と区別できないためである。
- **class の比べ方（R6 の M-2）。** class は、中の名前ごとに、安定しているかを判定して比べる。安定性の確認の間に変わった名前だけを不安定とする。click の後に、安定していた名前が増えたり減ったりした場合は、根拠にする。
- **長い class（F20 の発見事項）。**
  - class の値は、ほかの属性の上限（512文字）ではなく、class 専用の上限（4096文字。`INTERACTION_CANDIDATE_LIMITS` に名前を付けて置く）まで記録する。Tailwind などで組んだボタンは、class が512文字を超えることがあるためである。
  - class 専用の上限でも切り詰められた可能性がある場合は、名前ごとの比較と名前の決まりを当てはめられない。そのため、class の変化を根拠にしない（fail-closed）。
- **`<details>` の開閉の記録（R6 の M-4）。** 開閉の変化の根拠（`detailsOpen`）に加えて、click の前後の `open` の値を Evidence に残す。

`aria-controls` の先の要素については、表示の状態の変化だけを根拠にする。layout（大きさ）の変化は根拠にしない。遅延読み込みでも起きるためである。

#### 4.4.2 凍結の前の下準備（選択肢 A）

click のときのスクロールと、そのスクロールで起きる通信を減らすため、凍結の前（Passive フェーズ）に、次の下準備を行う。

1. 候補を探し直し、handle を解決する。
2. 下準備の handle が、探索で見つけた候補と同じ要素かを確かめる。違う場合は、その候補を扱わない（2026-09-23 F16 で追加）。
3. `scrollIntoViewIfNeeded` を、期限付きで実行する。
4. 対象に hover し、focus する（期限付き。4.4.1）。ただし、`role="tab"` を明示した要素には focus をしない。focus の前後で、対象の ARIA の状態か `aria-controls` の先の表示が変わった場合は、NOT_VERIFIABLE にして終える（R8 の Important-2）。
5. ページが落ち着くのを待ち、下準備の handle を使って安定性の確認を行う（4.4.1）。同じ要素の hover の後の状態を得るため、handle はこの後で破棄する。
6. handle を破棄する。
7. 凍結する。
8. その後は、これまでと同じ流れで進める（探し直し、受け入れの判定、観測、click）。探し直しでは、hover の後の状態を目印にする。

下準備には、次の決まりがある。

- 凍結の後の受け入れの判定と、安全の判定の順序は変えない。
- 下準備の探索で使う DOM の作業量は、共有の上限（4.2）から差し引く。
- 下準備の途中で失敗した場合、期限を過ぎた場合、作業量の上限に達した場合は、NOT_VERIFIABLE にする。
- 凍結の後にスクロールする方式は採らない。スクロールで起きた遅延読み込みの通信が遮断され、普通のボタンが BLOCKED になるためである。

#### 4.4.3 スクロールが起きた場合

対象が別の要素に覆われていると、Playwright は click を再試行しながらスクロールする。そのため、観測の前後で、対象のスクロールする祖先（文書を含む。`overflow` が `visible`・`clip` 以外の祖先）のスクロール位置を比べる。

いずれかの位置が変わっていた場合と、比べられない場合は、対象の位置・大きさの変化を VERIFIED の根拠にしない。比べられない場合とは、作業量の上限に達した場合、記録が欠けた場合、祖先の並びが変わった場合である。4.4.1 により平行移動はもともと根拠にしないが、スクロールに伴う大きさの見かけの変化も除くため、この比較は残す。

#### 4.4.4 制約として受け入れること

- Chromium は、自動で続くダウンロードを約10件で止める。そのため、Passive のうちに大量のダウンロードを起こすページでは、click で起きたダウンロードが Ledger に残らないことがある（R2 の N2）。
- 押すと自分でスクロールするボタン（例: 先頭に戻るボタン）は、「祖先がスクロールした」ために NOT_VERIFIABLE になる（R''1 の Minor）。
- 下準備の後に、さらに遅れて始まる通信は、凍結の後に遮断される。これは、初めの読み込みの後に遅れて始まる通信と同じ限界である。
- 対象の属性・ARIA・`aria-controls` の先を変えずに、対象の外に内容を差し込むだけのボタン（例: 押すと、上に内容が広がるボタン）は、NOT_VERIFIABLE になる（R''' の M-2）。対象の外の DOM の変化は、遅延読み込みなどと区別できないため、根拠にしない。
- 自分の位置や大きさを変えるだけで、属性を変えないボタンは、NOT_VERIFIABLE になる。
- 対象の外の要素（親、body など）の属性だけを切り替える部品も、NOT_VERIFIABLE になる。例は、body に class を付けるハンバーガーメニュー、親の `li` に class を付けるタブ、`aria-controls` のないモーダルである（R5 の N-5）。対象の外の DOM の変化は、タイマーなどによる変化と区別できないためである。
- 安定性の確認の時間より周期の長いタイマーが、click の後に対象の属性を変えると、防ぎきれない（R5 の N-1）。持続の確認で一部は除けるが、すべては除けない。
- 1回だけ遅れて起きる変化も、防ぎきれない。例えば、hover の600ms後に class を付けるもの、読み込みの1秒後に style を変えるもの、画面に入った700ms後に class を付けるものである（R6 の M-1）。その変化が、安定性の確認の後で click の後に起き、持続の確認の間も続けば、VERIFIED になる。click の結果かどうかは、時間の関係だけでは本質的に見分けられないため、受け入れる。
- 押すと inline の style に `position` などの値を残す ripple（Vuetify の v-ripple の形。position が static の要素に限る）は、VERIFIED になることがある（R7 の Minor-1）。
- `type` のない `<button>` は、仕様（設計書 7.2）どおり submit とみなされる。そのため、REJECTED_UNSAFE になり、Interaction の検証の対象にならない。タブなどに `type` を付けないサイトでは、網羅の範囲が狭くなる（R7 の補足）。
- 対象の `data-state` だけを変え、ARIA の状態を変えず、`aria-controls` も持たない自作の部品は、NOT_VERIFIABLE になる（R8 の Minor-1）。よく使われるライブラリの部品では、ARIA の状態も変わるので、この形は起きない。
- `role="tab"` を持たないのに、focus だけで状態が変わる部品は、NOT_VERIFIABLE になる（R8 の Important-2）。
- `role="tab"` を持ち、`aria-selected` も `aria-controls` も持たず、class だけを切り替える自作のタブは、NOT_VERIFIABLE になる（R10 の Minor-1）。本物のタブは `aria-selected` を変えるという方針（4.4.1）による。
- 以上のように、Interaction の検証は推定である。偽の VERIFIED（確かめていないものを確かめたとする）を防ぐことを、偽の NOT_VERIFIABLE を防ぐことより優先する。

### 4.5 テキストのノード上限の理由を正しく記録する（M1）

テキストのノード上限（`maxTextNodes`）に達したことを、DOM作業量の上限と区別する。discovery の completeness に `TEXT_NODE_LIMIT_REACHED` を加え、auditor はそれに対応する理由を記録する。9-20設計 §5.3 のとおり、テキストの上限は走査を止めるだけの二次的な上限であり、DOM作業量の上限と混同しない。

### 4.6 機械的に除外した候補を Safety Ledger に記録する（M2）

Safety Ledger に、機械的に除外した Interaction 候補を記録する種類を加える（候補ID、除外理由 `InteractionRejectionReason`）。`SUBMISSION_CONTROL`、`RESET_CONTROL`、`FORM_ASSOCIATED`、同一Originの `NAVIGATION_HREF` はここに記録する。`blockedExternalActions` には、外部Origin・`tel:`・`mailto:`・ダウンロードなど、外部への作用だけを記録する。

### 4.7 Passive Context でのダウンロードを遮断する（M3、V1）

Passive Context と Interaction Context のどちらも、`acceptDownloads: false` で作る。Passive フェーズでページが起こしたダウンロードも、Safety Ledger の `blockedDownloads` に記録する。fixture の `download-button.html` などで、Passive フェーズのダウンロードが保存されないことと、Ledger に記録されることを確かめる。

### 4.8 テストの時間依存と型（Q4、Q6）

- `isolated-interaction.test.ts:3564, 3578` の判定枠から、実ブラウザのセッション生成時間を除く。
- `:3672` は、`INTERACTION_OWNER_CLOSE_TIMED_OUT` の記録を確かめる形にし、期限切れと reject の順序を区別する。
- 不要になった `as unknown as` を除く。`discover-candidates.ts:834` は、`boundingBox` が null の場合も上限付きのメッセージで拒否する。

### 4.9 見送るもの

- Q5（観測ループがフレームごとに文書の先頭から走査し直す）: 結果が誤るのではなく、DOM作業量の上限に早く達して `NOT_VERIFIABLE` になるだけで、正直な結果になる。性能の改善は、CC-008 の `discover-candidates.ts` の整理（Task 18 の後）で扱う。

## 5. Task 6〜10 の修正

### 5.1 スクロールする要素を正しく追う（V2）

controlled scroll は、`document.scrollingElement` と、その高さが増えない場合は body を含めて、実際にスクロールする要素を特定して追う。スクロールする要素を特定できない場合、または1回もスクロールできなかったのに内容の高さがビューポートより大きい場合は、`COMPLETE` ではなく `PARTIAL` と理由を返す。

スクロールする対象は、スクロールできる量が最も大きい候補とする。候補は、文書、body、内側の領域である（2026-09-23 R4 の N1 を受けて追記）。

- 内側の領域が最も大きい場合は、その領域をたどらず、PARTIAL と理由を返す。
- 文書か body をたどった後、内側の領域の走査が上限に達した場合は、COMPLETE のままにする。上限に達したことは、`innerScrollScan.scanLimitReached` として Evidence に記録する（F08 の判断を承認）。
  - COMPLETE のままにする理由は、文書をたどること自体は完了しており、上限に達した事実も Evidence に残るからである。
  - PARTIAL にすると、要素の多い実サイトがすべて PARTIAL になる。

完了と判定する前に、候補のスクロールできる量を測り直す（2026-09-23 R'2 の I-1 を受けて追記）。

- 測り直した結果、文書か body のほうが大きくなっていた場合は、1回だけ対象を切り替えて、たどり直す。
- 内側の領域のほうが大きくなっていた場合は、PARTIAL にする。
- 2回目も対象が変わった場合は、PARTIAL（`SCROLL_TARGET_UNSTABLE` など）にする。

内側の領域を探す走査は、open な shadow root の中にも入る（I-3）。

closed な shadow root の中の領域は、外から調べられないので、検出しない（R''1 の Minor）。同じ Origin の iframe が全画面を占め、その中でスクロールするページも、検出しない。これは制約として受け入れる。iframe の中の文書は、Passive の監査の対象にしていないためである。

controlled scroll の結果は、Evidence の種類 `scroll` として記録する（I-2）。走査が上限に達したことも、ここに残す。

### 5.2 収集時のスクロール位置を契約にする（V3）

- controlled scroll の後、DOM・layout・配色・accessibility を収集する前に、スクロール位置を先頭（`scrollX = 0, scrollY = 0`）に戻す。
- 各collectorは、収集した時点の `scrollX` と `scrollY` を Evidence に記録する。
- viewport のスクリーンショットは先頭で撮る（設計書 §18.4 の initial viewport）。full-page のスクリーンショットは、その後に撮る。
- 配色の標本は、ビューポート内に限らず、文書全体の可視要素から、上限の範囲で取る。

### 5.3 可視テキストで本文を落とさない（V4）

landmark（header、nav、main、aside、footer、form）で区分できる部分は区分する。どの landmark にも属さない可視テキストは、「その他」の区分として保持する。`main` がないページでも本文が落ちないことをテストで確かめる。

### 5.4 Task 12 のRuleに必要な Evidence を集める（V5）

- **idの重複**: DOM collector が、重複している `id` の値と件数を上限付きで記録する。
- **ラベルのない必須入力欄**: 入力欄ごとに、`labels`、`aria-label`、`aria-labelledby`、`title` の有無を記録する。アクセシブルネームがあるかどうかの判定は、Rule 側で行う。
- **要素の重なり**: layout collector が、可視の主要要素（見出し、段落、画像、ボタン、リンク、入力欄、固定要素）どうしの重なりの候補を、上限付きで記録する。固定要素については、固定要素の面積とビューポートの面積の比も記録する。重なりの判定には、visibility、position、z-index、overflow を組み合わせる（設計書 §14.8）。どの重なりを Finding にするかは Rule が決める。

### 5.5 可視判定を統一する（V7、CC-008）

「目に見えるかどうか」の判定は、すべてのcollectorで次の定義にそろえる。

- 要素に対して `element.checkVisibility({ opacityProperty: true, visibilityProperty: true, contentVisibilityAuto: false })` を呼び、真であること。`contentVisibilityAuto` を false にするのは、`content-visibility: auto` で描画が省かれている、ビューポートの外の区画を、不可視と判定しないためである（スクロールすれば利用者に見える。2026-09-23 C5 の報告を受けて改訂）。
- テキストノードの可視判定は、`display: contents` ではない最も近い祖先の要素に対して行う（`display: contents` の要素は箱を持たず、`checkVisibility` が false を返すため）。このとき、`visibility` は判定する要素自身の計算値で判断し、祖先の `checkVisibility` は `visibilityProperty: false` で呼ぶ（`display: contents` の要素に付いた `visibility` も継承で直下の文に効くため。2026-09-23 C5b の報告を受けて追記）。
- 配色の標本は、箱を持つ要素の単位で取るので、`display: contents` の直下の文は配色の標本に入らない。これは許容する制約とする。
- `content-visibility: auto` で描画が省かれている画面外の区画は、高さが0として扱われるので、配色の標本に入らない。DOM と layout では可視として記録される。これも許容する制約とする（2026-09-23 R4 の M4）。この標準APIは、祖先の `display: none` と `opacity: 0`、要素自身の `visibility` を正しく扱う（`visibility` は継承されて子で上書きできるので、祖先をたどって判定してはいけない）。
- 幅または高さが0の要素は、可視判定とは別の事実（大きさが0）として扱う。
- `aria-hidden` は、目に見えるかどうかではなく、支援技術に公開されるかどうかの事実である。可視判定には使わず、必要なcollectorが別の項目として記録する。

`checkVisibility` に渡すオプションは、Node側の1つの定数（`src/core/visibility.ts` の `VISIBILITY_CHECK_OPTIONS`（2026-09-23 F04 で `src/evidence/` から移した））として定義し、各collectorが `evaluate` の引数として渡す。

対象: `dom-collector.ts`、`color-collector.ts`、`layout-collector.ts`、`discover-candidates.ts`。discover-candidates の可視判定も、DOM作業量の上限の管理はそのままに、この定義へ置き換える。

discover-candidates では、`checkVisibility` の1回の呼び出しを DOM作業量の1単位と数える。この点で、9-20設計 §5.1・§5.6 の「可視判定で祖先を1つたどるごとに1単位」という数え方を置き換える。祖先をたどる処理はブラウザの内部で行われ、BeakSight の走査の作業量には入らないためである。作業フェーズには期限（4.3）があるので、処理が止まらなくなることはない（2026-09-23 R1 の指摘1を受けて明記）。

### 5.6 layout の収集を速くし、部分結果を失わない（V8）

- `selectorFor` は、上限（候補の件数）を確かめてから呼ぶ。兄弟の走査は、selector の深さと長さの上限の範囲に限る。16,000要素のページで1秒以内を目安とし、テストで確かめる。
- layout の収集に期限を付ける。
- `collectStressLayout` は、ある幅の収集が失敗しても、それまでの幅の結果を保持し、失敗した幅を理由付きで記録する。

### 5.7 未観測の値を0にしない（V6）

- `resourceSummaries` は、観測できなかった場合に 0 ではなく「未観測」を表す値にする。
- `performance.setResourceTimingBufferSize` でバッファを広げる（上限は既定の上限値の範囲内）。バッファが満杯になった場合（`resourcetimingbufferfull`）は、切り捨ての事実を記録し、`COMPLETE` にしない。
- Timing-Allow-Origin がなく転送量が 0 と報告される別Originの資源は、合計に 0 として入れず、「転送量が不明」として件数を分けて記録する。

### 5.8 敵対的なページに上限を設け、切り捨てを記録する（V9）

- console、pageerror、request、response の件数と、本文・stack・URLの長さに上限を設ける（`src/core/limits.ts`）。
- layout、配色、axe、performance、console、network のすべてで、上限により切り捨てた場合は、切り捨てた件数か「切り捨てた」という印を Evidence に残す。

### 5.9 Minor の修正（V10〜V14）

- **V10**: Network Evidence に、メインフレームのリクエストか、ナビゲーションのリクエストかの印を加える。レスポンスの転送量（取得できる場合）を加える。
- **V11**: axe の `incomplete` を、`violations` とは別の項目として記録する。axe の実行に期限を付ける。`failureSummary` などの文字列の長さに上限を設ける。
- **V12**: web-vitals の `rating` は保存しない。しきい値に照らした評価は Rule Catalog が行う。
- **V13**: Service Worker の遮断と、locale・timezone がブラウザで実際に効いていることを、実ブラウザのテストで確かめる。
- **V14**: 画像の Evidence に、解決済みのURLを加える。

## 6. Task 1〜5 の修正

### 6.1 `target.id` を確定後の設定に残す（R1）

`AuditConfig` に `target: { id: string }` を加え、`loadConfig()` が確定後の不変な設定に含める。

### 6.2 設定ファイルの一意性の確認を `config/targets` に限る（R2）

`target.id` の一意性の確認は、`config/targets/` 配下だけを対象にする。`--config` で指定したファイルが `config/targets/` の外にある場合は、そのファイルだけを読み、ほかの JSON を走査しない。そのファイルの `target.id` が `config/targets/` 配下の設定と重複していても、エラーにしない（`local/` の実運用の設定を想定している）。

### 6.3 Safety Ledger の記録上限を不変条件の違反と区別する（R3）

- Safety Ledger の記録上限に達したことは、`invariantViolations` ではなく、「記録が不完全」という別の事実（例: `truncated` と、切り捨てた件数）として記録する。
- 本物の不変条件の違反は、記録が満杯でも上書きしない。違反の記録は、ブロックの記録とは別の上限を持ち、違反の上限に達した場合も件数を数え続ける。
- 記録が不完全な Run は `PARTIAL` にする（`deriveRunStatus()` の入力に加える）。`ABORTED_BY_SAFETY` にはしない。
- HTTPメソッドの長さの上限を超えた値は、不変条件の違反ではなく、切り詰めて記録する。

### 6.4 設定の検証を実行時の判定とそろえる（R5）

- `allowedOrigins` と `startUrl` に認証情報（ユーザー名・パスワード）が含まれる場合は、設定エラーにする。
- 件数や深さを表す設定値（`maxPages`、`maxDepth` など）は、正の整数だけを受け付ける。
- 検証には、URLの意味のowner（`normalize-url.ts`）の関数を使う。

### 6.5 Run Status の入力が不正な場合は fail-closed にする（R6）

`deriveRunStatus()` に渡す安全違反の件数が、有限の0以上の整数でない場合は、`ABORTED_BY_SAFETY` を返す。

### 6.6 Link 抽出の受け入れ判定を必須にし、URLの認証情報を扱う（R7）

- `discoverLinks()` の `policy` を必須の引数にする。
- 認証情報を含むURLは、正規化の段階で受け入れない（理由 `CREDENTIALS_NOT_ALLOWED`）。Evidence に残す生の href からは、認証情報を伏せ字にする。この処理は `normalize-url.ts` が持つ。

### 6.7 fixture サーバで、GET・HEAD 以外のすべてのメソッドを数える（R8）

fixture サーバの変更系カウンタは、GET と HEAD 以外のすべてのメソッド（OPTIONS と独自メソッドを含む）を数える。ブラウザからの OPTIONS と独自メソッドがサーバに届かないことは、Task 18 の Safety Gate S02 の統合テストで確かめる（2026-09-23 R3 の M2 を受けて、確かめる場所を明記）。

### 6.8 テストが `dist/` を書き換えないようにする（R9）

`tests/unit/cli.test.ts` と `tests/unit/schema-validator.test.ts` は、`tsc` の出力先を一時ディレクトリにする。`dist/` を読み書きしない。

## 7. 型とスキーマの整備（R4、CC-009）

Task 12〜16 が使う型とスキーマを、Task 12 の前に整える（サブタスク C8）。ownerは変えない（型は `src/core/contracts.ts`、検証は `validateArtifact()`）。

- Evidence の payload の型を、Task 7〜11 の collector が実際に出す形に合わせて定義する。collector は、その型を返すようにする。Link と Color の Evidence の種類を加える。
- 観測状態を `OBSERVED | NOT_OBSERVED | UNSUPPORTED` にする。
- ページの結果に、Desktop と Mobile それぞれの状態を持たせる（設計書 §9.3）。
- `run.json` に、設計書 §18.1 と第35章の項目（`startUrl`、`allowedOrigins`、environment、実効の設定、Safety Ledger、ブロックした操作の件数、未検証の Interaction、クロールの上限の状態）を加える。
- `incompleteReasons` は、文字列の配列ではなく、理由コードと補足からなる構造にする。理由コードは閉じた union 型にする。
- `Finding.category` は閉じた union 型にする。値は Task 12 の設計で Rule Catalog とともに決める。C8 では型の枠だけを用意し、値は Task 12 で埋める。
- スキーマの版は `*-schema/1.0` のままにする。理由: まだ一度も artifact を出力しておらず、1.0 の利用者がいないため。

## 8.1 既存の不具合の修正

### DEF-001: axe の実行で、Passive Context が安全違反として閉じられる

C8 の実装中に見つかった（不具合台帳 `defects.md` の DEF-001）。

1. 実装者は、まず原因を確かめる。確かめることは2つある。axe の実行の中で、何が Guard の `CDP_SESSION_DETACHED` の記録を引き起こしているか。`AxeBuilder` が別の page を開いているか。
2. 原因が「`AxeBuilder` が同じ Context に別の page を開くこと」であれば、`AxeBuilder` をレガシーの方式（`setLegacyMode(true)`。対象の page の中だけで実行する）で使う。この方式では別Originの iframe の中は検査されないので、その制約を Evidence に記録する。別Originの iframe は、Passive Context の許可Originの外にあるので、もともと監査の対象外である。
3. 原因がほかにある場合は、実装者は修正せずに止まり、確かめた事実を報告する。設計者が改めて方針を決める。
4. Guard の不変条件の判定を緩めて回避することはしない。安全の境界を弱めるためである。
5. 受け入れ条件は2つある。Guard の付いた Passive Context で axe を実行した後に、Safety Ledger の `invariantViolations` が0件で、page が開いたままであること。既存の accessibility のテストがすべて PASS すること。

## 8. 対象外

- Task 12 以降の実装そのもの（この設計書の修正の後に行う）。
- CC-008 の `discover-candidates.ts` の中の複製の整理（Task 18 の後）。
- CC-010、CC-012（Task 16・17）。
- 実サイトへのアクセス（機能完成まで禁止）。

## 9. 完了条件

- [ ] 第4〜7章の各修正に対応するテストが、修正前にREDになり、修正後にGREENになる（記録のない過去の修正は第4.2節のとおり扱う）。
- [ ] 共通化候補 CC-001〜007、009、011 と、CC-008 の可視判定が、第3章のとおり実施されている。共通部品台帳が更新されている。
- [ ] Task 11 の独立レビュー（仕様・品質）を修正後にやり直し、Critical 0・Important 0 である。
- [ ] Task 1〜10 の修正について独立レビューを受け、Critical 0・Important 0 である。
- [ ] `npm run verify` が PASS する。

## 10. 設計変更履歴

| 日付 | 契機 | 変更内容 | 影響範囲 |
| --- | --- | --- | --- |
| 2026-09-23 | 初版。Task 1〜11 の独立レビューと、ユーザーの開発指示 | - | Task 1〜11 の実装、Task 12〜18 の前提 |
| 2026-09-24 | R10 の Minor-1 | 4.4.4 に、class だけを切り替える自作のタブの制約を加えた | なし |
| 2026-09-24 | R9 の Important-1 | 4.4.1 に、明示した tab では属性の変化を根拠にしないことを加えた（ARIA の状態の属性は残す） | F21 |
| 2026-09-24 | F20 の Blocker と発見事項 | 4.4.1 に、長い class の扱い（class 専用の上限と fail-closed）を加えた | F20b |
| 2026-09-24 | R8 の Important-1・Important-2・Minor-1 | 4.4.1 に、`data-headlessui-state`、名前の決まり、focus をしない要素を加えた。4.4.2 の手順4を更新した。4.4.4 に、制約を2つ加えた | F20 |
| 2026-09-24 | R7 の Important-1・Minor-1・補足 | 4.4.1 に、根拠にしない属性を加えた。4.4.4 に、ripple の制約と、type のない button の網羅の限界を加えた | F19 |
| 2026-09-24 | R6 の I-1・I-2・M-1〜M-4 | 4.4.1 に、期限の数え始め、CSS の変数だけの style の変化、class の名前ごとの比較、`<details>` の開閉の記録を加えた。4.4.4 に、1回だけ遅れて起きる変化の制約と、優先の考え方を加えた。時間の定数の置き場所の記述を直した | F18 |
| 2026-09-23 | F16 の実装者の判断 | 4.4.2 の手順を更新した（同じ要素かの確認、handle の破棄は安定性の確認の後）。4.4.1 に、空白だけの class と style の扱いを加えた | なし |
| 2026-09-23 | R5 の N-1〜N-5 | 4.4.1 に、focus、安定性の確認、持続の確認、`<details>` の開閉を加えた。4.4.2 の手順と、4.4.4 の制約を更新した | F16 |
| 2026-09-23 | R''' の I-1・I-2・M-1・M-2 | 4.4.1 を改訂した。対象の位置と大きさの変化だけでは、根拠にしない。下準備で hover する。`aria-controls` の先は、表示の変化だけを根拠にする。制約を追記した | F15 |
| 2026-09-23 | R''1 の Important | 4.4 を整理し直した。対象の平行移動だけの変化は、VERIFIED の根拠にしない（4.4.1）。自分でスクロールするボタンの制約を記した | F14 |
| 2026-09-23 | R'1 の N1' | 4.4 に、スクロールが起きた場合は位置の変化を根拠にしない方式を追記した | F10 |
| 2026-09-23 | R'2 の I-1〜I-3 | 5.1 に、測り直し、shadow root の走査、iframe の制約、Evidence の種類 `scroll` を追記した | F09 |
| 2026-09-23 | R4 の N1、F08 の判断 | 5.1 に、スクロールする対象の決め方と、走査が上限に達した場合の扱いを追記 | なし |
| 2026-09-23 | F06 の Blocker | 4.4 を再改訂し、凍結の前に下準備を行う（選択肢 A）ことにした | F06b |
| 2026-09-23 | R4 の M4 | 5.5 に、`content-visibility: auto` の区画が配色の標本に入らない制約を記した | なし |
| 2026-09-23 | R3 の M2 | 6.7 に、ブラウザから届かないことを Task 18 の S02 で確かめることを明記 | Task 18 |
| 2026-09-23 | R2 の N1・N2 | 4.4 を改訂した。変化を観測する前に、対象を画面内にスクロールしておく。ダウンロードの記録の限界を記した | F06 |
| 2026-09-23 | R1 の指摘1 | 5.5 に、9-20設計 §5.1・§5.6 の作業量の数え方を置き換えることを明記 | なし |
| 2026-09-23 | C8 の報告（発見事項1） | 8.1 に、既存の不具合 DEF-001 の修正の方針を加えた | DEF-001 |
| 2026-09-23 | C5 の報告（発見事項1、2） | 5.5 の `contentVisibilityAuto` を false に改めた。テキストノードの可視判定を `display: contents` でない祖先で行うことを加えた | F04、C5b |
| 2026-09-23 | C7 の報告（発見事項1） | 3章の CC-007 の方針を改訂し、Evidence の収集の上限も `limits.ts` に置くことにした | F04 |
| 2026-09-23 | F02b の報告（発見事項4） | 3.2 に、CC-001 の3か所を共通化しない例外を追加 | なし |
| 2026-09-23 | F01 の報告（発見事項1、2） | 3.2 に、isolated-auditor の振る舞いの変化と、代替文言を場所ごとに保つ方針を追加 | F02b |
