/**
 * Windows の予約されたデバイス名の一覧の唯一の owner（DEF-056。Task 24 の設計書 4.7。CC-101 で `artifact-layout.ts` から分けた）。
 * 何も import しない純粋なファイル（画面のブラウザ側も読む）。
 * - 使う所: 成果物のパスの区切りの決まり（`artifact-layout.ts` の `isPortableRelativeArtifactPath`。区切りの最初の `.` より前の部分で判定）と、
 *   開始の URL から作る対象の設定のファイルの名前の決まり（`src/config/target-config-draft.ts` の `isReservedTargetConfigName`）。
 * - コンソールの入出力（`CONIN$`、`CONOUT$`）と、上付きの数字のポート（`COM¹`〜`COM³`、`LPT¹`〜`LPT³`）も含める（T24b round 1）。
 */

/**
 * Windows がポートの番号として扱う上付きの数字（1、2、3。U+00B9、U+00B2、U+00B3）。`COM¹` などもデバイスを指す（DEF-056。T24b round 1）。
 */
const SUPERSCRIPT_PORT_DIGITS: readonly string[] = [0x00b9, 0x00b2, 0x00b3].map((codePoint) => String.fromCodePoint(codePoint));

/** Windows の予約されたデバイス名（大文字で書く。比べるときは大文字にしてから比べる）。 */
export const WINDOWS_RESERVED_DEVICE_NAMES: readonly string[] = Object.freeze([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM0', 'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT0', 'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
  'CONIN$', 'CONOUT$',
  ...SUPERSCRIPT_PORT_DIGITS.map((digit) => `COM${digit}`),
  ...SUPERSCRIPT_PORT_DIGITS.map((digit) => `LPT${digit}`),
]);
const WINDOWS_RESERVED_DEVICE_NAME_SET: ReadonlySet<string> = new Set(WINDOWS_RESERVED_DEVICE_NAMES);

/** 名前（拡張子を除いた部分）が、大文字と小文字を問わず、Windows の予約されたデバイス名か。 */
export const isWindowsReservedDeviceName = (name: string): boolean => WINDOWS_RESERVED_DEVICE_NAME_SET.has(name.toUpperCase());
