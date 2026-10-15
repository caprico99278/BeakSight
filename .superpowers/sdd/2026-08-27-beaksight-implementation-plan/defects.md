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
- 結果（2026-10-10）: DEF-034-fix で直した。テストの問題（混雑の下で pacer の側の開始の間隔は 207 回すべて設定以上）。pacer の側の間隔を許容なしで主に確かめ、サーバの側は測った遅れの最大（183 ms）に余裕を足した 250 ms の許容にした。最も重い混雑で直す前 3/75 失敗 → 直した後 60/60 PASS。状態: 完了。

## DEF-035 `page-auditor.test.ts` の DEF-008 の場面（Interaction の session を開く期限の後に `ContextConstructionError` が届く）が、全テストの同時の実行で、まれに失敗する（2026-10-08 R9 の後の全体の検証で登録）

- 現象: `npm run verify` の全テストの中で、`closes the Context of a ContextConstructionError that arrives after the Interaction session open deadline` が `expected 0 to be greater than 0`（`sessionCalls` が 0。Interaction の session を開く処理まで進まなかった）で失敗した。5,302 件中この 1 件だけ。
- 再現: 単独で 3 回、ファイル全体（47 件）で 1 回、いずれも PASS。CPU の混雑のとき（全テストの同時の実行）だけ起きる。
- 推測（未確認）: 混雑で Passive か幅の走査がページの期限を使い切り、Interaction の段階が始まらなかった。テストが「Interaction の段階まで進む」ことを前提にしている。DEF-034 と同じく、時間に左右されるテストの揺らぎ。production の不具合を示すものではないと考えるが、未確認。
- 影響: 全体の検証が揺らぎで FAIL し、ビルドが行われないことがある（R9 の後に、ビルドだけ実行し直した）。
- 扱い: 登録だけ（ユーザーの指示まで直さない）。

## DEF-036 Interaction でポップアップを遮断する場面で、負荷が高いときに、ポップアップの先への GET がサーバに届く（2026-10-08 Task 21 の Step 5 の全体の検証で登録。安全の Gate S04 に関わる）

- 現象: `npm run verify` の全テストの中で、`tests/integration/isolated-interaction.test.ts` の `blocks an admitted /popup-button.html action before its target reaches the server` が失敗した。結果は `BLOCKED_BY_SAFETY`、`blockedPopups` の記録もあったが、サーバの記録に `GET /popup-target.html` があった（1943 行の確かめ）。違反の記録は、このテストでは確かめる前に失敗したので未確認。
- 再現: 単独で 8 回とも PASS。全テストの同時の実行（CPU の混雑）で 1 回だけ起きた（R9 の後の 1 回目の全体の検証では起きていない）。同じ場面の Gate のテスト（`safety-gates.test.ts` の GATE-S04 Interaction）は、同じ全体の検証で PASS した。
- 仕組み（読んだ範囲）: Guard は、凍結の段階（`isFrozenPhase`）では、Context の `route('**/*')` で、すべての HTTP の要求を止めて記録する。ポップアップは `page`/`popup` の事象で記録して閉じる。
- 推測（未確認）: 混雑で、ポップアップの移動の要求が、凍結の段階の外（凍結が解けた後か、段階が変わる間）に出て、Passive の分類で許可された。あるいは、閉じる処理との競合。
- 影響: 本来の監査対象のサイトの Run（起動 1〜9）では、ポップアップの遮断の記録は 0 件、違反も 0 件で、この場面は起きていない。届いたのは GET（読み取り）で、送信（POST など）ではない。ただし、Interaction の安全の不変条件（ポップアップの先へ要求を届けない）が、混雑のときに破れる可能性がある。
- 扱い: 調査を実装者に依頼した（DEF-036-investigation）。
- 調査の結果（2026-10-08。設計者が Playwright の該当箇所と記録を確かめた）: **Guard の振る舞いの不具合。重大度 Critical。** 凍結中のポップアップを Guard がすぐ `page.close()` すると、Playwright はそのページの要求で Context の route の処理を呼ばなくなり（`_onRoute` の `_closeWasCalled` の確かめ）、Chromium は target を閉じる途中で、止める前の要求をネットワークへ出すことがある。ポップアップの中のフォームの POST が 40 回中 37 回届いた（違反の記録 0）。ポップアップを閉じない対照では、GET 0/150、POST 0/100。ほかの場面（移動、WebSocket、ページの中の POST、`form target=_blank`、Passive の段階）は 0 件。実サイトの Run ではポップアップの遮断 0 件で、起きていない。
- 修正: 設計書 `doc/design/2026-10-08-beaksight-def-036-frozen-popup-design.md`（凍結中のポップアップは記録だけで、閉じない。要求は Context の route で止める。Context と一緒に閉じる）。DEF-036-fix → DEF-036-gate → DEF-036R。Task 21 のチェックポイントと、実サイトの再開は、この修正とレビューの後。

## DEF-037 Interaction の候補の読み込みの観察のテストが、ブラウザの時計と Node の時計の 1 ms のずれで、まれに失敗する（2026-10-08 DEF-036 の後の全体の検証で登録）

- 現象: `tests/integration/isolated-interaction.test.ts` の `the observation of the target load of an interaction candidate` の 2 件（200 と 503）が、8590 行の `observationStartedAtMs <= hops[0].issuedAtMs` で、1 ms の差で失敗した（例: 1791439672627 と 1791439672626）。
- 原因: `issuedAtMs` は CDP の `wallTime`（Chromium の壁時計の秒）を ms に丸めた値、`observationStartedAtMs` は Node の `Date.now()`（`src/browser/navigation-diagnostics.ts` の 95 行、411〜424 行）。2 つの時計と丸めの差で、前後が 1 ms 入れ替わることがある。記録の値そのものは設計どおり（診断の記録で、判定には使わない）。
- 再現: 単独では PASS（5 件）。全体の検証の中で 1 回だけ起きた。
- 扱い: テストの確かめ方の不具合（許容の幅のない、別の時計の比べ）。直し方の案: 丸めの幅（1 ms）を許容する、または開始の時刻と発行の時刻の比べを外して、発行の時刻が数であることだけを確かめる。登録だけ（ユーザーの指示まで直さない。DEF-034、DEF-035 と同じく、時間に左右されるテストの揺らぎ）。

## DEF-038 Passive のページを閉じるときに、ページを離れるときの送信（`sendBeacon`、keepalive の `fetch` の POST）が Guard を通らずに届く（2026-10-08 独立レビュー DEF-036R の C1。Critical。修正の前からある）

- 現象: `closePassivePageAndContext`（`src/orchestration/passive-session-close.ts`）は、Guard の付いたページを `page.close()`（`closePassiveGuardedPage`）で閉じてから Context を閉じる。ページの `pagehide` と `visibilitychange` の処理から送る beacon と keepalive の POST が、サーバに届く（レビュー担当 5/5、3/3、5/5。設計者も 3/3 と 3/3 を再現。`blockedRequests` の記録なし、違反 0）。Context だけを閉じた対照では 0（レビュー担当 5/5、設計者 3/3）。DEF-036 と同じ仕組み（`page.close()` の後は Playwright が route の処理を呼ばない）と推測。
- 使う箇所: Passive のすべての読み込み（Page Auditor の Passive、幅の走査、PREFLIGHT、環境の確認、robots.txt と sitemap.xml）。Interaction の Context は、Context だけを閉じるので当たらない。
- **本来の監査対象のサイトへの影響（推測。サイトの側では確かめられない）**: 実サイトのトップページでは、読み込みの間に Guard が、Google Analytics（`g/collect`）、Microsoft Clarity、Cloudflare の計測（対象のサイトの Origin の `/cdn-cgi/rum`）、プラットフォームの閲覧の記録（`page_views`）、Google 広告の計測への POST を止めていた（PAGE-000001 の Safety の Evidence）。これらの多くはページを離れるときにも送信する。Task 21 の Run（9 回の起動、Passive の読み込み 1,929 回）で、ページを閉じるたびに、これらの送信が出た可能性が高い。業務のデータ（予約など）を変える送信ではないが、計測のデータに監査の閲覧が加わった可能性がある。
- 扱い: 修正の設計書 `doc/design/2026-10-08-beaksight-def-038-passive-page-close-design.md`。実サイトの再開は、DEF-038〜DEF-040 の修正と独立レビューの後。

## DEF-039 凍結中に、ページ自身がポップアップを閉じると、ポップアップの中の送信が Guard を通らずに届く（2026-10-08 DEF-036R の C2。Critical。修正の前からある）

- 現象: ページが `const p = open('about:blank')` の後、`p` に `pagehide` か `unload` の beacon と keepalive の POST を付け、`p.close()` で閉じる。同じ処理の中で閉じても（5/5）、300 ms 後に閉じても（8/8）、サーバに届く。結果は `blockedPopups` で BLOCKED、要求の記録なし、違反 0。DEF-036 の修正（Guard が閉じない）では防げない（ページの側から target を閉じるため）。
- 扱い: 直し方の選択肢を調査する（DEF-039-040-research）。

## DEF-040 Worker（Dedicated、Shared）の中の WebSocket の接続が、Passive でも Interaction でも止まらない（2026-10-08 DEF-036R の C3。Critical。修正の前からある）

- 現象: Worker の中で開いた `new WebSocket(...)` の接続の要求（HTTP の Upgrade）が、毎回サーバに届く。`blocked*WebSockets` の記録なし、違反 0。Playwright の `routeWebSocket` はページに差し込むスクリプトで差し替える方式なので、Worker の中に効かないと推測。
- 扱い: 直し方の選択肢を調査する（DEF-039-040-research）。

## DEF-036R の Minor（記録）

- M1: 凍結中のポップアップの about:blank の文書から出した `fetch`、beacon、keepalive、ping、Worker の `fetch` の POST は届かないが、`blockedInteractionRequests` に記録されない（止めたまま Context と破棄されると推測）。
- M2: GATE-S04 の POST の場面が route の記録を求めない分担を、コメントに書く。
- M3: `src/report/chatgpt-bundle.ts` の 2 行目のコメントの古いバンドルの名前。
- M4: CC-048（最後の実行を選ぶ処理が 2 か所）。
- M5: `bundleFileName` は `Date` で読める文字列なら ISO 8601 でなくても受ける（入力はスキーマで確かめた値）。

## DEF-041 Context を閉じる処理と、Run 全体のキャッシュへの書き込みの競争（2026-10-08 DEF-038-fix の報告の発見事項 1。負荷に関わる。監視の項目）

- 内容: factory は、`requestfinished` の後に `response.body()` を非同期に読んでからキャッシュに入れる（PC1）。DEF-038 で、Guard の付いた Passive のページを個別に閉じずに、すぐ Context を閉じるようになったので、本文を読み終える前に Context を閉じることがある。前は、ページを閉じる間に読み終わっていたと推測。
- 現れ方: `tests/component/context-factory.test.ts` の L5b（読み込みの直後に閉じる）が 3 回中 1 回失敗した。テストの側で、キャッシュに入ったことを待ってから閉じる形に直した。
- 影響（推測）: Page Auditor は、読み込みの後に Evidence を集めてから閉じるので、影響は小さいと推測。キャッシュに入らなかった分は、次のページで取り直すので、サイトへの転送量が増える方向。未確認。
- 扱い: 次の実サイトの起動の前に、fixture の Run でキャッシュから返した件数を、DEF-038 の前の記録と比べて確かめる。差があれば、factory が Context を閉じる前に、読みかけの本文を短い期限で待つ設計を書く。

## DEF-042 Passive で、ページ自身が別の文書へ移動するとき、ページを離れるときの送信（beacon、keepalive の POST）が Guard を通らずに届く（2026-10-08 独立レビュー T21R の C1。Critical。修正の前からある）

- 現象: Guard の付いた Passive のページで、ページ自身の `location.href` による移動でも、`goto` による 2 回目の移動でも、`pagehide` の `sendBeacon` と keepalive の `fetch` の POST がサーバに届く（headless shell と CLI の Chromium の両方。15 回で 60 件と 45 件）。`blockedRequests` 0、違反 0。読み込みの途中の POST は遮断・記録される（対照）。
- 条件: BeakSight 自身の移動は about:blank から 1 回だけなので起きない。サイト自身のクライアント側の移動（JS のリダイレクト、meta refresh など）で起きる。Interaction の凍結の前にも起きうる（推測）。
- **実サイトの記録（設計者の確認）**: 237 ビューポート（119 ページ）のうち、main frame の文書の要求が 1 つだけのものが 223、サーバのリダイレクトの連鎖（3xx の後に 1 つ）が 14、**文書が確定した後にページの中から別の文書へ移動したものは 0**。この経路は、実サイトの Run では起きていない。
- 原因（推測）: 離れる文書の要求で Playwright が route の処理を呼ばない（DEF-036、DEF-038 と同じ仕組み）。Guard の CDP の Fetch は Document だけを横取りするので、keepalive の POST を見ていない。
- 扱い: 直し方を調査する（DEF-042-research）。候補: Guard の CDP の Fetch をすべての要求に広げる（離れる文書の keepalive が `Fetch.requestPaused` に来るか）、Passive での 2 回目の main frame の移動を要求の段階で止める（文書が確定しないので `pagehide` が起きない。監査の結果への影響あり）、Chromium の設定。

## DEF-038 の追記（2026-10-08 T21R の I1）

- レビュー担当の実験: 旧経路（ページを閉じてから Context を閉じる）で、headless shell では 15 回中 12 件届いたが、**CLI の Chromium（`channel: 'chromium'` の `chrome.exe` の新しい headless）では 0 件**。新経路（Context だけ）はどちらも 0。Task 21 は headed で実行したので、headed で Context を破棄したときに `pagehide` が出るかは未確認。
- 訂正: 台帳と `progress.md` の「実サイトで計測の送信が出た可能性が高い」は強すぎる。正しくは「可能性がある（CLI の Chromium の headless では 0/15。headed は未確認）」。
- DEF-038 の Gate は headless shell で RED を検出した。CLI の起動の設定（`chromiumLaunchOptions`）でも Gate を動かすことは、DEF-030 の扱いとあわせて検討（監視の項目）。
- 修正の状態: 修正済み（2026-10-08 DEF-038-fix。RED: 3 場面とも 5/5 届いた（headless shell）。GREEN: 3 回のくり返り PASS。全体の検証 126 ファイル 5,342 件 PASS、ビルド PASS。`verify-20261008-def038.log`）。

## DEF-043 Guard が main frame の移動を `BlockedByClient` で止めると、エラーページが確定して DOM が消える（2026-10-08 DEF-042 の調査の実験 7 で登録。監査の証拠の質の問題。監視の項目）

- 現象: Guard が許可 Origin の外への main frame の移動（`EXTERNAL_MAIN_FRAME_NAVIGATION`）を `Fetch.failRequest`（`BlockedByClient`）で止めると、`chrome-error://chromewebdata/` のエラーページが確定し、元の文書の DOM が消え、`pagehide` が起きる。`Aborted` なら、移動は静かに失敗して DOM が残る。
- 影響: 送信の漏れは DEF-042 の修正で止まる。残るのは、止めた後の監査の証拠（DOM、スクリーンショット）が壊れる点。
- 扱い: 今は直さない。`Aborted` への変更は、DEF-027 の外部からの取り消し（`ERR_ABORTED`）の判定と `expectedCdpFailures` の `errorText` の対応に関わるので、設計を書いてから。

## DEF-044 Shared Worker の中の fetch / XHR の POST が、Passive と凍結の前の Interaction で Guard を通らずに届く（2026-10-08 独立レビュー NPR-T21R2 の C1。Critical。修正の前からある）

- 現象: blob の SharedWorker からの `fetch` POST、XHR POST、keepalive POST が、Passive で両方の Chromium とも 6/6 届く。`blockedRequests` 0、違反 0。凍結の前の Interaction（中継 `OPEN`）でも届く。凍結の後だけ中継が止める。対照の Dedicated Worker は route で止まり記録される。
- 原因（推測）: Playwright 1.62.1 は `shared_worker` の target に session を付けないので、`context.route` が効かない。Guard の CDP の横取りは page と OOPIF の session だけ。
- 実サイト: Shared Worker を使っているかは未確認。Playwright が target を付けないので、network の Evidence にも載らず、記録からは判別できない（推測）。
- 扱い: 修正の設計書 `doc/design/2026-10-08-beaksight-def-044-046-review-fixes-design.md`。Task 21 を閉じる前に直す。

## DEF-045 Interaction の凍結の段階で、owner の close を始めた後の「閉じた target」による `Fetch.failRequest` の失敗が違反になる（2026-10-08 NPR-T21R2 の I1。Important）

- 現象: 1 ms ごとに beacon と keepalive の POST を出すページで、凍結 → `session.close()` を 10 回行うと、両方の Chromium で 3/10 に `INTERACTION_CDP_FAIL_REQUEST_FAILED: cdpSession.send: Target page, context or browser has been closed` が記録され、`close()` が「invalidated」で reject。届いた要求は 0（安全の弱まりではない）。
- 原因: `handlePausedRequest` は `isFrozenPhase` の分岐を `isClosingOrInvalidatingPhase` より先に通し、凍結の分岐の失敗は `isClosedTargetFailure` を見ない（DEF-042 の設計書 2.4 の「閉じる途中の閉じた失敗は違反にしない」からの逸脱）。Document の凍結の分岐も同じ形（既存）。
- 影響: ポーリングのあるページの Interaction で、閉じる瞬間の要求により Run が `ABORTED_BY_SAFETY` になりうる（誤検出）。
- 扱い: 同上の設計書。

