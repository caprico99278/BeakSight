# BeakSight Task 12・13 Rule Engine と Cross-page Rule 設計書

作成日: 2026-09-23
状態: ユーザー承認済みの範囲内で設計者が確定（2026-09-23 のユーザーの開発指示に基づく）
対象範囲: 実装計画 Task 12（決定論的な Rule Engine と Rule Catalog）と Task 13（Cross-page の構造監査）の詳細

## 1. 目的

実装計画の Task 12・13 は、作る Rule の ID と、Rule Engine の大まかな契約を定めている。しかし、次のことはまだ決まっていない。

- category の値
- 各 Rule の severity
- 性能のしきい値
- 文言の言語と、文言の持ち方
- Safety の Finding の扱い
- Rule Engine の入力の形

この設計書で、これらを決める。

## 2. 根拠となる文書と優先順位

- 従う文書: 実装タスク指示（第4〜5章、第8章、ARCH05〜07）、実装計画 Task 12・13、設計書 第12〜15章、UI追補設計書（表示言語は日本語。表示カタログは category の表示だけを持つ）、基盤修正の設計書（第7章の型とスキーマの整備）。
- この設計書が置き換える箇所: 実装計画 Task 12 のファイル構成に、`src/audit/rule-catalog.ts`（実装タスク指示 第5章の owner）を加える。
- 引き続き守る不変条件:
  - Rule は、ブラウザを操作しない。
  - Evidence だけを入力にする。
  - 意味的・美的な判断を Finding にしない。
  - fingerprint は `createFindingFingerprint()` だけが作る。
  - Rule の登録は `RULE_CATALOG` に1回だけ行う。
  - Cross-page の評価は、`evaluateCrossPageRules()` だけが行う。

## 3. ファイルと責務

| パス | 責務 |
| --- | --- |
| `src/audit/rule.ts` | Rule の契約（`AuditRule`、`FindingDraft`）と、Rule の入力の型（`PageRuleInput`） |
| `src/audit/rule-catalog.ts` | `RULE_CATALOG`: すべての page rule の唯一の登録先 |
| `src/audit/rule-engine.ts` | `RULE_CATALOG` だけを使って Rule を評価し、Finding の ID と fingerprint を付け、並べ替えて返す |
| `src/audit/technical-rules.ts` | HTTP、Link、Resource、JavaScript、DOM、Form の Rule |
| `src/audit/layout-rules.ts` | Layout と、動的な layout shift の Rule |
| `src/audit/accessibility-rules.ts` | axe の結果の対応づけ |
| `src/audit/performance-rules.ts` | Web Vitals のしきい値の Rule |
| `src/audit/safety-rules.ts` | Safety Ledger の事象を、severity `SAFETY` の Finding にする Rule |
| `src/audit/cross-page-rules.ts` | `evaluateCrossPageRules()`（Task 13） |

## 4. category

`Finding.category` は、次の値だけを取る閉じた union 型にする。値の配列 `FINDING_CATEGORIES` と型 `FindingCategory` は、`Finding` の型と同じ `src/core/contracts.ts` に置く（`src/core` が `src/audit` に依存しないようにするため）。基盤修正の C8 で定義する。

| 値 | 対象 | 設計書 |
| --- | --- | --- |
| `HTTP` | HTTP・ナビゲーション | 14.1 |
| `LINK` | 内部リンク | 14.2 |
| `RESOURCE` | 資源 | 14.3 |
| `JAVASCRIPT` | JavaScript・Console | 14.4 |
| `DOM` | DOM・HTML | 14.5 |
| `FORM` | フォーム | 14.6 |
| `ACCESSIBILITY` | アクセシビリティ・コントラスト | 14.7 |
| `LAYOUT` | レイアウト・レスポンシブ・動的な layout shift | 14.8〜14.10 |
| `PERFORMANCE` | 合成計測の性能 | 14.10〜14.11 |
| `CROSS_PAGE` | ページをまたぐ構造 | 14.13 |
| `SAFETY` | 安全制御の事象 | 13、35 |

category の日本語のラベルと、レポートでの並び順は、表示カタログ（`src/presentation/catalog.ts`、Task 16）が持つ。Rule Catalog はラベルを持たない。

## 5. Rule の一覧と severity

severity の意味は、設計書 第13章に従う（ERROR: 客観的な故障・破損、WARN: 問題の可能性が高いが断定の範囲を限るもの、INFO: 後段の分析に役立つ観測、SAFETY: サイトの品質とは別の安全制御の事象）。

### 5.1 page rule（Task 12）

