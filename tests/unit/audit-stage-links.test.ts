// OP-R（設計書 `2026-10-27-beaksight-one-pass-flow-design.md` 4.1.9 の R1・R2）: 点検の段の成果物から見つけたリンクを読む共通の部品（`readAuditStageLinks`。J1 の
// 読み方を、ワーカーの操作さがしの段と画面のサーバの自動の下書きが共有する）。ページの ID の順・文書の順に、Desktop の `link` の Evidence の、受け入れが
// `INTERNAL_NAVIGABLE` で正規化できたリンクだけを読む。形の違う行・読めないファイル・ページの ID でない名前は飛ばす。出力先は一時のフォルダだけ。
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  auditStageLinksOfEvidence, auditStagePageWithoutDiscoveryCandidates, readAuditStageLinks, readAuditStagePages,
} from '../../src/core/audit-stage-links.js';

const ORIGIN = 'https://app.example.com';
const linkOf = (path: string, kind = 'INTERNAL_NAVIGABLE'): Record<string, unknown> => ({
  anchorText: path, ariaLabel: null, title: null, normalized: { ok: true, url: `${ORIGIN}${path}` }, admission: { kind },
});
const evidenceOf = (viewport: string, links: readonly Record<string, unknown>[]): Record<string, unknown> => ({ type: 'link', viewport, payload: { links } });

describe('OP-R: the links found by the audit stage (readAuditStageLinks)', () => {
  let directory = '';

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'beaksight-audit-stage-links-'));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  const writePage = async (pageId: string, content: string): Promise<void> => {
    await mkdir(join(directory, 'pages', pageId), { recursive: true });
    await writeFile(join(directory, 'pages', pageId, 'page.json'), content, 'utf8');
  };

  it('reads the admitted desktop links in the order of the page ids and of the document, and skips the rest', async () => {
    await writePage('PAGE-000002', JSON.stringify({ evidence: [evidenceOf('desktop', [linkOf('/admin/members'), linkOf('/outside', 'EXTERNAL')])] }));
    await writePage('PAGE-000001', JSON.stringify({ evidence: [evidenceOf('mobile', [linkOf('/mobile')]), evidenceOf('desktop', [linkOf('/admin')])] }));
    await writePage('PAGE-000003', '{ not json');
    await writePage('not-a-page', JSON.stringify({ evidence: [evidenceOf('desktop', [linkOf('/ignored')])] }));
    expect((await readAuditStageLinks(directory)).map(({ url }) => url)).toEqual([`${ORIGIN}/admin`, `${ORIGIN}/admin/members`]);
  });

  it('returns nothing for a directory without pages', async () => {
    expect(await readAuditStageLinks(join(directory, 'missing'))).toEqual([]);
  });

  it('DSEED: reads the URLs of the pages the audit stage read in its order, leaving out the pages outside the audit scope', async () => {
    const outside = { code: 'NAVIGATION_FAILED', detail: 'BLOCKED_EXTERNAL_REDIRECT' };
    const viewports = (reasons: readonly unknown[] = []) => ({ desktop: { incompleteReasons: reasons }, mobile: { incompleteReasons: [] } });
    await writePage('PAGE-000003', JSON.stringify({ pageUrl: `${ORIGIN}/away`, status: 'FAILED', incompleteReasons: [], viewports: viewports([outside]) }));
    await writePage('PAGE-000002', JSON.stringify({ pageUrl: `${ORIGIN}/broken`, status: 'FAILED', incompleteReasons: [{ code: 'NAVIGATION_FAILED', detail: null }], viewports: viewports() }));
    await writePage('PAGE-000001', JSON.stringify({ pageUrl: `${ORIGIN}/`, status: 'AUDITED', incompleteReasons: [], viewports: viewports() }));
    await writePage('PAGE-000004', '{ not json');
    expect((await readAuditStagePages(directory)).map(({ url }) => url)).toEqual([`${ORIGIN}/`, `${ORIGIN}/broken`]);
    expect(await readAuditStagePages(join(directory, 'missing'))).toEqual([]);
  });

  it('SKIP-1: a page is without pressable elements only when the DOM of both viewports counts none (a SAME page uses the Desktop count)', () => {
    const dom = (viewport: string, count?: number): Record<string, unknown> =>
      ({ type: 'dom', viewport, payload: count === undefined ? {} : { discoveryCandidateCount: count } });
    const pageOf = (evidence: readonly unknown[], extra: Record<string, unknown> = {}): Record<string, unknown> => ({ pageUrl: `${ORIGIN}/`, evidence, ...extra });
    expect(auditStagePageWithoutDiscoveryCandidates(pageOf([dom('desktop', 0), dom('mobile', 0)]))).toBe(true);
    expect(auditStagePageWithoutDiscoveryCandidates(pageOf([dom('desktop', 0), dom('mobile', 1)]))).toBe(false);
    expect(auditStagePageWithoutDiscoveryCandidates(pageOf([dom('desktop', 0), dom('mobile')]))).toBe(false);
    expect(auditStagePageWithoutDiscoveryCandidates(pageOf([dom('desktop', 0)]))).toBe(false);
    expect(auditStagePageWithoutDiscoveryCandidates(pageOf([dom('desktop', 0)], { sameness: { depth: 'SAME', sameAs: 'PAGE-000001' } }))).toBe(true);
    expect(auditStagePageWithoutDiscoveryCandidates(pageOf([dom('desktop', 2)], { sameness: { depth: 'SAME', sameAs: 'PAGE-000001' } }))).toBe(false);
    expect(auditStagePageWithoutDiscoveryCandidates(pageOf([]))).toBe(false);
  });

  it('reads no link from a record of another shape', () => {
    expect(auditStageLinksOfEvidence(null)).toEqual([]);
    expect(auditStageLinksOfEvidence({ type: 'link', viewport: 'desktop', payload: { links: [{ ...linkOf('/a'), anchorText: 1 }] } })).toEqual([]);
    expect(auditStageLinksOfEvidence({ type: 'link', viewport: 'desktop', payload: { links: [{ ...linkOf('/a'), normalized: { ok: false } }] } })).toEqual([]);
  });
});
