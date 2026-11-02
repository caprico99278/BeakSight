/**
 * PL-V（設計書 `doc/design/2026-10-26-beaksight-plain-ui-design.md` 13 章の 6・7）: 共通の部品の見た目の指定を、`react-dom/server` の
 * `renderToStaticMarkup` で HTML にして確かめる（ビルドとブラウザは使わない）。
 * - 知らせ（`Notice`）: 見出しがないときは、種類の語（カタログ `LOCAL_UI_FRAME_TEXT.noticeKinds`）を見出しの位置に出す。見出しがあれば見出しだけ。
 * - 確認のダイアログ（`ConfirmDialog`）: 確定のボタンの見た目は、使う側の指定（危険・主）のとおり。ボタンは 2 つのまま。
 * - PL-3（PL-2 の持ち越し。設計書 3 章の 1）: たたんだ区画（`AdvancedSettings`）の見出しは「詳しい内容」（直すための欄と、調べるための情報の両方を入れるため）。
 *   語はカタログ（`LOCAL_UI_TEXT.advancedSettings.summary`）の 1 か所。ほかの画面のテストは、カタログの定数で照らす。
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { LOCAL_UI_FRAME_TEXT, LOCAL_UI_TEXT } from '../../../src/presentation/messages.js';
import { AdvancedSettings } from '../src/components/AdvancedSettings';
import { ConfirmDialog, type ConfirmTone } from '../src/components/ConfirmDialog';
import { Notice, type NoticeKind } from '../src/components/Notice';

const NOTICE_KINDS: readonly NoticeKind[] = ['caution', 'critical', 'positive'];

describe('PL-V: the notice says its kind in words (13 の 6)', () => {
  it.each(NOTICE_KINDS)('shows the kind word of %s when the notice has no heading', (kind) => {
    const html = renderToStaticMarkup(createElement(Notice, { kind, children: createElement('p', null, 'body') }));
    expect(html).toBe(`<div class="notice notice--${kind}" role="${kind === 'critical' ? 'alert' : 'status'}">`
      + `<p class="notice-heading">${LOCAL_UI_FRAME_TEXT.noticeKinds[kind]}</p><p>body</p></div>`);
  });

  it('shows the heading only when the notice has one', () => {
    const html = renderToStaticMarkup(createElement(Notice, { kind: 'caution', heading: 'heading', children: createElement('p', null, 'body') }));
    expect(html).toBe('<div class="notice notice--caution" role="status"><p class="notice-heading">heading</p><p>body</p></div>');
  });
});

describe('PL-V: the confirm button of the dialog looks as the caller chose (13 の 7)', () => {
  const dialogOf = (confirmTone: ConfirmTone): string => renderToStaticMarkup(createElement(ConfirmDialog, {
    open: false,
    title: 'title',
    body: 'body',
    confirmLabel: 'confirm',
    cancelLabel: 'cancel',
    confirmTone,
    busy: false,
    onConfirm: () => undefined,
    onCancel: () => undefined,
  }));

  it.each([
    ['danger', 'button button--danger'],
    ['primary', 'button button--primary'],
  ] as const)('gives the %s look to the confirm button, and keeps the two buttons', (tone, className) => {
    const html = dialogOf(tone);
    expect(html).toContain(`<button type="button" class="${className}" data-confirm-tone="${tone}">confirm</button>`);
    expect(html).toContain('<button type="button" class="button">cancel</button>');
    expect(html.match(/<button /gu)).toHaveLength(2);
  });

  // PL-5（判断 1）: 確定を押せない指定（`confirmDisabled`）は、省けば今までどおり押せる（上の 2 件の HTML に `disabled` がない）。指定したときだけ押せない。
  it('disables the confirm button only when confirmDisabled is given', () => {
    const html = renderToStaticMarkup(createElement(ConfirmDialog, {
      open: false, title: 'title', body: 'body', confirmLabel: 'confirm', cancelLabel: 'cancel', confirmTone: 'primary', busy: false,
      onConfirm: () => undefined, onCancel: () => undefined, confirmDisabled: true,
    }));
    expect(html).toContain('<button type="button" class="button button--primary" data-confirm-tone="primary" disabled="">confirm</button>');
    expect(html).toContain('<button type="button" class="button">cancel</button>');
  });
});

describe('PL-3: the folded section is headed by the word of the design (3 の 1)', () => {
  it('heads the folded section with the catalog word, which is the word of the design', () => {
    // 設計書 3 章の 1 の語（設定と情報の両方を入れる区画）。語の置き場所はカタログの 1 か所。
    expect(LOCAL_UI_TEXT.advancedSettings.summary).toBe('詳しい内容');
    const html = renderToStaticMarkup(createElement(AdvancedSettings, { testId: 'folded', children: createElement('p', null, 'body') }));
    expect(html).toBe(`<details class="field-group" data-testid="folded"><summary class="field-group-heading">${LOCAL_UI_TEXT.advancedSettings.summary}</summary>`
      + '<p>body</p></details>');
  });
});
