# 不具合台帳

## DEF-001: axe の実行で、Guard の付いた Passive Context が安全違反として閉じられる

- 状態: 修正済み（DEF-001b で、Evidence に検査の範囲の制約 `frameScope: 'SAME_ORIGIN_ONLY'` を記録した）
- 発見日: 2026-09-23
- 発見した経緯: C8（型とスキーマの整備）の実装者が、ローカルの fixture で実際の Evidence をスキーマで検証するテストを書いていたときに見つけた。
- 現象: `fixtures/site/index.html` で `collectAccessibilityEvidence` を実行すると、Safety Ledger に `CDP_SESSION_DETACHED`（「Document interception session detached while its page remained active」）が1件記録され、page が閉じられる。
- 再現手順: Guard の付いた Passive Context で fixture のページを開く。`collectAccessibilityEvidence` を実行し、Safety Ledger の `invariantViolations` を確かめる。
- 影響範囲: Task 14 のページの監査の流れで axe を実行すると、不変条件の違反が記録され、Run が `ABORTED_BY_SAFETY` になる。既存のテストで見つからなかったのは、axe の実行後に Ledger を確かめるテストがなかったためと考えられる（未確認）。
- 発生時期の推測: Task 9（accessibility collector）と、Task 5・11（Guard）の組み合わせで起きる。いつから起きていたかは確かめていない（HEAD に戻す確認は禁止されている）。
- 原因の推測（未確認）: `@axe-core/playwright` の `AxeBuilder` は、既定の方式では、結果をまとめるために同じ BrowserContext に別の page を開く。それが Guard の監視（page ごとの CDP のセッション）と衝突している可能性がある。
- 対応する設計: `doc/design/2026-09-23-beaksight-foundation-corrections-design.md` 第8.1節
- 対応するサブタスク: DEF-001
- 原因（確かめた事実）: `@axe-core/playwright` 4.13.0 は、既定の方式では `context.newPage()` で `about:blank` の page を開き、それを直接閉じる。Guard はその page の CDP のセッションの切り離しを `CDP_SESSION_DETACHED` として記録し、Context を無効化していた。Guard の判定は仕様どおりである。
- 修正: axe をレガシーの方式（`setLegacyMode(true)`）で実行するようにした。
- 検証結果: 新しい統合テスト `tests/integration/accessibility-guard-safety.test.ts` で確かめた。修正前は RED で、修正後は GREEN になった。3回続けて実行し、3回とも PASS した。accessibility に関係する4ファイル・33件も PASS した。

## DEF-002 Evidence の ID の接頭辞の表が、Object の既定のプロパティ名を受け付ける

- 発見: 2026-09-24、P14b の実装者の報告（推測。実行では未確認）
- 現象:
  - `src/core/ids.ts` の `formatEvidencePrefix` は、普通のオブジェクト `evidencePrefixes` を `evidencePrefixes[type]` で引く。
  - この値が undefined かどうかで、種類の正しさを判定している。
  - そのため、`'constructor'` や `'toString'` を渡すと、関数の値が接頭辞として使われる。`RangeError` にならない。
- 影響:
  - `createEvidenceId` と `IdAllocator.allocateEvidenceId` が、不正な種類から ID を作るおそれがある。
  - 型の検査では防げるが、実行時の入力（テストや、将来の外部の入力）では防げない。
- 発生時期: 不明（HEAD との比較はしない）。
- 修正方針:
  - 表を `Object.hasOwn` で確かめる。または、`EVIDENCE_TYPES` に含まれるかで確かめる。
  - 同じ形の表がほかにもあれば、あわせて直す。
- 状態: 修正済み（2026-09-24）。`Object.hasOwn` で判定する。同じ形の不具合が `validateArtifact` にもあったので、あわせて直した。

## DEF-003 Interaction の除外理由の記録先の表が、Object の既定のプロパティ名を受け付ける

- 発見: 2026-09-24。DEF-002 の実装者が、同じ形の箇所を探した結果として報告した。
- 現象: `src/safety/interaction-policy.ts` の `interactionRejectionLedgerRecord` は、普通のオブジェクトの表を、存在を確かめずに引いている。
- 影響: いまは、実害のある経路がない。
  - 呼び出し元は1か所で、閉じた集合から作った理由だけを渡している。
  - 継承したプロパティ名が渡った場合は、Ledger に記録しない扱いになる（推測）。
  - それでも、安全の判定の部品なので、fail-closed の形にそろえる。
- 修正方針:
  - `Object.hasOwn` で確かめる。
  - 表にない理由は、例外にする。
- 実施の時期: Task 14 のチェックポイントの後に、CC-017 と同じサブタスクで行う。どちらも Interaction の周辺の変更なので、1回のサブタスクで扱う。
- 状態: 修正済み（2026-09-24、C14x）。表にない理由は、`TypeError` にする。

## DEF-004 ネットワークの層の失敗で、Guard が安全の不変条件の違反を記録する

- 発見: 2026-09-24。R15a の実装者の報告による。
- 現象:
  - 許可した GET のメインフレームのナビゲーションが、ネットワークの層で失敗することがある。確かめた例は、`net::ERR_CONNECTION_REFUSED` である。
  - このとき、`src/safety/passive-request-guard.ts` の `requestfailed` の処理（1296行目付近）が、`HTTP_MAIN_FRAME_DELIVERY_FAILED` を違反として記録し、Context を無効にする。
- 影響:
  - Run Status の入力の違反の件数に数えられるので、一時的なネットワークの失敗でも、Run が `ABORTED_BY_SAFETY` になる。
  - 設計書 5.2 の再試行（`ERR_CONNECTION_RESET` など）と矛盾する。
  - Page Auditor の理由に、閉じる処理の失敗（`UNHANDLED_FAILURE`）が加わる。
- 原因の分析:
  - この違反は、Guard 自身の不具合を、fail-closed で検出するためのものである。例えば、配送の取りこぼしや、予期しない中断である。
  - 許可した GET と HEAD は、ネットワークの層で失敗しても、安全の問題にならない。サーバに届いても、読み取りだけだからである。
  - しかし、いまの書き方は、これを区別していない。
- 発生時期: Task 5 の時点からの振る舞い（progress.md に「connection refusal remains immediate」の記録がある）。HEAD との比較はしていない。
- 修正方針（設計者）:
  - 違反から外すのは、次の3つの条件をすべて満たす場合だけにする。
    - 許可した（ALLOW）GET か HEAD の、メインフレームのナビゲーションである。
    - 失敗の理由が、ネットワークの層の失敗である。
    - その理由が、閉じた一覧に載っている。
  - 閉じた一覧は、`src/safety/` の1か所に置く。
  - `net::ERR_ABORTED`、`net::ERR_FAILED`、`net::ERR_BLOCKED_BY_CLIENT`、`net::ERR_BLOCKED_BY_RESPONSE` などは、一覧に入れない。これらは、Guard の不具合を示しうるので、これまでどおり違反とする。
  - 修正の後に、Guard の安全の性質の独立レビューを行う。