| ruleId | category | severity | 判定の要点（Evidence） |
| --- | --- | --- | --- |
| `HTTP_4XX` | HTTP | ERROR | メインフレームのナビゲーション応答が 400〜499 |
| `HTTP_5XX` | HTTP | ERROR | メインフレームのナビゲーション応答が 500〜599 |
| `NAVIGATION_TIMEOUT` | HTTP | ERROR | （2026-09-24 に、Cross-page rule（第7章）に移した） |
| `REDIRECT_LOOP` | HTTP | ERROR | リダイレクトの連鎖に同じURLが再び現れる |
| `UNEXPECTED_ORIGIN_REDIRECT` | HTTP | WARN | （2026-09-24 に、Cross-page rule（第7章）に移した） |
| `EMPTY_HTTP_RESPONSE` | HTTP | ERROR | メインフレームの応答が 200 番台で、本文の大きさが 0 と観測された |
| `INVALID_INTERNAL_URL` | LINK | WARN | 内部とみなされるリンクの href が、正規化できない |
| `UNSUPPORTED_URL_SCHEME` | LINK | INFO | http・https 以外の scheme（`tel:`・`mailto:` などを含む）のリンク。事実の記録だけ |
| `RESOURCE_4XX` | RESOURCE | ERROR | サブリソースの応答が 400〜499 |
| `RESOURCE_5XX` | RESOURCE | ERROR | サブリソースの応答が 500〜599 |
| `SCRIPT_LOAD_FAILED` | RESOURCE | ERROR | script の読み込みの失敗（requestfailed） |
| `STYLESHEET_LOAD_FAILED` | RESOURCE | ERROR | stylesheet の読み込みの失敗 |
| `IMAGE_LOAD_FAILED` | RESOURCE | ERROR | 画像の読み込みの失敗、または `complete` かつ `naturalWidth = 0` |
| `PAGE_ERROR` | JAVASCRIPT | ERROR | 捕捉されない例外（pageerror）。同じ message・source・stack は1つに集約する |
| `MISSING_TITLE` | DOM | WARN | `<title>` がない |
| `EMPTY_TITLE` | DOM | WARN | `<title>` が空白だけ |
| `MISSING_HTML_LANG` | DOM | WARN | `<html lang>` がないか空 |
| `EMPTY_VISIBLE_CONTENT` | DOM | ERROR | 可視テキストが空（C5 の可視判定による） |
| `DUPLICATE_ELEMENT_ID` | DOM | WARN | 同じ `id` が複数ある |
| `INVALID_CANONICAL_URL` | DOM | WARN | canonical の href が、正規化できない |
| `FORM_WITHOUT_ACTION` | FORM | INFO | action 属性がない form（事実の記録。form は送信しない） |
| `UNLABELED_REQUIRED_CONTROL` | FORM | WARN | required の入力欄に、`labels`・`aria-label`・`aria-labelledby`・`title` のどれもない |
| `COLOR_CONTRAST_VIOLATION` | ACCESSIBILITY | 下の 5.3 | axe の `color-contrast` の violation |
| `A11Y_<axeルールID>` | ACCESSIBILITY | 下の 5.3 | そのほかの axe の violation。ruleId は `A11Y_` に axe のルールIDを大文字の snake case にして付ける |
| `DOCUMENT_HORIZONTAL_OVERFLOW` | LAYOUT | ERROR | 文書の横幅がビューポートを超える |
| `ELEMENT_OUTSIDE_VIEWPORT` | LAYOUT | WARN | 可視の主要要素が、横方向にビューポートの外へはみ出す |
| `ELEMENT_OVERLAP` | LAYOUT | WARN | 可視の主要要素どうしの重なり（position・z-index・overflow・visibility を考慮した C6 の候補のうち、どちらも静的配置で、重なり面積が小さい方の要素の面積の一定割合を超えるもの） |
| `TEXT_CLIPPING` | LAYOUT | WARN | テキストの見切れ |
| `FIXED_ELEMENT_OCCLUSION` | LAYOUT | WARN | 先頭の位置で、固定要素が主要要素を覆う |
| `ZERO_SIZE_INTERACTIVE_ELEMENT` | LAYOUT | WARN | 可視であるべき操作要素の大きさが 0 |
| `CONTENT_COLLISION` | LAYOUT | WARN | 見出し・段落・画像どうしの衝突（`ELEMENT_OVERLAP` のうち、テキストを含む要素どうしのもの） |
| `OVERSIZED_FIXED_ELEMENT` | LAYOUT | WARN | 固定要素の面積がビューポートの面積の一定割合を超える |
| `DYNAMIC_LAYOUT_SHIFT` | LAYOUT | WARN | ユーザー入力のない layout shift の要素が観測された |
| `POOR_CLS` | PERFORMANCE | WARN | 下の 5.2 |
| `POOR_LCP` | PERFORMANCE | WARN | 下の 5.2 |
| `POOR_FCP` | PERFORMANCE | WARN | 下の 5.2 |
| `POOR_TTFB` | PERFORMANCE | WARN | 下の 5.2 |
| `POOR_INP` | PERFORMANCE | WARN | 下の 5.2。INP が観測された場合だけ |
| `SAFETY_*` | SAFETY | SAFETY | 下の 5.4 |

