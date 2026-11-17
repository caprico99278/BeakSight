// AUD-1d（ユーザーの判断 2026-11-09）: ChatGPT に渡すまとめファイル（ZIP）を分けたときの、ダウンロードのリンクの文言（作業の画面とサイトの画面の 1 か所）。
import { formatInteger } from '../../../../src/presentation/format.js';
import { LOCAL_UI_AUDIT_TEXT } from '../../../../src/presentation/messages.js';

/** まとめファイルの 1 つの部（番号は 1 から）。 */
export interface BundlePartLabelInput {
  readonly partNumber: number;
  readonly partCount: number;
}

/** 分けたまとめファイルの 1 つの部の、ダウンロードのリンクの文言。 */
export const bundlePartLabelOf = (part: BundlePartLabelInput): string =>
  LOCAL_UI_AUDIT_TEXT.job.downloadBundlePart(formatInteger(part.partCount), formatInteger(part.partNumber));