- 状態: 修正済み（2026-09-24）。閉じた一覧は `src/safety/network-layer-failure.ts` にある。Guard の独立レビュー（RDEF4）は承認。
- 追加の修正（DEF-004b）: 違反から外すのは、凍結中でない場合に限る（RDEF4 の Minor-1）。修正済み（2026-09-24）。
- 観察の対象（RDEF4 の Minor-2）: 一覧にないネットワークの層の失敗がある。
  - 該当するのは、`ERR_HTTP2_PROTOCOL_ERROR`、`ERR_QUIC_PROTOCOL_ERROR`、`ERR_PROXY_CONNECTION_FAILED`、`ERR_TUNNEL_CONNECTION_FAILED`、`ERR_SOCKET_NOT_CONNECTED`、`ERR_NETWORK_IO_SUSPENDED`、`ERR_CONTENT_LENGTH_MISMATCH`、`ERR_INCOMPLETE_CHUNKED_ENCODING`、`ERR_RESPONSE_HEADERS_TRUNCATED`、`ERR_BAD_SSL_CLIENT_AUTH_CERT`、`ERR_CERTIFICATE_TRANSPARENCY_REQUIRED` である。
  - fail-closed の扱いのまま、違反とする。
  - 実際のサイト（Task 20・21）で起き、Run が `ABORTED_BY_SAFETY` になった場合は、そのコードを一覧に入れるかを、Guard の独立レビューとともに判断する。

## DEF-005 外部へのリダイレクトの遮断と、接続拒否を続けた後に、Context を閉じる処理が止まる（疑い）

- 発見: 2026-09-24。R15d の実装者の報告による。設計者も再現した。
- 現象:
  - `tests/integration/page-navigation.test.ts` の191行目のテスト（`judges BLOCKED_EXTERNAL_REDIRECT by the increase ...`）が、`afterEach` の後片付けで、30秒の期限を過ぎて失敗する。
  - このテストは、1つの Guard の付いた page で、2回ナビゲーションする。
    1. 外部へのリダイレクトの遮断
    2. 接続拒否
  - 後片付けでは、`closePassiveResources` を使う。
  - このテストを単独で実行すると PASS する。直前の「接続拒否」のテストと続けて実行すると、失敗する（実装者の報告）。
- 経緯:
  - DEF-004 の後の設計者の verify（68ファイル）では、PASS していた。
  - その後に入った変更は、DEF-004b（Guard の条件1つ）と R15d である。R15d は、このテストが使うファイルを変えていない。
- 影響（推測）:
  - 製品のコードで、Context を閉じる処理が止まるのであれば、実際の Run でも、接続拒否の後にページを閉じる処理が、最大30秒止まるおそれがある。
  - DEF-004 で、接続拒否で Context を無効にしなくなったことが、関係している可能性がある。以前は、無効化によって、Context がすぐに閉じられていた。
- 発生時期: HEAD との比較はしない。
- 原因（2026-09-24、DEF-005 の調査）: 製品のコードではない。
  - エラーページを表示している page で、次のナビゲーションも失敗し、その直後に `page.close()` を呼ぶと、Chromium は page を閉じない。これは、Guard の有無に関係しない。
  - DEF-004 より前は、Context の無効化によって、この経路が隠れていた。
- 状態: 修正済み。テストの後片付けを、Context を閉じる形に直した。潜在的な問題は、DEF-006 とした。

## DEF-006 page を閉じる処理に期限がなく、Chromium の条件によっては永久に止まる（潜在的な不具合）

- 発見: 2026-09-24。DEF-005 の調査による。
- 現象:
  - エラーページを表示している page で、次のナビゲーションも失敗し、その直後に `page.close()` を呼ぶと、Chromium は page を閉じない。この場合、`page.close()` は永久に終わらない。
  - 期限のない `page.close()` は、次の箇所にある。
    - `src/safety/passive-request-guard.ts` の `closePassiveGuardedPage`
    - `src/orchestration/passive-session-close.ts`
    - `tests/helpers/passive-cleanup.ts`
- 影響:
  - いまの製品のコードは、ナビゲーションごとに新しい page を開くので、この条件には当たらない（推論）。
  - ただし、当たった場合は、Run 全体が永久に止まる。Task 14 の方針（止まり続ける経路を残さない）に反する。
- 修正方針:
  - page を閉じる処理に、期限を付ける。期限は、名前を付けた定数にする。
  - 期限を過ぎた場合は、Context を閉じる処理に切り替える。Context を閉じれば、止まった page も閉じる。
  - 期限を過ぎたことは、閉じる処理の失敗として記録する。
  - Guard の `closePassiveGuardedPage` を変える必要があるかは、実装者が調べて報告する。Guard を変える場合は、独立レビューを行う。
- 実施の時期: Task 16 の前の整理のサブタスク（CC-021 と同じサブタスク）。
- 状態: 修正済み（2026-09-24、C15x）。page は `PAGE_CLOSE_TIMEOUT_MS`、Browser は `BROWSER_CLOSE_TIMEOUT_MS` の期限で閉じる。

## DEF-007 再試行すると、最初の試行のスクリーンショットが上書きされる

- 発見: 2026-09-24。R15e の実装者の報告による。
- 現象:
  - Page Auditor のスクリーンショットのパス（`screenshotCapturePaths(root, pageId, profile)`）は、試行を区別しない。
  - 再試行は、同じ `pageId` で行う。そのため、2回目の試行が、最初の試行のファイルを上書きする。
  - R15e で、最初の試行の Evidence を残すようにした。その結果、最初の試行の `screenshot` の Evidence が、別の試行の画像を指すことになる。
- 影響: Evidence と、それが指すファイルが食い違う。証拠として正しくない。
- 修正方針:
  - 再試行の前の試行のスクリーンショットは、`pages/<pageId>/retry-<n>/<ビューポート>/` に置く。
  - 最終の試行のものは、これまでの場所に置く。
  - Coordinator から Page Auditor に、試行を区別する情報を渡す。例えば、スクリーンショットの置き場所の副ディレクトリである。
- 実施の時期: C15x（Task 15 の後の整理）で行う。
- 状態: 修正済み（2026-09-24、C15x）。再試行の前の試行のスクリーンショットは、`retry-<n>` に置く。

## DEF-008 Context を閉じる処理と、Context・page を作る処理に、期限がない（潜在的な不具合）

- 発見: 2026-09-24。R15r の Minor-1 による。
- 現象: 次の処理に、期限がない。
  - `src/safety/passive-request-guard.ts` の `context.close()`（429行目付近）
  - Context と page を作る処理
- 影響（推測）:
  - DEF-005 の観察では、Context を閉じる処理は、止まった page も閉じた。そのため、現実の危険は低い。
  - それでも、止まった場合は、Run が止まり続ける。
- 修正方針: 期限を付ける。期限を過ぎた場合の扱いは、Guard の設計に関わる。そのため、設計者が決め、Guard の独立レビューを行う。
- 実施の時期: Task 18 の前の整理で行う。
- 進み具合: P18a で、PREFLIGHT、環境の読み取り、サイトの metadata、幅の走査に、期限を付けた（2026-09-25）。P18c で、Page Auditor と Interaction に、期限を付けた（2026-09-25）。
- 状態: 修正済み（2026-09-25、P18a・P18c）。Guard の独立レビュー（RP18）で確かめる。

## DEF-009 同じ秒に始めた2つの Run が、同じディレクトリに書く

- 発見: 2026-09-25。R16 のレビューの指摘の4による。
- 現象:
  - `runId` は、開始の時刻の秒の単位で作る（`src/orchestration/run-id.ts`）。
  - 同じ UTC の秒に始めた2つの Run は、同じ `runId` になり、同じ Run のディレクトリに書く。
  - Page Auditor のスクリーンショットと、`ArtifactWriter` の書き出しは、どちらも既存のディレクトリを検出しない。
- 影響:
  - 2つの Run の artifact が混ざるか、上書きされる。証拠として正しくない。
  - 起きるのは、同じ出力先に、ほぼ同時に2つの CLI を起動した場合に限られる。