## DEF-046 Chromium 自身の通信（`CONNECT www.google.com:443`）が中継の記録に載り、Interaction の結果を `BLOCKED_BY_SAFETY` にしうる（2026-10-08 NPR-T21R2 の I2。Important）

- 現象: CLI の Chromium（`chrome.exe`）は、Interaction の Context の中継へ `CONNECT www.google.com:443` を毎回 2〜4 回出し、凍結の後にも 1 回出て `INTERACTION_FROZEN_EGRESS` になる。`isolated-auditor.ts` の `hasFreezeEvent` は `blockedInteractionRequests` が 1 件以上なら `BLOCKED_BY_SAFETY` にするので、ページの操作と関係なく結果が BLOCKED になりうる（headless shell では出ない。production の方針では凍結の前の CONNECT は転送され、`freeze()` でトンネルが切れた後に再接続すれば同じ記録になる。推測）。
- 影響: Interaction の結果の区分の誤り（安全の弱まりではない）。production では、BeakSight の Node の process が Chromium の代わりに外部へ TCP 接続を開く（露出は増えないが新しい振る舞い）。
- Chromium 自身が www.google.com へ接続する理由は未調査（Playwright の既定の引数で止まっていない何か。推測）。これは中継の前からある振る舞い。
- 扱い: 同上の設計書（結果の区分から中継の記録を外す）。Chromium 自身の通信を止める引数の調査は、別の監視の項目（DEF-047）。

## DEF-047 CLI の Chromium（`chrome.exe`）が、監査と関係なく www.google.com へ接続する（2026-10-08 登録。監視の項目）

- 現象: Interaction の Context ごとに `CONNECT www.google.com:443` が 2〜4 回（中継の記録で観測。DEF-039-040 の調査、NPR-T21R2）。headless shell では出ない。
- 扱い: 止める起動の引数を調べる（Playwright の既定の `--disable-background-networking` などで止まっていない通信の正体）。Task 21 の後。

## NPR-T21R2 の Minor（記録）

- M1: テストの既定の headless shell では speculation rules の prefetch/prerender が動き、Passive で GET が記録なしに届く（CLI の Chromium は DEF-023 の引数で止まる）。テストの起動の補助に、先読みを止める引数を含めるかは別途（監視）。
- M2: DEF-036・038・039 の Gate は headless shell だけ（DEF-040・042 は両方）。
- M3: T21R の M1（Architecture の検査の抜け道。grep で該当 0 件）、M4（`site-metadata.ts` の変更に問題なし）、M5（DEF-041 は安全に影響なし）は、設計者が受け取ったまま記録していなかった → ここに記録。
- M4: `WORKER_CONNECT_POLICY_INIT_SCRIPT` の MutationObserver は head のない文書（SVG/XML）で解除されない（軽微）。

## DEF-048 `cli-interrupt-windows.test.ts` の再開の場面が、全テストの同時の実行（CPU の混雑）で、まれに終了コード 2 になる（2026-10-08 NP5 の後の全体の検証で登録。揺らぎ）

- 現象: 1 回目の Ctrl+C の後の再開で、「中断しなかった Run と同じ終了コード（0）」の期待に対し 2（`PARTIAL`）。同じ describe の「同じページと状態」も失敗。単独では 16 件 PASS。
- 推測: 混雑で、再開した Run のページの監査が期限を過ぎ、一部未完了になった（DEF-034・035・037 と同じ、時間に左右されるテストの揺らぎ）。安全の Gate ではない。
- 扱い: 登録だけ。

## DEF-049 Service Worker の遮断（`serviceWorkers: 'block'`）をページが回避すると、Service Worker の中の POST が Passive でも凍結の前でも届く（2026-10-08 独立レビュー NPR2 の C1。Critical。修正の前からある）

- 現象: Playwright の `serviceWorkers: 'block'` は、init script で `navigator.serviceWorker.register` をインスタンスのプロパティとして上書きするだけ。ページが `ServiceWorkerContainer.prototype.register.call(navigator.serviceWorker, '/sw.js')` を呼ぶ（または `delete navigator.serviceWorker.register` の後に呼ぶ）と登録が成功し、install と activate の中の `fetch` POST がサーバに届く（両 Chromium、Passive と凍結の前で 12/12、4/4）。`blockedRequests` 0、違反 0。凍結の後は中継が Service Worker の script の GET を拒む（Guard の CDP と route は見ない）。GATE-S08 は通常の呼び出しだけを確かめている。
- 引き金: ページが Playwright の上書きを迂回する書き方をしたときだけ。普通のサイトの書き方では起きない（推測）。実サイトで起きたかは不明。
- 扱い: 設計書 `2026-10-08-beaksight-def-044-046-review-fixes-design.md` の 5 に追補。Task 21 を閉じる前に直す。

## DEF-050 Document の閉じる途中の分岐（`failPausedDocumentForLifecycle`）が、閉じた target による失敗を違反にする（2026-10-08 NPR2 の I1。Important。DEF-045 と同種）

- 現象: iframe の `src` を 1 ms ごとに変えるページで Context を閉じると、`CDP_LIFECYCLE_FAIL_REQUEST_FAILED: ... has been closed` が記録される（headless shell 3/20、CLI の Chromium 4/20。凍結の直後に閉じた場面でも 1/20）。届いた POST は 0。
- 原因: DEF-042 の設計書 2.4 の「閉じる途中の閉じた失敗は違反にしない」が Document の分岐に及んでいない（DEF-042-fix で「Document の横取りは変えない」としたため）。
- 扱い: 同上の設計書の 6。

## NPR2 の Minor（記録）

- M1: 自己検査は、所有する Context がない時点の通知を捨てる（印を残さない）。実験では起きていない（閉じる直前に Shared Worker を作る 50 回すべて違反）。理論上の抜け道。
- M2: 中継の記録だけになる場面（SVG 文書の Worker の WebSocket、Service Worker の script の GET）では、結果が BLOCKED にならない（安全には影響なし。区分が甘い）。
- M3: Chromium 自身の `GET /favicon.ico` が凍結の後に `INTERACTION_FROZEN` で記録される（凍結が読み込みの直後のとき）。中継の `CONNECT www.google.com:443` の記録は `SAFETY_NON_READ_REQUEST_BLOCKED` の Finding になる（推測）。`catalog.ts` の説明に Chromium 自身の通信を含むことを書く（NP6 で）。
- M4: headed での `--disable-shared-workers` は未確認。

## DEF-051 iframe の `src` を 1 ms ごとに変えるページで、Guard がリダイレクトの対応付けの上限（`REDIRECT_PREDECESSOR_LIMIT_REACHED`）で Context を無効にすることがある（2026-10-08 NP6 の発見事項。監視の項目。DEF-014 の 1 と同じ種類）

- 現象: DEF-050 の実機のテスト（iframe の移動を高頻度でくり返すページ）で、閉じる前の Passive の段階に違反 `REDIRECT_PREDECESSOR_LIMIT_REACHED` が記録され Context が無効になった（Interaction 120 回中 1 回、Passive 1 回）。
- 推測: 取り消された iframe の移動は応答を受けないので、対応付けの記録（上限 64、保持 1 秒）が埋まる。
- 影響: iframe の移動を高頻度でくり返すページで、安全側に倒れて Run が止まりうる（偽の違反。DEF-014 の監視の項目と同じ）。実サイトでは起きていない（違反 0）。
- テストでの扱い: DEF-050 の実機のテストは、違反がこの 1 件だけの回を「除いた回」として出力に残し、回数の半分未満であることを確かめる（NPR3 で弱体化ではないと判断）。除いた回の数は `--reporter=verbose` でだけ見える（NPR3 の Minor-2）。
- 扱い: 登録だけ。

## NPR3 の Minor（記録。2026-10-08）

- Minor-1: `catalog.ts` の `blockedInteractionRequests` の説明は、中継の記録に Chromium 自身の通信が含まれることは書いたが、`INTERACTION_FROZEN`（Guard の記録）にも Chromium 自身の `GET /favicon.ico` が含まれうることと、「Guard を通らずに出た要求の証拠」の書き方の整合は、設計書 7 に「書かない」と記録（Chromium 自身の通信の正体は DEF-047 で調べてから直す）。
- Minor-2: DEF-050 の「除いた回」と DEF-049 の自己検査の届いた要求の数は `console.info` で、`--reporter=verbose` のときだけ出る。DEF-051 の監視は verbose で実行する（台帳の DEF-051 に追記）。
- Minor-3: GATE-S08 の回帰は top・同じ Origin の iframe・about:blank × 2 経路。ポップアップと OOPIF の経路は実験のみ（将来の候補）。

## DEF-052 iframe の移動を繰り返すページで、Interaction の凍結の直後に閉じると、`CDP_CONTINUE_REQUEST_FAILED`（`Fetch.continueRequest` の `Invalid InterceptionId`）が違反になることがある（2026-10-09 DEF-035-fix の調査の途中で発見。誤検出。Guard）

- 現象: `tests/integration/passive-request-guard.test.ts` の DEF-050 の「Interaction（the owner close right after the freeze）」の場面（headless shell）で、混雑の下（unit と integration の全体を並行で流した状態）、20 回中 1 回（19 回目）に、違反 `CDP_CONTINUE_REQUEST_FAILED: cdpSession.send: Protocol error (Fetch.continueRequest): Invalid InterceptionId.` が 3 件記録され、閉じる処理が「invalidated」で失敗した。サーバに届いた POST は 0（安全の弱まりではない）。ログ: scratchpad の `def035/load2.log`。
- 文言は `INVALID_INTERCEPTION_ID_FAILURE_TEXTS` の一覧と完全に一致する。推測: 文書（iframe）の要求の `continueRequest` の失敗は、DEF-026 の取り消しの証拠（`Network.loadingFailed` の canceled など）がそろったときだけ違反にしない決まりで、混雑で証拠が遅れると違反になる。または、凍結の直後の段階の判定の経路が `isInvalidInterceptionIdFailure` を見ていない。未調査。
- 影響: iframe の移動を高頻度で繰り返すページで、Run が誤って `ABORTED_BY_SAFETY` になりうる（DEF-051 と同じ種類の偽の違反）。
- 扱い: 調査と直しを依頼する（DEF-052-fix）。G22 の全体の検証の前に。
- 結果（2026-10-09）: 約 6,000 ラウンドで再現せず、原因は未確定。元のログから、1 件目は閉じる処理の前に記録されたと分かった。対策と診断を入れた（設計書 `2026-10-09-beaksight-def-052-guard-evidence-wait-design.md`）: 待ちの終わりに Node が受信済みの事象を読んでから決める。違反の文に、証拠がなかった理由を付ける。決まり（500 ms、256 件と 5 秒、証拠を要する）は変えない。状態: 対策済み・監視（次に出たら、診断で原因を切り分けて改めて設計する）。

## DEF-053 `navigation-diagnostics.test.ts` の「records a 302 redirect and its 200 target as two hops」が、混雑の下で時刻が `null` になって失敗することがある（2026-10-09 DEF-035-fix の調査の途中で発見。揺らぎ）

- 現象: 205 行で時刻が `null`。混雑の下の全体の並行の実行で 1 回。単独では未確認。推測: 診断の観察（`Network.*ExtraInfo` の事象）の到着が混雑で遅れる。診断の記録の取りこぼしで、安全とは関係しない。
- 扱い: 登録だけ。

## DEF-054 既存の依存に、既知の脆弱性が 4 件ある（2026-10-09 T23b の install の出力で発見。依存の追加の前からあった）

- `npm audit` の結果（設計者が実行。変更なし）: high 2 件、moderate 2 件。どれも T23 の依存の追加の前の lockfile にあった版（scratchpad の `t23b/package-lock.before.json` で確かめた）。
  - `fast-uri` 3.1.6（`ajv` 8.20.0 の依存）: GHSA-qw65-cvwx-89v3、GHSA-58mr-gqgx-xq4g、GHSA-hrr3-gc8f-f4qj（URI の authority と host の解釈）。直った版 3.1.8。lockfile の更新だけで直る（ajv の範囲の中）。
  - `source-map-js` 1.2.1（`vite` → `postcss` の依存）: GHSA-68fv-2mgg-jv7q（細工した source map で処理が止まる）。直った版 1.2.2。lockfile の更新だけで直る。
  - `vitest` 4.1.10 と `@vitest/mocker` 4.1.10: GHSA-82fw-gwwq-j7x9（mock の転送でのパスの外への読み出し）。直った版 4.1.11（直接の依存の更新）。
- 影響（推測）: BeakSight の監査の入力（ページの URL）を `fast-uri` で解釈しているかは未確認（URL の正規化の owner は WHATWG の `URL`）。`source-map-js` と `vitest` は開発の道具。
- 扱い: 依存の更新なので、ユーザーの承認を求める。
- 結果（2026-10-09）: ユーザーの承認（「3つとも上げてよい」）で、vitest 4.1.11、fast-uri 3.1.8、source-map-js 1.2.2 に更新。`npm audit` 0 件。vitest の更新で承認の外の chai 6.3.0、tinyrainbow 3.2.0 も上がり、ユーザーの判断で残した。状態: 完了。

## DEF-055 全体の検証の途中で、Vitest の子のプロセス（forks の worker）が予期せず終わり、1 ファイルが走りきらない（2026-10-09 T23 の `npm run verify:all` で発見。揺らぎか未確定）

- 現象: `npm run verify:all` の `vitest run` で、`Error: [vitest-pool]: Worker forks emitted error. Caused by: Error: Worker exited unexpectedly`。148 ファイル中 147 ファイル PASS、6,170 件中 6,112 件 PASS（58 件が走らず）、終了コード 1。失敗したテスト（assertion）はない。ログ: scratchpad の `verify-all-20261009-t23.log`。
- 走りきらなかったファイル（推測。件数から）: 58 件のテストを持つファイルは `tests/component/context-factory.test.ts` だけ（流し直しの JSON で確かめた。Task 23 で変えていない既存のファイル。Guard の付いた Context を作る部分）。
- 流し直し（同じ作業ツリー、ほかに何も動いていない）: 148 ファイル・6,170 件すべて PASS（428 秒）。
- 過去の観測: DEF-052 の調査（強い混雑の下）でも `Worker exited unexpectedly` を 3 回観測している（progress.md の DEF-052-fix の行）。
- 影響: 検証の結果が揺れる。worker が落ちた原因（Node の異常終了、メモリ、Chromium の子の扱い）は未確認。安全の部品のテストのファイルなので、原因を調べる。
- 扱い: 調査を依頼する（DEF-055-investigation）。
- 調査の結果（2026-10-09）: 原因は、Vitest の worker（node.exe）のネイティブの異常終了（Node 24.15.0、V8 13.6）。混雑の下で `context-factory.test.ts` を繰り返して 460 回中 4 回（`--single-threaded-gc` を含めると 5 回）、混雑なしで 0/30。終了コードは 0xC0000409（fast fail）3 回、0xC0000005（アクセス違反）1 回、0x80000003 と V8 の致命的エラー（`Check failed: !IsFreeSpaceOrFillerMap(map)`。GC の背景のスレッド）1 回。exit・kill・未処理の例外・IPC の誤り・メモリの不足はなし。worker はネイティブのアドオンを読み込まない。Vitest 4.1.10 のときにも 9 回起きていた（過去のログ）。落ちる場所は毎回違い、`isolated-interaction`、`passive-request-guard` でも起きている。T23 の 1 回の落ちたファイルは確定できない（Vitest は結果を約 100 ms ごとに送るので、58 件の欠けからは絞れない）。テストと製品のコードが原因の事実はない。
- 状態: 道具（Node/V8）の側の問題として監視。直し方の候補: (1) Node 24 の新しい patch の版で同じ再現を比べる（開発環境の変更なのでユーザーの承認を待つ。後回しの項目）、(2) 全体の検証で走りきらなかったファイルを表示する reporter（開発の道具の改善。後で検討）。全体の検証で worker の異常終了が起きたら、毎回この番号で記録し、流し直しの結果と合わせて扱う。

## DEF-056 `isPortableRelativeArtifactPath` が、Windows で別の意味になる名前を通す（2026-10-09 T24 調査で発見。既存）

