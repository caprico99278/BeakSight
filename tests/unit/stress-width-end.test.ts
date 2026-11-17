// 幅の走査の 1 つの幅の終わり方（ブラウザを使わない）。
// - B（C18i）: 幅の結果が `PAGE_CLOSED` で、違反が記録されていれば、その幅の理由は `SAFETY_VIOLATION_ABORT`（Guard が違反で Context を閉じた）。
// - C: 幅の page が外部スキームへ移ろうとした記録が入るか、文書が誤りの画面（`chrome-error://`）に替わった・閉じたら、その幅を終えて次へ進む（発見の側の
//   `documentGoneOf` と同じ考え方。Playwright の 1 手には期限を付けない）。
import type { Page } from 'playwright';
import { describe, expect, it } from 'vitest';
import { auditDocumentLeftCause, stressWidthIncompleteReasonOf, stressWidthSessionCloser } from '../../src/orchestration/stress-width-end.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';

const pageAt = (url: string, closed = false): Page => ({ isClosed: () => closed, url: () => url, mainFrame: () => ({ url: () => url }) }) as unknown as Page;

describe('the end of a stress width', () => {
  it('names a closed width SAFETY_VIOLATION_ABORT only when a violation is recorded (B)', () => {
    expect(stressWidthIncompleteReasonOf('PAGE_CLOSED', true)).toBe('SAFETY_VIOLATION_ABORT');
    expect(stressWidthIncompleteReasonOf('PAGE_CLOSED', false)).toBe('PAGE_CLOSED');
    expect(stressWidthIncompleteReasonOf('NAVIGATION_FAILED', true)).toBe('NAVIGATION_FAILED');
  });

  // DEF-247: 幅を早く終えるときも、その幅の session の閉じる口（factory が持ち主として Context ごと閉じる）を使う。page だけを閉じると、Guard が印のない
  // session の切れを違反にする。早く終える所と、collector の後片付けの両方から呼んでも、閉じるのは 1 回だけ（session の 2 回目の close は reject する）。
  it('closes the width session once, however many times the early end and the cleanup ask (DEF-247)', async () => {
    let closes = 0;
    const close = stressWidthSessionCloser(async () => {
      closes += 1;
    });
    await Promise.all([close(), close()]);
    await close();
    expect(closes).toBe(1);
  });

  // C と DEF-250 の c（幅の走査と Passive の page の共通の判定）: main frame の外部スキームへの移動の記録が入るか、読み込んだ後に文書が消えたら、その原因を返す。
  it('tells why the page cannot be used: a main frame move to an external scheme, or a gone document (C, DEF-250 c)', () => {
    const external = new SafetyLedger();
    external.recordExternalSchemeNavigation({ url: 'mailto:a@example.test', scheme: 'mailto', frame: 'MAIN', phase: 'PASSIVE', reason: 'EXTERNAL_SCHEME_NAVIGATION' });
    const subFrame = new SafetyLedger();
    subFrame.recordExternalSchemeNavigation({ url: 'tel:0000', scheme: 'tel', frame: 'SUB', phase: 'PASSIVE', reason: 'EXTERNAL_SCHEME_NAVIGATION' });
    const clean = new SafetyLedger().snapshot();
    // 外部スキームの記録は、読み込みの前でも見る。子の frame の記録では、page は使える。
    expect(auditDocumentLeftCause(pageAt('about:blank'), [external.snapshot()], false)).toBe('EXTERNAL_SCHEME');
    expect(auditDocumentLeftCause(pageAt('https://example.test/'), [subFrame.snapshot()], true)).toBeNull();
    expect(auditDocumentLeftCause(pageAt('chrome-error://chromewebdata/'), [clean], true)).toBe('DOCUMENT_GONE');
    expect(auditDocumentLeftCause(pageAt('https://example.test/', true), [clean], true)).toBe('DOCUMENT_GONE');
    expect(auditDocumentLeftCause(pageAt('https://example.test/'), [clean], true)).toBeNull();
    // 読み込む前の page（`about:blank`）は、文書が消えたとみなさない。
    expect(auditDocumentLeftCause(pageAt('about:blank'), [clean], false)).toBeNull();
  });
});