- 修正方針（案。Task 18 の前の整理で、設計を書いてから行う）:
  - Run Coordinator が、Run の開始の時点で、Run のディレクトリを排他的に作る。親のディレクトリは作ってよいが、Run のディレクトリそのものは、すでにあれば失敗させる。
  - 失敗した場合は、対象のサイトにアクセスする前に止める。
  - 扱いは、PREFLIGHT の失敗と同じく `FAILED` とし、理由を付ける。
- 実施の時期: Task 18 の前の整理（DEF-008 と同じ時期）。
- 状態: 修正済み（2026-09-25、P18d）。Run のディレクトリを、PREFLIGHT の前に排他的に作る。作れなかった場合は、理由 `RUN_DIRECTORY_UNAVAILABLE` で `FAILED` とし、artifact を書かない。

## DEF-010 ポップアップと移動の先の確認が、常に真になる（既存のテストの欠陥）

- 発見: 2026-09-25。Task 18 の着手前の、読み取り専用の調査による。
- 現象:
  - `tests/integration/isolated-interaction.test.ts:1846-1847、1864` は、ポップアップと移動の先のページへのリクエストが届かないことを確かめている。
  - しかし、確かめるパスが `'popup-target.html'` と `'navigation-target.html'` で、先頭の `/` がない。
  - fixture のサーバが記録するパスは、必ず `/` で始まる。そのため、この確認は常に真になり、何も確かめていない。
  - 確認の対象のファイルも、`fixtures/site/` にない。
- 影響:
  - Interaction 中のポップアップと移動の遮断（Safety Invariants の S04・S06）を、サーバの境界で確かめていないことになる。
  - Ledger の記録の確認は、別にある。そのため、遮断そのものが働いていないとは限らない（推測）。
- 修正方針: Task 18 の T18a で、次の2つを行う。
  - 移動の先のページを `fixtures/site/` に置き、確認のパスを直す。
  - Safety の Gate（S04・S06）でも、サーバの境界で確かめる。
- 実施の時期: Task 18（T18a）
- 状態: 修正済み（2026-09-25、T18a）。パスを直した後も、遮断のテストは PASS した。対照の確認で、Guard がなければ GET が届くことも示した。

## DEF-011 UI Gate のコメントの除去が、文字列の中の `/*` を誤って扱う

- 発見: 2026-09-25。T18d の報告の発見事項1による。
- 現象:
  - `tests/architecture/ui-ssot.test.ts:81-82` の `stripComments` は、正規表現だけでコメントを除く。
  - そのため、文字列の中の `/*` を、コメントの始まりとみなす。
  - 例: `src/safety/passive-request-guard.ts:1385` の `'**/*'` から1481行までが、コメントとして消える。
- 影響:
  - 消えた範囲は、GATE-UI04・UI06 と、CC-016 の検査（`join('、')`）から抜け落ちる。そこに違反があっても、検出できない。
  - 今は、その範囲に対象の式がないので、結果に違いはない（T18d の確認）。
- 修正方針: UI Gate も、T18d で作った `tests/architecture/source-scan.ts` の走査を使う形にする。この走査は、コメント、文字列、正規表現のリテラルを分ける。
  - あわせて、ファイルの一覧の取得と読み込みの重複もなくす。
  - 修正の前に、文字列の中に `/*` がある例で、今の関数が誤ることを RED で確かめる。
- 実施の時期: Task 18（T18e）
- 事実の訂正（2026-09-25、T18e の報告による）:
  - 上の「1385行から1481行までが消える」は、今のソースでは起きていなかった。その `'**/*'` の後ろには、閉じる `*/` がない。
  - 実際に消えていたのは、`src/crawl/normalize-url.ts:161` の1行だった。テンプレートの中の `//` を、行コメントとみなしていた。
  - 不具合そのもの（文字列の中の `/*` や `//` の誤った扱い）は、RED のテストで実際に起きることを確かめた。
- 状態: 修正済み（2026-09-25、T18e）。UI Gate も、`tests/architecture/source-scan.ts` の走査を使う形にした。修正の後、どちらの範囲も検査され、違反はない。

## DEF-012 ページのスクリプトによる外部スキームへの移動を、Guard が検出も記録もしない

- 発見: 2026-09-25。R18 の M3 を受けた、読み取り専用の調査による。調査は headless だけで行った。
- 現象:
  - ページのスクリプトが、外部スキーム（`tel:`、`mailto:`、独自のスキーム）へ移動しようとしても、Guard は止めない。Ledger にも、何も記録しない。
  - 経路は、`location.href`、`location.assign`、meta refresh、iframe の src、スクリプトによる anchor の click、form の action、本物の click による移動である。
  - 外部スキームはネットワークを通らないので、`context.route('**/*')` と CDP の `Fetch` が働かない。
  - `requestfailed` は届くが、分類が BLOCK なので、Guard は何もしない（`passive-request-guard.ts:1242-1300`）。
- 影響:
  - headless: 外部のアプリは起動しない。このバイナリ（`chrome-headless-shell`）には、外部のアプリへ URL を渡す仕組みがない（観測と推定）。ただし、試みが証拠に残らない。
  - headed: 外部のアプリが起動しうる（推定。確度は高い）。
    - `mailto:` は、確認なしに OS の既定のアプリへ渡る。
    - Interaction の click は、ユーザーの操作として扱われる。
  - 安全の不変条件 S03（`mailto:`、`tel:`、外部のアプリを起動しない）を、headed では守れない。
- 修正方針: `doc/design/2026-09-25-beaksight-pre-task-19-cleanup-design.md` の第4章。
  - 検出して、Ledger の新しい事象の一覧 `externalSchemeNavigations` に記録する。
  - headed では、不変条件の違反として、Context を閉じる。
  - headless では、記録だけにする。
  - GATE-S03 を広げる。
  - Guard の独立レビューを行う。
- Task 20 への影響: 実装計画の Task 20 は、headed で実サイトの smoke を行う予定である。headed では起動そのものを防げないので、Task 20 の前にユーザーの判断を求める。
- 実施の時期: Task 19 の前の整理（C18a、C18b）
- 進み具合: C18a で、検出、記録、headed での違反、`BLOCKED_BY_SAFETY` への反映を行った（2026-09-25）。GATE-S03 の拡張は C18b、Guard のレビューは RC18a で行う。
- 進み具合: C18b で、GATE-S03 を、7経路 × 3スキームで、4つの段階（Passive、Interaction、headed の注入、Run）を確かめる形に広げた（2026-09-25）。Guard のレビューは RC18a で行う。
- 追加の事実（2026-09-25、RC18b の N1）:
  - 別のプロセスの iframe（OOPIF）の中の移動によるサーバのリダイレクトは、止めることも記録することもできない。
  - 原因: CDP の横取りを、page の target にだけ付けている。
  - 完全版の Chromium（headed）は、別のサイトの iframe を別のプロセスにする。テストで使う headless の Chromium は、別のプロセスの iframe を作らないので、Gate で検出できなかった。
  - → C18i で直す（設計書 4.2.1 の制約）。
- 進み具合: C18i で、OOPIF にも横取りを付けた（2026-09-25）。Guard の確認のレビューは RC18c で行う。
- 状態: 修正済み（2026-09-25、C18a〜C18i。RC18c で承認）。
  - スクリプトによる移動: 検出して記録する。headed では違反にし、Context を閉じる。違反の後は、監査を続けない（C18f）。
  - サーバのリダイレクト（main、sub、OOPIF、入れ子の OOPIF）: たどる前に止めて、記録する。headed でも違反にしない。
  - 残る制約（設計書 4.2.1）:
    - headed でのスクリプトによる移動は、最初の1回は、外部のアプリの起動を防げない。
    - fenced frame と、先読みの page は、確かめていない。
    - OOPIF の上限など（DEF-014）

