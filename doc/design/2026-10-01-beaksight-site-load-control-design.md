# BeakSight 監査対象のサイトへの負荷の制御 設計書

作成日: 2026-10-01
状態: ユーザー承認済み（2026-10-01。第1段と第2段の方針、既定値（間隔 5秒、候補 20件））
対象範囲: BeakSight が監査対象のサイトに送る要求の速さと回数に上限を設け、読み込み直しの要求を減らし、その実績を記録する仕組み。

## 1. 目的

### 1.1 起きたこと

2026-10-01 に、Task 21（本来の監査対象のサイトの full audit）を、既定の設定の headless で始めた。実行中に、ユーザーから「サイトに過負荷を与えていないか注意して」と指示があった。設計者が測ったところ、次のとおりだった。

- PC 全体の受信は、20秒の計測で平均毎秒約14MB、最大で毎秒約56MBだった。Run を止めると、毎秒約5KBに下がった。
- 1ページの監査に約40秒かかった。

設計者は約5分で Run を止めた。その後、ユーザーから次の指示を受けた（2026-10-01）。

> 短時間の内に大量リクエストを送信して、監査対象サイトに過負荷を与える設計はNG

### 1.2 原因（コードで確かめた事実）

1ページにつき、次の回数だけページを読み込み直す。どれも新しい Context なので、ブラウザのキャッシュがなく、画像などをすべて取り直す。

| 段階 | 読み込みの回数 | 根拠 |
| --- | --- | --- |
| Passive の監査 | Desktop と Mobile で2回 | `src/orchestration/page-auditor.ts` の `#auditViewport` |
| 幅の走査 | 幅ごとに1回。幅ごとに新しい Context を作る（既定では 320・768・1024 の3回） | `src/evidence/layout-collector.ts:1338-1349` |
| Interaction | Desktop だけで、候補ごとに1回。候補ごとに新しい Context を作る（候補は最大100件） | `src/safety/interaction-policy.ts:22`、`src/orchestration/page-auditor.ts:683`、`src/interaction/isolated-auditor.ts:1160` |
| robots.txt と sitemap.xml | Run の初めに2回 | `src/crawl/site-metadata.ts:436-440` |

- 読み込みと読み込みの間に、待ち時間を置く仕組みがない。並行の数は1だが、前の読み込みが終わるとすぐ次を始める。
- 読み込みのたびに、サイトに埋め込まれた外部のサービス（アクセス解析、広告など）にも要求が送られる。2026-10-01 の Run でも、Chromium から外部のサービスのアドレスへの接続があった。
- 上位の設計書（`2026-08-27-beaksight-web-audit-design.md` 第24章）は、並行の数を1とするだけで、サイトへの負荷の上限を決めていない。

### 1.3 この設計で解決すること

- サイトへのページの読み込みの速さに、BeakSight が守る上限を設ける。既定の設定は、負荷の小さい側に置く。
- 同じページの読み込み直しで取り直す要求を減らす（Run 全体のキャッシュ）。
- 読み込み直しの Context から、外部のサービスへ要求を送らない。
- 1ページの読み込み直しの回数に上限を置き、設計書に明記する。
- 実際にどれだけの要求を送ったかを、Run ごとに記録し、レポートで見られるようにする。

### 1.4 ユーザーの判断（2026-10-01）

- 「負荷を抑える仕組みを先に作る」。その後に Task 21 を再開する。
- 「第2段も先に含める」: Run 全体のキャッシュと、外部のサービスへの要求の扱いも、Task 21 の前に作る（この設計書の 4.6、4.7）。
- ページの読み込みの最小間隔の既定値は 5秒。
- Interaction で監査する候補の、1ページあたりの上限の既定値は 20件。
- 監査が途中で中断した場合に、途中から再開できるようにする。これは別の設計書（`2026-10-01-beaksight-resumable-run-design.md`）で扱う。この設計書の記録（4.5）は、再開の後も引き継ぐ。

## 2. 根拠となる文書と優先順位

- 従う文書: `2026-08-27-beaksight-implementation-tasks.md`、`2026-08-27-beaksight-implementation-plan.md`、`2026-08-27-beaksight-web-audit-design.md`、`2026-09-23-beaksight-task-14-17-pipeline-report-cli-design.md`（4.5.6 幅の走査、4.5.7 期限）、`2026-09-23-beaksight-ui-ssot-design.md`（表示）。
- この設計書が拡張する箇所:
  - 上位の設計書 第24章（Default Browser / Locale Policy）に、サイトへの負荷の方針（この設計書の第3章）を加える。
  - 実装タスク指示 第5章（SSOT Owner Matrix）に、3つの owner を加える（第5章）。
  - Task 14〜17 の設計書 4.5.7 の期限の計算に、待ち時間を期限から除く決まりを加える（4.4）。
- 引き続き守る不変条件:
  - Safety Invariants（Passive Context では GET と HEAD 以外を送らない、など）。この設計は、ネットワークに送る要求を減らすだけで、Guard の許可の判定（`src/safety/request-policy.ts`）を変えない。
  - Passive Context と Isolated Interaction Context の境界。Interaction の候補ごとに新しい Context を作る形は変えない。
  - 凍結（クリックの後の要求をすべて止める）は一方向のまま。凍結の後の要求には、この設計の処理を一切使わない。
  - 完了の正直さ。上限のために確かめなかった部分は、理由付きで PARTIAL にする。
  - Target Isolation。`src/**` に対象の固有の情報を書かない。

## 3. 採用する設計（サイトへの負荷の方針）

### 3.1 方針

1. **ページの読み込みの間隔を空ける。** BeakSight が始めるページの読み込み（トップレベルのナビゲーション）は、Run 全体で、前の読み込みの開始から設定の最小間隔（`crawl.minNavigationIntervalMs`）以上空けてから始める。Passive、幅の走査、Interaction、robots.txt と sitemap.xml、再試行の、すべての読み込みに適用する。
2. **読み込み直しでは、取ったことのあるものを取り直さない。** 主の読み込み（Passive の Desktop と Mobile）で取った画像、スタイルシート、スクリプト、フォントを、Run 全体のキャッシュに入れる。読み込み直しの Context（幅の走査と Interaction）では、キャッシュにあるものはキャッシュから返し、ネットワークに送らない。
3. **読み込み直しの Context からは、外部のサービスに要求を送らない。** 幅の走査と Interaction の Context では、許可 Origin の外への要求（文書の読み込みを除く）は、キャッシュになければ送らない。
4. **1つのページの読み込み直しの回数に上限を置く。** Interaction で監査する候補の数に、1ページあたりの上限（`crawl.maxInteractionsPerPage`）を置く。上限を超えた候補は監査せず、理由付きで PARTIAL にする。
5. **主の読み込みは、ふつうのブラウザと同じにする。** Passive の Desktop と Mobile の読み込みは、利用者が初めてページを開いたときと同じく、すべてネットワークから取る（performance と network の Evidence を正しく集めるため）。1回の読み込みの中の要求は遅らせない。 （2026-10-06 改訂: 4.10 を見よ）: Passive も Run 全体のキャッシュを使い、画像・動画・スクリプト・フォントは同じ起動の中で最初の1回だけ取る（DEF-031。ユーザーの判断）。文書は毎回取る。
6. **待ち時間は、期限を消費しない。** 間隔のために待った時間で、ページの監査が期限切れにならないようにする（4.4）。実行時間の上限（`crawl.maxRuntimeMs`）には、待ち時間も含める。
7. **実績を記録する。** 読み込みの回数、待った時間の合計、許可 Origin とそれ以外への要求の数と1分あたりの最大、キャッシュから返した数、送らなかった数を、`run.json` に記録し、レポートと CLI に示す。