layout の判定で使う割合などの定数（例: `ELEMENT_OVERLAP` の面積の割合、`OVERSIZED_FIXED_ELEMENT` の割合）は、各 Rule の定義の中に名前付きの定数として置く。Rule の外で定義し直さない。値は実装者が設計書 14.8（誤検知を避ける）に沿って決め、報告する。値を決めた根拠が弱い場合は WARN にとどめる（上の表のとおり）。

### 5.2 性能のしきい値

しきい値は、Web Vitals の公開された「poor」の境界に合わせる。値は `src/audit/performance-rules.ts` だけに置く（web-vitals の `rating` は保存していない。基盤修正の設計書 5.9 V12）。

| ruleId | 指標 | poor の条件 |
| --- | --- | --- |
| `POOR_LCP` | LCP | 4000 ms を超える |
| `POOR_FCP` | FCP | 3000 ms を超える |
| `POOR_CLS` | CLS | 0.25 を超える |
| `POOR_TTFB` | TTFB | 1800 ms を超える |
| `POOR_INP` | INP | 500 ms を超える |

- 観測できなかった指標（`NOT_OBSERVED`・`UNSUPPORTED`）からは Finding を作らない。0 や「良好」とみなさない（設計書 14.11）。
- 合成計測の値は環境に左右されるので、ERROR にしない。

### 5.3 axe の impact の対応

| axe の impact | severity |
| --- | --- |
| `critical` | ERROR |
| `serious` | ERROR |
| `moderate` | WARN |
| `minor` | INFO |
| なし・不明 | WARN |

axe の `incomplete`（判定できなかったもの）は Finding にしない。Evidence として残し、後段の意味監査に渡す。

### 5.4 Safety の Finding

Safety Ledger のページごとの事象から、severity `SAFETY` の Finding を作る。サイトの品質の Finding とは、集計の上で分ける（設計書 第13章）。

| ruleId | 元の事象 |
| --- | --- |
| `SAFETY_NON_READ_REQUEST_BLOCKED` | GET・HEAD 以外のリクエストの遮断 |
| `SAFETY_EXTERNAL_NAVIGATION_BLOCKED` | 外部Originへのナビゲーションの遮断 |
| `SAFETY_EXTERNAL_ACTION_BLOCKED` | `tel:`・`mailto:` などの外部アクションの遮断 |
| `SAFETY_DOWNLOAD_BLOCKED` | ダウンロードの遮断 |
| `SAFETY_POPUP_BLOCKED` | popup の遮断 |
| `SAFETY_WEBSOCKET_BLOCKED` | WebSocket の遮断 |
| `SAFETY_INTERACTION_CANDIDATE_EXCLUDED` | Interaction の候補の機械的な除外（基盤修正の設計書 4.6） |

同じ種類の事象が1ページで多数ある場合は、ページと種類ごとに1つの Finding に集約し、件数と代表の Evidence 参照を持たせる。不変条件の違反は、Finding ではなく Run Status（`ABORTED_BY_SAFETY`）で扱う。

### 5.1.1 layout の Rule の補足（2026-09-24 T12c の報告を受けて追加）

- **レスポンシブの幅ごとの結果**
  - 次の5つの Rule は、主要なビューポートの結果（`primary`）に加えて、幅ごとの layout の結果（`stressSweep`）にも当てはめる。上位の設計書 14.9 に従うためである。
    - `DOCUMENT_HORIZONTAL_OVERFLOW`
    - `ELEMENT_OUTSIDE_VIEWPORT`
    - `ELEMENT_OVERLAP`
    - `CONTENT_COLLISION`
    - `FIXED_ELEMENT_OCCLUSION`
  - 幅ごとの結果から作る Finding は、同一性の要素 `stressWidth`（幅の値）を持つ。Finding の `viewport` は、入力のビューポートのままにする。
  - 主要なビューポートと同じ幅の結果は、判定しない。重複するためである。
  - `FAILED` の結果と、layout が null の結果は、判定しない。
  - `PARTIAL` の結果は、集めた部分だけで判定する。