## DEF-013 遅いリダイレクトで、`REDIRECT_PREDECESSOR_MISSING` の違反が出るおそれ（推定）

- 発見: 2026-09-25。C18g の報告の発見事項6（コードを読んだうえでの推定。実験はしていない）。
- 現象（推定）:
  - `passive-request-guard.ts` の `RedirectPredecessorRegistry` は、リクエストの段階から 1,000ms で、リダイレクトの対応付けの登録を期限切れにする。
  - サーバが、リクエストを受けてから1秒を超えてリダイレクトを返した場合を考える。このとき、リダイレクトの後のリクエストの対応付けが見つからず、`REDIRECT_PREDECESSOR_MISSING` の違反になる可能性がある。
- 影響（推定）:
  - 応答の遅い実サイトで、普通のリダイレクトが違反になり、Run が `ABORTED_BY_SAFETY` になる。
  - 安全の面では fail-closed の側だが、偽の違反になる。
- 修正方針: まず、fixture で再現を確かめる（C18g の続き）。再現したら、設計者が直し方を決める。
- 実施の時期: Task 19 の前の整理
- 再現した（2026-09-25、C18g）。1.5秒待ってから同じ Origin へ返す普通の 302 で、main frame と iframe の両方に `REDIRECT_PREDECESSOR_MISSING` の違反が出た。C18g の前からある不具合である。設計書 4.6 のとおり、C18h で直す。
- 状態: 修正済み（2026-09-25、C18h）。リダイレクトの応答（3xx）を受けた時点で、対応付けを登録し直し、そこから期限を数える。1.5秒の普通の 302 で、偽の違反が出ないことを、実際の Chromium で確かめた。Guard のレビューは RC18b で行う。

## DEF-014 実サイトで偽の違反になりうる、Guard の上限と競合（監視の項目）

- 発見: 2026-09-25。C18i の報告による。
- 内容: 次の場合に、Guard が fail-closed で違反を記録し、Context を閉じる。安全は保たれるが、Run が不要に `ABORTED_BY_SAFETY` になるおそれがある。
  1. 1つのページで、64件を超える iframe を同時に読み込む場合: `REDIRECT_PREDECESSOR_LIMIT_REACHED`（`MAX_REDIRECT_PREDECESSORS`）。C18i で、実際に65件で確かめた。今回の変更の前からある。
  2. 広告の多いページで、OOPIF の数が `MAX_GUARD_OOPIF_SESSIONS`（64）を超える場合: `OOPIF_GUARD_ATTACH_FAILED`
  3. 横取りの処理中に frame が消える場合（広告の iframe の入れ替えなど）: `CDP_CONTINUE_REQUEST_FAILED` など。同じプロセスの iframe でも、前から同じ扱いである。
- 扱い:
  - 今は直さない。どれも fail-closed の側で、fixture では、通常のページでは起きない。
  - 実サイトの smoke（Task 20）で起きた場合は、その事実をもとに、設計者が直し方を決める。
  - 例: 上限の見直し、消えた frame の失敗を予期した失敗にする。
- 実施の時期: Task 20 の結果を見て決める。
- Task 20 の結果（2026-10-01）: 起きなかった。デモのサイトは1ページで、iframe も OOPIF もなく、違反は 0件だった。材料がないので、監視を続ける。判断の時期を Task 21 の結果の後に移す。
- 手がかり（RC18c の参考）: OOPIF の処理中に frame が消えた場合は、`channel.closed` で、frame が消えたことが明確に分かる。実サイトで起きた場合は、これを手がかりに、予期した失敗として扱えるかもしれない（推測）。

## DEF-015 vitest のワーカーのプロセスが、全テストの途中で1回だけ異常終了した（監視の項目）

- 発見: 2026-09-26。C18p の後の設計者の `npm run verify` で。
- 現象: `Error: [vitest-pool]: Worker forks emitted error.` と `Worker exited unexpectedly` が出て、終了コード 1 になった。100ファイルのうち99ファイル、3,616件が PASS。期待値の不一致で失敗したテストはない。残りの1ファイル（16件）の結果が出なかった。
- 再現: すぐに全テストを実行し直した（`--reporter=json`）。100ファイル、3,632件がすべて PASS。再現しなかった。直前の実装者の verify も PASS している。
- 候補のファイル（16件のもの）: `tests/unit/redact.test.ts` と `tests/integration/auditor-gates.test.ts`。ブラウザと CLI の Run を多く動かす `auditor-gates` の可能性が高い（推測。確かめていない）。
- 原因: 未確認。ワーカーのプロセスの異常終了（メモリの不足、子のプロセスの異常、`process.exit` の呼び出しなど）が考えられる。
- 扱い:
  - 今は直さない。設計者の verify のたびに、起きたかどうかを記録する。verify は `--reporter=json` の結果も残す形で実行し、起きた場合にファイルを特定できるようにする。
  - もう一度起きた場合は、ファイルを特定し、調査のサブタスクを出す。
- 実施の時期: 再び起きたとき。

## DEF-016 HTML でない 404 の応答のページに、文書の構造の Finding が出る（雑音のおそれ。監視の項目）

- 発見: 2026-09-26。T19a の報告による。
- 現象: 本文が text/plain の 404 のページ（fixture のサーバの 404）に、`HTTP_4XX` のほか、`MISSING_TITLE`、`MISSING_HTML_LANG`、`A11Y_DOCUMENT_TITLE`、`A11Y_HTML_HAS_LANG`、`A11Y_LANDMARK_ONE_MAIN`、`A11Y_PAGE_HAS_HEADING_ONE`、`A11Y_REGION` が出る。
- 再現: `tests/integration/fixture-full-crawl.test.ts` の `missing.html`。
- 影響: Rule の判定は事実のとおり（Chromium がテキストを表示する文書には、title も lang もない）。ただし、利用者には雑音になるおそれがある。安全や Run Status への影響はない。
- 扱い: 今は直さない。実サイトの 404 のページは、たいてい HTML である。Task 20 の smoke で実際の出方を見てから、直し方を決める（例: HTML でない応答やエラーの応答では、文書の構造の Rule を評価しない）。
- 実施の時期: Task 20 の結果を見て決める。
- Task 20 の結果（2026-10-01）: 材料はなかった。監査したページ（1件）は HTTP 200 で、4xx のページはなかった。`robots.txt` と `sitemap.xml` の 404 は metadata の Evidence（`NOT_FOUND`）として記録され、ページとしては監査されず、Finding も出なかった。監視を続け、判断の時期を Task 21 の結果の後に移す。

## DEF-017 `--headless` の説明に、設定の `browser.headed` を上書きすることが書かれていない（未着手）

- 発見: 2026-09-26。T19b の実装者の報告（発見事項3）による。設計者がコードで確かめた。
- 現象: `src/presentation/messages.ts:395-398` の `--headless` の説明は「ブラウザの画面を表示せずに実行します。--headed と同時には指定できません。」である。`--headed` の説明（391-394 行）と違い、設定を上書きすることを書いていない。
- コード: `src/cli/arguments.ts:120` は、`--headless` のときに `browser.headed` を `false` で上書きする。
- 影響: `--help` の表示だけの問題。振る舞いと安全への影響はない。README はコードに合わせて書いてある。
- 扱い: 小さな文言の修正のサブタスクとして、次に CLI の表示に触れるときにまとめて行う。UI Gate と CLI のテストで文言を確かめているかを、設計のときに確かめる。
- 実施の時期: 未定（ユーザーと相談）。

## DEF-018 単体テストの置き場所のテストが、Chromium を起動する（未着手。分類の問題）