### 3.2 既定値（ユーザーの判断。2026-10-01）

| 設定 | 既定値 | 下限・上限 | 理由 |
| --- | --- | --- | --- |
| `crawl.minNavigationIntervalMs` | 5000（5秒） | 1000 以上。ただし、許可 Origin がループバックのアドレス（`127.0.0.1`、`[::1]`、`localhost`）だけの場合は 0 以上 | ページの読み込みを1分に12回までにする。下限を置き、設定の誤りで短時間に大量の読み込みをしないようにする。ループバックの例外は、ローカルの fixture のテストを遅くしないため（外部のサイトには関係しない） |
| `crawl.maxInteractionsPerPage` | 20 | 1 以上 100 以下（100 は候補の発見の上限 `INTERACTION_CANDIDATE_LIMITS.maxCandidates`） | Interaction の候補ごとの読み込みが、読み込みの回数の大部分を占めるため |

キャッシュの上限（4.6）は、設定にせず、コードの定数とする（利用者が選ぶ必要がないため）。

### 3.3 見込み（既定値の場合）

| 項目 | 2026-10-01 の Run（既定の設定） | この設計 |
| --- | --- | --- |
| ページの読み込みの間隔 | 待ちなし | 5秒以上（1分に12回まで） |
| 1ページの読み込みの回数 | 2 + 3 + 候補の数（最大100） | 最大25（Passive 2、幅の走査 3、Interaction 20） |
| ページ全体を取る読み込み | 上と同じ（すべて） | 2（Passive の Desktop と Mobile）。2026-10-06 改訂（4.10）: Passive も、キャッシュにあるものはキャッシュから返す |
| 読み込み直し（幅の走査、Interaction）で取るもの | ページ全体（画像なども、外部のサービスも） | 文書と、キャッシュにないもの（許可 Origin の中だけ） |
| 1ページの監査の時間 | 約40秒 | 候補が20件なら、少なくとも約125秒 |
| 1時間に監査できるページ | 約90（推定） | 候補が20件のページばかりなら、約29以下（推定） |

受信の量は、ページの重さによる。仮に、ページ全体が 5MB、文書が 0.2MB で、候補が20件なら、1ページで約 15MB を約125秒で受け取るので、毎秒約0.1MBになる（2026-10-01 の計測の約100分の1。推定）。

- この速さでは、既定の `maxPages`（500）は、既定の `maxRuntimeMs`（1時間）の中で終わらない。本来の監査対象のサイトの full audit では、利用者が `maxPages` と `maxRuntimeMs` を明示して選び、途中で中断した場合は再開の機能（別の設計書）で続ける。既定の `maxPages` と `maxRuntimeMs` は、この設計では変えない。

### 3.4 採らなかった案

- **Guard の中で、要求ごとに速さを抑える案**: Guard（安全の境界）の中に待ちを入れると、凍結の切り替えや、Guard の処理の待ち合わせ（`drainGuardTasks`）の期限に影響する。また、1回の読み込みが数十秒に延び、ほとんどのページが期限切れで PARTIAL になる。採らない。
- **Interaction の Context を、候補のあいだで使い回す案**: 候補を実行した後の Context は凍結されていて、凍結を解く操作は安全の設計（凍結は一方向）に反する。採らない。
- **幅の走査を1つの Context にまとめる案**: ブラウザのキャッシュが使えるが、Run 全体のキャッシュ（4.6）で同じ効果が得られる。よく確かめられた幅の走査の構造を変えないため、採らない。
- **キャッシュを、Guard の前に別の route の処理として置く案**: Playwright は、route の処理を登録の逆の順に呼ぶ。Guard より先に登録すれば、Guard の許可の後にだけ呼ばれ、Guard のコードを変えずに済む。しかし、安全が登録の順序という暗黙の決まりに依存し、後から誰かが route を足すと崩れる。Guard の中で、注入した部品を明示して呼ぶ形（4.7）にする。

## 4. 詳細設計

### 4.1 ページの読み込みの間隔（`NavigationPacer`）

- 置き場所: `src/crawl/navigation-pacer.ts`（新設。この意味の owner）。
- Run Coordinator が Run の初めに1つだけ作り、ページの読み込みを始めるすべての部品に渡す。
- 入出力:

```ts
export interface NavigationPacer {
  /**
   * 前の読み込みの開始から `minIntervalMs` 以上たつまで待ち、今回の読み込みの開始を記録する。
   * 待った時間（ミリ秒。0 以上の整数）を返す。呼び出し側は、待った時間を期限から除く（4.4）。
   */
  beforeNavigation(): Promise<number>;
  /** これまでの読み込みの回数、待った時間の合計、最後の読み込みの開始の時刻（4.5 の記録と、再開のための保存に使う）。 */
  snapshot(): {
    readonly navigationCount: number;
    readonly totalWaitMs: number;
    readonly lastNavigationStartedAtMs: number | null;
  };
}

export function createNavigationPacer(options: {
  readonly minIntervalMs: number;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  /**
   * 再開のときに、前の回の記録を引き継ぐ（再開の設計書 4.9）。省略すると 0 から始める。
   * `lastNavigationStartedAtMs` は、前の回の最後の読み込みの開始の時刻（エポックからのミリ秒。なければ null）。
   * 再開の直後の最初の読み込みも、この時刻から最小間隔以上空ける。
   */
  readonly initial?: {
    readonly navigationCount: number;
    readonly totalWaitMs: number;
    readonly lastNavigationStartedAtMs: number | null;
  };
}): NavigationPacer;
```

- 時刻と待ちは注入する（テストで、実際に待たずに確かめるため）。本番では `Date.now` と、`src/core/deadline.ts` の `wait` を使う。
- 1回の呼び出しで待つのは、呼ばれた時刻から数えて `minIntervalMs` までとする（時計が後ろに戻っても、それ以上待たない）。タイマーが早く発火した場合は残りを待ち直すが、`sleep` を呼ぶ回数に上限を置く（時計が進まない場合にも止まる。L2-fix-round-1）。
- 並行の数は1なので、`beforeNavigation()` が重ねて呼ばれることはない。重ねて呼ばれた場合も、呼ばれた順に間隔を守る（内部で直列にする）。
- 呼ぶ場所（ページの読み込みの直前。読み込みの前の Context の作成は、待ちの後でも前でもよい）:

