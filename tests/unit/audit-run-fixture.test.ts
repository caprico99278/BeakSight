// C16b（CC-024。Task 14〜17 の設計書 6.1.3、6.1.8、6.1.9）: 表示のテストが使う Run の見本（`tests/helpers/audit-run-fixture.ts`）。
// 見本は、どれもスキーマに合う。既定値を上書きでき、呼ぶたびに新しい値を作る。
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { screenshotRelativePath } from '../../src/core/artifact-layout.js';
import type { AuditRunResult, EvidenceRecord } from '../../src/core/contracts.js';
import { INTERACTION_REASON_CODES_BY_STATUS, type InteractionEvidence } from '../../src/core/evidence-types.js';
import { createEvidenceId, createFindingId } from '../../src/core/ids.js';
import { validateArtifact } from '../../src/core/schema-validator.js';
import { deriveRunStatus } from '../../src/core/status.js';
import { ArtifactWriter } from '../../src/report/artifact-writer.js';
import {
  FIXTURE_OBSERVED_AT,
  FIXTURE_ORIGIN,
  FIXTURE_RUN_ID,
  HOSTILE_STRINGS,
  HOSTILE_TEXT,
  JAPANESE_TEXT,
  PAGE_1,
  PAGE_2,
  PAGE_3,
  SPECIAL_SCHEME_URLS,
  auditRun,
  dom,
  edgeCaseAuditRun,
  finding,
  fixtureUrl,
  idOf,
  interaction,
  metadata,
  page,
  record,
  retry,
  runStatusInput,
  runSummary,
  safety,
  screenshot,
  viewportResult,
} from '../helpers/audit-run-fixture.js';

const workDirectories: string[] = [];

afterEach(async () => {
  for (const directory of workDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

/** run.json、audit.json、各ページの page.json、各 Finding を、それぞれのスキーマで検証した結果の一覧（合わないものだけ）。 */
async function schemaErrorsOf(result: AuditRunResult): Promise<string[]> {
  const audit = { schemaVersion: 'audit-schema/1.0', run: result.run, pages: result.pages, findings: result.findings };
  const checks: [string, Promise<unknown>][] = [
    ['run', validateArtifact('run', result.run)],
    ['audit', validateArtifact('audit', audit)],
    ...result.pages.map((value): [string, Promise<unknown>] => [`page:${value.pageId}`, validateArtifact('page', value)]),
    ...result.findings.map((value): [string, Promise<unknown>] => [`finding:${value.findingId}`, validateArtifact('finding', value)]),
  ];
  const errors: string[] = [];
  for (const [name, check] of checks) {
    const outcome = await check;
    if (JSON.stringify(outcome) !== JSON.stringify({ ok: true })) {
      errors.push(`${name}: ${JSON.stringify(outcome)}`);
    }
  }
  return errors;
}

/** 値と、その中のオブジェクトのうち、凍結されているものの場所の一覧。 */
function frozenPaths(value: unknown, path = '$'): string[] {
  if (typeof value !== 'object' || value === null) {
    return [];
  }
  return [
    ...(Object.isFrozen(value) ? [path] : []),
    ...Object.entries(value).flatMap(([key, child]) => frozenPaths(child, `${path}.${key}`)),
  ];
}

const allEvidence = (result: AuditRunResult): EvidenceRecord[] => result.pages.flatMap((value) => value.evidence);

describe('auditRun: the default Run', () => {
  it('builds run.json, audit.json, page.json and Findings that match their schemas', async () => {
    const result = auditRun();
    expect(await schemaErrorsOf(result)).toEqual([]);
    expect(deriveRunStatus(result.statusInput)).toBe(result.run.runStatus);
    expect(result.run.runStatus).toBe('COMPLETE');
    expect(result.run.runId).toBe(FIXTURE_RUN_ID);
    expect(result.run.startUrl).toBe(`${FIXTURE_ORIGIN}/`);
  });

  it('is written by ArtifactWriter without an invalid artifact, keeping its Run Status', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'beaksight-audit-run-fixture-'));
    workDirectories.push(directory);
    const result = auditRun();
    const written = await new ArtifactWriter().writeRun(result, { outputDirectory: directory });
    expect(written.invalidArtifacts).toEqual([]);
    expect(written.schemaValid).toBe(true);
    expect(written.result.run).toEqual(result.run);
  });

  it('has one audited page with metadata, DOM, screenshots of both viewports, an Interaction and Safety, and one Finding', () => {
    const result = auditRun();
    expect(result.pages.map((value) => [value.pageId, value.pageUrl, value.status])).toEqual([[PAGE_1, fixtureUrl('/'), 'AUDITED']]);
    expect(allEvidence(result).map((evidence) => [evidence.type, evidence.viewport])).toEqual([
      ['metadata', null],
      ['dom', 'desktop'],
      ['screenshot', 'desktop'],
      ['screenshot', 'desktop'],
      ['dom', 'mobile'],
      ['screenshot', 'mobile'],
      ['interaction', 'desktop'],
      ['safety', 'desktop'],
    ]);
    expect(result.findings).toHaveLength(1);
    expect(result.findings).toEqual(result.pages[0]?.findings);
    expect(result.findings[0]?.evidenceRefs).toEqual([allEvidence(result)[1]?.evidenceId]);
    expect(result.run.retries).toEqual([]);
  });

  it('builds new, unfrozen values on every call', () => {
    const first = auditRun();
    const second = auditRun();
    expect(second).toEqual(first);
    expect(second).not.toBe(first);
    expect(second.run).not.toBe(first.run);
    expect(second.pages[0]).not.toBe(first.pages[0]);
    expect(second.statusInput.incompleteReasons).not.toBe(first.statusInput.incompleteReasons);
    expect(frozenPaths(first)).toEqual([]);
  });
});