- 発見: 2026-09-26。T19b の実装者の報告（発見事項1）による。設計者が、クラウドの環境（Chromium がない）の実行で確かめた。
- 現象: `tests/unit/schema-validator.test.ts` の「C8: real collector output from local fixtures」（2105 行付近の `useHeadlessChromium`）は、headless の Chromium を起動する。`tests/unit` は `npm run test:unit` の対象で、ブラウザを使わない単体テストの置き場所と受け取られやすい。
- 影響: Chromium のない環境で `tests/unit` を実行すると、このファイルだけ失敗する。製品の振る舞いへの影響はない。
- 扱い: C8 を `tests/integration/` へ移すかどうかを、設計者が決めてから、サブタスクにする。テストを弱めたり削ったりはしない。
- 実施の時期: 未定（ユーザーと相談）。

## DEF-019 レイアウトの結合テストの1件が、Windows のフォントを前提にしていて、Linux のクラウドの環境で失敗する（監視の項目）

- 発見: 2026-09-26。クラウドの環境（Linux、既定のフォントは DejaVu Sans、日本語のフォントなし）での設計者の verify で。
- 現象: `tests/integration/layout-accessibility.test.ts` の「compares the overshoot above and below a single line separately, and does not report the heading (I1)」が、前提の確かめの assert（648 行付近）で失敗する。`#heading-line-height-10` の上下に出た量の合計が 4 px で、行の高さの4分の1を超えない。
- 再現: Windows の既定のフォントがない環境で、`npx vitest run tests/integration/layout-accessibility.test.ts`。
- 影響: 製品の振る舞いへの影響はない。Windows では PASS する。Windows 以外の環境で全体の verify を行うと、毎回この1件が失敗する。
- 扱い: 今は直さない。テストは、前提が崩れた環境で skip にせず失敗させる設計である（RT12r3 の m2）。クラウドで verify を続けるなら、fixture で使うフォントを固定する（fixture に同梱した字形を使うなど）案を、設計者が検討してからサブタスクにする。テストを弱めたり skip にしたりはしない。
- 実施の時期: 未定（ユーザーと相談）。

### DEF-018 の判断（2026-09-26）: 対応しない

- 設計書 `2026-09-26-beaksight-post-task-19-defects-design.md` の 3.3 のとおり、直さない。
- 理由: `npm run test:unit` の対象の `tests/component` の4ファイルも、もともと Chromium を起動する。`test:unit` は、ブラウザのない環境で動くことを約束していない。対象の describe を移すと、同じファイルの見本のデータ（約 800 行）の複製か、大きな切り出しが要る。Chromium を入れた環境では PASS する（2026-09-26 のクラウドの verify）。
- 状態: 対応しない（理由付きで閉じる）。

### DEF-017・DEF-019 の完了（2026-09-26）

- DEF-017: 完了。`--headless` の説明に、設定の `browser.headed` を上書きすることを加えた。テストを2件加えた。
- DEF-019: 完了。fixture の `@font-face` で行の縦の寸法を固定し、Linux の環境でも前提が成り立つようにした。クラウドの verify で全件 PASS。Windows での確認は未実行。

## DEF-020 実サイトへの負荷を抑える仕組みがない（ページを、キャッシュのない新しい Context で何度も読み込み直す）（未着手。ユーザーの判断が必要）

- 発見: 2026-10-01。Task 21 の full audit の実行中に、設計者が通信量を測って気づいた（ユーザーから「サイトに過負荷を与えていないか注意して」と指示があった）。
- 現象:
  - 本来の監査対象のサイトへの Run（headless、既定の設定）で、PC 全体の受信が、20秒の計測で平均毎秒約14MB、最大で毎秒約56MBだった。Run を止めると、毎秒約5KBに下がった。
  - 1ページの監査に約40秒かかった。この速さでは、`maxRuntimeMs`（1時間）の間に約90ページしか監査できず、既定の `maxPages`（500）には届かない。
- 原因（コードで確かめた）:
  - 1ページにつき、次の回数だけ、ページを読み込み直す。どれも新しい Context なので、ブラウザのキャッシュがなく、画像などをすべて取り直す。
    - Passive の監査: Desktop と Mobile で2回
    - 幅の走査: 幅ごとに1回（既定では 320・768・1024 の3回。`src/evidence/layout-collector.ts:1344-1349`）
    - Interaction: Desktop だけで、候補ごとに1回（候補は最大100件。`src/safety/interaction-policy.ts:22`、`src/interaction/isolated-auditor.ts:1160`）
  - 読み込みと読み込みの間に、待ち時間を置く設定がない。並行の数は1だが、前の読み込みが終わるとすぐ次を始める。
  - 設計書（`2026-08-27-beaksight-web-audit-design.md` 第24章）は並行の数を1とするだけで、サイトへの負荷の上限（間隔、転送量）を決めていない。
- 影響:
  - 監査の対象のサイトに、利用者1人よりずっと大きい負荷をかけるおそれがある。安全の不変条件（GET と HEAD 以外を送らない）には反しない。
  - ページの読み込みのたびに、サイトに埋め込まれた外部のサービス（広告やアクセス解析など）にも要求が送られる。Run の間、Chromium から外部のサービスのアドレスへの接続があった。アクセス解析の数字を水増しするおそれがある（推測。要求の中身は未確認）。
- 扱い: 直し方は、製品の仕様の変更になるので、ユーザーの判断を待つ。候補は、設定で負荷を下げて運用する案と、読み込みの間隔などを守る仕組みを加える案。
- 実施の時期: ユーザーの判断の後。

## DEF-021 PREFLIGHT の結合テストの時間の上限の確かめが、全体のテストの並行の実行で1回だけ失敗した（監視の項目）

- 発見: 2026-10-01。L1 の実装者の報告（発見事項2）による。
- 現象: `tests/integration/preflight.test.ts:427` の、かかった時間の上限（`INJECTED_TIMEOUT_MS + CLOSE_MARGIN_MS` = 5,300 ms）の確かめが、全体の `npx vitest run` の中で 8,754 ms かかって失敗した。そのファイルを単独で実行し直すと PASS した。
- 影響: テストの結果の揺れ。製品の振る舞いへの影響は未確認（負荷の高いときの時間の揺れによると推測）。L1 の変更（設定の値を足すだけ）とは関係がないと見ている（推測）。
- 扱い: 今は直さない。設計者の verify のたびに、起きたかどうかを記録する。もう一度起きた場合は、時間の上限の決め方を調べるサブタスクを出す。
- 実施の時期: 再び起きたとき。

## DEF-022 再開した実行で PREFLIGHT に失敗すると、出力に前の回のページが入らない（2026-10-01 R4a2b・R4b2 の報告で登録）

- 現象: 再開した実行で PREFLIGHT に失敗すると、Run Coordinator は巡回の記録を作り直さない（作り直しは `#crawl` の中で、Browser がないと呼ばれない）。そのため、その実行の `run.json`・`audit.json` には、前の回までに終わったページが入らない。前の回の出力の `pages/<pageId>/` は、ディスクに残る（出力の中で食い違う）。
- 影響:
  - 違反がない場合は、保存の終わり方が `ABANDON` なので、保存の状態は変わらず、次の起動で再開して出力を書き直す（残る影響は、その間の出力が不完全なことだけ）。
  - 再開した実行の PREFLIGHT で違反も記録した場合は、最後の状態が `FINISHED`（巡回の記録が空の中身）になり、不完全な出力が残る。安全の決まり（違反の後に監査を始めない）は守られている。
