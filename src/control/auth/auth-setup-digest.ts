// 承認に縛る認証の設定の digest の唯一の owner（Task 28 の設計書 3 章の「承認を縛るもの」、10 章の 1。T28c）。純粋な関数。
// - 入力: 保存した認証の設定（版 3 の文書。`StoredAuthSetup` の `setup`）と、資格情報の事実（自動ログインのプロファイルだけ。ほかは null）。
//   資格情報の事実は、資格情報のファイルの版（`credentialRevision`。ないときは null）と、管理データの `credential_events` の、そのプロファイルの
//   資格情報の変更（登録・変更・削除）の最後の出来事の id（ないときは null）。T28R-fix-1（独立レビュー T28R の I-1）: 版は削除の後の登録で 1 に戻る
//   ので、削除をまたいで必ず変わる出来事の id を入れる（削除して別の値で登録し直すと、digest が変わり再承認になる）。保存の時刻・鮮度・今の
//   プロファイルの改訂は入れない（時刻だけの変化では値が変わらない。プロファイルの改訂は承認が別に縛る）。
// - 値: 文書の形の印（`AUTH_SETUP_DIGEST_FORMAT`。I-1 で版 2 に上げた）、文書（鍵を UTF-16 のコード単位の順に並べた JSON。配列の順は変えない）、
//   資格情報の版、最後の出来事の id を並べた JSON の `createSha256Fingerprint`（`sha256:<16進64桁>`。T28a の契約 `ApprovalBoundFacts.authSetupDigest`
//   の形）。設定がなければ null。
// - 資格情報の値は入れない: 認証の設定の文書は資格情報の値を持たない（設計書 4.7）。資格情報の事実は、版と出来事の id の 2 つの項目だけを写す（余分な
//   項目は入れない）。文書の形（版 3 のスキーマ `AUTH_SETUP_SCHEMA_NAME`。項目の過不足を許さない）に合わない値は `RangeError`（黙って落とさない）。
//   LG-3b: 版 1・版 2 の文書の digest は求めない（形の誤り）。版 3 の文書の digest は、版 1・版 2 を捨てる前と同じ値（テストで固定する）。
// - 管理データ・ファイル・資格情報のファイルを読まない（求めるのは `src/control/approval-external-facts.ts`）。
import { createSha256Fingerprint } from '../../core/ids.js';
import { sortedKeysJsonOf } from '../../core/sorted-keys-json.js';
import { validateControlDocument } from '../control-schema-validator.js';
import { AUTH_SETUP_SCHEMA_NAME, type AuthSetup } from './auth-setup-contracts.js';

/** 認証の設定の digest の入力の形の印（版つき。T28R-fix-1 で、資格情報の最後の出来事の id を足して版 2 に上げた）。 */
export const AUTH_SETUP_DIGEST_FORMAT = 'beaksight-auth-setup-digest/2';

/** 資格情報の版の最小（資格情報のファイルの `credentialRevision` は 1 から）。 */
const MIN_CREDENTIAL_REVISION = 1;

/** 出来事の id の最小（SQLite の行の id は 1 から）。 */
const MIN_CREDENTIAL_EVENT_ID = 1;

/** 承認に縛る資格情報の事実（値は持たない）。 */
export interface AuthSetupCredentialFacts {
  /** 資格情報のファイルの版（ないときは null）。 */
  readonly credentialRevision: number | null;
  /** 資格情報の変更（登録・変更・削除）の最後の出来事の id（`credential_events`。ないときは null）。削除をまたいで必ず増える。 */
  readonly lastCredentialEventId: number | null;
}

// 鍵を UTF-16 のコード単位の順に並べた JSON は、`src/core/sorted-keys-json.ts` の `sortedKeysJsonOf` に移した（CC-078。CCX-12）。

/** null か、最小以上の安全な整数か。 */
const isOptionalIdentifier = (value: number | null, minimum: number): boolean => value === null || (Number.isSafeInteger(value) && value >= minimum);

/**
 * 承認に縛る認証の設定の digest（設定がなければ null）。文書の形が違う、資格情報の版か出来事の id が 1 以上の整数でも null でもなければ
 * `RangeError`（呼び出し側の誤り）。資格情報の事実が null（自動ログインでないプロファイル）なら、資格情報は縛らない。
 */
export const authSetupDigestOf = (
  stored: { readonly setup: AuthSetup } | null,
  credential: AuthSetupCredentialFacts | null,
): string | null => {
  const facts = credential === null
    ? null
    : [credential.credentialRevision, credential.lastCredentialEventId] as const;
  if (facts !== null && (!isOptionalIdentifier(facts[0], MIN_CREDENTIAL_REVISION) || !isOptionalIdentifier(facts[1], MIN_CREDENTIAL_EVENT_ID))) {
    throw new RangeError('the credential revision and the last credential event id must be null or integers of at least 1');
  }
  if (stored === null) {
    return null;
  }
  // 版 3 のスキーマで確かめる（LG-3b: 前の版の文書は形の誤り）。
  const shape = validateControlDocument(AUTH_SETUP_SCHEMA_NAME, stored.setup);
  if (!shape.ok) {
    throw new RangeError(`the auth setup does not match the contract: ${shape.errors.join('; ')}`);
  }
  // 外側の配列の順は変えない（並べるのはオブジェクトの鍵だけ。形の印と資格情報の事実は、鍵を持たない配列）。
  return createSha256Fingerprint(sortedKeysJsonOf([AUTH_SETUP_DIGEST_FORMAT, stored.setup, facts]));
};