describe('auditRun and runSummary: overrides', () => {
  it('overrides the run summary, the pages, the Findings and a part of the Run Status input', () => {
    const shot = screenshot(1, PAGE_2, 'mobile');
    const pageFinding = finding(2, 'ERROR', 'HTTP', PAGE_2, [idOf(shot)]);
    const crossPage = finding(3, 'WARN', 'CROSS_PAGE', null, [idOf(shot)]);
    const pages = [page(PAGE_2, '/second.html', 'AUDITED', [shot], [pageFinding])];
    const result = auditRun({
      run: { runStatus: 'PARTIAL', toolVersion: '9.9.9' },
      pages,
      statusInput: { notVerifiedRequiredWork: 1 },
    });
    expect(result.run.runStatus).toBe('PARTIAL');
    expect(result.run.toolVersion).toBe('9.9.9');
    expect(result.run.runId).toBe(FIXTURE_RUN_ID);
    expect(result.pages).toBe(pages);
    // Findings を渡さない場合は、各ページの Finding を、ページの順に並べる。
    expect(result.findings).toEqual([pageFinding]);
    expect(result.statusInput).toEqual(runStatusInput({ notVerifiedRequiredWork: 1 }));
    expect(deriveRunStatus(result.statusInput)).toBe('PARTIAL');

    expect(auditRun({ pages, findings: [crossPage, pageFinding] }).findings).toEqual([crossPage, pageFinding]);
  });

  it('keeps every other field of the run summary, and gives a COMPLETE Run Status input by default', () => {
    expect(runSummary({ discoveredPageCount: 7 })).toEqual({ ...runSummary(), discoveredPageCount: 7 });
    expect(deriveRunStatus(runStatusInput())).toBe('COMPLETE');
    expect(runStatusInput({ crawlLimitReached: true })).toEqual({ ...runStatusInput(), crawlLimitReached: true });
  });

  it('builds a retry record from the Evidence of the attempt before the retry', () => {
    const before = dom(1, PAGE_1, 'desktop', 'before');
    expect(retry(fixtureUrl('/'), 1, [before])).toEqual({
      url: fixtureUrl('/'),
      attempt: 1,
      navigationOutcome: 'TIMEOUT',
      detail: 'TIMEOUT',
      evidenceIds: [idOf(before)],
    });
    expect(retry(fixtureUrl('/'), 2, [], { navigationOutcome: 'FAILED', detail: 'net::ERR_FAILED' })).toMatchObject({
      attempt: 2,
      navigationOutcome: 'FAILED',
      detail: 'net::ERR_FAILED',
      evidenceIds: [],
    });
  });
});