- 重大度: Minor（まれな場合で、安全には関わらない）。
- 方針: 再開のときは、PREFLIGHT の結果によらず、保存から巡回の記録と終わったページの結果を作り直し、残りの URL を理由 `PREFLIGHT_FAILED` の SKIPPED にする（設計書 4.10）。
- RR の判断（2026-10-02）: 違反がある場合は前の回までのページの結果を取り戻せないので、全体を Important とし、Task 21 の前に直す。
- 状態: 完了（R7b。2026-10-02。設計者が関連の検証で確かめた）。

## DEF-023 ページの先読み（speculation rules）の要求が、Guard・pacer・LoadMeter を通らずにサイトに届く（2026-10-02 RR2 の指摘2で登録）

- 現象: ページに speculation rules（`<script type="speculationrules">` や、`Speculation-Rules` の応答の header）があると、Chromium が、指定のページを先に読み込む（prefetch）か、裏で描画する（prerender）。その要求は、Guard の route も、読み込みの間隔（NavigationPacer）も、負荷の記録（LoadMeter）も通らずに、サイトに届く。
- 再現: RR2 のレビュー担当が、127.0.0.1 の自作のサーバに、prefetch と prerender の先読みの指定（すぐに行う設定）を持つページを置き、ビルド済みの `BrowserContextFactory` と `SafetyLedger` で読み込んだ。headless shell と `channel: 'chromium'` の両方で、サーバに `GET /prefetched.html`（`Sec-Purpose: prefetch`）と `GET /prerendered.html`（`prefetch;prerender`）が届いた。Ledger の記録も route の事象も0件だった。prerender したページからの POST は届かなかった。
- 影響: 先読みを使うサイトでは、BeakSight の読み込みの間隔の外で、ページの読み込みが増える。その分は負荷の記録に出ない。prerender したページのスクリプトは、Guard の外で動く（今回の実験では、POST は届かなかった）。サイトへの負荷の決まり（短い時間に多くの要求を送らない）と、読み取り専用の保証の両方に関わる。
- 発生の時期: 今回の変更（R7a）より前からある（2つの Chromium で違いがない）。負荷の制御の設計書 4.2.1 で「確かめていない」としていたものが、現に起きると分かった（推測ではなく、レビュー担当の実験による）。
- 重大度: Task 21（本来の監査対象のサイト）の前に直す。
- 状態: 設計中。
- 対応（2026-10-02 DEF-023 の実装）: CLI の Chromium の起動の設定を `src/browser/chromium-launch.ts` にまとめ、`--enable-features` に `NoStatePrefetchHoldback` と `PrefetchMultipleActiveSetSizeLimitForBase:...value/0`（Playwright の既定の `CDPScreenshotNewSurface` を引き継ぐ）を渡す。speculation rules の prefetch と prerender、`<link rel="prerender">` の先読みは、サーバに届かなくなった。`<link rel="prefetch">` は止められないが、Guard の route を通る（負荷の記録に数えられるかは R8 で確かめる）。結合テスト `tests/integration/preloading-disabled.test.ts` で見張る。設計者の確認: 7ファイル 142件 PASS、`npm run typecheck` PASS。
- 状態: 完了（R8 で、`<link rel="prefetch">` の要求が負荷の記録に数えられることを確かめた。2026-10-02）。

## DEF-024 通常の Chromium が、ページのアイコン（favicon）を取りに行く（2026-10-02 Task 21 の前の全体の検証で登録）

- 現象: Task 21 の前の `npm run verify` で、`tests/integration/fixture-full-crawl.test.ts` の「fixture のサーバに、GET と HEAD だけを、fixture のサイトの分だけ送る」が失敗した。サーバが、fixture のサイトの外の `/favicon.ico` の GET を受けていた（`expected [ '/favicon.ico' ] to deeply equal []`）。
- 推定の原因: R7a で、CLI の Chromium を `channel: 'chromium'`（通常の Chromium の本体）で起動するようにした。通常の Chromium は、headless でもページのアイコンを取りに行く（以前の `chrome-headless-shell` では起きなかった）。R7a と DEF-023 の実装者の検証、R7 の後の全体の検証では、同じテストが PASS したので、時々起きる（推測）。
- 影響（未確認）: GET だけで、送信の安全には関わらない。ただし、ブラウザ自身が出す要求なので、ページの先読み（DEF-023）と同じく、Guard の route、読み込みの間隔、負荷の記録を通らない可能性がある。ページが許可 Origin の外のアイコンを指していれば、その Origin にも要求が届く可能性がある。
- 同じ検証で、vitest のワーカーの異常終了（DEF-015）も1回起きた。
- 調査の結果（2026-10-03。実装者の報告）: 既定の `/favicon.ico` の要求は、Guard の付いた Context では Playwright 自身が止める（事象も出さない）。全体の検証で届いた1件は再現せず、まれなすり抜けと推測する。ページがアイコンの URL を指定している場合は、Guard を通り、負荷の記録に数えられ、読み込み直しでは許可 Origin の外へ送らない。起動の引数で止める方法は見つからなかった。
- 設計者の判断: 残る制約として受け入れる（許可 Origin への GET の1件だけで、負荷も安全への影響もごく小さい）。README に書き、fixture の全体の監査のテストは、ブラウザ自身の `/favicon.ico` の GET だけを「fixture のサイトの外」の確かめから除く（負荷の制御の設計書 4.9）。
- 状態: 完了（2026-10-03。残る制約として受け入れ、DEF-024-fix でテストと README を直した）。

## DEF-025 Guard の付いた Context では、URL が `/favicon.ico` で終わる要求が、ページの画像なども含めて黙って止められる（2026-10-03 DEF-024 の調査で登録）

- 現象（コードからの事実。実験は `<link rel="icon">` だけ）: Playwright 1.62.1 は、route のある Context で、URL が `/favicon.ico` で終わる要求を、route の手続きを呼ばずに `abort("aborted")` で止め、`request` などの事象も出さない（`node_modules/playwright-core/lib/coreBundle.js` の 13225 行、22762〜22795 行）。そのため、ページの `<img src=".../favicon.ico">` なども、Guard の Context では読み込まれない。
- 影響（推測）: そうした画像を表示するページで、画像が壊れたように見え、監査の結果（スクリーンショット、画像の Finding など）が、利用者の見え方と違うことがある。Task 5 からある振る舞いで、今回の変更とは関係ない。
- 重大度: 低い（Minor）。Task 21 の結果で、実際に起きているかを見る。
- 状態: 記録だけ（Task 21 の後に扱いを決める）。

## DEF-026 実在のサイトの Interaction の Context で、Guard の CDP の層の `Fetch.continueRequest` が「Invalid InterceptionId」で失敗し、違反として Run が止まる（2026-10-05 Task 21 の1回目で登録）

