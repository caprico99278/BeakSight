/**
 * 操作さがし（発見）の結果が、今のプロファイルの改訂のものとみなせるかの判定の 1 か所（SSOT。PL-U の修正の 1 回目。設計書
 * `doc/design/2026-10-26-beaksight-plain-ui-design.md` 14.1 の U5 と「PL-U の調べの後の判断」）。
 * - 前は、4 か所（自動の下書き `isAutoDraftDiscoveryStale`、下書きの確かめ `apiProfileRevisionErrorsOf`、保存の文脈の読み方 `scenario-store.ts`、承認の有効さの
 *   `API_DISCOVERY_PROFILE_STALE`）が、それぞれ「発見のジョブの改訂 === 今の改訂」と比べていた。今は、どれもこのファイルの `isDiscoveryProfileRevisionCurrent`
 *   を使う（読み出しの側は `discoveryProfileRevisionsIn` で値を作る）。
 * - 同じとみなすのは、改訂が同じとき、または、発見のジョブの改訂から今の改訂まで「書き込みも試す」の切り替えの 1 歩（`isWriteModeSwitchStep`）だけで
 *   進んだことを、保存した改訂の記録（`profile_revisions` の文書）で確かめられたときだけ。確かめられない（記録がない・読めない・ほかの変更がある）ときは
 *   古い（fail-closed）。OP-2（設計書 `2026-10-27-beaksight-one-pass-flow-design.md` の OP-1 の持ち越し）: ログインの希望（`loginPreference`）だけの 1 歩も、
 *   中身の変わらない 1 歩とみなす（判定の 1 か所 `isDiscoveryNeutralStep`）。
 * - 根拠（PL-U の調べ）: 発見は読み取りだけで、ワーカーはモードも隔離の参照も読まない（`worker-protocol.ts` に、どちらもない）。書き込みの OK と書き込みの
 *   ときは、`approval-validity.ts` がモード・改訂・認証の設定・設定のファイル・承認したサービスの Origin を照らし直す（その判定は変えない）。
 * - 承認したサービスの Origin の一覧は、型の Origin の番号の元なので、変わった改訂は同じとみなさない（切り替えの 1 歩では変わらない）。
 */
import { isDeepStrictEqual } from 'node:util';
import { isRecord } from '../../core/guards.js';
import { WRITE_AUDIT_MODE } from '../contracts.js';
import type { SqliteConnection } from '../store/sqlite-module.js';

/** 発見のジョブの改訂と今の改訂（と、その間が切り替えだけだったか）。 */
export interface DiscoveryProfileRevisions {
  /** 候補を見つけた発見のジョブのプロファイルの改訂（分からなければ null）。 */
  readonly discoveryJob: number | null;
  /** 今のプロファイルの改訂。 */
  readonly current: number;
  /**
   * 発見のジョブの改訂から今の改訂まで、中身の変わらない 1 歩（`isDiscoveryNeutralStep`。切り替えと、OP-2 からログインの希望だけの変更）だけで進んだことを、
   * 保存した改訂の記録で確かめられたか（省けば偽。名前は前のまま）。
   */
  readonly switchOnlySinceDiscovery?: boolean;
}

/** 切り替えの 1 歩で変わってよい項目（改訂の番号・モード・環境の証跡の参照。`write-mode-switch.ts` の `switchToWriteMode` が変えるもの）。 */
const SWITCH_CHANGED_KEYS: ReadonlySet<string> = new Set(['revision', 'mode', 'environmentEvidenceRef']);

/**
 * 改訂の文書 `older` から `newer` への 1 歩が、「書き込みも試す」の切り替えか（書き込みのモードでない改訂から、書き込みのモードの次の改訂へ。ほかの項目は
 * 同じ。項目が足されたか消されたときも違う）。形が文書でなければ偽。
 */
export const isWriteModeSwitchStep = (older: unknown, newer: unknown): boolean => {
  if (!isRecord(older) || !isRecord(newer)) {
    return false;
  }
  const { revision: olderRevision, mode: olderMode } = older;
  const { revision: newerRevision, mode: newerMode } = newer;
  if (typeof olderRevision !== 'number' || newerRevision !== olderRevision + 1 || olderMode === WRITE_AUDIT_MODE || newerMode !== WRITE_AUDIT_MODE) {
    return false;
  }
  return onlyKeysChangedInNextRevision(older, newer, SWITCH_CHANGED_KEYS);
};

/** OP-2（設計書 `2026-10-27-beaksight-one-pass-flow-design.md` 4.2 の OP-1 の持ち越し）: ログインの希望だけの 1 歩で変わってよい項目。 */
const LOGIN_PREFERENCE_CHANGED_KEYS: ReadonlySet<string> = new Set(['revision', 'loginPreference']);

