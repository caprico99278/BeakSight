/**
 * AUD-1d（ユーザーの判断 2026-11-09）: ChatGPT に渡すまとめファイル（ZIP）を分けたときの、画面のダウンロードのリンクの文言（作業の画面とサイトの画面の 1 か所）。
 * 配る組の選び方（いちばん新しい組の全部の部を、部の番号の順に）は、名前の owner の `newestBundleFileSetOf`（`tests/unit/bundle-file-parts.test.ts`）。
 * サーバもブラウザも使わない。
 */
import { describe, expect, it } from 'vitest';
import { LOCAL_UI_AUDIT_TEXT } from '../../../src/presentation/messages.js';
import { bundlePartLabelOf } from '../src/display/bundle-part-label';

describe('the download link of a part of the bundle (AUD-1d)', () => {
  it('tells which part of how many it is, and differs from the link of one ZIP', () => {
    expect(bundlePartLabelOf({ partNumber: 2, partCount: 3 })).toBe(LOCAL_UI_AUDIT_TEXT.job.downloadBundlePart('3', '2'));
    expect(bundlePartLabelOf({ partNumber: 2, partCount: 3 })).toContain('全 3 個のうち 2 個目');
    expect(bundlePartLabelOf({ partNumber: 1, partCount: 2 })).not.toBe(LOCAL_UI_AUDIT_TEXT.job.downloadBundle);
  });
});