- 現象（調査担当の実験）: `pages/p/x:stream`（NTFS の代替データストリーム）、`run.json.`、`run.json `（末尾の点と空白）、`CON`、`pages/NUL`（デバイス名）が真になる。`..`、絶対パス、`\` は偽（外へは出ない）。
- 影響: 今は BeakSight が書く名前の確かめに使われ、BeakSight が書く名前はこれらに当たらない（推測。T24b で確かめる）。Task 24 で、画面から成果物を取り出すときのパスの確かめに使うと、別名やデバイスを開く恐れがある。
- 扱い: Task 24 の T24b で直す（設計書 `2026-10-09-beaksight-task-24-ui-public-audit-design.md` 4.7）。
- 結果（2026-10-09）: T24b で直した（`:`、末尾の点と空白、デバイス名（`CONIN$`・`CONOUT$`・上付きの数字を含む）、制御文字を拒む）。BeakSight が書く名前はすべて通る。レポートで `:` を含むパスはリンクにせず文字で出す。状態: 完了。

## DEF-057 `findActiveRun` の確かめから Run のディレクトリとロックの作成までの間に、2 つ目の Run が確かめを通れる（2026-10-09 T24 調査で発見。既存）

- 現象（調査担当がコードで確かめた事実）: 同じ秒なら 2 つ目は `RunDirectoryUnavailableError`（FAILED、終了コード 1）、秒が違えば 2 つの Run が並んで動く。再開どうしは `wx` とロックの判定で止まる。
- 影響: 同じ出力先で 2 つの監査が並ぶと、pacer が別々になり、監査対象への負荷が 2 倍になる（負荷の決まりに反する）。CLI を 2 つ同時に起動した場合と、Task 24 で CLI と画面のジョブが同時に始まった場合に起きうる。
- 扱い: Task 24 の T24c で直す（設計書 4.6）。
- 結果（2026-10-09）: T24c で直した（出力先ごとの開始のロック）。両方の Chromium で RED（Run が 2 つ）→ GREEN（1 つ）。残る稀な競争（古い開始のロックを 2 つの起動が同時に取り直す場合、作った空の出力先を消す瞬間）は、既存の Run のロックの取り直しと同じ程度として受け入れる。状態: 完了。


## DEF-058 `context-factory.test.ts` の「passes requestfinished of the Passive and Interaction Contexts…」が、強い混雑の下で要求の終わりの順を決め打ちして失敗する（2026-10-09 DEF-055 の調査で発見。テストの揺らぎ）

- 現象: 799 行の `expect.poll(...).toEqual([html, svg])` が順序を決め打ちしている。強い混雑の下で svg の requestfinished が html より先に届き、約 400 回中 2 回失敗した。
- 扱い: 登録だけ。テストの直し（順を問わない比べ）は後で依頼する。
- 結果（2026-10-09）: T24g で直した（Passive の文書と画像を順を問わずに比べる。同じテストの 2 か所）。強い混雑の下の繰り返しは未実行。状態: 完了（監視）。

## DEF-059 テストの補助が、使い回された PID のために無関係なプロセスを子孫と数える（2026-10-09 G24 の全体の検証で発見。テストの不具合）

- 現象: `npm run verify:all` の `test:ui` で、`apps/local-ui/tests/audit-job-functions.test.ts` の `afterAll`（138 行）が「残ったプロセス」として `OneDrive.Sync.Service.exe`（親の PID 16512）を挙げて失敗した。テスト 112 件はすべて PASS（ファイルの片付けの確かめだけが失敗）。ログ: scratchpad の `verify-all-20261009-t24.log`。
- 原因（推測。コードと結果から）: `tests/helpers/process-tree.ts`（T24d）が、親の PID だけで子孫をたどるので、監査で起動したプロセスが終わった後に同じ PID を使い回した無関係なプロセスの子を、子孫と数える。
- 影響: 検証が揺れる。製品の不具合ではない。
- 扱い: 補助を直す（子孫の判定に、親のプロセスの起動の時刻が子より前であることと、プロセスの名前（node、Chromium）を加える）。
- 結果（2026-10-09）: 直した（`AUDIT_PROCESS_NAMES`、起動の時刻が親以上のものだけ、時刻を読めないときは名前だけで数える（見逃さない側））。単体テスト 5 件、補助を使う 6 ファイル（結合 14 件、画面 32 件）が PASS。RED は未実行（前の形で流せなかった）。状態: 完了。

## DEF-060 古いロックを取り直す方式（書き換えて読み直す）では、2 つの起動が同時に取り直すと両方が自分のものと読み、同じ Run を 2 つ同時に再開しうる（2026-10-09 T24R の I1。既存。Run のロックにも同じ方式）

- 現象（レビュー担当の実機の確かめ。scratch の `t24r/e2`。2 つの CLI の process）: 中断した Run を 2 つの CLI でほぼ同時に再開すると、古い開始のロックがない場合は 3 回とも片方だけが再開した。死んだ PID の開始のロックを置くと、4 回中 1 回は両方が同じ Run を再開した（どちらも終了コード 0）。
- 原因: 開始のロック（T24c）と Run のロック（保存のセッション）の、古いロックの取り直しが「自分のロックで書き換え → 読み直して自分のものか確かめる」方式で、2 つの process の手順が少しずれると両方が自分のものと読む。
- 影響: 同じサイトに 2 つの監査が同時に要求を送る（負荷の決まりに反する）。古いロックは、開始の段の途中の強制終了などで残る。
- 扱い: Task 24 の中で直す（T24h-2）。古いロックの取り直しを原子的にする（古いファイルを一意の名前へ rename してから `wx` で作り直す。rename に負けた側は判定し直す）。`cli.md` と `resume.md` の記述を実際の振る舞いに合わせる。
- 結果（2026-10-09）: T24h-2 で直した（rename → 中身の確かめ → wx。2 つの CLI の process で 20 回ずつ、直す前 2/20 → 直した後 0/20）。状態: 完了。

## DEF-061 画面のサーバを 2 つ動かすと、起動したサーバがほかのサーバのジョブも中断に書き換え、同時に 2 つの監査が動く（2026-10-09 T24R の C1。Critical）

- 現象（レビュー担当の実機の確かめ。scratch の `t24r/e1`）: サーバ A がジョブを RUNNING にした後、サーバ B を起動すると、B は `recoverInterruptedJobs` で A のジョブを `INTERRUPTED`（`SERVER_RESTARTED`）に書き換え、B（または A）で新しいジョブを始められた。2 つのワーカーが同時に生きていた。2 つ目の `npm run ui` は port の使用中で止まるが、止まる前に 1 つ目のジョブを中断と記録する。`npm run ui` と `npm run ui:dev`、`--port` で、2 つのサーバが同じ `local-data` で動く。
- 影響: 2 つのプロファイルが同じサイトを指していれば、そのサイトに 2 倍の負荷。出力先が別なので開始のロックでも止まらない。`local-ui.md` の「監査は画面全体で同時に 1 つだけ」と食い違う。
- 扱い: Task 24 の中で直す（T24h-1）。画面のサーバを 1 つだけにするロック（`local-data` の中。持ち主の PID・OS の起動の時刻・ハートビート。`judgeRunLock` と同じ考え。取り直しは DEF-060 と同じ原子的な方式）を、管理データの準備の後、ジョブの中断への直しの**前**に取る。取れなければ日本語の説明で起動を止め、何も書き換えない。
- 結果（2026-10-09）: T24h-4 で直した（管理データの表 `control_instance` の 1 行のロックを、ジョブの管理を作るときに原子的に取る）。レビュー担当の再現（`t24r/e1`）は直した後に再現しない。残る隙間: 持ち主のサーバが 5 分より長く止まった場合（スリープなど）。状態: 完了。

## DEF-062 3 つ以上の起動が同時に開始のロックを取ろうとすると、2 つが同時にロックを持ちうる（2026-10-10 T24R2 の Minor m2。監視）

- 現象（レビュー担当の確かめ。scratch の `t24r/e3`。時刻で揃えた 3 つの process）: 古いロックありで 40 回中 2 回、古いロックなしでも 40 回中 1 回、2 つが同時にロックを持った。2 つの process では 40 回中 0 回。
- 原因（コードから）: 他人のロックを動かしてしまった後の戻し（`#restoreMovedLock`）は、3 つ目が先にロックを作ると戻さずに消す。`wx` で作った直後の空のファイルは `null` と読まれ、古いと判定される。
- 影響: 同じ出力先で 3 つ以上の監査をほぼ同時に始めた場合だけ。現実の利用ではまず起きない（推測）。
- 扱い: 監視。直すなら、中身を書いた一時ファイルを `link` で置く（作成と中身を 1 回で入れる）方式にする。

## DEF-063 `cli-site-unavailable.test.ts` の SU6（2 回目の確かめ直しの前にサイトが戻る）が、全体の検証の混雑の下で PARTIAL（終了コード 2）になって失敗する（2026-10-10 G24 の全体の検証で発見。揺らぎか未確定）

- 現象: `npm run verify:all` の 3 回目で、「SU6: the site is back before the second recheck of the k+1-th page … finishes the Run in the one execution …」が `expected 2 to be +0`（878 行。中断なしの Run は 0、この Run は 2）で失敗。標準エラーの中身はログに出ていない。ログ: scratchpad の `verify-all-20261010-t24-3.log`。
- 単独の実行: 3 回とも 40 件 PASS（各 約 153 秒）。
- 推測: 確かめ直しの時刻（サイトを戻す時刻）とテストの待ちの順が、混雑で入れ替わり、2 回目の確かめ直しも失敗して Run が `STOPPED_BY_SITE_UNAVAILABLE` になった。Task 24 の変更（開始のロック、ロックの取り直し）との関係は未確認。
- 扱い: 混雑の下で再現して原因を確かめる（DEF-063-investigation）。
- 結果（2026-10-10）: 原因は、強い混雑で本番の期限（DOM の準備 5 秒、Browser を閉じる 10 秒）が切れて Run が PARTIAL になり、別々に走る比べる相手の Run と片方だけに起きると食い違うこと（製品は設計どおり。Task 24 の変更とは関係しない）。テストの中で、両方の Run に名前つきの長めの期限を入れた（判定の値は変えない）。強い混雑の下で 20/20 PASS。状態: 完了。

## DEF-064 Guard の診断の経過時間が、待つ時間より 1 ms 短く出ることがあり、テストの下限の確かめが揺れる（2026-10-11 Task 26 の全体の検証で発見。テストの揺らぎ。安全への影響なし）

- 現象: `npm run verify:all`（Node 24.21.0、強い混雑の下）で、`tests/integration/passive-request-guard.test.ts` の「DEF-052: without the evidence, the failure is still a violation, ...」が 1 回失敗した（`expected 499 to be greater than or equal to 500`。`diagnostic.elapsedMs` が `EVIDENCE_WAIT_MS`（500）より 1 ms 短い）。単独での再実行は 3 回とも PASS。
- 原因（コードを読んだ結果）: Guard（`src/safety/passive-request-guard.ts` の `settlePausedDocumentCommand`）は、待つのを `setTimeout` で行い、経過時間を `Date.now()` の差で記録する。Node のタイマーはイベントループの時刻（ms の単位）で発火するため、`Date.now()` の差で測ると、待つ時間より 1 ms 短く見えることがある（推測。Node と libuv の時刻の丸めの違い）。
- 影響: 安全の判定は変わらない（違反として記録し、Context を閉じる。テストのほかの確かめは通った）。診断の数値の下限の確かめだけが揺れる。
- 扱い: DEF-064-fix で、テストの下限に、時刻の単位の違いを名前つきの許容（1 ms）として入れる（製品の振る舞いは変えない）。直した後に全体の検証を通しで 1 回 PASS させる。
- DEF-064-fix（2026-10-11）: 直した。原因を実験で確かめた（Node 24.21.0 の `setTimeout(500)` を Guard と同じ形で 12,000 回測り、128 回が `Date.now()` の差で 499 ms、499 未満は 0 回、`performance.now()` の差の最小は 499.018 ms。タイマーは ms に切り捨てたループの時刻で決まり 1 ms 未満早く発火しうる）。テストの下限を `EVIDENCE_WAIT_MS - TIMER_CLOCK_GRANULARITY_MS`（1）にした（ほかの確かめは変えない。製品のコードは変えない）。単独 3 回、該当の確かめ 20 回 PASS。全体の検証の通しは、T26R の後にまとめて行う。

## DEF-065 待つ時間の下限を許容なしで確かめるテストがほかにもある（2026-10-11 DEF-064-fix の報告で発見。揺らぎの可能性。推測）

- 場所: `tests/component/layout-collector.test.ts` の 741 行あたり、`tests/integration/isolated-interaction.test.ts` の 7358 行と 8755 行あたり、`tests/integration/fixture-server.test.ts` の 254 行あたり。
- 内容: DEF-064 と同じく、タイマーで待った時間を、許容なしの下限で確かめている。タイマーが 1 ms 未満早く発火するので、揺れうる（まだ失敗は観測していない）。
- 扱い: DEF-065-fix で、各箇所が本当に同じ形かを確かめ、同じなら DEF-064 と同じ名前つきの許容を入れる（共通の定数はテストの補助に 1 つ置く）。
- DEF-065-fix（2026-10-11）: 直した。4 か所のうち同じ形は `tests/component/layout-collector.test.ts` の 1 か所だけ（`awaitBeforeDeadline` の `setTimeout` を `Date.now()` の差の下限で確かめる）→ 1 ms の許容を入れた。ほかの 3 か所は、測る区間に本物の Chromium の読み込みや 100 ms の余裕が入るので同じ形でない（触らない）。許容の定数 `TIMER_CLOCK_GRANULARITY_MS` は `tests/helpers/timer-clock.ts` の 1 か所にし、DEF-064 の定数もそれを使う形にした。直した 2 ファイルを単独で各 2 回 PASS。`fixture-server.test.ts` の数値の直書き（`1_400`）は記録だけ。

## DEF-066 画面のサーバの関数のファイルから普通の関数を公開すると、サーバの部品がブラウザのバンドルに入ってページが壊れうるのに、Gate が捕まえない（2026-10-11 T26g-2 round 1 の報告で発見。潜在の不具合）

- 現象: `apps/local-ui/src/server/credential-functions.ts` の部品の組み立てを普通の関数のまま公開したところ、ブラウザの組み立てで管理データと資格情報のファイルの部品が残り、ページの読み込みで `TypeError: Cannot read properties of undefined (reading 'O_RDONLY')`。画面の検査で見つけ、`createServerOnlyFn` で包んで直した（今は起きていない）。
- 影響: 画面の検査が通れば見つかるが、Gate（`local-ui-boundary`）は形を捕まえない。サーバの部品（資格情報のファイルの部品を含む）がブラウザのバンドルに入ること自体が望ましくない。
- 扱い: Gate の候補。`apps/local-ui/src/server/` のファイルが公開する値が、Server Function か `createServerOnlyFn` で包んだものか型だけであることを確かめる規則を、`local-ui-boundary` に足す（fs と正規表現の近似。1 秒以内）。T26R2 の後の片付けにまとめる。

## DEF-067 認証つきの Run の目印の検査のテストが、強い混雑の下で 30 秒の時間切れになる（2026-10-11 T26g の後の全体の検証で発見。テストの揺らぎ）

- 現象: `npm run verify:all`（Node 24.21.0）で、`tests/integration/authenticated-run.test.ts` の「T25c: the authenticated Run (the CLI launch settings) > writes none of the secret markers to any file of the Run directory ...」が `Test timed out in 30000ms`。単独での実行では 13〜15 秒で PASS（2 回）。
- 原因（推測）: 回転するサーバで認証つきの Run を最後まで行い、すべてのファイル（ZIP の中を含む）を調べるので、単独でも 15 秒かかる。全体の検証の混雑で 2 倍を超えた。製品の不具合ではない（目印の検査の結果の誤りではなく、時間切れ）。
- 扱い: DEF-067-fix で、このテスト（と同じファイルの同じ重さのテスト）の時間の上限を、名前つきの値で広げる（DEF-063 と同じやり方）。

## DEF-068 Safety Gate の GATE-S07 の間に、テストのサーバのソケットの `ECONNRESET` が処理されずに残る（2026-10-11 T26g の後の全体の検証で発見）

- 現象: 同じ全体の検証で、Vitest が「Unhandled Errors: Error: read ECONNRESET（`TCP.onStreamRead`）」を 1 件報告した。発生した場所は `tests/integration/safety-gates.test.ts` の実行中で、最後のテストは「GATE-S07 Interaction: the WebSocket upgrade from inside a Worker never reaches the server, and is recorded as WORKER_CONNECT_POLICY (DEF-040)」。テストそのものは PASS。単独での実行では 2 回とも出なかった。
- 原因（推測）: ブラウザが止められた接続を切ったときに、テストのサーバ（fixture）のソケットに `error` の受け手がない。安全の判定への影響はない（GATE-S07 は PASS。サーバに upgrade は届いていない）。ただし、処理されない誤りは全体の検証を失敗させ、ほかの誤りを隠しうる。
- 扱い: DEF-068-fix で、どのサーバのどのソケットかを確かめ、テストのサーバのソケットに `error` の受け手を付ける（製品のコードは変えない）。GATE-S07 の確かめ（サーバに届かない）は弱めない。
- DEF-067-fix（2026-10-11）: 直した。`authenticated-run.test.ts` の 10 秒を超える 4 つのテスト（回転するサーバ、robots.txt と sitemap.xml、秘密の目印。単独で最大 約 16 秒）に `FULL_RUN_TEST_TIMEOUT_MS = 120_000`（ほかのファイルの `RUN_TEST_TIMEOUT_MS` とそろえた）。確かめる内容と Run の期限は変えない。単独 2 回 PASS。
- DEF-068-fix（2026-10-11）: 直した。原因は `fixtures/server.ts` の upgrade と CONNECT のソケット（Node が `error` の受け手を外して渡す。応答の後にクライアントが RST で切ると処理されない `ECONNRESET`）。何もしない `error` の受け手を付けた（数え方と応答と GATE-S07 の確かめは変えない）。`fixture-server.test.ts` に再現のテスト 2 件（直す前は毎回 Unhandled Errors 2 件、後は 0 件）。ブラウザを使う GATE-S07 の経路では、直す前の混雑の下でも再現しなかった。ほかの fixture は受け取ってすぐ `destroy()` するので同じ形でない。