| 段階 | 呼ぶ場所 |
| --- | --- |
| Passive の監査（Desktop と Mobile、再試行を含む） | `page-auditor.ts` の `#auditViewport` の初め。ページの期限（`pageDeadlineAtMs`）を計算する前 |
| 幅の走査 | `collectStressLayout` の、各幅の `page.goto` の前 |
| Interaction | `page-auditor.ts` の `#auditInteractions` の、各候補の期限を計算する前 |
| robots.txt と sitemap.xml | `site-metadata.ts` の、各ファイルの `page.goto` の前 |

- `environment.ts` の `about:blank` の読み込みは、サイトに要求を送らないので、対象にしない。

### 4.2 設定

- `crawl.minNavigationIntervalMs`（0 以上の整数。ミリ秒）と `crawl.maxInteractionsPerPage`（1 以上 100 以下の整数）を加える。既定値と範囲は 3.2 のとおり。
- 置き場所: 型は `src/core/evidence-types.ts` の `EffectiveAuditConfig`、既定値は `src/config/defaults.ts`、検証は `src/config/validate-config.ts`、スキーマは `schemas/run.schema.json` の `effectiveConfig.crawl`。
- 検証:
  - `minNavigationIntervalMs` が整数でない、または負なら誤り。
  - 許可 Origin にループバックでないものが1つでもあり、`minNavigationIntervalMs` が 1000 未満なら誤り。誤りの文は、ほかの設定の誤りと同じく英語の技術的な詳細で示す。
  - ループバックの判定は、許可 Origin の host が `127.0.0.1`、`[::1]`、`localhost` のどれかであることとする。判定は `validate-config.ts` の中に置く（使うのはここだけ）。
  - `maxInteractionsPerPage` が 1 以上 100 以下の整数でなければ誤り。上限の 100 は、`INTERACTION_CANDIDATE_LIMITS.maxCandidates` を参照する（値を書き写さない）。
- テストの共通の補助（`tests/helpers/test-config.ts`）は、`minNavigationIntervalMs` を 0 にする（テストの対象は、すべてループバックの fixture）。CLI を別のプロセスで動かすテストの設定のファイルも、0 を指定する。

### 4.3 Interaction の候補の上限

- `#auditInteractions` の候補の繰り返しで、監査を始めた候補の数が `crawl.maxInteractionsPerPage` に達したら、残りの候補を始めない。
- そのときは、今の途中で止める理由の形（`interactionStoppedReason`）で、新しい理由 `limit` を加え、残りの件数を記録する（`interaction:limit:remaining=<件数>`）。これで、そのビューポートは PARTIAL になる（期限で止めた場合と同じ扱い）。
- 候補の発見（`discoverInteractionCandidates`）と、その上限（100）は変えない。発見した候補の数は、今までどおり Evidence に残る。
- 止める理由を確かめる順序は、違反（`safety`）、上限（`limit`）、予算（`budget`）の順とする。
- 利用者向けの説明は加えない。途中で止めた理由は `COLLECTOR_INCOMPLETE` の `detail`（英数字の技術的な詳細）として記録され、表示面はそれを訳さずに示す（`messages.ts` の冒頭の方針。`budget` などの既存の理由にも、理由ごとの説明はない。L3 の報告。2026-10-01 設計者の判断）。

### 4.4 待ち時間を期限から除く

待った時間は、サイトの応答の遅さではないので、ページの監査の期限を消費させない。次のとおりにする。

- **Passive の監査**: `#auditViewport` の初めに待つ。ページの期限は、待った後の時刻から計算する（今の計算の位置の前に待つだけでよい）。
- **幅の走査**: `collectStressLayout` は、`beforeNavigation()` が返した待ち時間の分だけ、自分の期限を延ばす。`page-auditor.ts` は、走査の前後の `pacer.snapshot().totalWaitMs` の差の分だけ、ページの期限（`pageDeadlineAtMs` と `collectorDeadlineAtMs`）を延ばす。走査の後の段階（配色、accessibility、performance、スクリーンショット、Link、Interaction の候補の発見）は、延ばした期限を使う。
- **Interaction**: 各候補の前に待つ。待った時間の分だけ、段階の期限（`interactionStageDeadlineAtMs`）を延ばす。1件目の候補の開始の時刻（今は候補の発見が終わった時刻）も、待った時間の分だけ後ろにずらす。こうすると、設定の検証を通った設定なら、1件目の候補が予算に収まるという今の性質（4.5.7）が保たれる。
- **robots.txt と sitemap.xml**: 各ファイルの期限は、待った後の時刻から計算する。
- **実行時間の上限**: 待ち時間を含めた実際の時間で判定する（今のまま）。

### 4.5 サイトへの負荷の記録（`run.json` の `load`）

- 置き場所: 記録の部品は `src/crawl/load-meter.ts`（新設。この意味の owner）。
- 要求の数え方:
  - `BrowserContextFactory`（`src/browser/context-factory.ts`）が、作るすべての Context で、要求の終わりの事象（`requestfinished` と `requestfailed`）を `LoadMeter` に渡す。Guard の判定には関わらない（観察だけ）。
  - `BrowserContextFactory` を作るのは PREFLIGHT（`src/orchestration/preflight.ts`）である。Run Coordinator は、meter（と、4.6 のキャッシュ）を作り、PREFLIGHT の引数 `contextFactoryOptions` で渡す。PREFLIGHT は、それをそのまま factory のコンストラクタに渡す（L4 の Blocker 1。2026-10-01 設計者の判断）。
  - ネットワークに送らなかった要求は数えない。次の2つである。
    - Guard またはリソースの届け方（4.7）が止めた要求（`requestfailed` の理由が、`route.abort('blockedbyclient')` で Chromium が報告する理由の閉じた一覧のどれか）。Chromium は、文書の要求では `net::ERR_BLOCKED_BY_CLIENT`、文書以外の要求では `net::ERR_BLOCKED_BY_CLIENT.Inspector` を報告する（L4 の実装者が Playwright 1.62.1 で確かめた）。一覧は `src/browser/playwright-errors.ts` に置き、完全一致で照合する。一覧にない理由の失敗は数える（多めに数える側）。Guard が止めた要求は、今までどおり Safety の記録に残る。
    - キャッシュから返した要求（4.7 が、返す前に `LoadMeter` に印を付ける）。
  - 要求の URL の Origin が許可 Origin に含まれるかで、`allowedOrigins` と `otherOrigins` に分けて数える。Origin の比べ方は、Guard と同じ判定（`src/safety/request-policy.ts` の `hasAllowedOrigin`。今は非公開なので、L5a で export する）を使う。第二の判定を作らない。
  - 1分あたりの最大は、要求の終わりの時刻で、直近60秒の件数の最大とする。
  - ブラウザ自身のキャッシュ（同じ Context の中のメモリーのキャッシュ）から返した要求も、事象が来れば数える場合がある（多めに数える側。未確認。実装者が確かめて報告する）。
  - 制約（RL の Minor-3。推測・未再現）: Guard が CDP の応答の段階で止めた文書（外部スキームへのリダイレクトなど）は、要求がサーバに届いているのに、失敗の理由が `net::ERR_BLOCKED_BY_CLIENT` なので数えない。まれなので、制約として記録する。
  - 制約（RL の確認できなかった点）: ページ自身が始める読み込み（meta refresh、`location.reload` など）は、間隔の対象にも `navigationCount` にも入らない（要求の数には入る）。