- 現象: 本来の監査対象のサイトの1ページ目の、8番目の Interaction の Context の読み込みの初めで、`CDP_CONTINUE_REQUEST_FAILED`（`cdpSession.send: Protocol error (Fetch.continueRequest): Invalid InterceptionId.`）が2件記録され、Guard が Context を閉じ、`INTERACTION_OWNER_CLOSE_FAILED` も記録された。Run は `ABORTED_BY_SAFETY` で止まった。
- 推定の原因（未確認）: Guard の CDP の層は、文書（Document）の要求を Request と Response の段階で一時停止し、確かめてから `Fetch.continueRequest` で進める。その間に、ブラウザ側で要求が取り消された（iframe が消えた、ページがすぐに別の URL へ移った、ほかの横取りの層が先に決めた、など）と、一時停止の ID が無効になり、進める命令が失敗する。Guard は fail-closed で、この失敗を違反にする。
- 安全への影響（推測）: 取り消された要求は、Guard の命令で送られたものではない。ただし、ほかの横取りの層（Playwright の route）が先に進めた場合は送られうるので、その場合の扱いを確かめる必要がある。
- 影響: 動的な iframe などを使う実在のサイトでは、Run が違反で止まり、監査を続けられない。fixture のテストでは起きていなかった。
- 調査の結果（2026-10-05）: 原因を確定した（ブラウザが取り消した iframe の文書の要求への命令の失敗）。取り消された要求は、サーバに届かなかった（Request の段階）。
- 方針: 取り消しの証拠（`Network.loadingFailed` の canceled）を ID で対応付けたときだけ違反にしない（設計書 `2026-10-05-beaksight-def-026-guard-canceled-document-design.md`）。
- 修正（2026-10-05 DEF-026-fix）: Guard の CDP の session で `Network.enable` を行い、文書の要求の取り消しの証拠を、一時停止の有無によらず上限（256件、5秒）付きで覚える。命令が「一時停止の ID が無効」の文言で失敗し、その要求の証拠があるときだけ、違反にしない（止める命令の失敗は、止めた記録を残す）。証拠がなければ違反のまま。設計者の確認: 関連の 13ファイル 542件 PASS、型チェック PASS。
- 独立レビュー（2026-10-05）: 承認（`DEF-026-review-result.md`）。
- 状態: 完了（Minor のテストの補強などは、Task 21 の後に行う）。

## DEF-027 main frame が `location.replace` を続けて行うページで、`HTTP_MAIN_FRAME_DELIVERY_FAILED` の違反が起きうる（2026-10-05 DEF-026 の調査で登録）

- 現象（調査の実験の記録 `exp1.out` の事実）: main frame が、読み込みの途中で `location.replace` を続けて行うローカルのページで、`HTTP_MAIN_FRAME_DELIVERY_FAILED`（`net::ERR_ABORTED`）が、`PRIMARY` と `REVISIT` の両方で毎回起きた。main frame の移動が、次の移動で取り消されるためと考えられる。DEF-026 とは別の経路である。
- 影響: そうしたページを持つサイトでは、Run が違反で止まる（安全側の停止）。本来の監査対象のサイトで起きるかは、未確認。
- Task 21 の2回目（2026-10-05）で起きた: サイトのメンテナンスで応答が止まった状態で、13ページ目のモバイルの Passive の main frame の要求が、接続も応答もないまま `net::ERR_ABORTED` で失敗し、`HTTP_MAIN_FRAME_DELIVERY_FAILED` の違反で Run が止まった（`location.replace` の連続とは別の起き方の可能性がある）。
- 調査の結果（2026-10-05。`DEF-027-investigation-brief.md`。127.0.0.1 のサーバと `dist/` の Page Auditor と CLI、headless）:
  - 実際と同じ形（理由の並び、Network の Evidence の要求1件・応答0件・時刻がすべて -1、違反）を再現できたのは、読み込み中のタブを BeakSight の外から閉じた場合だけ（`Target.closeTarget`。5/5）。外からの停止・再読み込み・別の URL への移動も、`navigatePage` を直接使うと違反になる。
  - サーバの状態（応答しない、途中で止まる、接続の拒否・切断・RST、503・502、リダイレクト、meta refresh など）、BeakSight 自身の期限と閉じる処理、本物の Ctrl+C では、起きなかった。
  - 時刻の -1 は、応答がない場合の Playwright の初期値で、「接続も始まっていない」根拠にならない（要求はサーバに届いていることがある）。
  - 推測: 実際の件は headed の Run で、利用者がモバイルのウィンドウを閉じた（または停止や再読み込みをした）。利用者に確かめる。
  - 安全への影響: 取り消された要求は、Guard が許可した GET で、応答はページに渡っていない。GET 以外は送られていない。
  - 直し方の案: A（Guard の証拠で、外からの取り消しを違反にしない。Guard の中核の変更）、B（運用で防ぐ。headed では Chromium の画面を操作しないと README と起動時の表示に書く）、C（応答のない ERR_ABORTED を違反にしない。安全を弱めるので採らない）。
- 利用者の回答（2026-10-05）: 止めたときは、Ctrl+C と、ブラウザの画面を閉じる操作の両方をした。調査の推測と合う。
- ユーザーの判断（2026-10-05）: 「Guard も直す」（案 A）。設計書 `doc/design/2026-10-05-beaksight-def-027-external-cancel-design.md`。README の運用の注意（画面を操作しない。止めるときは Ctrl+C）も、サイトの不調の機能の SU4 で書く。
- 状態: 直した（2026-10-05、DEF-027-fix と修正1回目。設計者が確かめた: Guard の 8 ファイル 487 件 PASS）。停止、再読み込み、別の URL への移動、間隔の長い `location.replace` の連続（Guard が要求を進めた後の取り消し）は違反にならない。DEF-027 の元の現象（0〜5ms の間隔の `location.replace` の連続。Guard が進める前に取り消される）は、違反のまま残る（設計書 2.1.1 の限界。独立レビューの指摘1。要求はサーバに届いていない。実在のサイトで起きたら調べる）。外からタブを閉じたときの `CDP_SESSION_DETACHED` は違反のまま（設計書 2.4。DEF-028 と合わせて後で考える）。DEF-029 と合わせて独立レビューを受けている。調査で見つかった別の不具合は DEF-029 に登録した。

## DEF-028 OOPIF の中の文書を一時停止している間に、その OOPIF の iframe が消されると、Guard の命令が「No session with given id」で失敗し、Run が止まる（2026-10-05 DEF-026 の独立レビューの指摘1で登録）

- 現象（レビュー担当の一時ディレクトリでの再現。headless、CLI の起動の設定、`PRIMARY`）: 127.0.0.1 のページが localhost の iframe を20個作り、各 iframe が同じサイトの iframe を8個作る。親が、その iframe を0〜8ms 後に消すと、16回中16回、Context が閉じた（`CDP_CONTINUE_REQUEST_FAILED`: `cdpSession.send: Protocol error (Target.sendMessageToTarget): No session with given id`、52件）。消さない対照では 0/8。
- 扱い: DEF-026 の設計書 3章のとおり、対象の session が閉じた失敗は違反のまま（fail-closed）。DEF-026 の調査で、CDP の session が外れると、一時停止中の要求がそのままサーバに届いた例があるため、この失敗を安全とみなすには、iframe（target）が壊されたことの確かな証拠が要る。
- 影響: そうした iframe を使うサイトでは、Run が違反で止まりうる（安全側の停止）。本来の監査対象のサイトで起きるかは、未確認。
- 状態: 記録だけ。Task 21 で起きたら、実データで調べる。

## DEF-029 main frame の読み込みが、応答を受けた後に Chromium の都合で失敗すると（本文が空の 4xx・5xx、401 Basic、本文の途中の切断）、`HTTP_MAIN_FRAME_DELIVERY_FAILED` の違反で Run が止まる（2026-10-05 DEF-027 の調査で登録）

- 現象（調査の実験の事実）: 本文が空の 4xx・5xx の応答で、main frame の読み込みが `net::ERR_HTTP_RESPONSE_CODE_FAILURE` で失敗し、違反になった。空の 503 で起き、本文が空の 404 の robots.txt では、Run が開始直後に ABORTED_BY_SAFETY になった。本文の途中の切断（`net::ERR_CONTENT_LENGTH_MISMATCH`）、401 Basic（`net::ERR_INVALID_AUTH_CREDENTIALS`）も違反になった。
- 原因（コードの事実）: Guard の `onRequestFailed` は、許可した main frame の読み取りの失敗を、閉じる途中の ERR_ABORTED、ネットワークの層の失敗（DEF-004 の閉じた一覧）、予期した失敗を除いて、違反にする。上の3つは、どれにも当たらない。
- 影響: メンテナンス中のサイトが本文の空の 503 を返すと、サイトの不調で止める機能（SU）の前に、違反で Run が止まり、再開できない。robots.txt が本文の空の 404 のサイトは、Run を始められない。本来の監査対象のサイトで起きるかは、未確認。
- 状態: 直した（2026-10-05、DEF-029-fix。設計者が確かめた: Guard と DEF-029 の 8 ファイル 404 件 PASS）。設計書 `doc/design/2026-10-05-beaksight-def-029-response-received-failures-design.md`。独立レビューは、DEF-027-fix と合わせて行う。