## DEF-069 form の中に `name="method"`（や `name="action"`）の入力の欄があると、DOM の Evidence の収集と Interaction の候補の発見が例外で落ちる（2026-10-11 T27 調査で発見。公開監査に影響。修正の前からある）

- 現象: form の中に `<input name="method">` があると、`src/evidence/dom-collector.ts` の `collectDomEvidence` が `normalizeWhitespace(form.method)` で「value?.replace is not a function」、`src/interaction/discover-candidates.ts` の `discoverInteractionCandidates` が `form.method.slice` で落ちる（T27 調査の実験で確かめた）。`name="action"` でも `form.action` で同じく落ちると推測（未実験）。DOM clobbering（form の名前つきの子が、form のプロパティを隠す）による。
- 影響: WordPress などに多い書き方で、公開監査の DOM の Evidence と Interaction の候補が取れない（Run の結果への影響の程度は未確認）。安全の判定（Guard）への影響はない（推測）。
- 扱い: DEF-069-fix で、form のプロパティを標準の prototype の getter で読む（`src/browser/login-form-submitter.ts` と同じやり方。共通の部品にできるか確かめる）。再現のテスト（`name="method"`、`name="action"`、`name="target"`、`name="elements"` など）を RED にしてから直す。公開監査の golden に影響する場合は報告する。

## DEF-070 CLI の起動の設定の Chromium が、自分で Google（`www.google.com`、`content-autofill.googleapis.com`）へ接続しようとする（2026-10-11 T27 調査で発見。調査中）

- 現象: T27 調査の実験で、CLI の起動の設定の Chromium（`chromiumLaunchOptions({ headless: true })`）の Interaction の Context で、出口の中継が `CONNECT www.google.com:443` と `content-autofill.googleapis.com:443` を受けて拒否した（`EGRESS_UPSTREAM_DENIED`、`INTERACTION_FROZEN_EGRESS`）。headless shell では出なかった。
- 影響（推測）: Passive の Context には出口の中継がないので、実サイトの監査の間に Chromium が Google へ直接接続している可能性がある。autofill の通信は、ページの form の構造の情報を Google へ送る機能の可能性がある。監査対象のサイトへの要求ではないが、第三者への送信になりうる。
- 扱い: DEF-070-research（読み取り専用の調査。インターネットへは出さず、Chromium の `--proxy-server` を 127.0.0.1 の記録用の中継に向けて、どの Context の種類・どの起動の設定で、どこへ接続しようとするかを数える。止める起動の引数（Playwright の既定の `--disable-features` を上書きしない方法を含む）の候補を実機で比べる）。

## DEF-071 資格情報の画面のテストで、削除の知らせの直後に読む `credential-saved` が揺れる（2026-10-11 T26g-3 の `verify:ui` で発見。テストの揺らぎ）

- 現象: `apps/local-ui/tests/credential-ui-flows.test.ts` の「asks to replace both values ... deletes the credential after the dialog」で、削除の知らせ（`data-notice="removed"`）が出た直後の `credential-saved` が `no` でなく `yes`。単独の再実行では 16 件すべて PASS。
- 原因（推測）: 知らせを待った直後に、画面の値の読み直しが揃う前に読む。
- 扱い: T26g-3 round 1 で、待つ対象を `credential-saved` が `no` になるまでにする（期待は弱めない）。
- DEF-066-fix（2026-10-11、T26g-3 round 1）: 直した。`local-ui-boundary` の (i)（ブラウザ側のコードが値を import する `server/` のファイルが公開する関数は、`createServerFn` か `createServerOnlyFn` で包んだものだけ。例外は理由つきで `auth-setup-errors.ts`（たどった先に `node:` がないことも確かめる）と `artifact-files.ts` のサーバの route の受け手）。今の違反は `listJobArtifacts` の 1 件 → `createServerOnlyFn` で包んだ。0.6〜0.7 秒。近似で捕まえない形（名前だけの再公開、型の注記に `=`、最上位の値での呼び出し）は記録。
- DEF-071-fix（2026-10-11、T26g-3 round 1）: 直した。削除の知らせの後に `credential-saved` が `no` になるまで待ってから確かめる（同じ形の残ったファイルの検査も）。期待は変えない。
- DEF-070-research（2026-10-11）: 完了。CLI の起動の設定（chrome.exe、Chromium 151）は、Chromium 自身が Google へ 5 種類の接続を試みる（headless shell は 0）: 起動のたびに `clients2.google.com/time`、`accounts.google.com`（ListAccounts）、`android.clients.google.com`（GCM の checkin）、`www.google.com`（AI Mode の可否の問い合わせと preconnect）、form のあるページのたびに `content-autofill.googleapis.com`（form の署名と欄の署名を含む問い合わせ。入力の値と URL の平文は入っていない）。Passive・Interaction・ログインの段のどれでも。外へは出さない実験（記録用の中継、DNS の規則、TLS を中で終える実験 1 回）で確かめた。本番（中継なし）でも同じと推す根拠あり。過去の CLI の実サイトの Run（R7a 以降）でも出ていた可能性が高い（推測）。止める方法: Playwright の既定の `--disable-features` の 16 個に `AutofillServerCommunication`・`NetworkTimeServiceQuerying`・`PreconnectToSearch`・`AimEnabled` を合わせた 1 つの引数で、Context から出る接続は 0（スクリーンショットと DOM の hash と Ledger は同じ）。起動のときの ListAccounts と checkin は残り、`--gaia-url`・`--gcm-checkin-url` を 127.0.0.1:9 に向けると 0（ユーザーの判断）。`--disable-features` を単独で足すと Playwright の既定を上書きして HttpsUpgrades が効き出すので使えない。すべての Context を中継に通す案は、ブラウザの水準の要求が通らないので止まらない。→ DEF-070-fix で (i-b) を入れる（設計者の判断。離席中の承認の下。安全と第三者への送信を止める直し）。(i-c) と、過去の Run で第三者へ送っていた可能性の扱いは、ユーザーに判断を求める。実験のフォルダ（scratchpad の `def070\`。自己署名の証明書と秘密鍵を含む）は、削除が権限で止められたので残っている（ユーザーに伝える）。
- DEF-069-fix（2026-10-11）: 直した。`dom-collector.ts` と `discover-candidates.ts` のブラウザの中の関数で、form になりうる要素の標準のプロパティとメソッドを、prototype の getter とメソッドの `.call` で読む（それぞれの関数の中に置く。`page.evaluate` の関数は外を参照できないので共通にしない → CC-068）。RED: 両方の Chromium で新しいテスト 8 件中 6 件 FAIL（`method`、`action`、`elements`、`getAttribute`、`tagName`、`childNodes`、`checkVisibility` などの名前で例外や誤った値）→ GREEN。公開監査の golden と `cli-output-parity` は前後とも PASS。

## DEF-072 ほかの collector とスクロールも、form の名前つきの子で落ちる・誤った値になる（2026-10-11 DEF-069-fix の報告で発見。公開監査に影響。修正の前からある）

- 場所と現象（両方の Chromium で確かめた）: `src/evidence/color-collector.ts`（`tagName`・`childNodes`・`getBoundingClientRect` で例外、`parentElement` で文字の標本が減る）、`src/evidence/layout-collector.ts`（`getAttribute`・`matches`・`checkVisibility`・`getBoundingClientRect`・`getClientRects` で例外）。`src/browser/controlled-scroll.ts` は今回の形では問題が出なかったが、同じく直接読む（未確認）。
- 扱い: DEF-072-fix で、DEF-069 と同じ読み方にする。

## DEF-073 `document` の名前つきの要素による上書きで、DOM の Evidence・候補の発見・色の標本・スクロールが落ちる・誤った値になる（2026-10-11 DEF-069-fix の報告で発見。公開監査に影響。修正の前からある）

- 現象: `<img name="forms">`、`<form name="querySelector">` などで `document` のプロパティが隠れる。`collectDomEvidence` は `forms`・`images`・`title`・`querySelector`・`querySelectorAll` で例外、`discoverInteractionCandidates` は `createTreeWalker` で例外、`documentElement` で候補が 0 件、`body`・`scrollingElement` で色の標本が 0 件、`scrollingElement` で controlled scroll が `PARTIAL:SCROLL_TARGET_UNRESOLVED`。
- 扱い: DEF-073-fix で、ブラウザの中の関数の `document` の読み取りを `Document.prototype` の getter とメソッドで行う。
- DEF-070-fix（2026-10-11）: 直した。`chromium-launch.ts` に `PLAYWRIGHT_DEFAULT_DISABLED_FEATURES`（Playwright 1.62.1 の 16 個の写し）と `CHROMIUM_GOOGLE_SERVICES_DISABLED_FEATURES`（4 個）を合わせた `--disable-features` 1 つ、ユーザーの判断で `--gaia-url`・`--gcm-checkin-url` を `http://127.0.0.1:9` へ。RED: 4 つの場面で time・www・autofill・accounts・android への試み（Interaction の出口の中継に 9 件）→ GREEN: 記録用の中継の記録も出口の中継の記録も 0 件（対照で記録の仕組みが働くことも確かめる）。既定の値のテストは `preloading-disabled.test.ts` に寄せ、`chrome://version` で完全一致（Playwright の版が変われば失敗する）。HttpsUpgrades は効き出していない。「Google でログイン」の fixture でスクリーンショット・DOM・Ledger・ページの要求は同じ。DEF-046 も解消。`doc/spec/safety.md` に章を足した。新しいテストは記録用の中継と DNS の規則つきで、インターネットへは出していない。scratchpad の `def070-fix\`（証明書なし）の削除が権限で止められた。
- DEF-072-fix・DEF-073-fix（2026-10-11）: 直した。7 ファイルと `discover-links.ts` の `baseURI`（`<img name="baseURI">` で巡回の候補が 0 件になっていた）。テストは案 A（`Document.prototype` の差し替え、偽の環境に `Document`。期待は変えない）。両方の Chromium で新しいテスト 18 件、結合 17 ファイル 850 件、巡回 33 件、golden と `cli-output-parity` PASS。

## DEF-074 ページの `document.querySelectorAll` が上書きされていると、Playwright の `locator.evaluateAll` が落ち、リンクの抽出が失敗する（2026-10-11 DEF-072・073-fix の報告で発見。公開監査に影響）

- 現象: `<img name="querySelectorAll">` のあるページで、`discoverLinks` が `locator.evaluateAll: TypeError: root.querySelectorAll is not a function ...`（両方の Chromium）。Playwright がページの側で要素を集めるときに `document.querySelectorAll` を使うため。ほかの `locator.evaluateAll`・`$$eval` の使い方も同じ影響を受けうる（推測）。
- 扱い: DEF-074-fix で、リンクの抽出の唯一の入口（ARCH03 の owner）を、`page.evaluate` の中で標準のメソッド（`Document.prototype.querySelectorAll.call`）で集める形に変える。ほかの `evaluateAll`・`$$eval` の使い方を一覧にし、同じ形なら直す。GATE-ARCH03 の検出の形を保つ。

## DEF-075 Interaction のテストの一部の計測が、DEF-069 の直しの後に空振りしている（2026-10-11 DEF-072・073-fix の報告で発見。テストの弱まり。Important 相当）

- 現象: `tests/integration/isolated-interaction.test.ts` の `installGeometryReadCounter`（要素のインスタンスの `getBoundingClientRect` の差し替え）、700・705 行目付近の `document.documentElement.matches` と `target.getAttribute` のインスタンスでの差し替えが、prototype の `.call` で読む今のコードでは呼ばれない。期待（読み取り 0 回など）は満たすが、何も測っていない。
- 扱い: DEF-075-fix で、`Element.prototype` などを差し替えて元に戻す形に直し、計測が実際に働くこと（差し替えが呼ばれる回数が 0 より大きい場面がある、または計測の対照）を確かめる。同じ形の空振りがほかのテストにないかも探す。
- DEF-074-fix・DEF-075-fix（2026-10-11）: 直した。DEF-074: `discoverLinks` を `page.evaluate` の中で `Document.prototype.querySelectorAll.call` と `shadowRoot` の getter で集める形に（Playwright の CSS のエンジンと同じ順。open な shadow root を貫く）。DEF-075: `Element.prototype` を差し替える計測に直し、対照のテスト 3 件（直す前は FAIL）を足し、境界のテストの期待を強めた（空振りの間は狙った境界を確かめていなかった）。結合 19 ファイル 888 件、golden、`cli-output-parity` PASS。

## DEF-076 ログインの成功・失敗の条件のセレクタの判定が、上書きされた form で落ちる（2026-10-11 DEF-074 の報告で発見。fail-closed。記録だけ）

- 現象: `loginStageLocator(page, selector).count()` が、form の `matches` が上書きされたページで `TypeError: element.matches is not a function`。呼ぶ側は「当たらない」として扱う（成功を誤って認めない向き）。
- 扱い: 安全の側に倒れるので、今は記録だけ。設定のセレクタは Playwright の CSS のエンジン（shadow root を貫く、独自の文法）で評価しており、標準の `querySelectorAll` に置き換えると意味が変わるので、直すなら設計の判断が要る。

## DEF-077 axe（`@axe-core/playwright`）のアクセシビリティの Evidence が、DOM clobbering のあるページで `PARTIAL:EVALUATION_FAILED` になる（2026-10-11 DEF-074 の報告で発見。依存のライブラリの中。記録だけ）

- 現象: 上書きのある fixture で `collectAccessibilityEvidence` が `PARTIAL:EVALUATION_FAILED`（対照は `COMPLETE`）。axe-core の中の読み取りによる。
- 扱い: 依存のライブラリの中なので直さない。PARTIAL として正直に記録されることは保たれている。手順書に「DOM clobbering のあるページでは、アクセシビリティの Evidence が取れないことがある」と書くかは、後で判断する。

## DEF-078 資格情報の変更の記録の順が、時刻によって逆になり、画面のサーバのテスト 4 件が決まって失敗する（2026-10-11 全体の検証で発見）

- 現象: `npm run verify:all`（2026-10-11 夜）で、`apps/local-ui/tests/credential-service.test.ts` の 3 件と `credential-retire.test.ts` の 1 件が FAIL（`expected [ 'DELETED', 'CREATED' ] to deeply equal [ 'CREATED', 'DELETED' ]`、`HOLD_CLEARED` も同じ）。単独での再実行でも同じく 4 件 FAIL（揺らぎではなく、決まって失敗する）。同じテストは、同じ日の昼の `verify:ui` では PASS していた。
- 原因（推測）: 記録の読み出しは `recorded_at DESC, event_id DESC` の順。後の記録（DELETED など）の `recorded_at` が、前の記録（CREATED）より早い。登録と削除・解除で、記録の時刻を別の時計（テストの固定の時刻と、実際の時刻など）から取っている可能性がある。製品のコードで時計が混ざっているなら、製品の不具合。
- 扱い: DEF-078-fix で原因を確かめる（どの記録がどの時計の時刻を使うか）。製品で時計が混ざっていれば、1 つの時計に揃える（記録の順の正しさは、監査の記録として大事）。テストだけの問題なら、テストの時計を揃える。
- DEF-078-fix（2026-10-11）: 直した。原因は製品のコードの時計の混ざり（`credential-service.ts` の `recordChange` が資格情報のファイルの `updatedAt`（ファイルの部品の時計）、削除と解除の操作が依存の時計 `deps.now` から時刻を取っていた。テストではファイルの部品が実際の時刻、依存が固定の 09:00 UTC だったので、09:00 UTC を過ぎると順が逆になった）。`recordChange` も依存の時計に揃えた。時刻によらず決まって RED になる検査（2030 年に固定）を足した。`auto_login_attempts`・`auto_login_holds` はジョブの管理の時計 1 つで混ざりなし。

## DEF-079 再開の同一性のテストで、強い混雑の下で一方の Run にだけ `POOR_TTFB` の Finding が出て、比べが揺れる（2026-10-11 全体の検証で発見。テストの揺らぎ）

- 現象: `npm run verify:all`（2026-10-11 夜）で、`tests/integration/resume-run.test.ts` の「R4a2b: ... gives the same pages, IDs, Evidence, Findings, Run Status, ...」が FAIL。中断のない Run にだけ `POOR_TTFB`（FIND-000010）があり、以降の Finding の ID が 1 つずれた。単独での再実行は 2 回とも 15 件 PASS。
- 原因（推測）: fixture のサーバの応答の時間（TTFB）は、全体の検証の CPU の混雑で伸びる。性能の指標に基づく Rule の結果は、2 つの Run の間で同じとは限らない。製品の不具合ではない（再開の同一性は、性能の指標によらない部分で確かめるべき）。
- 扱い: DEF-079-fix で、このテスト（と同じ形の再開・同一性のテスト）の比べ方を確かめ、時間に左右される Finding（`POOR_TTFB` など、性能の指標の Rule）を、名前つきの一覧で比べの対象から外すか、テストの設定で閾値を混雑でも超えない値にする（どちらが今の設計に合うかを確かめて決め、報告する）。期待をほかに弱めない。
- DEF-079-fix（2026-10-11）: 直した。原因を計測で確かめた（127.0.0.1 の TTFB は混雑なしで最大 9 ms、CPU の 8 倍の Worker の混雑で最大 2,166 ms、30 回中 3 回が `POOR_WEB_VITAL_THRESHOLDS.TTFB`（1,800）を超える。閾値は製品の定数で設定では変えられない）。案 (a): 再開の同一性を比べるテストの設定に `RUN_IDENTITY_AUDIT_OVERRIDES`（`audit.performance: false`）を 1 か所に置き、`resume-run`（R4a2b・R4b2）、`cli-resume`、`cli-site-unavailable` に使った（Finding の ID の比べは保つ。案 (b) は ID のずれが残るので不可）。製品のコードは変えない。元の失敗の形は R4a2b そのものでは再現できなかった。発見: 極端な混雑（CPU の 8 倍）で R4a2b の beforeAll が checkpoint なしで失敗（中断する Run が最初のページの保存の前に終わったと推測。全体の検証より重い条件。未確認）→ 全体の検証で再び出たら調べる（記録だけ）。