- `run.json` に、必須の項目 `load` を加える。

```json
"load": {
  "minNavigationIntervalMs": 5000,
  "maxInteractionsPerPage": 20,
  "navigationCount": 0,
  "pacingWaitMs": 0,
  "requests": {
    "allowedOrigins": { "count": 0, "peakPerMinute": 0 },
    "otherOrigins": { "count": 0, "peakPerMinute": 0 },
    "servedFromCache": 0,
    "withheldOtherOrigins": 0
  }
}
```

- `navigationCount` と `pacingWaitMs` は `NavigationPacer.snapshot()` から、`requests` は `LoadMeter` から取る。
- `navigationCount` は、間隔の判定に使った読み込みの開始の回数である。読み込みの準備の前に待つので、待った後に読み込みを始められなかった場合（Context の作成の失敗、Interaction の予算による停止など）も含む。実際の読み込みの回数より多くなることがあるが、負荷の面では多めに数える側なので、この意味で記録し、表示でもそう説明する（L2 の報告の発見事項1。2026-10-01 設計者の判断）。
- 再開の機能（別の設計書）のため、`LoadMeter` は、記録の状態を JSON にできる値で取り出し、その値から作り直せるようにする（`NavigationPacer` の `initial` と同じ考え方）。1分あたりの最大は、再開の前と後のそれぞれの最大のうち、大きい方とする。
- スキーマの版は上げない（未公開。これまでの変更でも上げていない）。
- 表示（UI 追補設計書に従う）:
  - 表示用モデルに、負荷の記録を1回だけ組み立てる。
  - HTML レポートの要約に「サイトへの負荷」の節を加え、上の値を示す。
  - CLI の結果の表示に、1行を加える（例: `サイトへの負荷: ページの読み込み 120回、許可 Origin への要求 3,400件（1分あたり最大 210件）`）。
  - ChatGPT 用のバンドルの `summary.json` にも、表示用モデルから同じ値を入れる。
  - 文言は `src/presentation/messages.ts` に置く。

### 4.6 Run 全体のリソースのキャッシュ（`ResourceCache`）

- 置き場所: `src/browser/resource-delivery.ts`（新設。4.7 と同じファイル。この意味の owner）。
- Run Coordinator が Run の初めに1つだけ作り、`BrowserContextFactory` に渡す。Run の終わりに捨てる（ファイルには書かない。再開のときは空から始める）。
- 入れるもの（すべての Context の `response` の事象を、factory が渡す。観察だけ）:
  - 要求の method が GET。
  - 要求の種類（`request.resourceType()`）が `stylesheet`、`script`、`image`、`font` のどれか。文書（`document`）、XHR、fetch、media などは入れない。 （2026-10-06 改訂: 4.10 を見よ）: `media` を加えた（`bytes=0-` に全体を返した 206 も、200 として入れる）。
  - 応答の status が 200。要求に `Range` の header がない。応答の `cache-control` に `no-store` がない。
  - 本文（`response.body()`）が 5MB 以下。 （2026-10-06 改訂: 4.10 を見よ）: 1件の上限を 16 MiB にした。
  - キャッシュから返した応答（4.7）は、入れ直さない。
- 持つもの: URL（完全一致の鍵）、status、header（`content-encoding`、`content-length`、`transfer-encoding`、`set-cookie` を除く。本文は展開済みのため）、本文。
- 上限: 合計 256MB。超えたら、最も前に使われたものから捨てる（LRU）。上限の値はコードの定数とする。
- `Vary` の header は考えない（同じ URL なら同じ応答とみなす）。制約として記録する。

### 4.7 リソースの届け方（`ResourceDelivery`）

- 置き場所: `src/browser/resource-delivery.ts`（新設。この意味の owner）。
- Context の役割を2つに分ける。役割は、Context を作るときに factory に渡す。

| 役割 | 使う Context | 届け方 |
| --- | --- | --- |
| 主（`PRIMARY`） | Passive の Desktop と Mobile、robots.txt と sitemap.xml | 2026-10-06 改訂（4.10）: 文書でない GET で、キャッシュにあればキャッシュから返す。なければネットワーク（`WITHHOLD` は選ばない）。応答はキャッシュに入れる |
| 読み込み直し（`REVISIT`） | 幅の走査、Interaction | 下の表のとおり |

- 判断の種類の名前は `NETWORK`、`FROM_RUN_CACHE`、`WITHHOLD` とする。`request-policy.ts` の ALLOW の `delivery`（リダイレクトの確かめ方）と混同しないよう、型の名前には `ResourceDelivery` を付ける。
- 読み込み直しの Context での届け方（Guard が許可（ALLOW）した、文書の読み込みでない要求だけが対象）:

| 要求 | 届け方 |
| --- | --- |
| GET で、4.6 の種類で、キャッシュにある | キャッシュから返す（`route.fulfill`）。ネットワークに送らない |
| 許可 Origin の外で、キャッシュにない | 送らない（`route.abort('blockedbyclient')`） |
| それ以外（許可 Origin の中で、キャッシュにない） | 今のまま（ネットワーク）。応答はキャッシュに入れる |

- 文書の読み込み（ナビゲーションの要求。main frame と iframe の両方）は、どの役割でも、今のままネットワークに送る。サイトの今の状態を見るためである。外部の iframe の文書は1回ずつ読み込まれるが、その中の画像などは、キャッシュになければ送らない。
- Guard の変更（`src/safety/passive-request-guard.ts`）:
  - `PassiveRequestGuardOptions` に、届け方の部品（省略可）を加える。省略した場合は、今のまま（すべてネットワーク）。
  - route の処理の最後（今の `continueNative` の呼び出し。2062 行）で、ナビゲーションの要求でなく、届け方の部品がある場合だけ、部品に届け方を尋ねる。
  - 尋ねるのは、Guard の段階が `PASSIVE_ACTIVE` で、許可の判定が ALLOW の後だけである。凍結の段階、閉じている段階、BLOCK の要求は、今のまま Guard が止める（部品に渡さない）。
  - 「キャッシュから返す」と「送らない」の前に、その要求を `expectedRouteFailures` に登録する（Guard が自分の失敗として扱い、違反にしない）。
  - 送らなかった要求は、Safety の記録（Ledger）には入れない（安全のための遮断ではないため）。`LoadMeter` に数える。
  - 部品が例外を投げた場合は、今のまま（ネットワーク）にする。`route.fulfill` が失敗した場合は、`route.abort('blockedbyclient')` を試みる。どちらの失敗も Guard の外に投げない（Guard の処理の失敗の違反にしないため。安全には関わらない）。
