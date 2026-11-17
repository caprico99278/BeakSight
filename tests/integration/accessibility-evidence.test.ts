import type { Browser } from 'playwright';
import { afterEach, describe, expect, it } from 'vitest';
import { BrowserContextFactory } from '../../src/browser/context-factory.js';
import { collectAccessibilityEvidence } from '../../src/evidence/accessibility-collector.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';
import { startFixtureServer, type FixtureServer } from '../../fixtures/server.js';
import { useHeadlessChromium } from '../helpers/chromium.js';
import { withGuardedPassivePage } from '../helpers/gate-harness.js';
import { createTestConfig } from '../helpers/test-config.js';

let browser: Browser;
let server: FixtureServer | undefined;

useHeadlessChromium((launched) => {
  browser = launched;
});

afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe('accessibility evidence in a guarded Chromium lifecycle', () => {
  it('keeps axe incomplete (needs review) results apart from violations within a deadline', async () => {
    const fixtureServer = await startFixtureServer();
    server = fixtureServer;
    const factory = new BrowserContextFactory(
      browser,
      createTestConfig(fixtureServer.origin, '/bad-contrast.html'),
      () => new SafetyLedger(),
    );
    await withGuardedPassivePage(factory, { width: 800, height: 600 }, async (page) => {
      await page.goto(`${fixtureServer.origin}/bad-contrast.html`, { waitUntil: 'load' });

      const evidence = await collectAccessibilityEvidence(page);

      expect(evidence.status).toBe('COMPLETE');
      expect(evidence.violations.some((rule) => rule.ruleId === 'color-contrast')).toBe(true);
      const incompleteContrast = evidence.incomplete.find((rule) => rule.ruleId === 'color-contrast');
      expect(incompleteContrast?.nodes.map((node) => node.targetSelectors.flat()).flat()).toContain('#image-ambiguous');
      expect(evidence.violations.flatMap((rule) => rule.nodes).some((node) => (
        node.targetSelectors.flat().includes('#image-ambiguous')
      ))).toBe(false);
      expect(Object.isFrozen(evidence.incomplete)).toBe(true);
      expect(fixtureServer.getCounters()).toMatchObject({ post: 0, put: 0, patch: 0, delete: 0 });
    });
  });

  it('AUD-8: keeps the contrast check data, the reason it could not be measured, and the disabled facts', async () => {
    const fixtureServer = await startFixtureServer();
    server = fixtureServer;
    const factory = new BrowserContextFactory(
      browser,
      createTestConfig(fixtureServer.origin, '/disabled-contrast.html'),
      () => new SafetyLedger(),
    );
    await withGuardedPassivePage(factory, { width: 800, height: 600 }, async (page) => {
      await page.goto(`${fixtureServer.origin}/disabled-contrast.html`, { waitUntil: 'load' });

      const evidence = await collectAccessibilityEvidence(page);

      expect(evidence.status).toBe('COMPLETE');
      const contrastNodes = evidence.violations.filter((rule) => rule.ruleId === 'color-contrast').flatMap((rule) => rule.nodes);
      const nodeOf = (id: string) => contrastNodes.find((node) => node.targetSelectors.flat().includes(`#${id}`));
      // axe は disabled のボタンを色差の対象から外す（数えない）。
      expect(nodeOf('disabled-button')).toBeUndefined();
      // 見た目だけ無効のリンク: Finding の元に残し、「無効の状態を支援技術に伝えていない」の事実を付ける。
      const link = nodeOf('visual-disabled-link');
      expect(link).toMatchObject({
        countExclusion: null,
        disabledFacts: { status: 'READ', cursor: 'not-allowed', pointerEvents: 'none', disabledForAssistiveTech: false, disabledStateNotExposed: true },
      });
      expect(link?.checks?.[0]).toMatchObject({ id: 'color-contrast', result: 'FAILED' });
      expect(Object.keys(link?.checks?.[0]?.data ?? {})).toEqual(expect.arrayContaining(['fgColor', 'bgColor', 'contrastRatio', 'fontSize', 'fontWeight']));
      // 薄いだけの文字は、無効の事実を付けない。
      expect(nodeOf('faint-text')).toMatchObject({ disabledFacts: { status: 'READ', disabledStateNotExposed: false }, countExclusion: null });
      // 背景がグラデーションの文字は測定できない（理由の鍵を残す）。
      const gradient = evidence.incomplete
        .filter((rule) => rule.ruleId === 'color-contrast')
        .flatMap((rule) => rule.nodes)
        .find((node) => node.targetSelectors.flat().includes('#gradient-text'));
      expect(gradient?.checks?.[0]).toMatchObject({ result: 'UNDETERMINED', messageKey: 'bgGradient' });
      expect(fixtureServer.getCounters()).toMatchObject({ post: 0, put: 0, patch: 0, delete: 0 });
    });
  });
});