/** 改訂の文書 `older` から `newer` への次の改訂の 1 歩で、`changedKeys` のほかの項目が同じか（項目が足された・消されたときも、`changedKeys` の外なら違う）。 */
const onlyKeysChangedInNextRevision = (older: Record<string, unknown>, newer: Record<string, unknown>, changedKeys: ReadonlySet<string>): boolean => {
  const keys = new Set([...Object.keys(older), ...Object.keys(newer)]);
  return [...keys].every((key) => changedKeys.has(key) || (key in older && key in newer && isDeepStrictEqual(older[key], newer[key])));
};

/**
 * OP-2: 改訂の文書 `older` から `newer` への 1 歩が、ログインの希望（`loginPreference`。サイトの設定の「毎回手でログインする」）だけの変更か。承認したサービスの
 * Origin、認証の方式、モードなど、ほかの項目は同じ（操作さがしの中身は変わらない）。認証の設定は別の表なので、ここでは見ない（ログインの希望の保存は認証の
 * 設定を書かない）。
 */
export const isLoginPreferenceStep = (older: unknown, newer: unknown): boolean => {
  if (!isRecord(older) || !isRecord(newer)) {
    return false;
  }
  const { revision: olderRevision } = older;
  // ログインの希望が実際に変わった 1 歩だけ（改訂の番号だけが進んだ保存は、今どおり中身の変わらない 1 歩とみなさない）。
  return typeof olderRevision === 'number' && newer['revision'] === olderRevision + 1
    && !isDeepStrictEqual(older['loginPreference'], newer['loginPreference'])
    && onlyKeysChangedInNextRevision(older, newer, LOGIN_PREFERENCE_CHANGED_KEYS);
};

/**
 * OP-2: 操作さがしの中身が変わらない 1 歩の判定の 1 か所（「書き込みも試す」の切り替えの 1 歩か、ログインの希望だけの 1 歩）。保存した改訂の記録の照らし
 * （`discoveryProfileRevisionsIn`）は、間のどの 1 歩もこれに当たるときだけ、発見の結果を今の改訂のものとみなす。
 */
export const isDiscoveryNeutralStep = (older: unknown, newer: unknown): boolean =>
  isWriteModeSwitchStep(older, newer) || isLoginPreferenceStep(older, newer);

/** 発見の結果を、今の改訂のものとみなせるか（判定はファイルの先頭。分からないときは偽）。 */
export const isDiscoveryProfileRevisionCurrent = (revisions: DiscoveryProfileRevisions | undefined): boolean => {
  if (revisions === undefined || revisions.discoveryJob === null) {
    return false;
  }
  return revisions.discoveryJob === revisions.current
    || (revisions.discoveryJob < revisions.current && revisions.switchOnlySinceDiscovery === true);
};

/** 改訂の記録の 1 行。 */
interface ProfileRevisionRow {
  readonly revision: number;
  readonly document: string;
}

const SELECT_PROFILE_REVISIONS_SQL =
  'SELECT revision, document FROM profile_revisions WHERE profile_id = ? AND revision >= ? AND revision <= ? ORDER BY revision';

/** 記録の文書を読む（JSON でなければ null）。 */
const documentOf = (row: ProfileRevisionRow | undefined): unknown => {
  if (row === undefined) {
    return null;
  }
  try {
    return JSON.parse(row.document) as unknown;
  } catch {
    return null;
  }
};

/**
 * 発見のジョブの改訂から今の改訂までが、中身の変わらない 1 歩だけか（保存した改訂の記録で確かめる。間の改訂がすべてそろい、どの 1 歩も
 * `isDiscoveryNeutralStep`（書き込みのモードへの切り替えか、OP-2 からログインの希望だけの変更）のときだけ真）。読むだけ（呼び出し側のトランザクションの中で使う）。
 */
const switchOnlyBetweenIn = (connection: SqliteConnection, profileId: string, from: number, to: number): boolean => {
  const rows = connection.prepare(SELECT_PROFILE_REVISIONS_SQL).all(profileId, from, to) as unknown as ProfileRevisionRow[];
  if (rows.length !== to - from + 1 || rows.some((row, index) => row.revision !== from + index)) {
    return false;
  }
  return rows.slice(1).every((row, index) => isDiscoveryNeutralStep(documentOf(rows[index]), documentOf(row)));
};

/** 発見のジョブの改訂と今の改訂から、判定に渡す値を作る（読み出しの側の 1 か所。`scenario-store.ts` と `scenario-facts.ts` が使う）。 */
export const discoveryProfileRevisionsIn = (
  connection: SqliteConnection,
  profileId: string,
  discoveryJob: number | null,
  current: number,
): DiscoveryProfileRevisions => ({
  discoveryJob,
  current,
  switchOnlySinceDiscovery: discoveryJob !== null && discoveryJob < current && switchOnlyBetweenIn(connection, profileId, discoveryJob, current),
});