- 安全の性質: 部品が選べるのは「今のままネットワーク」「キャッシュから返す」「送らない」の3つだけで、後の2つはネットワークに何も送らない。したがって、読み込み直しの Context でネットワークに送る要求は、今の要求の部分集合になる。許可の判定と凍結は変わらない。
- 制約（README と設計書に書く）:
  - 読み込み直しの Context では、外部のサービスのスクリプトがキャッシュから動いても、その通信は送られない。外部のサービスが作る部品（チャットのボタンなど）は現れないことがある。Interaction の候補がそうした部品なら、候補が見つからず NOT_VERIFIABLE になる。
  - 幅の走査で、外部の iframe の中身が表示されないことがある。外部の iframe によるはみ出しを見逃すことがある。
  - キャッシュは URL だけで見分ける（`Vary` を考えない）。

### 4.8 実行中の進み具合と負荷の表示（L7）

- 目的: 実行中に、サイトへの負荷が上限の中に収まっていることを、利用者が数字で確かめられるようにする（ユーザーの判断。2026-10-01「headed ＋ 実行中の表示」）。
- Run Coordinator は、ページの監査が1つ終わるたびに（`frontier.markFinished` と Link からの発見の後に）、進み具合の事実を、注入された受け手（省略可能な依存。例: `onProgress`）に渡す。受け手がなければ何もしない。受け手の例外は、Run を止めない（握りつぶし、Run の理由にもしない。表示の失敗で監査を止めないため）。
- 進み具合の事実（型は `src/core/contracts.ts`。値は JSON にできる）:
  - 監査を終えたページの数（この実行と、再開の前の分を含む）、発見したページの数、設定の `maxPages`
  - 経過時間（この実行の開始から。ms）
  - `NavigationPacer.snapshot()` の `navigationCount` と `totalWaitMs`
  - `LoadMeter` の記録（`snapshot()` の値）と、区分ごとの直近60秒の件数（`LoadMeter` に、今の窓の件数を返す関数を加える。数え方は `LoadMeter` だけが持つ）
- CLI は、受け取った事実から、1行を標準出力に出す（開始の行と結果の行と同じ出力）。文言は `src/presentation/messages.ts`、数値の書式は `src/presentation/format.ts` に置く。表示の側で計算しない（直近1分の件数も、事実のものをそのまま示す）。
  - 例: `進み具合: 監査を終えたページ 12件（発見したページ 85件、上限 50件）・ページの読み込み 284回・許可 Origin への要求 1,930件（直近1分 38件、1分あたり最大 61件）・許可 Origin の外 12件・経過 24分10秒`（L7 の実装の文言。「監査を終えたページ」は PARTIAL と FAILED も含む数で、結果の行の「監査したページ」（AUDITED だけ）と区別する。経過時間は、1時間未満では秒まで、1時間以上では秒を省く）
- HTML レポートとバンドルには出さない（実行中だけの表示のため。最後の記録は 4.5 の `load`）。
- headed でも headless でも同じに出す。

### 4.9 ページの先読みを止める（DEF-023。2026-10-02）

- 起きていること: ページに先読みの指定（speculation rules。`<script type="speculationrules">`、`Speculation-Rules` の応答の header）があると、Chromium が、指定のページを先に読み込む（prefetch）か、裏で描画する（prerender）。この要求は、Guard の route も、読み込みの間隔（4.1）も、負荷の記録（4.5）も通らずに、サイトに届く（独立レビュー RR2 の実験。headless shell と通常の Chromium の両方で起きた）。そのため、先読みを使うサイトでは、BeakSight の読み込みの間隔の外で読み込みが増え、記録にも出ない。prerender したページのスクリプトは、Guard の外で動く。
- 方針: CLI の Chromium の起動（`PRODUCTION_RUN_DEPENDENCIES.launchBrowser`）で、Chromium の先読みの機能を、起動の引数で止める。BeakSight は、先読みの結果を監査に使わない（監査するページは、BeakSight が自分で読み込む）ので、止めても監査の結果は変わらない。
- 起動の引数は、`src/browser/` の名前付きの定数の閉じた一覧にし、理由をコメントに書く。どの引数で止まるかは、Chromium の版によって変わりうるので、実装者が、ローカルの fixture のページで実際に確かめて決める。確かめる形:
  - speculation rules の prefetch と prerender（すぐに行う設定）を持つページを開き、一定の時間待つ。先読みの対象のページへの要求が、サーバに1件も届かないこと。
  - 先読みの対象のページは、ほかのどこからも読み込まない（届いたら、先読みによる要求と分かる）。
  - 古い形の先読み（`<link rel="prefetch">`、`<link rel="prerender">`）も同じく確かめる。止まらない場合は、その要求が Guard の route を通ること（Guard に見えていること）を確かめ、報告する。
  - 引数を外すと要求が届く（RED）ことを確かめてから、引数を加えて届かなくなる（GREEN）ことを確かめる。
- Chromium の版が変わって引数が効かなくなった場合に気づけるよう、この確かめを結合テストとして残す（CLI の起動を通す）。
- README の「サイトへの負荷」に、BeakSight が先読みを止めることを書く。
- 結果（DEF-023 の実装。Chromium 151、Playwright 1.62.1。2026-10-02）:
  - 先読みを「止める」feature は見つからなかった（`--disable-features` の `Prerender2`、`SpeculationRules` など、`--disable-blink-features` の候補は、どれも効かなかった）。効いたのは、`--enable-features` の `PrefetchMultipleActiveSetSizeLimitForBase`（同時に行う prefetch の数の上限）を 0 にする設定（speculation rules の prefetch と、prerender の前に行う prefetch が始まらない。hover と pointerdown で始まるものも止まる）と、`NoStatePrefetchHoldback`（`<link rel="prerender">`）。設計者は、この方式を受け入れた。止まる仕組みは推測を含むので、結合テスト（`tests/integration/preloading-disabled.test.ts`）で見張る。
  - Chromium は `--enable-features` が複数あると最後の1つだけを使うので、Playwright が自分で加える既定の値（`CDPScreenshotNewSurface`）を、同じ引数に含めて引き継ぐ。`--disable-features` は使わない（使うと、Playwright の既定の `--disable-features` を上書きする）。Playwright の版が変わって既定が変わったら、同じ結合テストで気づく。
  - `<link rel="prefetch">` は止められない。この要求は Guard の route を通り、許可の判定を受ける（ページの画像などと同じ扱いで、読み込みの間隔の対象ではない）。負荷の記録に数えられることは、R8 で確かめる。
  - `Speculation-Rules` の応答の header による先読みは、確かめていない（ページの中の指定と同じ仕組みで、同じく止まると推測する）。