## DEF-080 `control-discovery-jobs` の `other-summary` が、強い混雑の下で `FAILED` でなく `INTERRUPTED`（`WORKER_EXITED`）になることがある（2026-10-12 T27e の報告で発見。テストの揺らぎ。推測）

- 現象: T27e の結合の通しの実行で 1 回 FAIL。単独で 3 回 PASS。
- 原因（推測）: 偽のワーカーの `exit` が `FINISHED` のメッセージより先に処理される。
- 扱い: 記録だけ（2026-10-11 のユーザーの判断「揺らぎの追跡は後回し」による）。揺らぎの片付けのときにまとめて調べる。

## DEF-081 CLI の監査が、出力先の開始のロックの取り直しの途中で作り直した出力先を覚えず、Run を始めずに終わると空の出力先を残すことがある（2026-10-12 CCX-6 の調べで発見。推測。狭い競争の場面）

- 内容: `src/cli/audit-run.ts` は、最初の `acquireOutputStartLock` で作れたときだけ `createdDirectory` を覚え、`takeOverStaleLock` の中の作り直し（`CHANGED` の後の `port.acquire`）で作った出力先を覚えない。前の持ち主が空の出力先を消した後に作り直し、Run を始めずに終わると、空の出力先が残る。ワーカーの Run（`worker-run-session.ts`）は作れるたびに覚えるので残さない。`tests/unit/output-start-lock.test.ts` の「Run を始めないときは、開始のロックのために作った出力先を残さない」の意図にはワーカーの側が合う。
- 扱い: CCX-6 で、ワーカーの側（作れるたびに覚える）に揃えて直す。この場面を再現するテストで RED（CLI が空の出力先を残す）→ GREEN を確かめる。
- DEF-081-fix（2026-10-12、CCX-6 の中）: 直した。出力先の開始のロックの取り直しを `src/orchestration/output-start-lock.ts` にまとめ、作れるたびに `createdDirectory` を覚える形（ワーカーの側）に揃えた。再現のテスト（取り直しの途中で作り直し、Run を始めずに終わる）で RED（空の出力先が残る）→ GREEN。

## DEF-082 `startWorkerRun` が `clock()` を try の外で呼び、時計が例外を投げると開始のロックと作った出力先が残る（2026-10-12 CCX-6 の報告で発見。推測。本番の時計は `new Date()` なので起きにくい）

- 扱い: 記録だけ。ワーカーの Run の次の変更のときに、`clock()` を try の中に入れる。

## DEF-083 `discovery-job-fork` の読み込みの間隔の確かめが、間隔を守らない変化でも PASS する見込み（2026-10-12 T27g の報告で発見。推測）

- 現象（推測）: `tests/integration/discovery-job-fork.test.ts` は、間隔を 400 ms にして、サーバに届いた時刻の最初から最後までの長さで間隔を確かめる。1 画面の発見に約 1.1 秒かかるため、間隔を 0 にしても長さの条件を満たしてしまう。T27g の端から端のテストでは、400 ms で同じ形の確かめが間隔 0 の変異でも PASS した（その後 3,000 ms に上げて、変異で FAIL することを確かめた）。
- 影響: テストの検出力だけ（製品の不具合ではない）。間隔そのものは `discovery-run.test.ts` の pacer の記録と、T27g の `discovery-secret-markers`（3,000 ms、変異で FAIL を確認）が確かめている。
- 扱い: 記録だけ。テストの整理のときに、間隔を発見の所要時間より十分長くするか、pacer の記録で確かめる形に直す。

## DEF-084 ワーカーが結果を送ってから終わっても、混雑の下でジョブが `INTERRUPTED`（`WORKER_EXITED`）になることがある（2026-10-12 Task 27 の全体の検証で発見。DEF-080 と同じ原因の見込み。推測）

- 現象: `npm run verify:all`（T27R のレビュー担当の実験と並行の混雑の下）で、`tests/integration/control-audit-jobs-auth.test.ts` の「sends the validated setup, the approved origins and their digest in START, and records the auth states and the lost page」が 1 回 FAIL。期待は `FINISHED`・`PARTIAL`・`SESSION_LOST` だが、`INTERRUPTED`・`WORKER_EXITED`・`AUTHENTICATED` になった（ワーカーの最後の `AUTH_STATE` と `FINISHED` のメッセージが処理される前に、終わりとして扱われた）。単独で 3 回 PASS。
- 原因（推測）: `src/control/job/audit-job-manager.ts` は、ワーカーの終わりを子 process の `exit` の事象で扱う。Node.js では、`exit` の後にまだ届いていない IPC のメッセージ（`message` の事象）が残ることがあり、`exit` を先に処理すると、最後のメッセージを読まずにジョブを終わらせる。DEF-080（発見のジョブの `other-summary`）も同じ形の見込み。
- 影響（推測）: テストだけでなく、本番でも、混雑の下で、終わった Run のジョブを「中断」と記録しうる（Run の成果物は残る。安全の問題ではない。結果の記録の正しさの問題）。
- 扱い: テストの揺らぎでなく製品の不具合の見込みなので、T27R の後に直し方を調べる（`exit` ではなく `close`、または `disconnect` の後に終わりとして扱う、など。直す前に、混雑を作って再現するテストで RED を確かめる）。T27R の間は、レビューの対象のコードを変えないため着手しない。
- DEF-084 の調査（2026-10-12）: 推測が実験で確かめられた。Node.js 24.21.0 の `fork`（stdio は本番と同じ ignore と IPC）で、子が最後のメッセージを送ってから終わると、混雑の下で親の `exit` が最後の `message` より先に来る（200 回中 74〜134 回）。`disconnect` と `close` は、どの条件でも最後の `message` より後（逆転 0 回）。メッセージは失われない（順序の問題）。ワーカーが `send` のコールバックを待ってから終わる形はすでに入っているが効かない（コールバックは「パイプに書けた」の意味）。本物の管理と偽のワーカーで、START の直後に子が終わるまで親をふさぐ fork（追加 100 ms）を使うと、公開・認証つき・発見の 3 つの形で 20/20 回 `INTERRUPTED`・`WORKER_EXITED` になる（決定的な RED）。DEF-080 も同じ形で再現した（同じ原因の可能性が高い。偽のワーカーの書き込みの失敗の可能性は残る）。
- DEF-084 の修正の設計（2026-10-12、設計者）: 調査の (b) を採る。ジョブの管理は、`exit` を受けたら「process は終わった」の印を付け、IPC が切れる（`disconnect`）か、名前つきの期限（`AUDIT_JOB_IPC_DRAIN_WAIT_MS`。`job-records.ts`。3,000 ms。`exit` から `close` までの観測の最大は 768 ms）の早い方まで待つ（`child.connected` が false なら待たない）。待つ間は、合図の見張り（`#checkHeartbeats`）と `readyTimer` でジョブを終わらせない。待ち終わったら、`job.ending === null` のときに `WORKER_EXITED` を同期で決め（それ以後に届いたメッセージは捨てる）、その後に `#readJobResult` を呼び、`#exited` で記録する（成果物を読む間に `FINISHED` が割り込んで、確かめずに記録されることを防ぐ）。期限は `AuditJobTiming` から渡せるようにする（テストで短くする）。ワーカーの側は変えない。受け入れ条件: 親をふさぐ fork のテスト（公開・認証つき・発見、`tests/helpers/` の共通の部品）が修正の前に RED、後に GREEN。`exit` だけ来て `disconnect` が来ない偽の子で、期限の後に `WORKER_EXITED` で終わり枠が空く。既存のジョブのテスト（`control-*`、画面のジョブのテスト）が変わらない。T27R の後に実装する（レビューの対象のコードを変えないため）。

## DEF-085 同じタスクの中で開いた 2 つ目のポップアップの GET が、読まない URL や別の Origin へ届く（2026-10-12 T27R の C1。Critical。修正の前からある Guard の経路）

- 現象: ページの JS が `target=_blank` の form の `requestSubmit()`（または `a[target=_blank].click()`）の同じタスクの中で、続けて `window.open('<読まないパス>')` を呼ぶと、2 つ目のポップアップの GET がサーバに届く。Ledger には `FRAME_CLASSIFICATION_FAILED` が残り Run は `ABORTED_BY_SAFETY` になるが、要求は届いた後。
- 再現（T27R の実機。CLI の起動の設定）: 読み込みの直後に 11/12 回、300 ms 後に 4/5 回（混雑の下で 2/10 回）、発見のジョブの端から端で 2/4 回、認証なしの factory（公開監査と同じ）で別の Origin へ 1/5 回。headless shell では 0/10 回。凍結の後は 0/5 回。2 つ目を 5 ms 以上遅らせると届かない。ポップアップが 1 つだけ、POST のポップアップは 0/40 回。
- 影響: 発見の落ち着きの待ち、READ の結果の画面、認証つきの監査、公開監査のすべて（PASSIVE の段のポップアップの最初のナビゲーション）。
- 扱い: 直し方を調査担当の実験で決める（推測で設計しない）。

## DEF-086 表の行の中身が、送信ボタンの文言として `discovery.json` と画面に出る（2026-10-12 T27R の C2。Critical）

- 現象: `src/discovery/probe.ts` の `submitterTextOf` が、ボタンの文字・`aria-label`・`title` をつなげて `submitterText` にする。表の各行のボタンに行の名前を含むラベル（例「<行の名前> を編集」）があると、行の中身が `discovery.json` の `submitterText` と、`/discovery/$profileId`・`/read-checks/...` の画面に出る（両方の Chromium）。`submitterText` は候補の識別の digest（`fingerprint.ts`）にも入る。
- 原因: 設計書 4.1 が「送信ボタンの文言を成果物に持つ」と決め、4.8 の「表の行の中身を写さない」とぶつかっていた（設計の誤り）。
- 修正の設計: 下の「T27R の修正の設計」の 1。

## DEF-087 ページの JS が probe と構造の読み取りを偽れる（メインの world で動く）（2026-10-12 T27R の C3。Critical の字義。実際の害は小さい）

- 現象: ページが `Function.prototype.call` を上書きして標準の getter の結果を偽ると、`method=post`・`_method=DELETE`・ボタン「削除」の form が `GET`・`READ_GET_FORM`・ボタン「検索」・別の送信先の候補になり、READ の確かめで偽の送信先へ GET を送って `MATCHED` になった（CLI の Chromium）。READ の結果の行の数なども同じく偽れる。
- 害の範囲: 送るのは Guard と事前の判定を通る GET だけ（同じ GET はページ自身も送れる）。書き込みは起きない。
- 扱い: isolated world（CDP の `Page.createIsolatedWorld`）で読む案を、調査担当の実験で確かめてから決める。

## DEF-088 発見の分類と READ の事前の判定の抜け（2026-10-12 T27R の M2・M5。Minor）

- GET の form の欄の名前と、READ で送る query の名前と値が、発見の分類の危険な語（日本語を含む）の判定の対象になっていない（`name="削除"` の GET の form が `READ`。日本語の語は Guard の既定の語にないので、READ の事前の判定でも止まらない）。
- 見える（hidden でない）`_method` の欄を持つ GET の form が `READ` になり、`_method=PUT` を送れる。
- 別の言語の語（中国語、ドイツ語）、似た形の文字（キリル文字の е、`İ`）、アイコンだけのボタンは、閉じた一覧の限界（手順書に書く）。
- 修正の設計: 下の「T27R の修正の設計」の 2・3。

## T27R の修正の設計（2026-10-12、設計者）

1. **DEF-086**: 候補は、送信ボタンの文言そのものを持たない。probe が読んだ文言は、Node の側で、分類の閉じた一覧の語のうちその文言に当たるもの（分類の owner `classify.ts` が公開する 1 つの関数で求める。分類の判定と同じ当たり方）だけに変え、文言は捨てる。契約の `submitterText` を `submitterWords`（並べた語の一覧。0 件もありうる）に変え、分類・識別の digest（`CANDIDATE_IDENTITY_DIGEST_FORMAT` の版を上げる）・`discovery.json` のスキーマ・`candidate.schema.json`・画面（語の一覧、0 件なら「分類の語なし」）がそれを使う。`aria-label`・`title` も、語を求めるためだけに読み、持たない。同じ form の中で同じ語の組のボタンが 2 つあるときは、今の `DUPLICATE_IDENTITY_CONFLICT` の扱いに任せる。選択肢の `value` は、READ の定義に要るので今のまま持つ（設計どおり。手順書に、個人情報になりうることを書く）。
2. **DEF-088（語の判定）**: (a) 発見の分類で、GET の form の欄の名前も危険な語の判定の対象に加える（当たれば `NOT_EXECUTABLE`）。(b) READ の実行の前の確かめで、送る query の名前と値に、発見の分類の危険な語の判定（日本語を含む。owner は `classify.ts`）をかけ、当たれば読まずに `READ_BLOCKED_BY_POLICY`（`detail` は新しい閉じた値）。定義の保存のときも同じ判定で拒む（理由のコードを足す）。
3. **DEF-088（`_method`）**: GET の form に、型を問わず `_method`（畳み込みで比べる）の欄があれば `NOT_EXECUTABLE`。
4. **M3**: Gate `discovery-boundary` の (w)（入力の操作を呼ばない）の対象に、page を受け取る `src/worker/discovery-run.ts`・`read-check-run.ts`・`worker-run-session.ts` を加える。
5. **M4**: 設計書 11 章の「READ の送る値が出てよい場所」に、ワーカーから親への `AUTH_STATE`（セッションの切れの URL。管理データに記録される）を加える（ワーカーが送る値を含む URL で切れを知らせるため。秘密の目印は出ない）。
6. **M1（`İ`）**: 現実の経路になる見込みは低い（T27R の判断）。守りを重ねる案（NFKD の後に結合文字を除いた形でも比べる）は、公開監査の除外の比べを変えるので、Task 27 の後に別に判断する（記録だけ）。手順書の「確かめていないこと」に、閉じた一覧の語の限界として書く。
7. **I1・I2**: 手順書を実際に合わせて直す（凍結の前の落ち着きの待ちの間の繰り返しの probe、閉じた一覧の語の限界、メインの world の読み取りの限界（DEF-087 の結論しだい）、ポップアップ（DEF-085 の結論しだい））。T27g の目印の fixture に、ボタンの文字・`aria-label`・`title` に行の目印を置いた形を足す（DEF-086 の修正の前に RED）。
- DEF-084 の状態（2026-10-12）: 修正済み。`audit-job-manager.ts` は、`exit` を受けたら `processExited` の印を付け、`child.connected` なら `disconnect` か `AUDIT_JOB_IPC_DRAIN_WAIT_MS`（3,000 ms）の早い方まで待つ。待つ間は合図の見張り・`readyTimer`・`killTimer` で終わらせず、`STOP` も送らない。待ち終わったら `WORKER_EXITED` を同期で決めてから成果物を読み、記録する。親をふさぐ fork（`tests/helpers/worker-fork.ts`）のテスト 4 つ（公開・認証つき・発見・READ）が修正の前に 3〜4 回とも FAIL、後に 3 回とも PASS。期限のテスト 6 件（偽の子）も前に FAIL、後に PASS。DEF-080 も同じ原因として直った見込み（`other-summary` の形が RED → GREEN）。設計者の確かめ: ジョブのテスト 5 ファイル 93 件 PASS、`audit-job-manager.ts`・`job-records.ts` の改行は CRLF のまま（実装者の Edit ツールで一度 LF に変わり、実装者が戻した）。
- DEF-087 の調査（2026-10-12）: isolated world で読む案が効くことを実機で確かめた。probe と構造の読み取りを、CDP の `Page.getFrameTree` → `Page.createIsolatedWorld`（main frame）→ `Runtime.callFunctionOn`（`returnByValue`）で動かすと、試した 6 種類の偽り（`Function.prototype.call`、`Object.getOwnPropertyDescriptor`、prototype の getter の書き換え、要素の own property、組み込みのメソッドの上書き、Proxy）をすべて防ぎ、読み取りの間にページの JS が走った回数は 0 回（main world では発見 1 回で 912 回）。両方の Chromium で同じ。DOM clobbering は prototype の getter で読めば正しい。open な shadow root も正しい。凍結の前後どちらでも動き、読み込み直しの後の古い world の id は失敗（fail-closed）。大きな画面の probe は main 320 ms → iso 73 ms。listener の取得（`DOMDebugger.getEventListeners`）は objectId の world の listener しか返さないので、今のまま main world の objectId を使う（CDP の読み取りでページの JS は走らない）。
- DEF-087 の修正の設計（2026-10-12、設計者）: 調査の (a) を採る。新しい部品（例 `src/discovery/isolated-read.ts`。送る CDP の命令の閉じた一覧、期限、例外の詳細があれば読めなかったとして扱う、session を切る）を置き、`probe.ts` と `read-executor.ts` の 2 か所の読み取りをそれに移す。`listeners.ts` は main world のまま（理由を説明に書く）。Gate: `src/discovery/` で `page.evaluate` を使わない（入口は isolated world の部品だけ）。受け入れ条件: 調査の再現のテスト 8 件（`forgedCall`・`forgedPrototype`・`forgedShadow` の発見と、構造の読み取りの偽り。両方の Chromium）が修正の前に RED、後に GREEN。今の発見と READ のテストが変わらない。T27R-fix-1 の後に行う（`probe.ts`・`read-executor.ts` が重なるため）。

