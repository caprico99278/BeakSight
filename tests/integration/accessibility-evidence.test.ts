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

      const evidence = await collectAccessibilityEvidence(page, { deadlineAtMs: Date.now() + 20_000 });

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
});
