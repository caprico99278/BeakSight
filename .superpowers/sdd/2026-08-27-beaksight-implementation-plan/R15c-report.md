# R15c 実装報告（要約。設計者が保存）

## 結論

完了した。担当のテスト23件と `npm run typecheck` は PASS した。verify は、並行作業のため実行していない。

## R15d が使うシグネチャ

```ts
createRunIdFromTime(date: Date): RunId   // UTC の RUN-YYYYMMDDHHmmss。書式は createRunId を使う
PREFLIGHT_CHECKS = ['OUTPUT_DIRECTORY', 'SCHEMA', 'START_URL', 'BROWSER_LAUNCH', 'PASSIVE_GUARD']
type BrowserLauncher = (options: { headless: boolean }) => Promise<Browser>
runPreflight({ config, launchBrowser, createSafetyLedger, outputDirectory }): Promise<
  | { ok: true; browser; factory; safetyLedgers }
  | { ok: false; failedCheck; message; reason /* PREFLIGHT_FAILED */; safetyLedgers }>
collectRunEnvironment({ config, browser | null, factory | null, onSafetyLedger }): Promise<RunEnvironment>
readToolVersion(): Promise<string>
```

- 成功の場合、Browser は閉じない。閉じるのは、R15d の役目である。
- 失敗の場合は、起動した Chromium を閉じる。どの失敗でも、fixture のサーバにリクエストは届かない。
- `about:blank` は、Guard に遮断されない。

## 実装者の判断と、設計者の判断

1. `createRunId` を、そのまま使った。4桁の年でない時刻は、RangeError にする。→ 承認する。
2. Guard の確認に使った Context の Ledger を、結果の `safetyLedgers` として返す。→ 承認する（設計書 5.6.5）。
3. `collectRunEnvironment` に、`onSafetyLedger` を加えた。→ 承認する。
4. `browser` と `factory` を null にできる。→ 承認する。PREFLIGHT が失敗した Run でも、環境の事実を書ける。
5. スキーマの確認に、`validateArtifact('run', null)` を使う。→ 承認する。
6. PREFLIGHT では、設定を検証し直さない。→ 承認する。
7. `about:blank` の期限に、`navigationTimeoutMs` を使う。→ 承認する。

## 発見事項と、設計者の判断

- Desktop と Mobile の設定の対応づけが、2か所にある。1つは `page-auditor.ts` の `viewportSizeOf`（公開されていない）、もう1つは `environment.ts` である。
  - 判断: CC-020 として登録する。R15d で、共通部品として1か所にまとめ、3か所（Page Auditor、環境の事実、Run Coordinator）から使う。
