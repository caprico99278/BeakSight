// 通知の枠の設計書（`doc/design/2026-11-06-beaksight-notification-overlay-design.md`）の NO-1 の結合テスト。
// - DEF-204（3.5）: 全面の透明な入れ物（背景なし・`pointer-events: none`）を、固定の要素の面積と覆いの規則で数えない。中の小さな固定の枠と、
//   背景を描く全面の固定の要素は、今までどおり数える。
// - 3.1: 通知の枠の見分け方（`readNotificationFrames`）。隅の通知の枠（× ボタン）、`role="dialog"` の枠（「閉じる」ボタン）、閉じるボタンのない枠、
//   ヘッダの中の × ボタン（対象外）、全面のモーダル（閾値を超えるので閉じる対象から外す）。枠を閉じない（押さない）ことも確かめる。
// 両方の Chromium（既定の headless shell と、環境変数 `BEAKSIGHT_TEST_DEFAULT_CHROMIUM=cli` の CLI の Chromium）で確かめる。
import type { Browser, Page } from 'playwright';
import { afterEach, describe, expect, it } from 'vitest';
import { LAYOUT_RULES } from '../../src/audit/layout-rules.js';
import type { FindingDraft } from '../../src/audit/rule.js';
import type { Viewport } from '../../src/config/types.js';
import type { EvidenceRecord } from '../../src/core/contracts.js';
import type { LayoutCollectionResult, LayoutEvidence, NormalizedHttpUrlEvidence } from '../../src/core/evidence-types.js';
import { createEvidenceId, createPageId } from '../../src/core/ids.js';
import { BrowserContextFactory } from '../../src/browser/context-factory.js';
import { collectLayoutEvidence } from '../../src/evidence/layout-collector.js';
import { dismissNotificationFrames, readNotificationFrames } from '../../src/interaction/notification-overlay.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';
import { startFixtureServer, type FixtureServer } from '../../fixtures/server.js';
import { useHeadlessChromium } from '../helpers/chromium.js';
import { withGuardedPassivePage } from '../helpers/gate-harness.js';
import { createTestConfig } from '../helpers/test-config.js';

let browser: Browser;
let server: FixtureServer | undefined;

/** fixture のページを開くビューポート。 */
const VIEWPORT: Viewport = Object.freeze({ width: 400, height: 300 });
/** 通知の枠の fixture を開くビューポート。 */
const FRAMES_VIEWPORT: Viewport = Object.freeze({ width: 800, height: 600 });
/** 通知の枠の読み取りの期限（ms）。 */
const FRAMES_READ_TIMEOUT_MS = 5_000;

useHeadlessChromium((launched) => {
  browser = launched;
});

afterEach(async () => {
  await server?.close();
  server = undefined;
});

/** fixture のサーバの `pathname` を、Guard の付いた Passive の page で開いて `run` に渡す（終わったら閉じる）。 */
async function withFixture(pathname: string, run: (page: Page) => Promise<void>, viewport: Viewport = VIEWPORT): Promise<void> {
  server ??= await startFixtureServer();
  const fixtureServer = server;
  const factory = new BrowserContextFactory(browser, createTestConfig(fixtureServer.origin, '/overflow.html'), () => new SafetyLedger());
  await withGuardedPassivePage(factory, viewport, async (page) => {
    await page.goto(`${fixtureServer.origin}/${pathname}`, { waitUntil: 'load' });
    await run(page);
  });
}

function completeLayout(result: LayoutCollectionResult): LayoutEvidence {
  expect(result.status).toBe('COMPLETE');
  if (result.status !== 'COMPLETE') {
    throw new Error('layout collection was not complete');
  }
  return result.layout;
}

/** layout の Evidence から、1 つの layout の Rule の Finding の下書きを作る。 */
function layoutRuleDrafts(ruleId: string, layout: LayoutEvidence): readonly FindingDraft[] {
  const rule = LAYOUT_RULES.find((candidate) => candidate.ruleId === ruleId);
  if (rule === undefined) {
    throw new Error(`${ruleId} is not registered`);
  }
  const record: EvidenceRecord = {
    evidenceId: createEvidenceId('layout', 1),
    type: 'layout',
    pageId: createPageId(1),
    viewport: 'desktop',
    observedAt: '2026-11-06T00:00:00.000Z',
    payload: { primary: { status: 'COMPLETE', layout }, stressSweep: null },
  };
  return rule.evaluate({
    pageId: createPageId(1),
    pageUrl: 'http://127.0.0.1/notification-overlay' as NormalizedHttpUrlEvidence,
    viewport: 'desktop',
    evidence: [record],
  });
}