describe('Evidence builders', () => {
  it('build Evidence of every builder that matches the page schema', async () => {
    const evidence: EvidenceRecord[] = [
      metadata(1, PAGE_1),
      metadata(2, PAGE_1, { outcome: 'NOT_FOUND', httpStatus: 404, text: null }),
      dom(3, PAGE_1, 'desktop', '本文'),
      dom(4, PAGE_1, 'mobile', 'text', { title: null, lang: null }),
      screenshot(5, PAGE_1, 'desktop'),
      screenshot(6, PAGE_1, 'mobile', 'FULL_PAGE', 2),
      interaction(7, PAGE_1, 'VERIFIED', null),
      interaction(8, PAGE_1, 'NOT_VERIFIABLE', 'OBSERVED_NO_CHANGE', { viewport: 'mobile' }),
      interaction(9, PAGE_1, 'NOT_VERIFIABLE', 'CHECK_NOT_COMPLETED'),
      interaction(10, PAGE_1, 'EXECUTION_FAILED', null),
      interaction(11, PAGE_1, 'REJECTED_UNSAFE', null),
      interaction(12, PAGE_1, 'BLOCKED_BY_SAFETY', null),
      safety(13, PAGE_1),
      safety(14, PAGE_1, 'mobile', { scope: 'INTERACTION', blockedRequestsByMethod: { POST: 1 } }),
      record('metadata', 15, PAGE_1, null, {
        kind: 'SITEMAP_XML',
        url: fixtureUrl('/sitemap.xml'),
        outcome: 'OK',
        httpStatus: 200,
        text: '<urlset></urlset>',
        textTruncated: false,
        sitemapUrls: [fixtureUrl('/')],
        sitemapUrlsTruncated: false,
      }),
    ];
    await expect(validateArtifact('page', page(PAGE_1, '/', 'AUDITED', evidence))).resolves.toEqual({ ok: true });
  });

  it('give each Evidence the ID of its type and sequence, the page, the viewport and the observed time', () => {
    expect(record('safety', 3, PAGE_2, null, safety(1, PAGE_2).payload)).toMatchObject({
      evidenceId: createEvidenceId('safety', 3),
      type: 'safety',
      pageId: PAGE_2,
      viewport: null,
      observedAt: FIXTURE_OBSERVED_AT,
    });
    expect(metadata(4, PAGE_1)).toMatchObject({ evidenceId: createEvidenceId('metadata', 4), viewport: null });
    expect(safety(5, PAGE_1).viewport).toBe('desktop');
    expect(interaction(6, PAGE_1, 'VERIFIED', null).viewport).toBe('desktop');
  });

  it('make the screenshot path with screenshotRelativePath, for the final attempt and for an attempt before a retry', () => {
    expect(screenshot(1, PAGE_1, 'desktop').payload).toEqual({
      pageId: PAGE_1,
      viewport: 'desktop',
      relativePath: screenshotRelativePath(PAGE_1, 'desktop', 'VIEWPORT', null),
      captureType: 'VIEWPORT',
      scrollPosition: { scrollX: 0, scrollY: 0 },
    });
    expect(screenshot(2, PAGE_1, 'desktop', 'VIEWPORT', 1).payload.relativePath).toBe('pages/PAGE-000001/retry-1/desktop/viewport.png');
    expect(screenshot(3, PAGE_2, 'mobile', 'FULL_PAGE').payload.relativePath).toBe(screenshotRelativePath(PAGE_2, 'mobile', 'FULL_PAGE', null));
  });

  it('put the visible text in the DOM Evidence, and apply the overrides of the payload', () => {
    const value = dom(1, PAGE_1, 'desktop', '日本語の本文', { title: 'タイトル' });
    expect(value.payload.visibleText.text).toBe('日本語の本文');
    expect(value.payload.title).toBe('タイトル');
    expect(value.payload.pageId).toBe(PAGE_1);
  });

  it('give an Interaction its status, kind, target and reason, with options', () => {
    const value = interaction(8, PAGE_1, 'NOT_VERIFIABLE', 'CHECK_NOT_COMPLETED');
    const payload: InteractionEvidence = value.payload;
    // C18n: 理由は status に合うコードの一覧の最初のコード、詳細は `reason <番号>`。work も同じ。lifecycle の理由はない。
    expect(payload).toMatchObject({
      status: 'NOT_VERIFIABLE',
      notVerifiableKind: 'CHECK_NOT_COMPLETED',
      reason: INTERACTION_REASON_CODES_BY_STATUS.NOT_VERIFIABLE[0],
      reasonDetail: 'reason 8',
    });
    expect(payload.work).toMatchObject({
      status: 'NOT_VERIFIABLE',
      reason: INTERACTION_REASON_CODES_BY_STATUS.NOT_VERIFIABLE[0],
      reasonDetail: 'reason 8',
    });
    expect(payload.lifecycle).toEqual({ status: 'CLOSED', reason: null, reasonDetail: null });
    expect(interaction(10, PAGE_1, 'VERIFIED', null).payload.reason).toBe('OBSERVABLE_STATE_CHANGED');
    expect(payload.evidence.before).toMatchObject({ tagName: 'button', role: null, accessibleName: 'Button 8', candidateId: payload.candidateId });
    expect(payload.candidateId).toMatch(/^interaction-candidate:sha256:[a-f0-9]{64}$/u);
    expect(interaction(9, PAGE_1, 'VERIFIED', null).payload.candidateId).not.toBe(payload.candidateId);

    const custom = interaction(9, PAGE_2, 'EXECUTION_FAILED', null, {
      viewport: 'mobile',
      reason: 'CLICK_FAILED',
      reasonDetail: 'custom',
      accessibleName: 'メニュー',
    });
    expect(custom.viewport).toBe('mobile');
    expect(custom.payload.reason).toBe('CLICK_FAILED');
    expect(custom.payload.reasonDetail).toBe('custom');
    expect(custom.payload.work.reason).toBe('CLICK_FAILED');
    expect(custom.payload.work.reasonDetail).toBe('custom');
    const withoutDetail = interaction(9, PAGE_2, 'EXECUTION_FAILED', null, { reasonDetail: null });
    expect(withoutDetail.payload.reasonDetail).toBeNull();
    expect(withoutDetail.payload.work.reasonDetail).toBeNull();
    expect(custom.payload.evidence.before?.accessibleName).toBe('メニュー');
  });

  it('apply the overrides of the metadata and Safety payloads', () => {
    expect(metadata(1, PAGE_1, { httpStatus: 500, outcome: 'FAILED', text: null }).payload).toMatchObject({
      kind: 'ROBOTS_TXT',
      url: fixtureUrl('/robots.txt'),
      outcome: 'FAILED',
      httpStatus: 500,
      text: null,
    });
    const events = safety(2, PAGE_1, 'desktop', { blockedRequestsByMethod: { POST: 2 } }).payload;
    expect(events.blockedRequestsByMethod).toEqual({ POST: 2 });
    expect(events.scope).toBe('PASSIVE');
    expect(events.blockedRequests).toEqual([]);
    expect(events.recordLimits.truncated).toBe(false);
  });
});