- **制約**（Evidence が足りないための近似）
  - `text-overflow: ellipsis` や `line-clamp` による意図した切り詰めを、`TEXT_CLIPPING` の対象から除けない。
  - 見出しが固定要素の子孫かどうかの事実がない。
  - 重ね合わせの文脈（stacking context）の入れ子を、扱えない。
  - 「静的配置」は `position: static` だけとする。`CONTENT_COLLISION` は見出しと段落どうし、`ELEMENT_OVERLAP` は画像・ボタン・リンク・入力欄どうしとする。テキストの要素とテキストでない要素の組は、判定しない（float による回り込みと区別できないため）。
- **共通化**（CC-013）
  - 入力のビューポートの、ある種類の Evidence を取り出す処理は、`src/audit/rule-helpers.ts` に置く。
  - 文言の中の数値の書式は、`src/presentation/format.ts`（UI追補設計書の表示用の書式の owner）の関数を使う。このファイルは Task 16 の予定だったが、T12f で先に作る。`src/audit/*` が `src/presentation/format.ts` を import することは、UI追補設計書の依存の向き（presentation は core だけに依存する）に反しない。

### 5.1.2 誤検知を避けるための Evidence の追加（2026-09-24 RT12 を受けて追加）

- **`ELEMENT_OUTSIDE_VIEWPORT`**
  - layout の collector は、はみ出しの候補ごとに、次の2つを記録する。
    - `horizontalClipAncestor`: 横方向に最も近い、`overflow-x` が `visible` 以外の祖先の種類。`NONE`、`CLIPPED`（`hidden`・`clip`）、`SCROLLABLE`（`auto`・`scroll`）のいずれか。
    - 一覧の中の、最も近い祖先の番号（ない場合は null）
  - Rule は、次の要素だけを報告する。
    - `horizontalClipAncestor` が `NONE` であること
    - kind が `other` でないこと（主要要素であること）
    - 一覧の中に、横にはみ出す祖先がないこと
      - 縦にだけはみ出す祖先（ページの下まで続く `main` など）は、数えない。
      - これを数えると、長いページの中の本当のはみ出しが、報告されなくなる（RT12a の判断を承認）。
  - 祖先の overflow で切り取られる要素と、スクロールで見られる要素は、はみ出しではない。入れ子の要素ごとに Finding を重ねない。
  - 主要要素の種類に、表（`table`）と埋め込み（`media`。iframe、video、embed、object、canvas）を加える（RT12r の N3）。
    - このため、表と埋め込みは、重なりの候補にも入る。固定要素がそれらを覆う場合は、`FIXED_ELEMENT_OCCLUSION` を作る。これは、画像を覆う場合と同じ、本当の問題である（RT12d の発見事項）。
  - はみ出しの候補の件数の上限の中では、`horizontalClipAncestor` が `NONE` の候補を優先して残す（RT12r の N4）。
  - 制約（RT12r の N2）: 切り取る祖先（`overflow:hidden` の外枠や clearfix）の中で、固定の幅の要素が切れても、報告しない。画像を広く置いて、わざと切り取るデザインがよく使われ、区別できないためである。
  - 制約（RT12r の N3）: kind が `other` の要素だけが横にはみ出す場合は、要素としては報告しない。ページの `DOCUMENT_HORIZONTAL_OVERFLOW` で報告される。
- **`DOCUMENT_HORIZONTAL_OVERFLOW`**（2026-09-24 RT12a の発見事項を受けて追加）
  - layout の collector は、ビューポートの横方向の overflow（`html` と `body` から伝わる計算値）を記録する。
  - その値が `hidden` か `clip` の場合は、横スクロールが生じないので、Rule はこの Finding を作らない。
  - このとき、切り取られた内容は、`ELEMENT_OUTSIDE_VIEWPORT` でも報告しない。これは、`horizontalClipAncestor` が `CLIPPED` になるためである。
  - 意図して隠している場合と区別できないので、受け入れる。
  - 制約: 次の形では、誤検知が残りうる（RT12c）。まれな形なので、受け入れる。
    - html が `overflow-x:auto` である。
    - ビューポートに伝わらない body が `overflow-x:hidden` である。