/** Finding の下書きの、識別の欄（固定の要素の selector）の一覧。 */
const identitiesOf = (drafts: readonly FindingDraft[]): readonly (string | undefined)[] =>
  drafts.map((draft) => draft.identityFields.find((field) => field.name === 'selector' || field.name === 'overlaySelector')?.value);

describe('DEF-204: a pass-through fixed container is not counted as a fixed element', () => {
  it('does not count the full transparent container, and still counts the small fixed box inside it', async () => {
    await withFixture('layout-pass-through-container.html', async (page) => {
      const layout = completeLayout(await collectLayoutEvidence(page, VIEWPORT));

      // 2 つの規則の結果を、先に 1 つの値で比べる（直す前の RED で、両方の規則が入れ物を数えることを 1 回で記録するため）。
      expect({
        oversized: identitiesOf(layoutRuleDrafts('OVERSIZED_FIXED_ELEMENT', layout)),
        occlusion: identitiesOf(layoutRuleDrafts('FIXED_ELEMENT_OCCLUSION', layout)),
      }).toEqual({ oversized: [], occlusion: ['#corner-box'] });

      const container = layout.fixedElements.find((element) => element.selector === '#pass-through-layer');
      const box = layout.fixedElements.find((element) => element.selector === '#corner-box');
      expect(container).toMatchObject({ viewportAreaRatio: 1, paintsOwnSurface: false, pointerEvents: 'none' });
      expect(box).toMatchObject({ paintsOwnSurface: true, pointerEvents: 'auto' });
    });
  });

  it('still counts a full fixed element that paints a background', async () => {
    await withFixture('layout-painted-full-overlay.html', async (page) => {
      const layout = completeLayout(await collectLayoutEvidence(page, VIEWPORT));

      expect(layout.fixedElements.find((element) => element.selector === '#painted-layer'))
        .toMatchObject({ viewportAreaRatio: 1, paintsOwnSurface: true, pointerEvents: 'none' });
      expect(identitiesOf(layoutRuleDrafts('OVERSIZED_FIXED_ELEMENT', layout))).toContain('#painted-layer');
      expect(identitiesOf(layoutRuleDrafts('FIXED_ELEMENT_OCCLUSION', layout))).toContain('#painted-layer');
    });
  });
});

/** 文書の根からの位置（要素の子の中の番号の並び）の要素の id。 */
async function idAtPath(page: Page, path: readonly number[] | null): Promise<string | null> {
  return page.evaluate((steps) => {
    if (steps === null) return null;
    let current: Element | null = null;
    for (const step of steps) {
      const children: HTMLCollection = current === null ? document.children : current.children;
      current = children.item(step);
      if (current === null) return null;
    }
    return current?.id ?? null;
  }, path === null ? null : [...path]);
}