describe('finding, viewportResult and page', () => {
  it('builds a Finding of the page, or a cross-page Finding without a page, with overrides', () => {
    const refs = [createEvidenceId('dom', 1)];
    expect(finding(3, 'ERROR', 'HTTP', PAGE_2, refs)).toEqual({
      schemaVersion: 'finding-schema/1.0',
      findingId: createFindingId(3),
      fingerprint: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u) as unknown,
      ruleId: 'TEST_RULE_3',
      ruleVersion: 1,
      category: 'HTTP',
      severity: 'ERROR',
      pageId: PAGE_2,
      pageUrl: fixtureUrl('/second.html'),
      viewport: 'desktop',
      message: 'テストの指摘 3',
      evidenceRefs: refs,
    });
    expect(finding(4, 'WARN', 'CROSS_PAGE', null, refs)).toMatchObject({ pageId: null, pageUrl: null, viewport: null });
    expect(finding(5, 'INFO', 'LINK', PAGE_1, refs, { pageUrl: SPECIAL_SCHEME_URLS.mailto, viewport: 'mobile' })).toMatchObject({
      pageUrl: SPECIAL_SCHEME_URLS.mailto,
      viewport: 'mobile',
    });
    expect(finding(6, 'INFO', 'LINK', PAGE_1, refs).fingerprint).not.toBe(finding(7, 'INFO', 'LINK', PAGE_1, refs).fingerprint);
  });

  it('builds the viewport result of an audited and a skipped viewport, with overrides', () => {
    expect(viewportResult(fixtureUrl('/'), 'AUDITED')).toEqual({
      requestedUrl: fixtureUrl('/'),
      finalUrl: fixtureUrl('/'),
      httpStatus: 200,
      status: 'AUDITED',
      incompleteReasons: [],
      navigationOutcome: 'OK',
    });
    expect(viewportResult(fixtureUrl('/'), 'SKIPPED')).toEqual({
      requestedUrl: fixtureUrl('/'),
      finalUrl: null,
      httpStatus: null,
      status: 'SKIPPED',
      incompleteReasons: [{ code: 'MAX_PAGES_REACHED', detail: null }],
      navigationOutcome: null,
    });
    expect(viewportResult(fixtureUrl('/'), 'FAILED', { navigationOutcome: 'TIMEOUT', finalUrl: null })).toMatchObject({
      status: 'FAILED',
      navigationOutcome: 'TIMEOUT',
      finalUrl: null,
    });
  });

  it('builds a page with both viewports, the given state, Evidence and Findings, with overrides', async () => {
    const evidence = [dom(1, PAGE_3, 'desktop', 'x')];
    const audited = page(PAGE_3, '/third.html', 'AUDITED', evidence);
    expect(audited).toMatchObject({ pageId: PAGE_3, pageUrl: fixtureUrl('/third.html'), status: 'AUDITED', evidence, findings: [], incompleteReasons: [] });
    expect(audited.viewports).toEqual({
      desktop: viewportResult(fixtureUrl('/third.html'), 'AUDITED'),
      mobile: viewportResult(fixtureUrl('/third.html'), 'AUDITED'),
    });

    const skipped = page(PAGE_3, '/skipped.html', 'SKIPPED');
    expect(skipped).toMatchObject({ status: 'SKIPPED', evidence: [], findings: [], incompleteReasons: [{ code: 'MAX_PAGES_REACHED', detail: null }] });
    expect(skipped.viewports.mobile.status).toBe('SKIPPED');

    const failed = page(PAGE_3, '/failed.html', 'FAILED', [], [], {
      incompleteReasons: [{ code: 'NAVIGATION_FAILED', detail: 'TIMEOUT' }],
    });
    expect(failed.incompleteReasons).toEqual([{ code: 'NAVIGATION_FAILED', detail: 'TIMEOUT' }]);
    for (const value of [audited, skipped, failed]) {
      await expect(validateArtifact('page', value)).resolves.toEqual({ ok: true });
    }
  });
});

