// 認証済みの状態の形（Playwright の `storageState` と同じ形。PRE42-CC 組 S3、台帳の CC-060 の B）。純粋な定義だけのファイル（import を持たない）。
// - Context の作り手（`src/browser/context-factory.ts`）と、認証の状態の絞り込みの owner（`src/control/auth/authenticated-state.ts`）が、ここの 1 つの形を
//   読む（監査の本体は `src/control/` を読めず、`src/control/` は Playwright を読まないため、どちらにも依らない core に置く。Gate
//   `tests/architecture/authenticated-storage-state-ownership.test.ts`）。
// - 形の型と `SameSite` の値の一覧だけを置く。値の検証、絞り込み、Context への渡し方は、それぞれの owner のまま。
// - Cookie の `partitionKey` は、ここに置かない（今は絞り込みの owner だけが写し、Context の作り手は写さない。扱いは CC-060 の C で決める）。
// - 秘密（Cookie と localStorage の値、IndexedDB の中身）を含むので、値をログ、誤りの文、成果物、Evidence、保存に入れない（Task 25 の設計書 4.6）。

/** Cookie の `SameSite` の値（Playwright の `storageState` の形）。 */
export const AUTHENTICATED_STATE_SAME_SITE_VALUES = Object.freeze(['Strict', 'Lax', 'None'] as const);
export type AuthenticatedStateSameSite = (typeof AUTHENTICATED_STATE_SAME_SITE_VALUES)[number];

/** Cookie 1 つ（Playwright の `storageState` の `cookies` の項目と同じ形。`partitionKey` は持たない）。 */
export interface AuthenticatedStorageCookie {
  readonly name: string;
  readonly value: string;
  readonly domain: string;
  readonly path: string;
  /** 秒の Unix 時刻。セッションの Cookie は -1。 */
  readonly expires: number;
  readonly httpOnly: boolean;
  readonly secure: boolean;
  readonly sameSite: AuthenticatedStateSameSite;
}

/** localStorage の項目 1 つ。 */
export interface AuthenticatedStorageItem {
  readonly name: string;
  readonly value: string;
}

/**
 * IndexedDB のデータベース 1 つ（DEF-139。Playwright の `storageState({ indexedDB: true })` の `origins[].indexedDB` の項目と同じ形）。名前と版のほかは、
 * 中身（object store、記録、索引）を読まずに写す。
 */
export interface AuthenticatedIndexedDBDatabase {
  readonly name: string;
  readonly version: number;
  readonly stores: readonly unknown[];
}

/** Origin ごとの localStorage と IndexedDB（Playwright の `storageState` の `origins` の項目と同じ形）。 */
export interface AuthenticatedStorageOrigin {
  readonly origin: string;
  readonly localStorage: readonly AuthenticatedStorageItem[];
  /** DEF-139: IndexedDB（あるときだけ）。 */
  readonly indexedDB?: readonly AuthenticatedIndexedDBDatabase[];
}

/** 認証済みの状態（Playwright の `storageState` と同じ形。Cookie と、Origin ごとの localStorage と、DEF-139 からは IndexedDB）。 */
export interface AuthenticatedStorageState {
  readonly cookies: readonly AuthenticatedStorageCookie[];
  readonly origins: readonly AuthenticatedStorageOrigin[];
}