describe('3.1: telling notification frames and their close buttons', () => {
  it('finds the corner notice and the dialog, and leaves out the header, the frame without a close button, and the full modal', async () => {
    await withFixture('notification-frames.html', async (page) => {
      const outcome = await readNotificationFrames(page, Date.now() + FRAMES_READ_TIMEOUT_MS);
      expect(outcome.status).toBe('READ');
      if (outcome.status !== 'READ') return;

      const frames = await Promise.all(outcome.frames.map(async (frame) => ({
        frame: await idAtPath(page, frame.frameElement.path),
        status: frame.status,
        closeButton: frame.closeButtonElement === null ? null : await idAtPath(page, frame.closeButtonElement.path),
        digest: frame.digest,
        surfaceAreaRatio: frame.surfaceAreaRatio,
      })));
      const byFrame = new Map(frames.map((frame) => [frame.frame, frame] as const));
      // 隅の通知の枠: 全面の透明な入れ物が枠の候補で、描く面は中の小さな枠（ビューポートの 7% ほど）で計る。
      expect(byFrame.get('corner-layer')).toMatchObject({ status: 'DISMISSIBLE', closeButton: 'corner-close' });
      expect(byFrame.get('corner-layer')?.surfaceAreaRatio).toBeCloseTo((240 * 140) / (800 * 600), 2);
      // role="dialog" の枠（「閉じる」ボタン）。
      expect(byFrame.get('info-dialog')).toMatchObject({ status: 'DISMISSIBLE', closeButton: 'dialog-close' });
      // 閉じるボタンのない枠。
      expect(byFrame.get('help-tab')).toMatchObject({ status: 'NO_CLOSE_BUTTON', closeButton: null });
      // 全面のモーダル: 閾値を超えるので、閉じる対象から外す。
      expect(byFrame.get('full-modal')).toMatchObject({ status: 'TOO_LARGE', closeButton: 'modal-close' });
      expect(byFrame.get('full-modal')?.surfaceAreaRatio).toBe(1);
      // ヘッダの中の × ボタンは、対象外。
      expect(byFrame.has('site-header')).toBe(false);
      expect(outcome.excluded.map(({ reason }) => reason)).toEqual(['IN_LAYOUT_LANDMARK']);
      expect(new Set(frames.map(({ digest }) => digest)).size).toBe(frames.length);
      expect(outcome.truncated).toBe(false);

      // 見分けるだけで、枠を閉じない（ページに何も書かない）。
      expect(await page.evaluate(() => ['corner-notice', 'info-dialog', 'full-modal']
        .map((id) => document.getElementById(id)?.checkVisibility() ?? false))).toEqual([true, true, true]);
    }, FRAMES_VIEWPORT);
  });

  // DEF-260: 名前の 65 文字目より後ろに削除の語がある閉じるボタンは、閉じるボタンにしない（押さない）。前はページの中で名前を 64 文字で切り、見逃した。
  it('does not take a button as the close button when a destructive word comes after the 64th character of its name', async () => {
    await withFixture('notification-frames.html', async (page) => {
      await page.evaluate(() => document.getElementById('dialog-close')?.setAttribute('title', `${'x'.repeat(64)} delete`));
      const outcome = await readNotificationFrames(page, Date.now() + FRAMES_READ_TIMEOUT_MS);
      expect(outcome.status).toBe('READ');
      if (outcome.status !== 'READ') return;
      const frames = await Promise.all(outcome.frames.map(async ({ frameElement, status, closeButtonElement }) => (
        { id: await idAtPath(page, frameElement.path), status, closeButton: closeButtonElement })));
      expect(frames.find(({ id }) => id === 'info-dialog')).toMatchObject({ status: 'NO_CLOSE_BUTTON', closeButton: null });
    }, FRAMES_VIEWPORT);
  });

  // RB-9: 前は notification-dismissal の結合（本物の Page Auditor で監査して押した数を数えた）で確かめた、名前とリンクの読み取り（SREV-1106 の
  // fix round 2 の I-1〜I-5・M-3、fix round 3 の R-I1、fix round 4 の N-I2）。本物の DOM から読んだ名前で、押す閉じるボタンだけが `DISMISSIBLE` になる。
  it('takes only the close words and the frame name as close buttons, not destructive objects or links that move', async () => {
    await withFixture('notification-frames.html', async (page) => {
      const notice = (index: number, inner: string, heading = ''): string => `<div style="position: fixed; inset: 0; z-index: ${String(40 + index)}; pointer-events: none;">
<section role="region" style="position: fixed; top: ${String(8 + (index % 5) * 70)}px; right: ${String(8 + Math.floor(index / 5) * 160)}px; width: 150px; height: 60px; pointer-events: auto; background: #fee; border: 1px solid #333;">
${heading === '' ? '' : `<h2 style="margin: 0; font-size: 12px;">${heading}</h2>`}<div>${inner}</div></section></div>`;
      const button = (id: string, label: string, attributes = ''): string => `<button type="button" id="${id}" ${attributes}>${label}</button>`;
      const icon = '<svg aria-hidden="true" width="12" height="12" viewBox="0 0 12 12"><path d="M1 1L11 11M11 1L1 11" stroke="#000"/></svg>';
      const box = (top: number, inner: string, attributes = ''): string =>
        `<div ${attributes} style="position: fixed; right: 8px; top: ${String(top)}px; width: 220px; height: 100px; z-index: 50; background: #fee;">${inner}</div>`;
      const groups: Readonly<Record<string, string>> = {
        notCloseWords: [
          notice(0, button('a0', 'Close account')), notice(1, button('a1', 'アカウントを閉じる')), notice(2, button('a2', 'ログオフして閉じる')),
          box(232, `<p>確認</p>${button('a3', 'Close ticket')}`, 'role="dialog" aria-modal="true"'),
        ].join(''),
        closeWords: [
          notice(0, button('c0', 'お知らせを閉じる')), notice(1, button('c1', icon, 'aria-label="お役立ち情報を閉じる"'), 'お役立ち情報'), notice(2, button('c2', '×')),
          notice(3, button('c3', 'Close')), notice(4, button('c4', 'Close dialog')),
        ].join(''),
        links: [
          '<a id="l0" href="mailto:someone@example.invalid">閉じる</a>', '<a id="l1" href="tel:0000">閉じる</a>',
          '<a id="l2" href="beaksight-test-app://close">閉じる</a>', '<a id="l3" href="/files/notice.zip" download>閉じる</a>',
          '<a id="l4" href="/next" target="_blank">閉じる</a>', '<a id="l5" href="/next">閉じる</a>',
          `<a id="l6" href="${(server?.origin ?? '').replace('://', '://user:pass@')}/next">閉じる</a>`,
        ].map((link, index) => notice(index, link)).join(''),
        destructiveObjects: [
          box(8, `<h2>アカウント</h2>${button('d0', 'アカウントを閉じる')}`),
          box(120, button('d1', 'Close account'), 'role="region" aria-label="account"'),
          box(232, `<span id="account-title">Account</span>${button('d2', 'Close account')}`, 'role="dialog" aria-labelledby="account-title"'),
          `<div style="position: fixed; left: 8px; top: 8px; width: 220px; height: 100px; z-index: 50; background: #fee;"><h2>アカウント</h2>${button('d3', icon, 'aria-label="アカウントを閉じる"')}</div>`,
        ].join(''),
        objectNames: [
          box(8, button('o0', '×', 'aria-label="プランを閉じる"'), 'role="region" aria-label="プラン"'),
          box(120, button('o1', '', 'title="Close workspace"'), 'role="region" aria-label="Workspace"'),
          box(232, button('o2', icon, 'aria-label="お役立ち情報を閉じる"'), 'role="region" aria-label="お役立ち情報"'),
        ].join(''),
      };
      const pressed: Record<string, readonly (string | null)[]> = {};
      for (const [name, html] of Object.entries(groups)) {
        await page.evaluate((body) => { document.body.innerHTML = body; }, html);
        const outcome = await readNotificationFrames(page, Date.now() + FRAMES_READ_TIMEOUT_MS);
        expect(outcome.status, name).toBe('READ');
        if (outcome.status !== 'READ') return;
        pressed[name] = await Promise.all(outcome.frames.filter((frame) => frame.status === 'DISMISSIBLE' && frame.closeButtonElement !== null)
          .map((frame) => idAtPath(page, frame.closeButtonElement?.path ?? null)));
      }

      expect(pressed).toEqual({
        notCloseWords: [], closeWords: ['c0', 'c1', 'c2', 'c3', 'c4'], links: [], destructiveObjects: [], objectNames: ['o2'],
      });
    }, FRAMES_VIEWPORT);
  });

  it('gives the same frame the same digest when it appears again on another load', async () => {
    await withFixture('notification-frames.html', async (page) => {
      const first = await readNotificationFrames(page, Date.now() + FRAMES_READ_TIMEOUT_MS);
      await page.reload({ waitUntil: 'load' });
      const second = await readNotificationFrames(page, Date.now() + FRAMES_READ_TIMEOUT_MS);
      expect(first.status === 'READ' && second.status === 'READ').toBe(true);
      if (first.status !== 'READ' || second.status !== 'READ') return;
      expect(second.frames.map(({ digest, status }) => [digest, status])).toEqual(first.frames.map(({ digest, status }) => [digest, status]));
    }, FRAMES_VIEWPORT);
  });
});

