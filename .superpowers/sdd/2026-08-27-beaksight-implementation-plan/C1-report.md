# C1 実装報告（要約。設計者が保存）

## 結論

完了。R1・R2・R5・R7・R8・R9 と、追加の指示を修正した。担当範囲の6ファイル・143件が PASS した。

## 主な変更

- `AuditConfig` に `target: { id }` を加えた。既定値の型は `AuditConfigDefaults` とした。
- `target.id` の一意性の確認は、`config/targets/` 配下だけで行う。`--config` にほかの場所のファイルを指定した場合は、そのファイルだけを読む。
- 確定した設定は、複製してから凍結する。
- `startUrl` と `allowedOrigins` に認証情報が含まれる場合は、拒否する。`maxPages` と `maxDepth` は、正の整数だけを受け付ける。
- `normalize-url.ts` に、`CREDENTIALS_NOT_ALLOWED`、`hasUrlCredentials`、`redactUrlCredentials` を追加した。
- `discoverLinks()` の `policy` を必須にした。`rawHref` の認証情報は伏せ字にする。
- fixture サーバのカウンタに `options` と `other` を加え、GET と HEAD 以外のメソッドをすべて数える。
- テストは、一時ディレクトリにビルドする（`tests/helpers/temporary-build.ts`）。`dist/` を書き換えない。
- 仕様違反を固定していた既存のテストを、正しい振る舞いを確かめる形に直した（R2、R8、R7）。

## 発見事項と、設計者の判断

1. `tests/helpers/test-config.ts` に、`target` を追加した。→ 承認する。型を必須にしたことに伴い、避けられない変更である。
2. `target` に `id` 以外の項目があると、設定エラーになる。→ 許容する。`local/targets/` の実運用の設定は `target.id` だけを持っていることを確認済み。
3. `admission-policy.ts:22` に、認証情報の判定が重複している。伏せ字の文字列 `'[REDACTED]'` も、共通の定数になっていない。→ F04 で整理する。
4. `normalize-url.test.ts` の「crawl admission policy と同じ Origin を許可する」テストは、同じ関数どうしを比べており、必ず PASS する。→ F04 で整理する。
5. 共通部品台帳への登録。→ 設計者が行う。
6. fixture サーバが、解析エラーに一律 400 を返すようになった。→ 影響は fixture だけなので、許容する。