- ページのアイコン（DEF-024。2026-10-03）: 通常の Chromium の本体（`channel: 'chromium'`）は、headless でもページのアイコンを取りに行く。
  - 既定の `/favicon.ico`（ページにアイコンの指定がない場合）の要求は、Guard の付いた Context では、Playwright 自身が route の手続きを呼ばずに止める（`node_modules/playwright-core` の処理。事象も出さない）。そのため、ふつうはサイトに届かない。ただし、全体の検証で1回だけ、fixture のサーバに届いた（再現しなかった。まれなすり抜けと推測する）。届いた場合も、許可 Origin への GET の1件だけで、負荷の記録には数えられない。
  - ページがアイコンの URL を指定している場合は、その要求は Guard の route を通り、負荷の記録に数えられる。読み込み直しの Context では、許可 Origin の外へは送らない（今の届け方の決まりのとおり）。
  - 起動の引数で止める方法は見つからなかった（Chromium 151。調べた候補は DEF-024 の報告）。CDP の `Network.setBlockedURLs` で止める案は、安全の境界のコードを変える割に、得られるのはまれなすり抜けを防ぐことだけなので、採らない。
  - 設計者の判断: 残る制約として受け入れ、README に書く。fixture の全体の監査のテストは、ブラウザ自身の `/favicon.ico` の GET だけを、「fixture のサイトの外」の確かめから除く（GET と HEAD だけであることの確かめは残す。`tests/integration/site-metadata.test.ts` と同じ扱い）。

### 4.10 Passive の読み込みでも Run 全体のキャッシュを使う（DEF-031。2026-10-06）

#### 4.10.1 起きたこと

- Task 21 の3回目の Run（2026-10-06）で、Passive の読み込み（`PRIMARY`）が、ページごと・ビューポートごとに、同じ画像・動画・スクリプト・フォントをネットワークから取り直していた。保存の31ページ分で約 1.5 GB。同じ URL を1回だけ取れば約 264 MB（約1/6）。大半は、対象のサイトが画像と動画を置く外部のストレージ（許可 Origin の外）からの約 1.1 GB で、運営者の転送量の上限や課金にかかわるおそれがある。
- ふつうの利用者は、同じ画像などをブラウザのキャッシュで使い回すので、同じページを見て回っても、この数分の1しか取らない。

#### 4.10.2 ユーザーの判断（2026-10-06）

- 「Run の中で使い回す」: 画像、動画、スクリプト、フォントは、Run の中で最初の1回だけ取る（ふつうの利用者がサイトを見て回るのと同じ）。2ページ目以降の読み込みの速さの測定は、キャッシュがある状態の値になる。

#### 4.10.3 決めたこと

- **Passive（`PRIMARY`）も、届け方の部品に尋ねる**: factory は、`PRIMARY` の Context の Guard にも、届け方の部品を渡す（役割は `PRIMARY`）。`decideResourceDelivery` は、`PRIMARY` では次のように決める。
  - ナビゲーションの要求（文書）: `NETWORK`（今のまま。サイトの今の状態を見る）。
  - GET で、キャッシュの種類で、キャッシュにある: `FROM_RUN_CACHE`。
  - それ以外: `NETWORK`。`PRIMARY` では `WITHHOLD` を選ばない（許可 Origin の外への、キャッシュにない要求も、ふつうの利用者の初めての読み込みと同じく送る）。
  - `REVISIT` の決め方は変えない。
- **動画と音声もキャッシュに入れる**: キャッシュの種類に `media` を加える。入れる条件は、今の条件（GET、`no-store` でない、本文が1件の上限以下、キャッシュから返したものでない）に加えて、次のどちらか。
  - status が 200 で、要求に `Range` がない（今の条件と同じ）。
  - status が 206 で、要求の `Range` がちょうど `bytes=0-`、応答の `Content-Range` が `bytes 0-(N-1)/N` で、本文の長さが N（ファイルの全体を受けた）。この場合は、status を 200 にし、`Content-Range` を除いて入れる。
  - それ以外の 206（ファイルの一部）は入れない。`media` 以外の種類の 206 も入れない（今のまま）。
- **動画をキャッシュから返すときは、全体を 200 で返す**: 要求に `Range` があっても、ファイルの全体を 200 で返す（HTTP では、サーバが `Range` を無視して全体を返してよい）。ブラウザは再生できる（途中への移動はできなくなるが、監査では使わない）。
- **1件の上限を 5 MiB から 16 MiB にする**（8.4 MB の動画を入れるため）。合計の上限 256 MiB は変えない（LRU で、よく使うものが残る）。
- **読み込みが成功して終わった応答だけを入れる**（2026-10-06 追補。独立レビュー PCR-DR の Important-1）: 本文が途中で切れた応答（`net::ERR_CONTENT_LENGTH_MISMATCH` など）も、Playwright の `response.body()` は途中までの本文で解決する。それを入れると、2ページ目以降の Passive に壊れた応答を返す。そのため、キャッシュに入れるのは、要求が成功して終わった（Playwright の `requestfinished`。`requestfailed` でない）応答だけにする（今の `REVISIT` にもかかわる、前からの隙間）。
- **`media` で、`Range: bytes=0-` に 200 で全体を返した応答も入れる**（同じレビューの Minor-4）: サーバが Range を無視して全体を返した場合である。全体なので、そのまま 200 として入れる。
- **Guard は変えない**: 届け方の部品に尋ねる場所、キャッシュから返す処理（`route.fulfill`）、`expectedRouteFailures` の登録は、`REVISIT` のために作った今の処理をそのまま使う。

#### 4.10.4 安全の性質

- `PRIMARY` で部品が選べるのは「今のままネットワーク」と「キャッシュから返す」の2つだけで、後者はネットワークに何も送らない。したがって、Passive の Context でネットワークに送る要求は、今の要求の部分集合になる。許可の判定、凍結、閉じる段階、違反の判定は変わらない（Guard のコードを変えない）。

#### 4.10.5 代償と制約（README に書く）

- 2ページ目以降（同じ起動の中）の Passive の読み込みの速さ（performance の Evidence）は、キャッシュがある状態の値になる。キャッシュは起動ごとに空から始まるので、起動の最初のページは、キャッシュがない状態の値になる。
- 1つのページのデスクトップとモバイルも、キャッシュを共有する（モバイルは、デスクトップで取った画像などを使う）。
- キャッシュから返した動画は、途中への移動ができない（200 で全体を返すため）。
- キャッシュは URL だけで見分け、有効期限（`max-age`）を考えない（今の制約と同じ。1回の起動の間、同じ URL は同じ内容とみなす）。
- キャッシュから返した応答は、network の Evidence で、ネットワークからの応答と見分けにくい（status、header（元の `date` を含む）、大きさの値が入る。違いは `timing` の `requestStart` などが -1 になることくらい）。Finding の判定は status と失敗だけを使うので、Finding は変わらない。Evidence の大きさを、転送量の根拠として読まない（2026-10-06 追補。同じレビューの Minor-1）。
- Task 21 の3回目の Run は、31ページを今の決まり（キャッシュなし）で監査した。続きから再開すると、32ページ目以降は新しい決まりになる。1つの Run の中で、読み込みの速さの測定の意味が混ざることを、Task 21 の記録に残す。

## 5. SSOTと安全性への影響

