// 資格情報のフォルダの起動のときの準備の唯一の owner（Task 26 の設計書 4.1 の「起動のとき」。T26e、CCX-5、台帳の CC-065）。
// - 書きかけの一時のファイルを消し（`removeTemporaryFiles`）、その後に暗号化の往復を 1 回確かめる（`checkProtection`）。
// - `npm run setup:local`（`src/control/setup-local.ts`）と画面のサーバ（`apps/local-ui/src/server/credential-runtime.ts`）が、この関数を使う
//   （手順を複製しない）。結果の表示は、それぞれの呼び出し側が行う。値は扱わない。
import type { CredentialProtectionState, CredentialStore } from './credential-store.js';

/** 資格情報のフォルダの準備の結果（値を持たない）。 */
export interface CredentialStoragePreparation {
  /** 暗号化の往復の確かめの結果。 */
  readonly protection: CredentialProtectionState;
  /** 消した一時のファイルの数（フォルダを読めず、片付けられなかったときは `null`）。 */
  readonly removedTemporaryFiles: number | null;
}

/**
 * 資格情報のフォルダの準備（Task 26 の設計書 4.1 の「起動のとき」）: 書きかけの一時のファイルを消し、暗号化の往復を 1 回確かめる。例外を投げない
 * （準備の失敗は、結果の値で返す）。
 */
export const prepareCredentialStorage = async (
  store: Pick<CredentialStore, 'removeTemporaryFiles' | 'checkProtection'>,
): Promise<CredentialStoragePreparation> => {
  let removedTemporaryFiles: number | null;
  try {
    removedTemporaryFiles = await store.removeTemporaryFiles();
  } catch {
    removedTemporaryFiles = null;
  }
  const protection = await store.checkProtection();
  return Object.freeze({ protection, removedTemporaryFiles });
};