## DEF-089 ほかにも main world の `page.evaluate` で読む部品がある（2026-10-12 DEF-087 の調査で登録。未確認）

- `src/interaction/discover-candidates.ts`、`src/browser/login-form-submitter.ts`（ログインの form の事前の確かめ）、evidence の収集、`src/crawl/discover-links.ts` も、main world の `page.evaluate` で読む。ページの JS が結果を偽れる型。公開監査の Evidence はページ自身が中身を決めるので、偽れることは安全の問題ではない見込み（推測）。ログインの form の事前の確かめは、偽られても、ログインの段の Origin の制限と送信の窓が要求を止める（T26R の確かめ）が、資格情報を入れる form を取り違える経路になりうるか（推測）は確かめていない。
- 扱い: Task 27 の後に、どれを isolated world へ移すかを判断する（ログインの form の事前の確かめを優先）。
- DEF-085 の調査（2026-10-12）: 原因を実機で特定した。1 つ目のポップアップが route で `FRAME_CLASSIFICATION_FAILED` になり、Guard が Context を無効化して閉じる（`Target.disposeBrowserContext`）。その破棄の途中で始まった 2 つ目のポップアップの最初のナビゲーションには、有効にした `Fetch` が効かず、ネットワークに出る（CLI の `chrome.exe`。headless shell では起きない。内部の理由は推測）。持ち主が閉じるとき（凍結の後を含む）も、初期化の途中のポップアップがあれば届きうる（中継なしの凍結の後の storm で 4/20 回。製品の Interaction は出口の中継があるので 0/15 回、拒否 504 件）。選択肢の実機の比較（各 20 回）: (e5) すべての Guard の Context に出口の中継を付け、close の前に中継を凍結する → 全条件で 0/20、拒否として記録できる。ただし公開監査の通信が中継を通る（監査の結果への影響は未測定）。(e) close の前にページの JS を止めて 200 ms 待つ → 試した全条件で 0/20、通信は変わらない。OOPIF の iframe と凍結の段のポップアップは未検証。(a) PASSIVE の段のポップアップを止めて記録し無効化しない → burst は 0/20、storm で 3〜5/20 届く（単独では不十分）。結果が変わる（ポップアップを開くページが中止されない）。(q) 待つだけ・(c) 初期化のスクリプト・(d) popup blocker・(b) 一時停止を保つ、は効かないか迂回がある。似た経路: `requestSubmit`・`a.click()`・`form.submit()` と `window.open` の組で 8〜17/20 回届く。除外の path（同じ Origin。認証つきの監査の `/logout`）でも 8/20 回届く。
- DEF-086・DEF-088 の状態（2026-10-12）: 修正済み（T27R-fix-1）。`submitterWordsOf`・`DISCOVERY_SUBMITTER_WORDS`（68 語）、識別の digest の版 2、画面は「ボタンの分類の語」（0 件は「分類の語なし」）。GET の form の欄の名前と `_method` の欄は `DESTRUCTIVE`。READ の送る名前と値の危険な語は、保存で `READ_PARAMETER_DANGEROUS_WORD`、実行の前で `PARAMETER_DANGEROUS_WORD`（修正の前は READ の GET が 3 件届き、後は 0 件。両方の Chromium）。I2 の fixture（行のボタンの文字・`aria-label`・`title` の目印）で `discovery-secret-markers` が修正の前に 4 種類の場所で RED、後に GREEN。M3 済み。M4 はテストには加えない（場面で `SESSION_LOST` が起きないため。設計書には加えた）。残り: 欄の名前の英語の語を語の単位で比べる（設計書 11 章の 2026-10-12 の (4)。T27R-fix-2）。
- DEF-085 の扱い（2026-10-12、ユーザーの判断「A 中継を全部に（推奨）」）: すべての Guard の Context に出口の中継を付け、閉じる前に中継を凍結する。実装の前に、公開監査の結果への影響を fixture で測る。
- DEF-087 の状態（2026-10-12）: 修正済み。`src/discovery/isolated-read.ts`（`readInIsolatedWorld`。命令は `Page.getFrameTree`・`Page.createIsolatedWorld`・`Runtime.callFunctionOn` の 3 つ、失敗はすべて読めなかった扱い）と `src/discovery/cdp-session.ts`（session の開け閉め。`listeners.ts` と共通）。probe と構造の読み取りを移した。listener は main world の objectId のまま。Gate `discovery-boundary` の (e)（`src/discovery/` で evaluate を使わない）と (c)（CDP の命令は閉じた一覧だけ）。偽りの 3 画面・構造・ページの JS の回数・古い world の 12 件（両方の Chromium）が修正の前に RED（ページの JS は発見 1 回で 1,779 回）、後に GREEN（0 回）。本番のビルドでも確かめた。大きな画面の probe は main 398〜452 ms → iso 111〜126 ms。設計者の確かめ: 3 ファイル 76 件 PASS。残り: `discover-page.ts`・`read-check-evaluation.ts` の説明の「1 回の `page.evaluate`」が古い（手順書の直しと一緒に直す）。
- DEF-085 の状態（2026-10-12）: 修正済み（fix round 2 まで）。すべての Guard の Context に出口の中継を付け、Guard が閉じる前に中継を凍結する（`GUARD_BYPASS_EGRESS` で記録。中継が閉じた後の要求は届かないが記録は残らない）。Passive とログインの段の中継は `PASS_THROUGH`（上流の失敗を RST・応答なしの切断・途中の破棄で伝える。接続の拒否は `ERR_CONNECTION_RESET` になる。同じ扱いの網の層の失敗）。Interaction は `BAD_GATEWAY` のまま。`localhost` とその下の名前は OS に問い合わせずループバックへ。診断の記録の相手のアドレスは、中継が覚えた上流の相手のアドレス（上限 256、引けなければ null。中継の待ち受けのアドレスは記録しない）。名前解決は Chromium から中継（OS）に移る。`chromium-google-connections` は、Passive の中継が本番の方針で実在の外部へ接続しうる作りだったので、テストの方針（loopback だけ）を渡して直した（直す前には実行していない）。`guard-popup-close-race`（CLI の Chromium で修正の前に burst 11〜13/20・storm 7〜15/40 届いた → 0）。時間の計測値は中継の分だけ遅い（ユーザーの判断で受け入れ）。設計者の確かめ: 7 ファイル 219 件 PASS。残り（別の判断）: Interaction の Context の診断の記録には、今も中継の待ち受けのアドレスが出る。

## DEF-090 `discovery.json` の画面ごとの安全の記録に、監査の段の除外で止めた件数と、中継の拒否の件数が出ない（2026-10-12 T27R2-fix-tests の再現の調べで登録。Minor）

- `discovery.json` の画面ごとの `blockedRequests` は、Ledger の `blockedRequestsByMethod`（読み取り以外の遮断）だけを数える。`AUDIT_EXCLUDED_URL` の遮断（`blockedAuditExclusions`）と、中継の拒否（`blockedInteractionRequests` の `GUARD_BYPASS_EGRESS` など）は出ない。そのため、`discovery-polling-blocked-count` のテスト（C1 の形）は、中継の拒否の数え違いを `discovery.json` からは見つけられない（C1 は DEF-085 の fix round 3 の本物の CLI の `run.json` の確かめで見る）。
- 扱い: 発見の成果物の安全の記録として足りるかを、Task 27 の後に判断する（記録だけ）。手順書の安全の記録の説明に、この範囲を書く。
- DEF-085 の fix round 3（2026-10-12）: C1 は閉じる直前の凍結（`CONTEXT_CLOSE`）の後の中継の拒否を記録しない形で直した（本物の CLI のポーリングのページで `blockedActions.requests` 80 → 0。`egress-close-freeze-run`）。C2 は、指示書の「Node で読み直して寛容にする」ではなく、上流の bytes をそのまま流す作り（`#relayPassThrough`。要求は origin-form にし、`keep-alive`、要求を読む側は `insecureHTTPParser` と `MAX_EGRESS_HTTP_HEADER_BYTES` 256 KiB（Chromium の `kMaxHeaderBufSize`））にした。設計者の判断: 受け入れる（読み直す作りでは同じにできない形が残るため。25 種類と大きな Cookie の 52 件が中継あり・なしで一致、`egress-http-fidelity`）。I2 は Guard の `activateInteractionFreeze` で中継も凍結（`INTERACTION_FROZEN_EGRESS`）。M4 は `localhost.` も OS に問い合わせない。手順 0 の再測定で違うのは時間の値だけ。設計者の確かめ: 5 ファイル 127 件 PASS。

## DEF-091 2 つの Origin へ高い頻度でポーリングするページが、中継の負荷で遅くなり `PARTIAL` になる（2026-10-12 DEF-085 の fix round 3 で発見。Minor）

- 現象: 2 つの Origin へ 5 ms ごとに fetch するページを CLI で監査すると、中継なしは約 6 秒で `COMPLETE`、中継ありは約 10 秒で `PARTIAL`（`COLLECTOR_INCOMPLETE:performance:RESOURCE_LIMIT_REACHED`）。Finding・遮断の件数・違反は同じ。同じ Origin だけ、https だけでは違いなし。
- 原因（推測）: 中継が CLI と同じ Node のプロセスで、毎秒数百の要求と失敗する CONNECT を処理するため CDP のやりとりが遅れる。
- 扱い（2026-10-12 ユーザーの指示「1 つの不具合に時間をかけすぎない」による）: 既知の違いとして手順書に書き、直さない。中継を別のプロセスにする、上流の接続を使い回すなどは、必要になったときに別に判断する。

## DEF-092 1 回だけの失敗（2026-10-12 DEF-085 の fix round 3 の検証で。再現しない）

- `discovery-isolated-read` の「fails by the deadline when the session opens late」が 1 回 FAIL（単独で 3 回 PASS、2 回目の全体で PASS）。DEF-087 の部品の時間の揺らぎの見込み（推測）。
- `page-auditor-site-unavailability` の「records the request, the response, and the end of the Passive load of both viewports for a normal page」が 1 回 FAIL（その後の 12 回で再現せず。記録なし）。中継の keep-alive の上流が閉じた瞬間の Chromium の送り直しで GET の数が合わなくなる可能性（推測）。
- 扱い: 記録だけ（揺らぎの片付けのときにまとめて調べる）。

## DEF-093 全体の検証で、時間の期限に関わるテストが 3 件失敗（2026-10-13 G27 のための `verify:all`。単独で 2 回とも PASS）

- `isolated-interaction` の「does not verify an inert offscreen button whose viewport position changes only by click scrolling」（期待の理由の一覧に `STABILITY_CHECK_DEADLINE` がない）、「keeps verifying the attribute change of a target without a role (Plain open toggle)」（`PERSISTENCE_CHECK_DEADLINE` で `NOT_VERIFIABLE`）、`preflight` の「fails PASSIVE_GUARD within the close deadline when closing the guarded Context does not finish」（5,307 ms。上限 5,300 ms）。
- 3 件とも混雑の下の時間の期限に関わる。`preflight` の 1 件は、DEF-085 で Passive の Context に中継を付け、閉じる処理に中継の凍結と停止が加わったことで、上限に近づいた可能性がある（推測）。
- 扱い: 記録だけ（揺らぎの片付けのときに、中継を付けた後の閉じる処理の時間を測る）。`verify:all` を流し直す。

## DEF-094 シナリオの送る欄に、名前が秘密に見えない password の欄を選べる（2026-10-13 T29 の調査で発見。Task 28 の穴）

- `isSendableField`（`src/discovery/read-check-contracts.ts`）は欄の type を見ず、`scenario-policy.ts` の送る欄の確かめは名前だけで秘密を判定する。そのため、名前が秘密に見えない `type=password` の欄（と `type=file`）が、シナリオの送る欄に入りうる。書き込みは Task 30 からなので、今は値が送られることはない。
- 修正の設計: シナリオの送る欄の確かめで、`type` が `password`・`file` の欄を拒む（理由のコードを足す）。READ の送れる欄でも同じ判定にするかを合わせて確かめる（READ は GET の form なので password は `UNSUPPORTED_READ_TRANSPORT` だが、二重に守る）。CCX-12 が `scenario-policy.ts` を触っているので、その後に小さな修正として行う（T28 の範囲）。

## T29 の調査で分かった Task 28 の残り（2026-10-13）

- `currentFactsIn` は「今の入力の規則の参照」としてシナリオ自身の参照を渡すので、`INPUT_RULES_CHANGED` は今は発火しない（コメントのとおり Task 29 まで）。Task 29 で規則の集まりの最新の版を読むように変える。
- `attachInputRuleReference` に参照を外す口はない。送る欄を変えても規則の参照は引き継がれる（Task 29 で範囲を確かめ直す）。
- DEF-094 の状態（2026-10-13）: 修正済み（シナリオの側）。`src/discovery/candidate-contracts.ts` の `UNSENDABLE_FIELD_TYPES`（`password`・`file`）と `isUnsendableFieldType`、`scenario-policy.ts` の新しい理由 `SCENARIO_FIELD_TYPE_NOT_SENDABLE`（同じ名前の欄のどれかが当たれば拒む）。RED 4 件 → GREEN。画面の文言は T28e に渡した。判断（2026-10-13、設計者）: READ の送れる欄（`isSendableField`）からも `file` の欄を外す（GET の form の file の欄に値を送る定義は意味がなく、止める側に寄せる。password の欄のある GET の form はもともと `UNSUPPORTED_READ_TRANSPORT`）。READ の定義の保存の結果と、画面の欄ごとの `sendable` の表示が変わるので、T28e の後に小さな修正として行う。

## DEF-095 `guard-unload-requests` の experiment 7（CLI の Chromium、Passive）で、止めた証拠が残らない回がある（2026-10-13 G29 の `verify:all`。単独で PASS。T30b の検証でも 1 回）

- 現象: 回の判定で `blockedRequests` が 0 件のため「失敗の回」になる。その回も、サーバに届いた数は 0、読み取りでない要求の数も 0、違反も 0（漏れではない）。画面は `chrome-error://chromewebdata/` で、ページが離れる POST を出す前にエラーの画面に移ったと見られる（推測）。
- 影響: テストの揺らぎだけ（止めた証拠を毎回求める条件が、混雑の下で満たされない）。安全の問題ではない。
- 扱い: 記録だけ（揺らぎの片付けのときに、証拠を「少なくとも 1 回」にする条件へ直すかを判断する。スキルの「競争のある安全のテストの条件」のとおり）。

## DEF-096 書き込みの段の送る中身の照合が、`_method` などの hidden の欄の値を照らさない（2026-10-13 T31 の調査で発見。Task 30 の範囲）

- 現象: `src/safety/write-payload-policy.ts` は passthrough（hidden・readonly）の欄の名前だけを照らす。`_method` を passthrough に入れた期待で、本文の `_method=DELETE` が `ALLOW` になる。`_method` が本文にない場合も `ALLOW`（scratchpad の `t31-investigation\method-override.mjs` で確かめた）。
- 影響: CREATE の候補は `_method` を持てない（分類による）ので、主に UPDATE（Task 31）の穴。ページの JS が送信の前に hidden の `_method` の値を書き換えると、承認と違う method の上書きで送られうる。
- 修正の設計: 照合の期待に「値を照らす passthrough」を足し、`_method` は承認した候補の上書きの値と完全に一致（候補に上書きがなければ本文に `_method` があれば止める）。T30b fix round 1 で直す。
- 状態: 解決（2026-10-13 T30b fix round 1）。照合の期待に `methodOverride`（`PUT`・`PATCH`・null）を足し、項目 (h) `METHOD_OVERRIDE_MISMATCH` で、本文の `_method`（Task 27 の `isMethodOverrideFieldName` の畳み込みで当たる名前）がちょうど 1 つで値が一致すること（上書きがなければ本文にないこと）を照らす。`_method` を名前の一覧に入れた期待は `EXPECTATION_INVALID`。`writeFormFieldListsOf` が `methodOverride` を返す。値の比べは畳み込みだけで、前後の空白は落とさない（より厳しい側）。修正の前は、ページの JS が `DELETE` に書き換えた POST が両方の Chromium で 1/1 届いた。修正の後は届かない（止めた回 21、2 秒待って数え直し）。設計者の確かめ: 3 ファイル 213 件 PASS。保つ欄・状態の hidden の値を照らす広げ方は Task 31（T31c）。

## DEF-097 関係するテストをまとめて流したときに、時間に左右される 2 件が 1 回 FAIL（2026-10-13 T30e の検証。単独と 2 回目は PASS）

