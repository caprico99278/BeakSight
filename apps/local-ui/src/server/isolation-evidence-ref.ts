/**
 * MI-5（設計書 `doc/design/2026-10-26-beaksight-minimal-input-ux-design.md` 4.2・4.5）: 隔離をまだ確かめていないテスト環境の、環境の証跡の参照
 * （`environmentEvidenceRef`）の形の唯一の定義。参照は `isolation-unverified-<YYYYMMDD>`（未確認であることが分かる参照。手順書
 * `doc/spec/real-test-environment.md` の例と同じ形）。
 * - 「書き込みにも使う」の確認のダイアログ（`write-mode-switch.ts`）が、参照が未確認の形かで、隔離がまだ確かめられていないことを目立つ形で出すかを決める。
 * - MI-1 の作成（「隔離はまだ確かめていない」を選んだとき）は、保存した日で参照を作る（`isolationUnverifiedEvidenceRefOf`。作るのはサーバの作成の流れ
 *   `target-config-writer.ts` の `createProfileFromRequest` だけ）。日付は、表示の日時の書式の owner（`formatDateTime`。表示の時間帯）の日付の部分を使う
 *   （日付の書式をここで組み立てない）。
 * - BeakSight は参照の中身を読まない（形だけ）。import は純粋な表示の書式だけ（ブラウザのコードからも読める）。
 */
import { formatDateTime } from '../../../../src/presentation/format.js';

/** 隔離が未確認であることを示す参照の接頭辞（この後に日付の `YYYYMMDD` が続く）。 */
export const ISOLATION_UNVERIFIED_EVIDENCE_REF_PREFIX = 'isolation-unverified-';

/** 環境の証跡の参照が、隔離が未確認であることを示す形か（参照がなければ偽）。 */
export const isIsolationUnverifiedEvidenceRef = (reference: string | null): boolean =>
  reference !== null && reference.startsWith(ISOLATION_UNVERIFIED_EVIDENCE_REF_PREFIX);

/** `formatDateTime` の書き方（`YYYY-MM-DD HH:mm:ss JST`）の、日付の部分の長さ。 */
const DISPLAY_DATE_LENGTH = 'YYYY-MM-DD'.length;
/** 日付の部分の区切り（参照では取り除く）。 */
const DISPLAY_DATE_SEPARATOR = '-';

/** MI-1: 保存した時刻 `savedAt` の日（表示の時間帯の日付）で、隔離が未確認であることを示す参照を作る（例: `isolation-unverified-20261026`）。 */
export const isolationUnverifiedEvidenceRefOf = (savedAt: Date): string =>
  `${ISOLATION_UNVERIFIED_EVIDENCE_REF_PREFIX}${formatDateTime(savedAt.toISOString()).slice(0, DISPLAY_DATE_LENGTH).replaceAll(DISPLAY_DATE_SEPARATOR, '')}`;
