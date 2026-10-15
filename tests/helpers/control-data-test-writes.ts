// T26f（Task 26 の設計書 4.7）: 資格情報の目印の検査（`apps/local-ui/tests/credential-secret-markers.test.ts`）が使う、管理データと SQLite への
// テストだけの書き込み。SQL の書き込みの文は、製品の画面のコード（`apps/local-ui/`）に置かない決まり（Gate `control-store-boundary` の (g)）なので、
// ほかの結合テストと同じく `tests/` の下に置く。
// - `shiftAutoLoginAttemptsBack`: 自動ログインどうしの最小の間隔を待たずに次の試しを始めるため、ジョブが動いていない間に、管理データの
//   `auto_login_attempts` の試し始めた時刻を前へずらす（上限の判定の部品は変えない）。画面のサーバが開いている管理データに、別の接続で書く
//   （WAL。画面のサーバの書き込みを、上限の時間まで待つ）。
// - `openWalControlDatabase`: 目印の検索の対照のための、WAL の SQLite（自動の checkpoint をしないので、書いた行は WAL のファイルに残る）。
import { DatabaseSync } from 'node:sqlite';
import { dateOfCompactUtcTimestamp } from '../../src/control/job/auto-login-limits.js';
import { formatCompactUtcTimestamp } from '../../src/core/utc-timestamp.js';

/** 管理データを書くときに、画面のサーバの書き込みを待つ上限（ms）。 */
const DATABASE_BUSY_TIMEOUT_MS = 10_000;

/**
 * 管理データの `auto_login_attempts` の、`profileId` の試し始めた時刻を、`shiftMs` だけ前へずらす（テストだけの操作。ジョブが動いていない間に
 * 呼ぶ）。ずらした行の数を返す。
 */
export const shiftAutoLoginAttemptsBack = (databasePath: string, profileId: string, shiftMs: number): number => {
  const database = new DatabaseSync(databasePath);
  try {
    database.exec(`PRAGMA busy_timeout = ${DATABASE_BUSY_TIMEOUT_MS}`);
    const rows = database.prepare('SELECT attempt_id, started_at FROM auto_login_attempts WHERE profile_id = ?').all(profileId) as {
      readonly attempt_id: number;
      readonly started_at: string;
    }[];
    const update = database.prepare('UPDATE auto_login_attempts SET started_at = ? WHERE attempt_id = ?');
    for (const row of rows) {
      const shifted = new Date(dateOfCompactUtcTimestamp(row.started_at).getTime() - shiftMs);
      update.run(formatCompactUtcTimestamp(shifted, 'shifted auto login attempt'), row.attempt_id);
    }
    return rows.length;
  } finally {
    database.close();
  }
};

/** WAL の SQLite を作り、`value` を 1 行書く（自動の checkpoint をしない。閉じるまで、行は WAL のファイルにある）。閉じる関数を返す。 */
export const openWalControlDatabase = (path: string, value: string): { readonly close: () => void } => {
  const database = new DatabaseSync(path);
  try {
    database.exec('PRAGMA journal_mode = WAL');
    database.exec('PRAGMA wal_autocheckpoint = 0');
    database.exec('CREATE TABLE control_rows (value TEXT NOT NULL) STRICT');
    database.prepare('INSERT INTO control_rows (value) VALUES (?)').run(value);
  } catch (error) {
    database.close();
    throw error;
  }
  return { close: () => database.close() };
};