- 現象: `control-instance-lock.test.ts` の「stalled holder の引き継ぎで worker を 2 つ動かさない」と、`execution-grant-processes.test.ts` の「2 つの process の発行・消費・確定の競合」が、59 ファイルをまとめて流した 1 回目に FAIL。単独と、まとめた 2 回目（1,378 件）は PASS。
- 影響: 推測では負荷による時間の揺れ。後者は T30e で子が `settleWriteForTest` を使う形に変わった。
- 扱い: 記録だけ（ユーザーの指示: 揺らぎで全体の検証を流し直さない）。G30 の `verify:all` で再び出たら原因を調べる。

## DEF-098 CREATE で、送る欄に選ばなかった見える欄があると、ブラウザが空の値で送るので照合が止める（2026-10-13 T30f の報告の発見事項 6 から設計者がコードで確かめた。Task 30 の範囲）

- 現象: `src/browser/write-form-submitter.ts` の `writeFormFieldListsOf` は、送る欄でない欄のうち hidden・readonly・見えない欄と file の欄だけを照合の期待に入れる。見えていて編集できる text 系の欄（例: 任意の `email`）を送る欄に選ばないと、ブラウザがその欄を空の値で本文に入れ、照合が `UNKNOWN_FIELD` で止める（送らずに `BLOCKED`）。select はブラウザが既定の選択肢の値を送るので同じく止まる。
- 影響: 任意の欄がある CREATE の画面は、すべての見える欄を送る欄に選ばないと実行できない。止める側なので安全の問題ではない。実際の管理画面では多くの CREATE が止まると推測。
- 修正の設計: 照合の期待の作り手で、送る欄でない見える編集できる欄を、text 系は「空の値で送る欄」（送る欄に値 `""`）、checkbox・radio は「送らない欄」（T31c の `absentFieldNames`）、組の checkbox は hidden を名前だけ照らす、として入れる。select（と select-multiple）は既定の値が分からないので、送る欄に選ばなければ実行しない（下書きの確かめで受けない理由と、ワーカーの `SPEC_INVALID`）。T30f fix round 1 で直す。
- 状態: 解決（2026-10-13 T30f fix round 1）。期待の作り手（`write-form-submitter.ts` の `unsubmittedFieldRoleOf`・`writePayloadFieldsOf`）で、選ばなかった text 系の欄は送る欄に値 `""`、組でない checkbox・radio は `absentFieldNames`、組の checkbox を選ばなかったものは hidden の名前を名前だけの一覧に。select・select-multiple・range・color を選ばなければ `SPEC_INVALID`、下書きの確かめで `SCENARIO_CREATE_SELECT_NOT_SENT`（fix round 2 で range・color にもそろえ、名前を変える）。両方の Chromium で、任意の欄のある画面で POST 1 回・`VERIFIED`、JS が選ばなかった欄に値を入れる・チェックする回は届かない。設計者の確かめ: 3 ファイル 66 件 PASS。

## DEF-099 応答の前に接続が切れると、ブラウザが書き込みの POST を自動で送り直し、登録が 2 件になる（2026-10-13 T30h-1 で発見。Task 30 の範囲。安全: Critical 相当）

- 現象: 書き込みの段で、サーバが登録の POST の本文を受けて登録した後、応答を返さずに接続を切ると、Chromium が同じ POST を新しい接続でもう一度送る。サーバに POST が 2 件届き、登録が 2 件できる（間は約 4〜5ms）。両方の Chromium（テストの既定と CLI の起動の設定）と、本物のワーカー（ジョブの管理から）で再現。製品の記録は送信 1 回（`SENT`、`httpStatus: null`、`UNKNOWN`（`NO_RESPONSE`）、予約 `UNKNOWN`）で、2 回目に気付けない。
- 再現: `tests/helpers/write-site-fixture.ts` の形 `connection-drop`、`tests/integration/write-job-g30.test.ts`（今は RED）。
- 原因（推測。未確認）: Chromium の通信の層は、使い回した keep-alive の接続が応答の前に閉じられると、要求を 1 回だけ送り直す。書き込みの画面の GET の接続が POST に使い回される。送り直しは CDP の `Fetch.requestPaused` より下で起き、Guard の照合も送信の報告も 1 回分しか見ない。
- 影響: 承認した 1 件が 2 件の登録になりうる（「二重の登録 0」「上限の超過 0」に反する）。結果は `UNKNOWN` なので成功と偽ってはいない。ログインの段（Task 26 の自動ログインの POST）にも同じ形がありうる（未確認）。
- 直し方: 推測で設計しない。調査（`DEF-099-research-brief.md`）で、中継（egress proxy）での数え・接続を使い回させない形・ほかの手を実機で比べてから決める。
- G30 のテスト: 直すまで厳しい形（POST は 1 件）のまま RED で残す。5xx の予約が `COMMITTED`（応答あり）なのは決まりのとおり。
- 修正の設計（2026-10-13、ユーザーの判断）: 書き込みは「BeakSight が 1 回だけ送る」（Guard が承認の POST を止め、照合した同じ bytes を Node の送り手が中継を通して 1 回だけ送り、`Fetch.fulfillRequest` で返す。http は中継でも 1 回に数える重ねの守り）。自動ログインは送り方を変えず、応答がない回の試しを 2 回と数える。Task 30 の設計書の 11 章の履歴。DEF-099 fix（指示書 `DEF-099-fix-brief.md`）で直す。

## DEF-100 画面の監査の停止のテストで、サイトへの要求の間隔が設定より短い（2026-10-13 T30g の報告。設計者が単独で再現）

- 現象: `apps/local-ui/tests/audit-ui-flows.test.ts` の「停止（PARTIAL）」で、要求 3（`/crawl/index.html`）の前の間隔が 2,423〜2,749ms（期待 2,950ms 以上）。単独で流しても FAIL（設計者の再現: 2,749ms）。
- 影響: 本当に間隔が短くなっているなら、サイトへの負荷の決まり（`crawl.minNavigationIntervalMs`）に反する（ユーザーの決まり: 過負荷を与えない）。テストの測り方の変化（CCX-16 で `audit-ui-flows` を補助に寄せた）の可能性もある。
- いつから: 未確認。最近の変更の候補は CCX-16（テストの補助）、CCX-19（時間の単位の定数）、T30f・DEF-098（`src/worker/`）。
- 扱い: 原因を調べる（読み取りと再現。`DEF-100-research-brief.md`）。

## DEF-101 書き込みの開始が、許可を発行した後・ジョブの行を作る前に拒まれると、予約が `RESERVED` のまま残る（2026-10-13 T30g の報告）

- 現象: `audit-job-manager.ts` の `startWriteCreate` は、許可を先に確かめた後、プロファイル・認証の設定・ターゲット設定の確かめや `JOB_ALREADY_ACTIVE` で拒むと、許可を使わないまま、予約が期限（5 分）まで `RESERVED` で残る。
- 影響: その間、同じシナリオの次の発行が同時実行の上限で拒まれうる。書き込みは起きない（止める側）。画面は発行の前に同じ確かめをして減らしたが、競合は残る。
- 修正の設計: その段の拒否でも `closeWriteWithoutSending`（消費していない許可は無効にして予約を返す）を呼ぶ。T30g fix round 1 で直す。
- 調査の結果（2026-10-13）: 製品の振る舞い。CLI の監査でも、サイトに届く間隔が最短 2,338ms（設定 3,000ms）。pacer は「読み込みの開始」の間隔を守っている（`navigation-pacing` は PASS）が、`page-auditor.ts` は待った後に Context を作って読み込むので、準備の時間の揺れの分だけ届く間隔が短くなる。待つ順は HEAD と同じ。揺れが大きくなったのは `context-factory.ts` の変更（DEF-085 の中継など）によると推測（未確認）。
- 修正の設計（2026-10-13、ユーザーの判断「届く間隔も設定以上にする」）: pacer が、前の読み込みの main frame の文書の要求を実際に送った時刻（Guard が見る。送った時刻の記録を pacer に渡す）から数えて待つ。次の読み込みの開始は「前の開始 + 間隔」と「前に送った時刻 + 間隔」の遅い方以降。待った後の準備は遅らせる方にしか働かないので、届く間隔は設定以上になる。送った時刻が記録されない読み込み（止めた等）は今どおり開始の時刻で数える。書き込みの段（DEF-099 の送り手が送る）も、送り手が送った時刻を渡す。`doc/spec/site-load.md` と画面・結合のテストの確かめ（届く間隔を主に確かめる）を直す。DEF-099 fix の後に、Guard と重ならない順で直す（DEF-100 fix）。
- DEF-101 の状態: 解決（2026-10-13 T30g fix round 1）。`startWriteCreate` が拒んだら `#releaseUnusedGrant`（依頼のシナリオとプロファイルの、消費していない・無効でない・予約 `RESERVED`・ジョブの行がない許可だけを `closeWriteWithoutSending` で返す）。3 つの拒む段で予約が `RELEASED`、次の発行ができる。残る形: 読む・確かめる・締めるが別のトランザクションなので、同じ許可の並ぶ開始が拒まれることがある（止める側。予約は残らない）。
- DEF-097 の追記（2026-10-13 T30h-1b）: `execution-grant-processes` の「累積の上限を超えて予約しない」で `issued` が 6（期待 5）。原因の推測: 2 つの子が回ごとに注入した時刻で動き、片方が先の回に進むと、もう片方の消費していない許可が期限切れと見なされて予約が返り、発行がもう 1 回通る。予約の上限（`RELEASED` を除いた数）は守られているはず（未確認）。直し: 推測を確かめ、テストが予約の数を先に確かめ、時刻の作りを揺れない形にする（DEF-097 fix）。
- DEF-097（`execution-grant-processes` の分）の状態: 解決（2026-10-13 DEF-097 fix）。推測を一時のテストで確かめた（回のずれで遅い子の許可が期限切れで無効、予約は `RELEASED` を除いて 1 件のまま。製品の上限は守られる）。テストは親が 2 つの子の回をそろえる形（`runInLockstep`、子 → 親の `ROUND`）にし、予約の数を先に確かめ、返した予約 0・`COMMITTED` 5 の確かめを足した。10 回続けて PASS。`control-instance-lock` の分は残り（記録だけ）。
- DEF-099 の状態（2026-10-13 DEF-099 fix）: 書き込みは解決。`src/safety/write-submission-sender.ts` の `sendWriteSubmissionOnce`（中継だけにつなぐ、1 回だけ、redirect を追わない、30 秒・16 MiB の上限、Node 同梱と OS の証明書で確かめる、`RESPONDED`・`NOT_WRITTEN`・`NO_RESPONSE`）。Guard は照合した同じ bytes を送り手に渡し、応答を今の Document の応答の段の扱いに通して fulfill。中継は書き込みの段の http の承認の POST を 1 回に限る（`requestBudget`）。Gate `write-stage-boundary` (e)(f)。RED: 接続を切る回で 4 つの組み合わせ（既定・CLI × http・https）すべて POST 2 件。GREEN: すべて 1 件、`write-job-g30` 7/7。設計者の確かめ: typecheck のエラー 0、4 ファイル 97 件 PASS。自動ログインの数え方は未（応答がない回を親が区別できない）。判断: IPC の版 2（未公開）の `automatedLogin` に応答の有無の印を足し、応答がない送信の回は試しの行を 2 行書く（版 4 の表は変えない。2 行目も `submitted: YES`。手順書に書く）。送り手に止める口（`AbortSignal`）を足す。DEF-099 fix round 1。
- DEF-099 の状態（2026-10-13 DEF-099 fix round 1）: 解決。自動ログインは、送った後に応答がなかった回（止めた回を含む）を、試しの行 2 行（2 行目の `job_id` は `-resent-` の印つき）で 2 回と数える。IPC の `responseAfterSubmission`。送り手に `AbortSignal`（Guard が閉じ始めるときに止める。`ABORTED`）。止めた回も 2 回と数える判断は、少なく数えない側として受ける。
- DEF-100 の状態: 解決（2026-10-13 DEF-100 fix）。間隔の起点は、前の開始・main frame の文書の要求を送った時刻・その応答を受けた時刻のうち最も遅い時刻。CLI の監査の最短 3,025ms・3,029ms、結合の最短 3,015ms（Playwright の Chromium）・3,028ms（CLI）、設定 3,000ms。監査の時間は約 2% 長い。設計者の確かめ: `navigation-pacing`・`guard-document-sent`・`navigation-pacer` 60 件と `audit-ui-flows` 3 件 PASS。設計書 3 つ（負荷の制御、web 監査、台帳）の起点の記述を直した。

## DEF-102 ログインの段の読み込みが pacer を通らない（2026-10-13 DEF-100 fix の報告）

- 現象: 自動ログイン（`src/worker/automated-login.ts`、`login-stage-checks.ts`）のログインの画面の GET とログインの POST は、pacer を通らず、送った時刻も記録しない。ログインの段の factory に pacer がない。そのため、ログインの直後の最初の読み込み（発見・READ・書き込み・監査）が、ログインの POST の応答から間隔を空けずに始まりうる（推測。未測定）。
- 影響: サイトに届く間隔が、ログインの前後で設定より短くなりうる（ユーザーの判断「届く間隔も設定以上にする」に反する）。前からある形。
- 修正の設計: ログインの段の factory にも同じ pacer を渡し、Guard の `onMainFrameDocumentSent` で送った時刻を記録する。ログインの段の `page.goto` の前に `beforeNavigation()` を通す。手動のログイン（人が操作する画面）は対象の外。DEF-102 fix で直す。
- DEF-102 の状態: 解決（2026-10-13 DEF-102 fix）。自動ログインの段の factory と、ログインの画面の GET・ログインの POST の前の待ちに、ジョブと同じ pacer を通した（POST の前の待ちは資格情報の復号の前）。AUDIT のジョブは、ワーカーの側でログインの段の pacer で待ってから始める（Run Coordinator が外から pacer を受け取る形は共通化の候補 CC-085）。結合の最短: ログインの GET → POST が 2,411ms・2,400ms、ログインの段の最後 → 次の読み込みが 2,026ms・2,032ms（設定 2,000ms）。許容 `SERVER_ARRIVAL_DELAY_TOLERANCE_MS` を 4 か所で 0 にした。手動のログインの段は対象の外。

## DEF-103 送る直前の確かめ直しが通った後に撤回すると、登録の POST が届いて `VERIFIED` になる（2026-10-13 T30R の C-1。Critical）

- 現象: `src/worker/write-create-run.ts` は、確かめ直しの後に、Context の作成 → pacer の待ち → 書き込みの画面の GET → 入力 → 300ms の待ち → 止める印の確かめ → もう一度 pacer の待ち → 押す、と進む。最後の待ちの後に止める印を確かめない。`revokeScenarioApproval` は管理データを変えるだけで、動いている書き込みのジョブに STOP を送らない。T30R の実験（本物のワーカー）で、確かめ直しの後に撤回すると、撤回の 525ms 後に POST が届き、`VERIFIED`・`COMMITTED`、シナリオは `REVOKED`。既定の間隔 5,000ms では、確かめ直しから押すまで 10 秒を超える窓がある（推測）。
- 影響: 撤回した承認で書き込みが届く（承認の範囲の外の書き込み）。手順書 `approved-create.md` の「撤回のときは、親がジョブも止めます」と食い違う。
- 修正の設計: (1) 確かめ直しを、最後の pacer の待ちと止める印の確かめの後、押す直前に移す（確かめ直しの結果を受けてから押すまでの間に待ちを入れない）。(2) 撤回・シナリオの変更・承認の無効化のときに、親が動いている書き込みのジョブに STOP を送る（画面のサーバの撤回の口からジョブの管理へ）。(3) ワーカーは最後の待ちの後にも止める印を確かめる。(4) G30 のテストに、確かめ直しの後に撤回する回を足す（両方の Chromium）。残る窓（確かめ直しの結果から押すまでの数 ms）は記録する。T30R-fix-1 で直す。

## DEF-104 `authenticated-run` の「exceeds 256 events」（PARTIAL）が、まとめて流したときだけ落ちる（2026-10-14 CCX-22 の報告。DEF-100 fix の報告でも 1 回）

- 現象: 結合のテストをまとめて流すと、`tests/integration/authenticated-run.test.ts` の「exceeds 256 events」が失敗することがある。単独では PASS。pacer を渡さない経路（CLI と同じ）。
- 扱い: 記録だけ（ユーザーの指示: 揺らぎで流し直さない、1 つの不具合に時間をかけすぎない）。G30 の `verify:all` で再び出たら原因を調べる。
- DEF-103 の状態: 解決（2026-10-14 T30R-fix-1）。確かめ直しを最後の pacer の待ちと止める印の確かめの後、押す直前に移した（答えから押すまでに待ち・読み込みなし）。撤回とシナリオの変更で、動いているそのシナリオの書き込みのジョブに STOP（`stopWriteJobsOfScenario`）。ほかの承認を無効にする操作は押す直前の確かめ直しで止まる。G30 に確かめ直しの後の撤回の回を 2 通り（POST 0、`NOT_SENT`・`BLOCKED`・`RELEASED`）。残る窓（答えから POST が届くまで）は 69〜277ms（手順書に記録）。

## DEF-105 `guard-write-stage` の popup の回で、`page.click` が Guard の Context を閉じる処理と競合して「Target closed」になることがある（2026-10-14 T30R-fix-1 の報告。揺らぎ）

- 単独で 4 回 PASS、まとめて流すと 2 回落ちた。届く POST は増えない（止める側）。DEF-1xx の popup の閉じる競合と同じ種類と推測。
- 扱い: 記録だけ（ユーザーの指示）。G30 の `verify:all` で再び出たら原因を調べる。

