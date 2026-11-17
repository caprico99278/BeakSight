// AUD-4b（整理の文書 `doc/design/2026-11-09-beaksight-audit-precision-triage.md` の AUD-4b）の結合のテスト（既定の Chromium。サーバは 127.0.0.1 だけ）。
// 名前の不一致の要素ごとに、CDP の Accessibility から、算出した名前・役割・無効の状態・命名元と、見えるラベルの文字のかたまりを読む（ページの main world で JS を
// 動かさない）。色差の要素の AX の無効の状態も読む。AX を読んでも、サーバへの要求は増えない。
import type { Browser } from 'playwright';
import { afterEach, describe, expect, it } from 'vitest';
import { labelInNameOf } from '../../src/audit/label-in-name.js';
import { BrowserContextFactory } from '../../src/browser/context-factory.js';
import type { AccessibilityNodeEvidence } from '../../src/core/evidence-types.js';
import { readAccessibilityAxFacts } from '../../src/evidence/accessibility-ax.js';
import { collectAccessibilityEvidence } from '../../src/evidence/accessibility-collector.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';
import { useHeadlessChromium } from '../helpers/chromium.js';
import { withGuardedPassivePage } from '../helpers/gate-harness.js';
import { startLoopbackHttpServer, type LoopbackHttpServer } from '../helpers/loopback-server.js';
import { createTestConfig, TEST_FACTORY_OPTIONS } from '../helpers/test-config.js';

const TEST_TIMEOUT_MS = 3 * 60_000;

const PAGE = '<!doctype html><html lang="ja"><head><meta charset="utf-8"><link rel="icon" href="data:,"><title>name context</title></head><body><main>'
  + '<h1>見出し</h1>'
  // 補足つきのラベル（バッジの「3」）。名前は「設定」。
  + '<button id="badge" aria-label="設定">設定 <span>3</span></button>'
  // 規則違反のラベル（見える文字「送信」、名前「button-1」）。
  + '<button id="wrong" aria-label="button-1">送信</button>'
  // 無効の操作と有効の操作（色差が足りない文字）。
  + '<button id="off" disabled style="color: #aaa; background: #fff">押せない</button>'
  + '<button id="on" style="color: #aaa; background: #fff">押せる</button>'
  + '</main></body></html>';

let browser: Browser;
let server: LoopbackHttpServer | undefined;
let requestCount = 0;

useHeadlessChromium((launched) => {
  browser = launched;
});

afterEach(async () => {
  await server?.close();
  server = undefined;
});

const nodeOf = (nodes: readonly AccessibilityNodeEvidence[], selector: string): AccessibilityNodeEvidence | undefined =>
  nodes.find((node) => JSON.stringify(node.targetSelectors) === JSON.stringify([selector]));

describe('AUD-4b: the name context of the label-in-name violations from the accessibility tree', () => {
  it('records the computed name, the role, the naming source and the visible label pieces, and does not send any request for it', async () => {
    server = await startLoopbackHttpServer((request, response) => {
      requestCount += 1;
      if (request.url === '/name-context') {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(PAGE);
        return;
      }
      response.writeHead(404).end();
    });
    const { origin } = server;
    const factory = new BrowserContextFactory(browser, createTestConfig(origin, '/'), () => new SafetyLedger(), TEST_FACTORY_OPTIONS);
    await withGuardedPassivePage(factory, { width: 800, height: 600 }, async (page) => {
      await page.goto(`${origin}/name-context`, { waitUntil: 'load' });
      const before = requestCount;
      const evidence = await collectAccessibilityEvidence(page);
      const axDirect = await readAccessibilityAxFacts(page, [[ '#off' ], [ '#on' ], [ '#missing' ]]);
      // AX を読んでも（axe の後の読み取りを含む）、サーバへの要求は増えない。
      expect(requestCount).toBe(before);

      const mismatch = evidence.violations.find((rule) => rule.ruleId === 'label-content-name-mismatch')?.nodes ?? [];
      const wrong = nodeOf(mismatch, '#wrong');
      expect(wrong?.nameContext).toEqual({
        status: 'READ',
        axName: 'button-1',
        axRole: 'button',
        axDisabled: false,
        nameSource: { type: 'attribute', attribute: 'aria-label' },
        labelSegments: ['送信'],
      });
      const wrongContext = wrong?.nameContext;
      expect(wrongContext?.status === 'READ' ? labelInNameOf({ name: wrongContext.axName, segments: wrongContext.labelSegments }).labelClass : null)
        .toBe('MAIN_LABEL_MISSING');
      const badge = nodeOf(mismatch, '#badge');
      expect(badge?.nameContext).toMatchObject({ status: 'READ', axName: '設定', labelSegments: ['設定 ', '3'] });
      const badgeContext = badge?.nameContext;
      expect(badgeContext?.status === 'READ' ? labelInNameOf({ name: badgeContext.axName, segments: badgeContext.labelSegments }).labelClass : null)
        .toBe('SUPPLEMENT_ONLY_MISSING');

      // 色差の要素の無効の事実に、AX の無効の状態が入る（有効の操作は偽）。
      const contrast = evidence.violations.find((rule) => rule.ruleId === 'color-contrast')?.nodes ?? [];
      expect(nodeOf(contrast, '#on')?.disabledFacts).toMatchObject({ status: 'READ', axDisabled: false, disabledForAssistiveTech: false });
      // 無効の操作と有効の操作の AX の状態（axe は無効の操作を色差で数えないので、読み取りの部品で直に確かめる）。
      expect(axDirect).toEqual([
        expect.objectContaining({ status: 'READ', axDisabled: true }),
        expect.objectContaining({ status: 'READ', axDisabled: false }),
        { status: 'UNREADABLE', reason: 'NOT_FOUND' },
      ]);
    });
  }, TEST_TIMEOUT_MS);
});