- **`TEXT_CLIPPING`**
  - layout の collector は、見切れの候補ごとに `partiallyClippedText` を記録する。これは、子孫のテキストが、要素の箱で切り取られているかを表す。
  - 判定の方法（2026-09-24 RT12r の N1 を受けて改めた）
    - テキストの行の矩形（`Range.getClientRects()`）は、フォントの内容領域の高さを持ち、行の高さとは一致しない。そのため、わずかなまたぎは数えない。
    - 次のどちらかに当たれば、真とする。
      1. 行の矩形のうち、箱の外に出た量が、次のしきい値を超える。
         - 縦方向: その行の高さの4分の1。フォントの内容領域と、行の高さのずれを吸収するためである。箱の上に出た量と下に出た量は、別々に比べる。合計しない（RT12r2 の I1。合計すると、1行の箱で誤って報告するため）。
         - 横方向: 2 px。横方向には、このずれがない。文字の少しの張り出しだけを許す（2026-09-24 RT12d の発見事項を受けて改めた）。
      2. 縦方向に切り取る箱で、行の矩形が、箱の上か下に丸ごと出ていて、しかも横方向に箱と重なる。
    - ただし、箱の中に見える行が1つもない場合は、偽とする。閉じたアコーディオンなどを、誤って報告しないためである。
    - 見えない子孫のテキストは、判定に使わない（RT12r2 の M1）。見えるかどうかは、共通部品の可視性の判定（`VISIBILITY_CHECK_OPTIONS`）で決める。対象は、`visibility:hidden` や `opacity:0` のテキストである。
  - Rule は、これが真の候補だけを報告する。
  - テキストでない中身（画像、カルーセルの外枠）のはみ出しや、横方向に箱と重ならないテキスト（隠れたスライド）は、対象にしない。
  - 制約: 次の形は、ellipsis や line-clamp と同じく、報告されることがある（WARN）。意図して隠したテキストと区別できないためである（RT12r2 の M1・M3）。
    - 「続きを読む」のように、高さを決めて意図して切り取った箱
    - 項目の全体を `max-height` で閉じるアコーディオン
    - 閉じても、上下の padding が残るパネル
    - `top:100%` に置き、hover で出す説明文
    - 隣のスライドを少し見せるカルーセル（peek）
- **`ZERO_SIZE_INTERACTIVE_ELEMENT`**
  - layout の collector は、候補ごとに `hasRenderedDescendant` を記録する。これは、子孫に、大きさのある描画された要素があるかを表す。
  - Rule は、これが真の要素を除く。float や absolute の子を包むリンクは、実際に操作できるためである。
  - 大きさが 1 px 以下の子孫は、描画された子孫として数えない（RT12r の N5）。visually hidden の要素だけを含む、大きさ0のリンクを見逃さないためである。
  - 文書の左か上の外（右端か下端が 0 以下の座標）に丸ごと置かれた子孫も、描画された子孫として数えない（RT12r2 の M2）。`left:-9999px` で隠したテキストだけを含むリンクを見逃さないためである。
    - ただし、この扱いは、候補のリンク自身が文書の外にない場合に限る（RT12r3 の m1）。`translate3d` で文書の外へ動かしたカルーセルのスライドの中のリンクを、誤って報告しないためである。
    - 「候補が文書の外にある」とは、次のどちらかが成り立つことをいう（2026-09-24 RT12g の Blocker を受けて定めた）。
      - 左端が負で、かつ右端が 0 以下である。
      - 上端が負で、かつ下端が 0 以下である。
    - 大きさ0の候補は、左端と右端が同じ値になる。そのため、「右端が 0 より大きい」だけでは、文書の左上（座標 0）にある幅0のリンクを、誤って文書の外と判定してしまう。これを避けるための定義である。
    - 制約: RTL の文書で、左へはみ出した部分にある同じ形のリンクは、報告されることがある。まれなので、受け入れる。
- 走査の作業量は、既存の上限の中で行う。

### 5.4.1 Safety の Evidence（2026-09-24 T12d の Blocker を受けて追加）

Safety の Rule が入力にする Evidence を、次のように定める。

- **Evidence の種類**: `safety` を、`EVIDENCE_TYPES` に加える。ID の接頭辞は `SAFETY` とする。
- **単位**: Safety Ledger 1つにつき、Evidence を1つ作る。
  - Passive の Ledger: ページとビューポートの組ごとに1つある。Evidence の `viewport` は、そのビューポートにする。
  - Interaction の Ledger: ページごとに1つあり、Desktop だけで使う。Evidence の `viewport` は `desktop` にする。
  - Page Auditor（Task 14）は、あるビューポートの Rule の入力に、そのビューポートの Evidence を含める。
- **中身（payload）**: `SafetyEventsEvidence` とする。
  - `scope`: `PASSIVE` か `INTERACTION`。
  - Ledger の snapshot のうち、次の項目を持つ。
    - ページの事象の記録: `blockedRequestsByMethod`、`blocked*` の各配列、`excludedInteractionCandidates`
    - 記録の上限の情報: `recordLimits`
  - 不変条件の違反（`invariantViolations`、`invariantViolationCount`）は、持たない。違反は Finding にせず、Run Status で扱う（実装タスク指示の Safety Invariants）。