## DEF-106 ページの JS が約 30ms 後にもう一度送ると、303 の移り先の GET が取り消され、`HTTP_MAIN_FRAME_DELIVERY_FAILED` の違反になる（2026-10-14 T30R-fix-1 の報告）

- 止める側（届く POST は 1、Run は `ABORTED_BY_SAFETY`）。DEF-027 の限界の種類。M-1（遅い応答の間の二重送信）は直したが、この間合いは対象の外。
- 扱い: 記録だけ。実害（サイトへの書き込み）はない。
- DEF-106 の追記（2026-10-14 T30R2 の M-c）: CLI の Chromium で、ページの JS が送信の事象から送信を繰り返すと、止める側の `Fetch.failRequest` が `CDP_FAIL_REQUEST_FAILED` を記録して `ABORTED_BY_SAFETY` になる（DEF-026 の取り消しの証拠が間に合わない）。届く POST は 1。記録だけ。
- DEF-105 の追記（2026-10-14 T30R2）: CLI の Chromium でまとめて流したときに 1 回再現。単独で 2/2 PASS。

## DEF-107 Gate `control-store-boundary` が 1 秒を超える（2026-10-14 CCX-27 の報告）

- 現象: 1,103〜1,444ms（前から）。Gate の速さの要件（1 ファイル 1 秒以内。スキル 6.3）に反する。
- 扱い: T31e（このファイルの (m) を直すかもしれない）の後に、読み込みを 1 回にする・走査を共有するなどで直す（DEF-107 fix）。
- DEF-107 の状態: 解決（2026-10-14 DEF-107 fix）。原因は (o) の `tests/` の全体（430 ファイル）の走査（約 355ms）と、(c)(f)(g)(n) の重い検出。`tests/` は 5 つの口の名前を含むファイルだけを走査し、重い検出に結果の変わらない前置きを足した。ファイルの中の処理は約 1.3 秒 → 約 0.8 秒、まとめての実行で 650〜700ms。34 件 PASS、`tests/architecture` 373 件 PASS。

## DEF-108 状態の語でない hidden・readonly・見えない欄の値を照らさないので、ページの JS が送信の直前に `id`・`_destroy`・readonly の値を変えても書き込みが届く（2026-10-14 T31R の C-1。Critical）

- 現象: 照合の期待で、状態の語に当たらない hidden・readonly・見えない欄は名前だけを照らす。T31R の実験 E6（本物の期待の作り手・Guard・送り手、両方の Chromium）で、hidden の `id` を別のレコードに、`member[_destroy]` を `1` に、readonly の `member_no` を変えた更新の POST が届いた。`lock_version` も同じ（楽観的な排他を外せる）。後の照合で `VERIFIED` にはならないが、書き込みは届く。登録（CREATE）にも同じ形がある（例 `user_id` を別の利用者に）。
- 修正の設計（ユーザーの判断 2026-10-14「更新と登録の両方で値も照らす」）: 秘密に見える名前（CSRF のトークンなど）を除く hidden・readonly・見えない欄の値を、送る前の読み取りで読み、送る中身の照合で前の値と完全に一致することを照らす（値を照らす passthrough）。秘密に見える名前の欄は今どおり名前だけ。読んだ値は記録しない。更新の後の照合では、この欄（`lock_version` など、更新で変わってよい値）は比べない。Task 30 の 10 章の 2 と Task 31 のユーザーの判断 2 の「値を読まない」を、秘密に見えない欄について変える。T31R-fix-1 で直す。
- DEF-108 の状態: 解決（2026-10-14 T31R-fix-1 C-1）。`isValueCheckedPassthrough`（秘密に見えない名前・disabled でない・値が 1 つの欄）を唯一の判定にし、登録は画面の確かめで `readWritePassthroughValues`、更新は前の読み取りで値を読み、`checkedPassthroughFields` で照らす。読んだ値は記録しない。更新の後の照合では比べない。RED: 両方の Chromium で登録 2 形・更新 4 形の書き換えが届いた。GREEN: すべて POST 0。CSRF（秘密に見える名前）の書き換えは届く（限界。手順書）。照合の部品は変えていない。
- DEF-108 の残り（2026-10-14 T31R2 の C-1）: 値を照らす判定の外の形で、ページの JS が値を変えた更新が届く（両方の Chromium）。見えない checkbox（入れ子の `_destroy` をチェック）、見えない select（`owner_id`）、disabled の hidden を有効にして値を入れる（`parent_id`）、秘密に見える名前の一覧に当たる一般の名前（`code`・`key`）。修正の設計（設計者の判断。ユーザーの判断の範囲の中）: (1) 見えない checkbox・radio はチェックの状態と値を読み、チェックしていれば値を照らし、していなければ「送られない」（`absentFieldNames`）。見えない select は選んだ値を照らす（select-multiple は止める）。(2) disabled の欄は「送られない」として扱う（名前だけの一覧に入れない。同じ名前の欄と重なれば止める）。(3) 名前だけで照らす（値を読まない）のは、CSRF などページが読み込みごとに作る値の閉じた一覧の名前（`csrf`・`xsrf`・`authenticity_token`・`_token`・`token`・`nonce`・`__RequestVerificationToken` など。owner は `src/discovery/` の 1 つの判定）だけにする。それ以外の秘密に見える名前（`code`・`key`・`ticket` など）の hidden・readonly・見えない欄がある画面は、登録も更新も実行しない（値を読めず照らせないため。止める側。下書きの確かめと期待の作り手の両方）。T31R2-fix-1 で直す。

## DEF-109 混雑の下で、ブラウザを閉じる処理が期限に間に合わず Run が `PARTIAL` になる（2026-10-15 G31 のための `verify:all`。単独で PASS）

- 現象: `fixture-full-crawl` の 2 件が `UNHANDLED_FAILURE`（`browser-close:Browser close did not finish before its deadline`）で `PARTIAL`。`audit-worker-automated-login-fork` の「失ったセッションで止めた Run を再開すると、もう一度自動でログインする」（CLI の Chromium）も、再開した Run が `PARTIAL`（理由は記録に出ず未確認。同じ原因と推測）。
- 単独の再実行: `fixture-full-crawl` 18/18、自動ログインの 1 件は両方の Chromium で 2/2 PASS。
- 全体の検証は 797 秒の間にテストの時間の合計が 9,655 秒（約 12 倍の並行）で、閉じる処理の期限に近づいたと見られる（推測）。止める側（`PARTIAL`）で、サイトへの書き込みや漏れはない。
- 扱い: 記録だけ（ユーザーの指示: 揺らぎで全体の検証を流し直さない）。揺らぎの片付けのときに、閉じる処理の時間を混雑の下で測る（DEF-093 と合わせて）。

## DEF-110 `egress-close-freeze-run` の Run で、混雑の下で違反が 1 件記録される（2026-10-15 G31 のための `verify:all`。単独で PASS）

- 現象: `run.json` の `safety.invariantViolationCount` が 1（`blockedActions.requests` は 0、`blockedRequestsByMethod` は空で、そこまでの確かめは通った）。違反の種類は全体の検証の出力に出ず、未確認。
- 単独の再実行: 2/2 PASS。
- 影響: 違反は記録された側（止める側）で、記録されない要求が届いたわけではない。ただし種類が分からないので、安全の問題でないとは言い切れない（未確認）。
- 扱い: 記録だけ。再び出たら、テストが `run.json` の違反の一覧を出すようにして種類を確かめる。

## DEF-111 `stale-lock-takeover-processes` の場面 1 で、20 回のうち 3 回、2 つの CLI がどちらも再開しない（2026-10-15 G31 のための `verify:all`。単独で PASS）

- 現象: 古い開始のロックと古い Run のロックがある場面で、4・5・9 回目に両方が終了コード 4。二重の再開（`resumedTwice`）は 0。
- 単独の再実行: PASS。
- 影響: 止める側（どちらも再開しない）。二重の再開はない。混雑の下で、ロックの引き継ぎの待ちが期限を越えたと見られる（推測）。
- 扱い: 記録だけ。
- DEF-110 の調査の結果（2026-10-15 `DEF-110-research`）: 混雑（20 Run と CPU を使う 16 process）で 20 Run のうち 10 Run・8 Run で再現。違反はすべて `GUARDED_CONTEXT_CLOSE_FAILED`（`browserContext.close: Target page, context or browser has been closed`）。経路: 最後のビューポートの Passive の Context の close が 5 秒の期限（`CONTEXT_CLOSE_TIMEOUT_MS`）に間に合わず、`closePassiveContextBeforeDeadline` が待つのをやめて先へ進む（ページに `UNHANDLED_FAILURE: passive-context-close`）→ Run Coordinator の `finally` が Browser を閉じる → 裏で続いていた `context.close()` が reject → Guard の `ensureCloseAttempt` の catch（`passive-request-guard.ts` の `OWNER_CLOSE`）が違反に記録 → Run が `ABORTED_BY_SAFETY`（終了コード 3）。サーバに届いたのは GET だけ（読み取りでない要求 0、届いた数は `run.json` の数を超えない）。**安全の漏れではないが、製品の誤った判定**（混雑や重いページの本番の Run でも、監査を終えた後に偽の `ABORTED_BY_SAFETY` になる）。DEF-109 と同じ根（閉じる処理が混雑の下で 13〜21 秒）。重大度: Important。直し方: DEF-110-fix（Context がもう存在しないことを確かめられたときだけ、閉じたとみなして違反にしない）。
- DEF-110 の状態: 解決（2026-10-15 DEF-110-fix）。Guard の `ensureCloseAttempt` は、close の reject の前にその Context の `close` の事象を見た場合だけ（`isGuardedContextGone`。`contextCloseObserved`。取り付けの最初に聞き始める）、閉じたとみなして違反にしない。文言では判定しない。見ていない reject は今のまま違反（持ち主の close と無効化の close の両方）。新しいテスト `guard-abandoned-context-close.test.ts` は修正の前 10 件中 4 件 FAIL、後は 10 件 PASS（両方の Chromium）。混雑の下の再実行（20 Run、16 process）で違反 0（DEF-110 の経路に入った Run は 4）。設計者の確かめ: 新しいテストと `passive-request-guard` で 323 件 PASS、CLI の Chromium で新しいテスト 10 件 PASS。

## DEF-112 headless shell だけで、close の途中に Browser を閉じると `Target.disposeBrowserContext: Failed to find context` で reject され、その時点では close の事象がまだない（2026-10-15 DEF-110-fix の発見事項）

- 現象: テストの既定の Chromium（headless shell）で、close の途中で Browser を閉じ始めると、40 回中 12 回この形で reject される。reject の時点では Context の `close` の事象がなく Browser もつながっているので、DEF-110 の直しでは確かめられず、違反のまま残る（事象はその後に出る）。
- CLI の Chromium（本番の起動）では 80 回で 0 回。
- 影響: テストの揺らぎの候補（止める側。偽の `ABORTED_BY_SAFETY`）。本番の Run で起きうるかは未確認。
- 扱い: 記録だけ。出たら、reject の後に Context の `close` の事象を短い上限まで待つ形を考える（推測）。

## DEF-113 PASSIVE のポップアップの最初の要求を止めているのが、route の `request.frame()` の失敗（`FRAME_CLASSIFICATION_FAILED`）だけで、明示の方針がない（2026-10-15 T32-research-3 で発見）

- 事実: CDP の横取りが付く前のポップアップの最初の要求は、Playwright の route だけが見る。今は route の中で frame の判定が失敗して無効化される形で止まっている（両方の Chromium で届いた 0）。route を薄くした変種では、読み取りでない要求 6・GET 15・他 Origin の main frame 3 が記録なしで届いた。
- 影響: 今は漏れていない。ただし止める理由が偶然に近く、Playwright の振る舞いが変わると記録なしで届く恐れがある（推測）。
- あわせて: 今のテストは、凍結の段のポップアップの route の分岐を外しても検出しない（出口の中継が覆う）。テストの弱さ。
- 扱い: Task 32 の CC-050 の作業で、明示の方針で止めること（ユーザーに諮る）と、回帰のテストを足す。

## DEF-114 `write-form-submitter.ts` の要素の同一の確かめ（`sameElements`）が main world で動き、ページの JS が偽れる（2026-10-15 T32j-3 の報告。既存の不具合の候補）

- 事実: `write-form-submitter.ts` の 1038 行あたりの `handle.evaluate((a, b) => a === b, other)` は main world で動く。`Object.prototype` に getter を足すと、別の要素を「同じ」と返した（両方の Chromium。単体の実験）。`Object.is` の書き換えでは undefined を返し、止める側になる。
- 影響（推測）: 書き込みの段で、ページの JS が、入力や押す対象の要素の取り違えを「同じ」と見せられる。送る中身は Guard の照合（`write-payload-policy.ts`）が最後に照らすので、承認の外の中身の POST は止まる見込みだが、書き込みの流れの全体では試していない（未確認）。
- 重大度: Important（安全の確かめの 1 つが偽れる）。
- 扱い: Task 32 の T32j-4 で、要素の橋渡しを 1 か所（isolated world で backendNodeId を照らす形）にまとめるときに直す。独立レビュー T32R で、書き込みの流れの全体で確かめる。

## DEF-115 監査の段で Guard が main frame の POST の移動を止めた画面の読み取りが、`PARTIAL`（`DOM_READINESS_FAILED`・`EVALUATION_FAILED`）になることがある（2026-10-15 T32i の報告。1 回だけ）

- 現象: 読み込みの後にフォームを送る画面（`/admin/relogin`）で、Guard が送信を止めた後、その画面の読み取りが完全でないことがあった。ほかの回は `AUDITED`。
- 影響: 止める側（読み取りの欠け）。漏れではない。止められた main frame の移動が評価の文脈を乱すと推測。
- 扱い: 記録だけ。再び出たら原因を調べる。
- DEF-113 の状態: 解決（2026-10-15 T32j-1）。印のない page のナビゲーションを、frame の判定の前に明示の違反 `PASSIVE_GUARD_PAGE_NOT_READY` で止めて Context を無効にする。届いた数は前後とも 0。回帰のテスト `guard-unguarded-popup.test.ts`（route の分岐を外した変種で落ちる）。凍結の段の route のテストの弱さも解消。
- DEF-114 の状態: 解決（2026-10-15 T32j-4 と fix round 1）。書き込みの段の同じ要素の確かめは、main world の `a === b` をやめ、isolated world で読んだ位置の backendNodeId を `backendNodeIdsAtPaths`（`src/discovery/isolated-read.ts`）で照らし、操作は自前の selector engine（`beaksight-element-path`）の Locator で解決し直す形にした（候補の発見は `elementHandleOf`）。`write-form-same-element.test.ts`: 修正の前は取り違えを「同じ」と見た（POST は 0）、後は `FORM_CHANGED`（両方の Chromium 10 件）。書き込みの流れの全体での確かめは T32R で行う。

## DEF-116 `controlled-scroll` の「switches once to the body when the body grows…（R'2 I-1）」が、単独でも 6 回中 2 回落ちる（2026-10-15 T32j-4 fix round 1 の報告。揺らぎ）

- 両方の Chromium。fixture の 150 ms のタイマーと最初の測定の前後の順に左右されると推測。T32j-4 はこのテストの経路を変えていない。
- 扱い: 記録だけ（ユーザーの判断 2）。
- DEF-114 の追記（2026-10-15 T32R の I-1。Important）: 位置で照らす形なので、ページの JS が handle を得てから照らすまでの間に要素を A→B→A と入れ替えると、違う要素を「同じ」とみなす競争の窓が残る（`elementHandleOf` の実験で 300 回中 74・78 回。両方の Chromium）。書き込みの流れの全体では 50 回すべて `FORM_CHANGED`・`INPUT_FAILED` で止まり POST 0・違反 0。ユーザーの判断「直す（調査から）」により、handle そのものの身元を確かめる方式を調べる（2 回で区切る）。

## DEF-117 `write-job-g30` の「no write outside the approval: a candidate changed on the page, and a candidate changed by a later discovery」が全体の検証で 1 回落ちる（2026-10-15 G32 の `verify:all`。単独で PASS）

- 現象: 発見のジョブの結果の期待（`jobKind: 'DISCOVERY'` の一致）が合わなかった。単独の再実行で PASS。
- 扱い: 記録だけ（ユーザーの判断 2）。

## DEF-118 Task 32 の後退 2 種（2026-10-15 G32 の `verify:all` で発見。決まって落ちる）

- `control-store-v5`・`control-store-v6` の移行のテストが、版 10 の `jobs.write_report_check` の列を数に入れていない（T32g）。
- `passive-request-guard` の 2 件が、テストの偽の CDP の session に `detach` がないために落ちる（T32j-4 で `cdp-session.ts` が `session.detach()` を呼ぶようになった）。
- どちらもテストの準備の古さで、製品の振る舞いの誤りではない見込み（推測。直す担当が確かめる）。
- 扱い: DEF-118-fix で直し、単独で流し直して確かめる（全体の検証は流し直さない）。
- DEF-118 の状態: 解決（2026-10-15 DEF-118-fix）。テストの準備だけの古さ（製品の誤りなし）。v5・v6 は `tests/helpers/control-upgrade-rows.ts` で前の版の列の写しを照らす形に、Guard の 2 件は偽の page を `adaptFakePage` で包んだ。単独で 348 件 PASS。