describe('NO-2: the general shape of a notice region (a fixed region in a pass-through layer, with a header of two buttons)', () => {
  it('picks the close button (not the minimize button) of the region in the header, and the press makes the frame disappear', async () => {
    await withFixture('notification-region.html', async (page) => {
      const outcome = await readNotificationFrames(page, Date.now() + FRAMES_READ_TIMEOUT_MS);
      expect(outcome.status).toBe('READ');
      if (outcome.status !== 'READ') return;
      const frames = await Promise.all(outcome.frames.map(async (frame) => ({
        frame: await idAtPath(page, frame.frameElement.path),
        status: frame.status,
        closeButton: frame.closeButtonElement === null ? null : await idAtPath(page, frame.closeButtonElement.path),
      })));
      // role="region" で position: fixed の枠を拾い、header の中の閉じるボタンを選ぶ（section の中の header は、ヘッダの landmark ではない）。
      // 透明な入れ物は、入れ子の外側として外す。隠したダイアログ（hidden・inert・aria-hidden）は、候補にしない。
      expect(frames).toEqual([{ frame: 'notice', status: 'DISMISSIBLE', closeButton: 'notice-close' }]);
      expect(outcome.excluded.map(({ reason }) => reason)).toEqual(['CONTAINS_FRAME']);

      const dismissal = await dismissNotificationFrames(page, { deadlineAtMs: Date.now() + FRAMES_READ_TIMEOUT_MS, pressMode: 'AUDIT' });
      expect(dismissal).toMatchObject({ readStatus: 'READ', pressCount: 1, navigated: false });
      expect(dismissal.frames.map(({ pressed, dismissed, hidden }) => ({ pressed, dismissed, hidden })))
        .toEqual([{ pressed: true, dismissed: true, hidden: false }]);
      // 枠が消え、最小化のボタンは押していない（中身は隠れていない）ことは、枠ごと消えたことで分かる。
      expect(await page.evaluate(() => document.getElementById('notice') === null)).toBe(true);
    }, FRAMES_VIEWPORT);
  });
});
