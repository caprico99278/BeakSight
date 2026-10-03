# F07 指示書: 再レビュー R3 の Minor の修正（型・スキーマ・設定・Link）

最初に `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/implementer-common-rules.md` を読み、そのルールに従ってください。

## サブタスク

- ID: F07
- 目的: 基盤修正の後の再レビュー R3 で見つかった Minor を直す。とくに、Task 14 に進む前に、ページの identity と型の曖昧さをなくす。
- レビューの結果: 作業記録置き場の `R3-review-result.md`

同時に、ほかの実装者が F06（`src/interaction/isolated-auditor.ts`、`src/interaction/discover-candidates.ts`、`src/evidence/interaction-collector.ts`、`tests/integration/isolated-interaction.test.ts`）を修正しています。これらのファイルは変更しないでください。

## 変更してよいファイル

- `src/config/validate-config.ts`
- `src/core/contracts.ts`、`src/core/evidence-types.ts`
- `src/crawl/normalize-url.ts`、`src/crawl/admission-policy.ts`、`src/crawl/discover-links.ts`
- `schemas/*.json`
- `src/core/limits.ts`（Link の上限を置く場合）
- テスト: `tests/unit/config.test.ts`、`tests/unit/core-contracts.test.ts`、`tests/unit/schema-validator.test.ts`、`tests/unit/normalize-url.test.ts`、`tests/unit/admission-policy.test.ts`、`tests/component/discover-links.test.ts`

## 修正する内容

1. **M1**
   - ビューポートの幅と高さ、`stressWidths` の各値、`interactionTimeoutMs` について、設定の検証を、正の整数だけを受け付けるように直す。
   - スキーマ（`run.schema.json` の `viewportSize`・`stressWidths` など）も `integer` にする。
   - 小数の設定が拒否されることを、テストで確かめる。修正前に RED、修正後に GREEN になること。
2. **M3**
   - `classifyUrl` の結果の `rawUrl` の認証情報を、`redactUrlCredentials` で伏せ字にする。
3. **M4**
   - Link の Evidence に上限を設ける。対象は、件数、`anchorText`、`title`、`rawHref` の長さ。
   - 上限を超えて切り捨てた場合は、件数か印を記録する。
   - 上限値は、collector に固有の値なので `discover-links.ts` に置く。URL の長さは、`src/core/limits.ts` の `MAX_URL_LENGTH` を使う。
   - 型とスキーマも、あわせて直す。
4. **M5（Task 14 の前に決める型）**
   - `ViewportAuditResult` に、ビューポートごとに次の3つを持たせる。
     - `requestedUrl`（要求した正規化済みのURL）
     - `finalUrl`（リダイレクトの後の最終URL。観測できなかった場合は null）
     - `httpStatus`（メインフレームの応答のステータス。観測できなかった場合は null）
   - `PageAuditResult.pageUrl` は、「クロールのキューで使う、要求した正規化済みのURL」とする。このことを型の説明に明記する。
   - `EvidenceRecordFor.viewport` と `Finding.viewport` を、`ViewportProfile` 型にする。
     - ビューポートによらない Evidence と Finding（例: Cross-page）は、null を許す。null になる場合を型の説明に書く。
   - 正規化と受け入れ判定の理由（`evidence-types.ts:174, 181` 付近、`normalize-url.ts:55, 59`、`admission-policy.ts:21`）を、閉じた union 型の理由コードにする。
     - 例: `'INVALID_URL' | 'CREDENTIALS_NOT_ALLOWED' | 'UNSUPPORTED_SCHEME' | ...`
     - 小文字の文の理由（`'invalid URL'` など）は、コードに置き換える。
   - スキーマもあわせて直す。
5. **M6**
   - `RunSummary` の `safety.blockedActions` の型の説明に、次の2点を書く。
     - 件数は、記録の上限があるため、下限であること。
     - 記録そのものは、ページの Safety の Evidence（Task 14 で加える）が持つこと。
6. **M7**
   - `tests/unit/schema-validator.test.ts:1087` 付近の古いコメント（axe が Context を無効にする）を、DEF-001 の修正後の内容に直す。

## 受け入れ条件

- 各項目で、振る舞いを変える修正は、修正前に RED、修正後に GREEN になる。型だけの修正は、typecheck で確かめる。
- `npm run typecheck` と、変更したファイルに関係するテストが PASS する。
- 型とスキーマが一致している（既存の、定数とスキーマの一致を確かめるテストと、見本のテストが PASS する）。

## 報告

共通ルールの形式で報告してください。M5 で決まった型の形を一覧にしてください（Task 14 の実装者が使います）。