| 項目 | owner | この設計での扱い |
| --- | --- | --- |
| ページの読み込みの間隔 | `src/crawl/navigation-pacer.ts` | 新設。Owner Matrix に加える |
| サイトへの負荷の記録 | `src/crawl/load-meter.ts` | 新設。Owner Matrix に加える |
| 許可された要求の届け方（キャッシュ、送らない） | `src/browser/resource-delivery.ts` | 新設。Owner Matrix に加える |
| Effective configuration | `src/config/load-config.ts` | 拡張（2つの設定の項目） |
| Interaction admission | `src/safety/interaction-policy.ts` | 利用のみ（候補の発見の上限を参照する。監査する候補の数の上限は、設定の値として page-auditor が適用する。admission の判定は変えない） |
| Passive HTTP authority | `src/safety/request-policy.ts` | 変更なし（許可の判定は、ここだけが行う） |
| Guard | `src/safety/passive-request-guard.ts` | 変更（許可の後の届け方を、注入された部品に尋ねる。4.7） |
| Final Run status | `src/core/status.ts` | 変更なし（上限で止めた候補は、既存の PARTIAL の理由の形で表す） |
| JSON Schema validation | `src/core/schema-validator.ts` | 利用のみ（`run.schema.json` に `load` と2つの設定を加える） |

- 許可の判定（authority）は、`request-policy.ts` だけが行う。届け方の部品は、許可された要求の届け方を選ぶだけで、許可されていない要求を通すことはない。
- 間隔の計算と待ちは `navigation-pacer.ts` だけが行う。ほかの部品は `beforeNavigation()` を呼ぶだけで、独自に待たない。
- 要求の数え方は `load-meter.ts` だけが持つ。Context の factory は事象を渡すだけで、数えない。
- `src/**` に対象の固有の情報を入れない。既定値と下限、キャッシュの条件は、すべての対象に共通である。

## 6. 共通部品と共通仕様

| 区分 | 名前 | 置き場所 | この設計での扱い |
| --- | --- | --- | --- |
| 利用する既存の部品 | `hasAllowedOrigin`（URL が許可 Origin に含まれるかの判定。Guard と同じもの） | `src/safety/request-policy.ts` | 拡張（export するだけ。中身は変えない） |
| 利用する既存の部品 | `interactionStoppedReason`、`collectorIncompleteReason` | `src/orchestration/page-auditor.ts` | 利用のみ（理由 `limit` を加える） |
| 利用する既存の部品 | 表示用モデル、`messages.ts`、HTML の部品 | UI 追補設計書 第4章 | 拡張 |
| 新しく作る共通部品 | `NavigationPacer` | `src/crawl/navigation-pacer.ts` | 新設。共通部品台帳に追記する |
| 新しく作る共通部品 | `LoadMeter` | `src/crawl/load-meter.ts` | 新設。共通部品台帳に追記する |
| 新しく作る共通部品 | `ResourceCache`、`ResourceDelivery` | `src/browser/resource-delivery.ts` | 新設。共通部品台帳に追記する |

- 後続での利用: 再開の機能（別の設計書）が、`NavigationPacer` と `LoadMeter` の状態を保存して引き継ぐ。
- 変更容易性: 新しく読み込みを行う段階を加えるときは、その段階で `beforeNavigation()` を呼び、Context の役割を選ぶだけでよい。新しい記録の項目を加えるときは、`load-meter.ts`、スキーマ、表示用モデル、`messages.ts` を変える。

## 7. テスト設計

- `NavigationPacer`（単体。時刻と待ちを注入）: 1回目は待たない。間隔より前に呼ぶと、残りの時間だけ待つ。間隔の後に呼ぶと待たない。回数と待った時間の合計が正しい。重ねて呼んでも間隔を守る。`initial` から引き継ぐ。
- 設定（単体）: 既定値（5000 と 20）。`minNavigationIntervalMs` の下限（ループバックだけなら 0 を受け付け、そうでなければ 999 を拒み、1000 を受け付ける）。`maxInteractionsPerPage` の範囲（0 と 101 を拒む）。スキーマの検証。
- 間隔（結合。ローカルの fixture で、短い間隔（例: 200ms）を設定）: すべての読み込みの開始の間隔が、設定以上である。読み込みの開始の時刻は、fixture のサーバが受け取った文書の要求の時刻で確かめる。
- 期限から待ち時間を除く（結合。注入した待ちで、期限より長い待ちを起こす）: 待ちがあっても、Passive、幅の走査、1件目の候補が期限切れにならない。
- Interaction の上限（結合）: 候補が上限より多い fixture で、上限の数だけ監査し、`interaction:limit:remaining=<件数>` の理由で PARTIAL になる。上限以下なら理由は付かない。
- キャッシュと届け方（単体と結合）:
  - 単体: 入れる条件（種類、status、`Range`、`no-store`、大きさ）、LRU の上限、header の除外。届け方の表の3つの場合。
  - 結合（fixture のサーバが受け取った要求を数える）: 主の読み込みで取った画像やスクリプトを、幅の走査と Interaction の Context では、サーバが再び受け取らない。許可 Origin の外（fixture の2つ目の Origin）の画像やスクリプトは、読み込み直しの Context からはサーバに届かない。文書の要求は、すべての読み込みで届く。
  - 安全（結合）: 凍結の後の要求は、キャッシュにあっても、今のまま止められ、Safety の記録に残る。GET 以外の要求は、届け方の部品に渡らない。主の Context では、キャッシュから返さない（performance の Evidence が変わらない）。 （2026-10-06 改訂: 4.10 を見よ）
  - Guard の既存のテストと、Safety Gate（S01〜S10）が、変更の後も PASS する。
- 負荷の記録（結合）: fixture のページで、許可 Origin とそれ以外の要求の数が、サーバの受け取った数と一致する（または、ブラウザのキャッシュの分だけ多い）。キャッシュから返した数と、送らなかった数が正しい。`run.json` の `load` がスキーマに合う。状態の取り出しと作り直しで、同じ記録になる。
- 表示（単体）: HTML、CLI、`summary.json` に、表示用モデルの同じ値が出る。UI Gate が PASS する。
- 既存のテスト: 期限、Interaction、幅の走査、Gate のテストが、変更の後も PASS する。テストを削除・弱体化・skip にしない。

## 8. 対象ファイル