- **型の定義は1か所にする**
  - 事象の型（`BlockedRequestEvent` など）、`SafetyLedgerRecordLimits`、`SafetyEventsEvidence` は、`src/core/evidence-types.ts` に置く。
  - `src/safety/safety-ledger.ts` は、それらを import して使う。`SafetyLedgerSnapshot` は、`SafetyEventsEvidence` の項目（`scope` を除く）に、違反の項目を加えた型として定義する。同じ意味の型を2か所に書かない。
  - 事象の型が参照する閉じた一覧は、core に `as const` の配列として置く。対象は、Interaction の候補の除外理由（`INTERACTION_REJECTION_REASONS`）などである。`src/safety/interaction-policy.ts` の `InteractionRejectionReason` は、その別名にする。
- **Rule との対応**
  - 各 Rule は、Evidence の scope（PASSIVE か INTERACTION か）では絞らず、項目ごとに数える（2026-09-24 T12d の判断を承認）。
    - Interaction の Context でも、凍結していない間は、Passive と同じ方針で遮断する。その記録は、同じ項目に入るためである。
  - `SAFETY_NON_READ_REQUEST_BLOCKED`: 次の2つを数える。
    - `blockedRequests`
    - Interaction の `blockedInteractionRequests` のうち、GET・HEAD 以外のもの
  - `SAFETY_EXTERNAL_NAVIGATION_BLOCKED`: `blockedNavigations` を数える。
  - `SAFETY_EXTERNAL_ACTION_BLOCKED`: `blockedExternalActions` を数える。
  - `SAFETY_DOWNLOAD_BLOCKED`: `blockedDownloads` を数える（Passive と Interaction の両方）。
  - `SAFETY_POPUP_BLOCKED`: `blockedPopups` を数える。
  - `SAFETY_WEBSOCKET_BLOCKED`: `blockedWebSockets` と `blockedInteractionWebSockets` を数える。
  - `SAFETY_INTERACTION_CANDIDATE_EXCLUDED`: `excludedInteractionCandidates` を数える。
  - Interaction の凍結中に遮断した GET・HEAD のリクエストと、`blockedInteractionNavigations` は、Finding にしない。
    - これらは、凍結のしくみで遮断されることが予定された通信である。
    - その結果は、Interaction の Evidence（BLOCKED の判定）に表れている。
    - Evidence には、そのまま残す。
- **件数**
  - Finding の件数は、記録された事象の数とする。
  - `recordLimits.truncated` が真の場合は、実際の件数はこれより多い可能性がある。そのことを文言に書く。
  - Finding は、ページ、ビューポート、Rule の組ごとに1つにまとめる。Scope（PASSIVE と INTERACTION）の違いでは分けない。
  - 同一性の要素は、Rule とページとビューポートで決まるので、追加しない（同じ Rule の Finding は1つだけ）。

## 6. Rule の契約

```ts
// 概念の例。正確な型名は実装者が C8 の型に合わせて決め、報告する。
interface AuditRule {
  readonly ruleId: string;          // 例: 'HTTP_4XX'
  readonly version: number;         // 正の整数。判定を変えたら上げる
  readonly category: FindingCategory;
  readonly severity: Severity;      // A11Y の一部のように入力で決まる場合は、評価の結果で指定する
  evaluate(input: PageRuleInput): readonly FindingDraft[];
}
```

- `PageRuleInput` は、1ページ・1ビューポートの型付きの Evidence（`EvidenceRecord` の配列。ID 付き）と、ページのID・URL・ビューポートを持つ。Rule は、ここに含まれない情報を読まない。
- `FindingDraft` は、`ruleId`・`ruleVersion`・`category`・`severity`・`message`・`evidenceRefs`（1件以上）・fingerprint の同一性の要素（安定した対象の識別子）を持つ。ID と fingerprint は持たない。
- **文言**: `message` は日本語で、Rule の定義が作る（UI追補設計書 3.1、4.2）。文言には、判定に使った事実（URL、ステータス、値としきい値など）を含める。意味的・美的な断定を書かない（例: 「リンク文言がリンク先と合っていない」とは書かない）。
- **Rule Engine**:
  - `RULE_CATALOG` のすべての Rule を評価する。
  - `createFindingFingerprint()` で fingerprint を付け、決定論的な順序（severity の順、ruleId、fingerprint）で並べ替えてから、Finding ID を振る。
  - Rule が例外を投げた場合は、その Rule の失敗を構造化された理由として返し、ほかの Rule の評価を続ける。失敗した Rule があるページは、Run Status を COMPLETE にしない（Task 14・15 で扱う）。
