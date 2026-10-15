// 資格情報を保存できるプラットフォームの値の唯一の owner（Task 26 の設計書 4.1、4.7。CCX-5、台帳の CC-065）。
// - 資格情報のファイルの部品（`credential-store.ts`）、暗号化の部品（`dpapi-protector.ts`）、画面のサーバ（`apps/local-ui/src/server/
//   credential-runtime.ts`）が、この値と `process.platform`（または渡された値）を比べる。ここは値を持つだけで、`process` を読まない。
// - この値を、ほかのファイルで `'win32'` と書かない（`tests/architecture/credential-boundary.test.ts` の (x)。意味の違う除外は理由つき）。

/** 資格情報を保存できる環境（`process.platform` の値。Windows の DPAPI を使うので、Windows だけ）。 */
export const CREDENTIAL_PLATFORM = 'win32';