| パス | 責務 | 変更の種類 |
| --- | --- | --- |
| `src/crawl/navigation-pacer.ts` | ページの読み込みの間隔 | 新規 |
| `src/crawl/load-meter.ts` | サイトへの負荷の記録 | 新規 |
| `src/browser/resource-delivery.ts` | Run 全体のキャッシュと、許可された要求の届け方 | 新規 |
| `src/core/evidence-types.ts` | 設定の型、`load` の型 | 変更 |
| `src/config/defaults.ts`、`src/config/validate-config.ts` | 既定値と検証 | 変更 |
| `schemas/run.schema.json` | `effectiveConfig.crawl` の2項目、`load` | 変更 |
| `src/orchestration/run-coordinator.ts` | pacer、meter、cache を作って渡す。`load` を Run の結果に入れる | 変更 |
| `src/orchestration/page-auditor.ts` | 待ちの呼び出し、期限の延長、候補の上限、Context の役割 | 変更 |
| `src/evidence/layout-collector.ts`、`src/orchestration/stress-session.ts` | 幅の走査の待ちと期限の延長、Context の役割 | 変更 |
| `src/interaction/isolated-auditor.ts` または Interaction の session を作る箇所 | Context の役割（`REVISIT`） | 変更 |
| `src/crawl/site-metadata.ts` | 待ちの呼び出し | 変更 |
| `src/browser/context-factory.ts` | Context の役割、事象を meter と cache に渡す、届け方の部品を Guard に渡す | 変更 |
| `src/safety/passive-request-guard.ts` | 許可の後の届け方を部品に尋ねる | 変更 |
| 表示用モデル、`src/report/html-report.ts`、`src/cli/`、`src/report/chatgpt-bundle.ts`、`src/presentation/messages.ts` | 負荷の記録の表示 | 変更 |
| `fixtures/` | 2つ目の Origin の画像とスクリプトを持つページ、候補の多いページ、要求を数えるサーバの機能 | 変更または新規 |
| `tests/helpers/test-config.ts`、CLI のテストの設定 | 間隔を 0 にする | 変更 |
| `README.md` | 設定の表、負荷の方針と制約の説明 | 変更 |
| `doc/design/beaksight-shared-components.md` | 共通部品台帳 | 変更（設計者） |

## 9. 対象外

- **ページをまたいだ Interaction の候補の重複の排除**: ヘッダーやフッターの同じ部品を、ページごとに監査し直さない仕組み。候補の同一性の決め方と、Evidence の形の変更が必要になる。キャッシュで1回の読み込み直しが軽くなるので、今回は行わない。
- **主の読み込みでの、外部のサービスへの要求の扱い**: 主の読み込みは、ふつうの利用者の初めての訪問と同じにするので、外部のサービスへの要求も送る。1ページにつき、Desktop と Mobile の2回分、アクセス解析などに記録が残りうる。
- **1回の読み込みの中の要求の速さの制御**（3.4 のとおり）。
- **受信の量（バイト数）の記録**: Playwright の要求の大きさの取り方を確かめてから、必要になったときに決める。
- **キャッシュのファイルへの保存**: 再開のときは、空から始める（主の読み込みで、すぐに埋まるため）。

## 10. 完了条件

- [ ] 第7章のテストが、RED を確かめた後に PASS する。
- [ ] `npm run verify` が PASS する。
- [ ] `npx vitest run tests/integration/safety-gates.test.ts tests/integration/auditor-gates.test.ts tests/architecture` が PASS する。
- [ ] ローカルの fixture の CLI の Run で、`run.json` の `load` が記録され、読み込みの間隔が設定以上で、読み込み直しの Context から2つ目の Origin に要求が届かない。
- [ ] 独立レビューで、Critical 0件、Important 0件。とくに Guard の変更（4.7）について、安全の性質が保たれることを確かめる。
- [ ] DEF-020 を「対応済み」に更新する。

## 11. 設計変更履歴

| 日付 | 契機 | 変更内容 | 影響範囲 |
| --- | --- | --- | --- |
| 2026-10-01 | 初版（DEF-020、ユーザーの指示「短時間の内に大量リクエストを送信して、監査対象サイトに過負荷を与える設計はNG」） | - | Task 21 |
| 2026-10-01 | ユーザーの判断（第2段も先に含める。間隔 5秒、候補 20件。途中からの再開） | Run 全体のキャッシュと届け方（4.6、4.7）を加えた。幅の走査を1つの Context にまとめる案を取りやめた（3.4）。候補の上限の既定値を 20 にした。再開の設計書との関係（1.4、4.1、4.5）を加えた | Task 21、再開の設計 |
| 2026-10-01 | L2 の報告 | 幅の走査のセッションの作成の期限の上限も、走査の中で待った時間の分だけ延ばす（実装者の判断を承認）。`navigationCount` の意味（始められなかった読み込みを含む）を 4.5 に書いた。pacer の1回の待ちの上限と、待ち直しの回数の上限を 4.1 に加えた（L2-fix-round-1） | L2、L4、L6 |
| 2026-10-01 | Blocker: L4 の報告 | factory を作るのは PREFLIGHT なので、meter とキャッシュは PREFLIGHT の `contextFactoryOptions` で渡す（4.5）。Guard が止めた要求の失敗の理由は、文書以外では `net::ERR_BLOCKED_BY_CLIENT.Inspector` になるので、除く理由を閉じた一覧にし、`src/browser/playwright-errors.ts` に置く（4.5） | L4、L5b |
| 2026-10-01 | L3 の報告 | 止めた理由 `limit` の利用者向けの説明は加えない（`detail` は技術的な詳細として訳さずに示す方針のため）。4.3 を直した | L3 |
| 2026-10-01 | ユーザーの判断（Task 21 を headed で行い、実行中の表示を加える） | 4.8 を加えた（L7） | L7、Task 21 |
| 2026-10-01 | L7 の報告 | 進み具合の行の例を、実装の文言に合わせた（4.8）。待った時間の合計も経過時間の書式で示す | L7 |
| 2026-10-01 | RL の報告 | 4.5 に、数えない要求と間隔の対象外の読み込みの制約を加えた。Owner Matrix（実装タスク指示 第5章）、上位の設計書 24.1、共通部品台帳を更新した（Important-1） | なし |
| 2026-10-02 | DEF-023（再開の機能の独立レビュー RR2 の指摘2） | 4.9 を加えた（ページの先読みを、CLI の Chromium の起動の引数で止める。確かめを結合テストとして残す） | CLI の Chromium の起動、README |
| 2026-10-03 | DEF-024（Task 21 の前の全体の検証） | 4.9 に、ページのアイコンの扱い（既定の `/favicon.ico` は Playwright が止めるが、まれに届く。残る制約として受け入れる）を加えた | README、`fixture-full-crawl.test.ts` |
| 2026-10-06 | DEF-031（Task 21 の3回目の Run で、Passive が同じ画像・動画を取り直し、外部のストレージから約 1.1 GB 取った）とユーザーの判断「Run の中で使い回す」 | 4.10 を加えた（Passive も Run 全体のキャッシュを使う。`media` を入れる。1件の上限 16 MiB。Guard は変えない） | `resource-delivery.ts`、`context-factory.ts`、README、Task 21 |
| 2026-10-06 | PC1 の実装者の発見（4.10 と食い違う古い記述） | 3.1 の5、3.3 の表、4.6、4.7 の表、7章に、4.10 の改訂の注を加えた | なし（記述） |
| 2026-10-06 | 独立レビュー PCR-DR（Important 1、Minor 4） | 4.10.3 に「読み込みが成功して終わった応答だけを入れる」と「`media` の `bytes=0-` に 200 で全体を返した応答も入れる」を加えた。4.10.5 に、キャッシュから返した応答の Evidence の見え方を加えた | `context-factory.ts`、`resource-delivery.ts`、README |