## DEF-030 テストの Chromium（headless-shell）と CLI の Chromium（`chrome.exe` の新しい headless）で、振る舞いが違う（2026-10-05 DEF-029-fix の報告で登録）

- 現象（DEF-029-fix の実装者の事実）: 本文が空の 4xx・5xx と 401 Basic の main frame の読み込みは、CLI と同じ起動の設定（`chromiumLaunchOptions`。R7a で `channel: chromium` にした）では `net::ERR_HTTP_RESPONSE_CODE_FAILURE` などで失敗するが、テストの補助の既定（`useHeadlessChromium`、`createRunLauncher` の `chrome-headless-shell`）では、503・404・401 の応答として成功する。
- 影響: 多くの結合テストと Safety Gate のテストは、headless-shell で動く。CLI の Chromium でだけ起きる振る舞い（DEF-029 のような違反）を、テストで見落とすおそれがある。DEF-029 と DEF-027 の新しいテストは、CLI と同じ起動の設定で動かしている。
- 方針の案: テストの補助の既定を CLI と同じ起動の設定にする、Safety Gate のテストだけ両方で動かす、など。テストの時間と安定への影響を確かめてから決める。
- 状態: 記録だけ（Task 21 の後に、ユーザーに相談して決める）。

## DEF-031 Passive の読み込みは、ページごと・ビューポートごとに、同じ画像・動画・スクリプトを取り直すので、ふつうの利用者より転送量がずっと多い（2026-10-06 Task 21 の3回目の Run で登録）

- 事実（保存の31ページ分の Passive の Network の Evidence）: 許可 Origin と、その外の合計で約 1.5 GB。同じ URL を1回だけ取れば約 264 MB（約1/6）。大半は、サイトの画像と動画を置く外部のストレージ（許可 Origin の外）からの 1,089 MB。3 MB の画像を61回取るなど、同じものを繰り返し取っている。動画（8.4 MB）は、範囲を指定した取り方（206）。
- 原因（設計の決まり）: Passive の2回の読み込みは「初めてページを開いた利用者と同じく、ページ全体をネットワークから取る」（サイトへの負荷の制御の設計書。README の「1つのページの読み込みの回数」）。Run 全体のキャッシュは、読み込み直し（幅の走査、Interaction）だけで使い、Passive では使わない。範囲を指定した要求は、キャッシュの対象外。
- 影響: 対象のサイトの運営者の、外部のストレージの転送量（契約によっては上限や課金）を、ふつうの利用者が同じページを見て回る場合の数倍使う。対象のサイトの本体（Cloudflare の後ろ）への負荷は小さい。
- 状態: Task 21 を止めて、直し方をユーザーと決める。

## DEF-032 広告の計測の通信を、ブラウザが ORB で捨てたものが、画像の読み込みの失敗（`IMAGE_LOAD_FAILED`、ERROR）として全ページに出る（雑音。2026-10-06 Task 21 の途中の結果で登録）

- 事実（Task 21 の3回目の Run の保存の31ページ）: `IMAGE_LOAD_FAILED` が 62件（全31ページ、ビューポートごとに1件）。どれも許可 Origin の外の広告の計測の URL（`/ccm/s/collect`）で、失敗の理由は `net::ERR_BLOCKED_BY_ORB`（Chromium の Opaque Response Blocking。画像でない応答を、画像として読まずに捨てる）。
- 影響: 利用者には見えない計測の通信で、ふつうのブラウザでも同じく捨てられる。サイトの品質の ERROR として数えられ、件数と Run の結果の読み方を誤らせる（雑音）。安全や Run Status には影響しない。
- 方針の案: 画面に出ない（大きさのない、DOM に描かれない）画像の要求や、`ERR_BLOCKED_BY_ORB` の失敗を、`IMAGE_LOAD_FAILED` の対象から外すか、INFO に下げる。DEF-016 と合わせて、Task 21 の結果の後に決める。
- 状態: 記録だけ。

## DEF-033 （調査）サイトが止まった要因が BeakSight にないかの確認（2026-10-06 ユーザーの指示で調査）

- 契機: Task 21 の3回目の Run で、10:25 と 13:50 にサイトの不調で止まった。ユーザーの情報では、サイトは実際に止まっていた（開発者の作業の可能性あり）。
- 調査の結果（`DEF-033-investigation-brief.md`。読み取り専用、127.0.0.1 だけ）:
  - コード: Guard の文書の要求の Request の段階から `Fetch.continueRequest` までに、continue 自身のほかに待つものはない（DEF-026・DEF-027 の待ちは、命令の失敗の後か requestfailed の後だけ）。止まったままになりうる条件（Guard の未完了の作業の上限、page の準備ができていない、Guard の session が外れた）は、違反を記録して Context を閉じる（黙って止まらない）。
  - 実験（`dist/` の CLI、間隔 0、3 Run、計約60分、読み込み 2,433回）: 時間切れ 0、サーバに届かなかった要求 0、開始から受付までの遅れは最大 31ms（p99 16〜19ms）、同時に処理中の文書の要求は常に1。サーバに届いたのは GET だけ。
  - 本番の記録: 13:50 の Interaction の9件目の Context では、部品の要求も始まっていない（HTML が届かなかった）。サイト側（エッジか origin）の停止と合う。対象のサイトへの接続は TCP（QUIC ではない）。
- 結論: BeakSight 側の要因（手元で要求を止める、過負荷）は見つからなかった。不具合ではない。
- 参考（ふつうのブラウザとの違い。どれも重い負荷ではない）: 同じ URL を1ページにつき約11回読み込む（設計どおり。読み込みごとにサイト側でページを組み立てる）、読み込みごとに新しい接続、Playwright が route のある Context で `Network.setCacheDisabled(true)` を送るので要求に `Cache-Control: no-cache` と `Pragma: no-cache` が付く。
- 状態: 調査を終えた（不具合なし）。

## DEF-034 `navigation-pacing.test.ts` のサーバ側の間隔の確かめが、全テストの同時の実行（CPU の混雑）で、まれに失敗する（2026-10-07 D3-fix-round-1 の後の全体の検証で登録）

- 現象: `npm run verify` で 1 回、「server-side interval before navigation 2: expected 900 to be greater than or equal to 950」で失敗（許容は 50 ms）。単独では 3/3 PASS。同日の前の 2 回の全体の検証（D3 の後、D3 の前）では PASS。
- 原因（設計者の推測）: pacer が保証するのは、読み込みの開始（`beforeNavigation` の戻り）の間隔。サーバに届く時刻は、その後の Context の作成（Interaction で中央 113 ms）や、D3 で加わった観察の開始（ふだん 2 ms、混雑時は数十 ms）の分だけずれ、連続する読み込みでずれの差が 50 ms を超えると失敗する。production の間隔の保証は変わらない。
- 方針の案: 観察の開始を pacer の待ちの前に移す（待ちの中に吸収される）、または、許容を Context の作成の揺らぎに合わせて見直す。
- 状態: 記録だけ（全体の検証はやり直して PASS を確かめる）。
