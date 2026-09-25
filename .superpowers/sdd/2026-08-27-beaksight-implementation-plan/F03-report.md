# F03 実装報告（要約。設計者が保存）

## 結論

完了。`tests/helpers/` に4つのテスト補助を作り、12個のテストファイルの準備処理と後片付けを、それを使う形に置き換えた。

- 作ったテスト補助: `test-config.ts`（`createTestConfig`）、`chromium.ts`（`useHeadlessChromium`）、`passive-cleanup.ts`（`closePassiveResources`）、`deferred.ts`（`createDeferred`）
- テストは、置き換えの前後とも33ファイル・605件が PASS した。各ファイルのテスト名の集合も一致した。
- 置き換えの前後で、7ファイルの設定の生成が同じ結果になることを、`toStrictEqual` で確かめた。
- typecheck が PASS した。`expect` の内容は変えていない。

## 置き換えなかったもの

次のものは、振る舞いが違うため置き換えなかった。

- discover-links の、テストごとのブラウザの起動
- contexts の一覧を閉じる afterEach
- 監視用の setTimeout
- `wait` そのものを検証するテスト

## 注意点

- `tests/integration/isolated-interaction.test.ts` の設定は、既定値に連動するようになった。
- 後片付けの順序は、フックを登録する順序（`sequence.hooks: 'stack'`）で保っている。
