/**
 * DLALL（設計書 `doc/design/2026-11-24-beaksight-job-artifacts-download-all-design.md` 3 章）: 作業の画面の「できたファイル」の「まとめてダウンロードする」。
 * ボタンは `react-dom/server` の `renderToStaticMarkup` で、押したときの処理はリンクを押す口を差し込んで確かめる（ビルドとブラウザは使わない）。
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { LOCAL_UI_AUDIT_TEXT } from '../../../src/presentation/messages.js';
import { DownloadAllArtifacts } from '../src/components/DownloadAllArtifacts';
import { clickDownloadLinksInOrder } from '../src/display/download-all';

describe('DLALL: the button to download all the files of the list', () => {
  it('is shown for two files or more, and not for one', () => {
    expect(renderToStaticMarkup(createElement(DownloadAllArtifacts, { hrefs: ['/a', '/b'] }))).toContain(LOCAL_UI_AUDIT_TEXT.job.downloadAll);
    expect(renderToStaticMarkup(createElement(DownloadAllArtifacts, { hrefs: ['/a'] }))).toBe('');
  });

  it('clicks the link of every href once, in the order of the list', () => {
    const clicked: string[] = [];
    clickDownloadLinksInOrder(['/a', '/b', '/c'], (href) => clicked.push(href));
    expect(clicked).toEqual(['/a', '/b', '/c']);
  });
});