describe('edgeCaseAuditRun: the Run for the HTML and bundle tests', () => {
  it('matches the schemas, with the Run Status that deriveRunStatus gives', async () => {
    const result = edgeCaseAuditRun();
    expect(await schemaErrorsOf(result)).toEqual([]);
    expect(deriveRunStatus(result.statusInput)).toBe(result.run.runStatus);
  });

  it('has the dangerous strings, the mailto and tel URLs, and Japanese text in the displayed values', () => {
    const result = edgeCaseAuditRun();
    const json = JSON.stringify(result);
    expect(HOSTILE_TEXT).toContain('<script>');
    expect(HOSTILE_TEXT).toContain('"onerror=');
    expect(HOSTILE_TEXT).toContain('javascript:');
    for (const value of [...Object.values(HOSTILE_STRINGS), ...Object.values(SPECIAL_SCHEME_URLS), JAPANESE_TEXT]) {
      expect(json).toContain(JSON.stringify(value).slice(1, -1));
    }
    expect(SPECIAL_SCHEME_URLS.mailto.startsWith('mailto:')).toBe(true);
    expect(SPECIAL_SCHEME_URLS.tel.startsWith('tel:')).toBe(true);

    const pageUrls = result.findings.map((value) => value.pageUrl);
    expect(pageUrls).toContain(SPECIAL_SCHEME_URLS.mailto);
    expect(pageUrls).toContain(SPECIAL_SCHEME_URLS.tel);
    expect(pageUrls).toContain(HOSTILE_STRINGS.javascriptUrl);
    expect(result.findings.some((value) => value.message.includes(HOSTILE_STRINGS.scriptTag) && /[ぁ-んァ-ヶ一-龠]/u.test(value.message))).toBe(true);
    expect(result.pages.some((value) => value.pageUrl.includes(HOSTILE_STRINGS.scriptTag))).toBe(true);
    expect(result.run.incompleteReasons.some((reason) => reason.detail === HOSTILE_TEXT)).toBe(true);
    const interactionPayload = allEvidence(result).find((evidence) => evidence.type === 'interaction')?.payload as InteractionEvidence;
    // C18n: 危険な文字列は、理由の詳細に入れる（理由はコード）。
    expect(interactionPayload.reason).toBe('CANDIDATE_REDISCOVERY_INCOMPLETE');
    expect(interactionPayload.reasonDetail).toBe(HOSTILE_TEXT);
    expect(interactionPayload.work.reasonDetail).toBe(HOSTILE_TEXT);
    expect(interactionPayload.evidence.before?.accessibleName).toContain(HOSTILE_STRINGS.attributeBreak);
  });

  it('has a retried page whose records before the retry are on the page, with a screenshot in retry-1', () => {
    const result = edgeCaseAuditRun();
    expect(result.run.retries).toHaveLength(1);
    const [retried] = result.run.retries;
    const start = result.pages.find((value) => value.pageUrl === retried?.url);
    expect(start?.pageId).toBe(PAGE_1);
    const earlier = start?.evidence.filter((evidence) => retried?.evidenceIds.includes(evidence.evidenceId)) ?? [];
    expect(earlier.map((evidence) => evidence.type)).toEqual(['dom', 'screenshot']);
    expect(earlier.map((evidence) => evidence.evidenceId)).toEqual(retried?.evidenceIds);
    const retryShot = earlier.find((evidence) => evidence.type === 'screenshot');
    expect(retryShot?.type === 'screenshot' ? retryShot.payload.relativePath : null).toBe(
      screenshotRelativePath(PAGE_1, 'desktop', 'VIEWPORT', 1),
    );
    // 最終の試行の Evidence もある。
    expect(start?.evidence.filter((evidence) => evidence.type === 'screenshot' && !retried?.evidenceIds.includes(evidence.evidenceId))).not.toEqual([]);
  });

  it('has Findings of every severity, cross-page Findings, and a Finding that refers to a screenshot', () => {
    const result = edgeCaseAuditRun();
    expect(new Set(result.findings.map((value) => value.severity))).toEqual(new Set(['ERROR', 'WARN', 'INFO', 'SAFETY']));
    expect(result.findings.some((value) => value.pageId === null)).toBe(true);
    const screenshotIds = new Set(allEvidence(result).filter((evidence) => evidence.type === 'screenshot').map(idOf));
    expect(result.findings.some((value) => value.evidenceRefs.some((ref) => screenshotIds.has(ref)))).toBe(true);
  });

  it('builds new, unfrozen values on every call', () => {
    const first = edgeCaseAuditRun();
    expect(edgeCaseAuditRun()).toEqual(first);
    expect(edgeCaseAuditRun().run).not.toBe(first.run);
    expect(frozenPaths(first)).toEqual([]);
  });
});