- **fingerprint の対象**: `targetId`（`AuditConfig.target.id`）、`ruleId`、正規化したページのURL、ビューポート、安定した対象の識別子（例: 資源のURL、selector、要素の id、axe のルールと target）。
- **下書きから Finding への変換の共通化（2026-09-24 T12a の報告を受けて追加）。**
  - 下書きの検査、fingerprint の付与、並べ替え、Finding ID の採番は、1つの関数（`materializeFindingDrafts`）で行う。
  - 置き場所は、`src/audit/rule-engine.ts` とする。
  - Page rule の Engine と、Cross-page rule（第7章）は、どちらもこの関数を使う。
  - ビューポートは、予約名 `viewport` の同一性の要素として、fingerprint に含める。ビューポートによらない Finding（Cross-page など）では、含めない。
  - Rule が `viewport` の名前の同一性の要素を返した場合は、その Rule の失敗とする。
- **ruleId の決まり（2026-09-24 追加）。**
  - `ruleIdPrefix` を持たない Rule の下書きは、ruleId が Rule の ruleId と一致しなければならない。
  - axe の Rule のように、評価のたびに ruleId を作る Rule は、`ruleIdPrefix`（例: `A11Y_`）を持つ。その下書きは、ruleId がその接頭辞で始まらなければならない。
  - `RULE_CATALOG` は、ほかの Rule の ruleId が、ある Rule の `ruleIdPrefix` で始まらないことを検査する。
  - 決まりに反する下書きは、その Rule の失敗とする。

## 7. Cross-page rule（Task 13）

| ruleId | severity | 判定の要点 |
| --- | --- | --- |
| `BROKEN_INTERNAL_LINK` | ERROR | 内部リンクの遷移先が、監査の結果として 4xx・5xx（category は LINK。2026-09-23 に page rule から移した） |
| `TARGET_NAVIGATION_FAILED` | ERROR | 内部リンクの遷移先へのナビゲーション自体が失敗した（category は LINK。同上） |
| `DUPLICATE_PAGE_TITLE` | WARN | 正規化した title が、別の canonical のページと同じ |
| `DUPLICATE_CANONICAL` | WARN | 異なるページが同じ canonical を宣言し、そのどれも canonical 自身ではない |
| `MULTIPLE_URLS_SAME_CANONICAL` | INFO | 複数のURLが同じ canonical を指す（事実の記録） |
| `CANONICAL_TARGET_NOT_FOUND` | WARN | canonical の遷移先が、クロールで発見されなかった、または 4xx・5xx |
| `INCONSISTENT_ORIGIN` | WARN | canonical の Origin が、許可Originの外（2026-09-24 に、最終URLの Origin は `UNEXPECTED_ORIGIN_REDIRECT` だけで扱うことにした。同じ事実から2つの Finding を作らないため） |
| `SITEMAP_URL_NOT_DISCOVERED` | INFO | sitemap にあるが、クロールで発見されなかったURL |
| `DISCOVERED_URL_NOT_IN_SITEMAP` | INFO | クロールで発見したが、sitemap にないURL（sitemap がある場合だけ） |
| `NAVIGATION_TIMEOUT` | ERROR | ページのナビゲーションが、設定の期限（`navigationTimeoutMs`）を過ぎた。category は HTTP（2026-09-24 に page rule から移した） |
| `UNEXPECTED_ORIGIN_REDIRECT` | WARN | ページのナビゲーションのリダイレクトの行き先が、許可Originの外だった（Guard が遮断したものを含む）。category は HTTP（同上） |

- 1つの事実から作る Finding は1つだけにする（2026-09-24 RT12 の I4）。リンク先の `navigationOutcome` に応じて、次のように分ける。
  - `TIMEOUT`: `NAVIGATION_TIMEOUT` だけで扱い、`TARGET_NAVIGATION_FAILED` にはしない。
  - `BLOCKED_EXTERNAL_REDIRECT`: `UNEXPECTED_ORIGIN_REDIRECT` だけで扱い、`TARGET_NAVIGATION_FAILED` にはしない。
  - `FAILED`: `TARGET_NAVIGATION_FAILED` の対象にする。
- `DUPLICATE_CANONICAL` と `MULTIPLE_URLS_SAME_CANONICAL` で canonical が自分自身かどうかを判断するときは、`pageUrl` だけでなく、最終URLでも比べる（RT12 の M7）。正常なリダイレクトの後に、自分自身を canonical にしているページを、誤って WARN にしないためである。
- sitemap の Evidence が上限で切り詰められた場合は、`DISCOVERED_URL_NOT_IN_SITEMAP` を判定しない。`SitemapEvidence` に切り詰めの印を加えるのは、Task 15 で行う（RT12 の確認できなかった点）。
- `NAVIGATION_TIMEOUT` と `UNEXPECTED_ORIGIN_REDIRECT` の入力（2026-09-24 T12b の Blocker を受けて追加）
  - ページとビューポートごとの、ナビゲーションの結果を使う。Task 14 の Page Auditor が記録する。
  - ナビゲーションの結果は、次の3つを持つ。
    - 要求したURL
    - 最終URL（得られない場合は null）
    - 結果の種類: `OK`、`TIMEOUT`、`FAILED`、`BLOCKED_EXTERNAL_REDIRECT`
  - 許可Originの一覧は、設定から Cross-page rule の入力として渡す。
  - これらの Rule は、ページごとの Evidence ではなく、ページの監査の結果から判断する。そのため、page rule ではなく Cross-page rule にした。
  - 同じページの複数のビューポートで同じ結果になった場合は、1つの Finding にまとめる。
- 入力の順序が、出力の順序と fingerprint に影響しないこと（実装計画 Task 13）。
- 見出しやリンクの文言の意味の重複（例: 「6つの理由」と「7つの理由」）は、Finding にしない。
- sitemap との違いだけで ERROR にしない。

## 8. テスト

- 各 Rule について、成立する Evidence と成立しない Evidence の両方でテストする。
- 実装計画 Task 12 Step 1 の Rule ID の一覧が、すべて Rule Catalog にあることをテストする。
- 「交通事故」というリンク文言で `/symptoms` を指すリンクが、Finding にならないことをテストする。
- `RULE_CATALOG` に同じ ruleId が2回登録されていないことをテストする。
- Rule Engine の出力が、入力の Evidence の順序に依存しないことをテストする。
- 観測できなかった性能の指標から Finding ができないことをテストする。

## 9. 対象外

- Task 14（ページの監査の流れの組み立て）と Task 15（Run の調整）。
- 表示のラベル（Task 16）。

## 10. 完了条件

- [ ] 第5章と第7章の Rule が、すべて実装されテストされている。
- [ ] `RULE_CATALOG` が唯一の登録先で、`evaluateCrossPageRules()` が唯一の Cross-page の評価の入口である。
- [ ] `npm run verify` が PASS する。
- [ ] 独立レビューで Critical 0・Important 0。

## 11. 設計変更履歴

| 日付 | 契機 | 変更内容 | 影響範囲 |
| --- | --- | --- | --- |
| 2026-09-23 | 初版 | - | Task 12、13 |
| 2026-09-24 | RT12g の Blocker | 「候補が文書の外にある」の定義を、端が負で、反対の端が 0 以下である場合に改めた | RT12g |
| 2026-09-24 | RT12r3 | 画面の外の子孫の扱いを、候補が文書の中にある場合に限った。RTL の制約を加えた | RT12g |
| 2026-09-24 | RT12r2 | 見切れの上下の比較、見えない子孫、画面の外の子孫、制約を加えた | RT12f |
| 2026-09-24 | RT12d の報告 | 見切れのしきい値を、縦と横で分けた。表と埋め込みの重なりの扱いを書いた | RT12e |
| 2026-09-24 | RT12r | 5.1.2 の `TEXT_CLIPPING` の判定の方法、主要要素の種類、候補の優先、1 px 以下の子孫、制約2つを加えた | RT12d |
| 2026-09-24 | RT12a の報告 | 5.1.2 の祖先の読み方を直した。`DOCUMENT_HORIZONTAL_OVERFLOW` の扱いを加えた | RT12c |
| 2026-09-24 | RT12 | 5.1.2 を加えた。第7章に、1つの事実から1つの Finding、canonical の自分自身の判断、sitemap の切り詰めを加えた | RT12a、RT12b、Task 15 |
| 2026-09-24 | T13b の報告 | `INCONSISTENT_ORIGIN` を canonical だけに絞った | T12f |
| 2026-09-24 | T12c の報告 | 5.1.1 を加えた（幅ごとの結果、制約、共通化） | T12e、T12f |
| 2026-09-24 | T12b の Blocker | `NAVIGATION_TIMEOUT` と `UNEXPECTED_ORIGIN_REDIRECT` を、page rule から Cross-page rule に移した。判定に、ナビゲーションの結果と許可Originが必要なため | Task 13（T13b）、Task 14 |
| 2026-09-23 | Task 14〜17 の設計（第5.3節） | `BROKEN_INTERNAL_LINK` と `TARGET_NAVIGATION_FAILED` を、page rule から Cross-page rule に移した。リンク先のページの監査結果が必要で、ページをまたぐ判断にあたるため | Task 12、13、15 |
