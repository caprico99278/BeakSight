// BN-c（設計書 `doc/design/2026-10-23-beaksight-bundle-beaksight-block-noise-design.md` 3.3・3.4）: 指摘と BeakSight の遮断の関係の区分の、純粋な判定の単体テスト。
// 区分ごと（CAUSED・POSSIBLE・NONE）、理由ごと、fetch と xhr、SharedWorker の TypeError、閉じる途中の遮断、敏感でない Rule を確かめる。
import { describe, expect, it } from 'vitest';
import {
  BEAKSIGHT_BLOCK_KIND_RESOURCE_TYPES,
  BEAKSIGHT_BLOCK_RECORD_SOURCES,
  BEAKSIGHT_BLOCK_RELATION_OF_REASON,
  BEAKSIGHT_BLOCK_RELATION_REASONS,
  BEAKSIGHT_BLOCK_RELATIONS,
  BEAKSIGHT_UNCERTAIN_BLOCK_KIND,
  beaksightBlockKindOf,
  reconcileBeakSightBlockKinds,
} from '../../src/core/beaksight-block-relation.js';
import type { AuditRunResult, EvidenceRecord, Finding, PageAuditResult } from '../../src/core/contracts.js';
import type { LayoutEvidencePayload, PerformanceEvidence, SafetyEventsEvidence } from '../../src/core/evidence-types.js';
import { SHARED_WORKER_PROPERTY_DISABLED_ERROR_NAME, SHARED_WORKER_PROPERTY_DISABLED_MESSAGE } from '../../src/core/guard-page-exceptions.js';
import { REPORT_BEAKSIGHT_BLOCK_REFERENCE_COUNT } from '../../src/core/limits.js';
import { formatPixels } from '../../src/presentation/format.js';
import { stressWidthFindingMessageText } from '../../src/presentation/messages.js';
import { beaksightBlockRelationOf, indexBeakSightBlocks } from '../../src/report/beaksight-block-relation.js';
import { REQUEST_RESOURCE_TYPES } from '../../src/safety/request-policy.js';
import {
  PAGE_1,
  PAGE_2,
  auditRun,
  consoleEvidence,
  dom,
  finding,
  fixtureUrl,
  idOf,
  network,
  networkFailure,
  page,
  record,
  retry,
  safety,
  viewportResult,
} from '../helpers/audit-run-fixture.js';

const BLOCKED_SUBRESOURCE = 'net::ERR_BLOCKED_BY_CLIENT.Inspector';
const BLOCKED_DOCUMENT = 'net::ERR_BLOCKED_BY_CLIENT';
const REFUSED = 'net::ERR_CONNECTION_REFUSED';
const SCRIPT_URL = fixtureUrl('/assets/app.js');
const OTHER_SCRIPT_URL = fixtureUrl('/assets/other.js');
const IMAGE_URL = fixtureUrl('/images/hero.png');
const DATA_URL = fixtureUrl('/api/items');
const STRESS_WIDTH = 768;

/** 1 ページの Run（Finding は判定に渡すので、Run の Finding の一覧は空）。 */
const runOf = (pages: readonly PageAuditResult[], options: { readonly retries?: AuditRunResult['run']['retries'] } = {}): AuditRunResult =>
  auditRun({ pages, findings: [], run: { retries: options.retries ?? [] } });

const judge = (result: AuditRunResult, target: Finding) => beaksightBlockRelationOf(indexBeakSightBlocks(result), target);

/** Rule の ID と文と参照の Evidence を指定した、PAGE-000001・desktop の Finding。 */
const findingOf = (ruleId: string, message: string, refs: readonly EvidenceRecord[], overrides: Partial<Finding> = {}): Finding =>
  finding(1, 'ERROR', 'RESOURCE', PAGE_1, refs.map(idOf), { ruleId, message, ...overrides });

/** 止めた要求（Ledger の記録）を持つ、ページの監査の読み込みの safety の Evidence。 */
const pageAuditSafety = (sequence: number, overrides: Partial<SafetyEventsEvidence>, viewport: 'desktop' | 'mobile' = 'desktop') =>
  safety(sequence, PAGE_1, viewport, { load: { kind: 'PAGE_AUDIT' }, ...overrides });

const scriptMessage = (url: string): string => `script の読み込みに失敗しました（URL: ${url}、エラー: ${BLOCKED_SUBRESOURCE}）。`;

describe('BN-c: the vocabulary of the relation to the BeakSight blocks', () => {
  it('gives every reason one of the three relations, and every relation at least one reason', () => {
    expect(BEAKSIGHT_BLOCK_RELATIONS).toEqual(['CAUSED', 'POSSIBLE', 'NONE']);
    for (const reason of BEAKSIGHT_BLOCK_RELATION_REASONS) {
      expect(BEAKSIGHT_BLOCK_RELATIONS).toContain(BEAKSIGHT_BLOCK_RELATION_OF_REASON[reason]);
    }
    for (const relation of BEAKSIGHT_BLOCK_RELATIONS) {
      expect(BEAKSIGHT_BLOCK_RELATION_REASONS.some((reason) => BEAKSIGHT_BLOCK_RELATION_OF_REASON[reason] === relation), relation).toBe(true);
    }
  });

  it('treats fetch (the network Evidence) and xhr (the Guard records) as the same kind of data request', () => {
    expect(beaksightBlockKindOf('fetch', 'PAGE')).toBe('DATA');
    expect(beaksightBlockKindOf('xhr', 'PAGE')).toBe('DATA');
    expect(beaksightBlockKindOf('xhr', 'GUARD')).toBe('DATA');
    expect(beaksightBlockKindOf('XHR', 'GUARD')).toBe('DATA');
  });

  // BN-R0 の M-1: Guard の記録の種類は CDP の Fetch の値で、`<link rel=prefetch>` が `fetch`、Worker の script が `other` になる。
  // LG-4: 種類のない前の版の記録は読まないので、種類がないときの印の確かめは捨てた。
  it('marks the Guard types that do not tell the page kind (fetch for a prefetch, other for a Worker script) as uncertain', () => {
    expect(beaksightBlockKindOf('fetch', 'GUARD')).toBe(BEAKSIGHT_UNCERTAIN_BLOCK_KIND);
    expect(beaksightBlockKindOf('other', 'GUARD')).toBe(BEAKSIGHT_UNCERTAIN_BLOCK_KIND);
    expect(beaksightBlockKindOf('other', 'PAGE')).toBeNull();
  });

  it('gives no kind to the requests the page JS and the measures do not see', () => {
    for (const source of BEAKSIGHT_BLOCK_RECORD_SOURCES) {
      for (const type of ['ping', 'prefetch', 'cspviolationreport', 'preflight', 'manifest', 'constructor', '__proto__']) {
        expect(beaksightBlockKindOf(type, source), `${source} ${type}`).toBeNull();
      }
    }
  });

  it('makes one kind of the records of the same request, and marks the kinds that do not agree as uncertain', () => {
    expect(reconcileBeakSightBlockKinds(['DATA', 'DATA'])).toBe('DATA');
    expect(reconcileBeakSightBlockKinds([BEAKSIGHT_UNCERTAIN_BLOCK_KIND, 'SCRIPT'])).toBe('SCRIPT');
    expect(reconcileBeakSightBlockKinds(['SCRIPT', 'IMAGE'])).toBe(BEAKSIGHT_UNCERTAIN_BLOCK_KIND);
    expect(reconcileBeakSightBlockKinds(['DATA', null])).toBe(BEAKSIGHT_UNCERTAIN_BLOCK_KIND);
    expect(reconcileBeakSightBlockKinds([BEAKSIGHT_UNCERTAIN_BLOCK_KIND])).toBe(BEAKSIGHT_UNCERTAIN_BLOCK_KIND);
    expect(reconcileBeakSightBlockKinds([null, null])).toBeNull();
  });

  it('keys the mapping by values of the closed list of request types of the Guard', () => {
    for (const type of BEAKSIGHT_BLOCK_KIND_RESOURCE_TYPES) {
      expect(REQUEST_RESOURCE_TYPES as readonly string[]).toContain(type);
    }
  });
});

describe('BN-c: CAUSED (the target request or navigation was blocked by BeakSight)', () => {
  it('makes a SCRIPT_LOAD_FAILED whose script was blocked while loading CAUSED, with the block as the reference', () => {
    const net = network(1, PAGE_1, 'desktop', [networkFailure(SCRIPT_URL, 'script', BLOCKED_SUBRESOURCE, { blockedByBeakSight: true, phase: 'LOAD' })]);
    const result = runOf([page(PAGE_1, '/', 'AUDITED', [net, pageAuditSafety(2, {})])]);
    expect(judge(result, findingOf('SCRIPT_LOAD_FAILED', scriptMessage(SCRIPT_URL), [net]))).toEqual({
      relation: 'CAUSED',
      reason: 'TARGET_REQUEST_BLOCKED',
      blocks: [{ pageId: PAGE_1, viewport: 'desktop', load: { kind: 'PAGE_AUDIT' }, requestKind: 'SCRIPT', phase: 'LOAD', method: 'GET', url: SCRIPT_URL, mainFrameNavigation: false }],
      blockCount: 1,
    });
  });

  it('reads the failure of the previous page.json version (no marks) by its errorText', () => {
    const net = network(1, PAGE_1, 'desktop', [networkFailure(SCRIPT_URL, 'script', BLOCKED_SUBRESOURCE)]);
    const result = runOf([page(PAGE_1, '/', 'AUDITED', [net])]);
    expect(judge(result, findingOf('SCRIPT_LOAD_FAILED', scriptMessage(SCRIPT_URL), [net])).relation).toBe('CAUSED');
  });

  it('makes a load failure CAUSED also when BeakSight blocked it while closing (the failure itself is the block)', () => {
    const net = network(1, PAGE_1, 'desktop', [networkFailure(SCRIPT_URL, 'script', BLOCKED_SUBRESOURCE, { blockedByBeakSight: true, phase: 'CLOSING' })]);
    const result = runOf([page(PAGE_1, '/', 'AUDITED', [net])]);
    const relation = judge(result, findingOf('SCRIPT_LOAD_FAILED', scriptMessage(SCRIPT_URL), [net]));
    expect(relation.relation).toBe('CAUSED');
    expect(relation.blocks.map((block) => block.phase)).toEqual(['CLOSING']);
  });

  it('makes an image of the DOM side (naturalWidth 0) CAUSED when BeakSight blocked the same URL in the same load', () => {
    const domEvidence = dom(1, PAGE_1, 'desktop', '本文', {
      images: [{ src: IMAGE_URL, resolvedUrl: IMAGE_URL, alt: 'x', complete: true, naturalWidth: 0, naturalHeight: 0, truncated: false }],
    });
    const ledger = pageAuditSafety(2, { blockedRequests: [{ method: 'GET', url: IMAGE_URL, reason: 'PAGE_SUBRESOURCE_LIMIT_REACHED', resourceType: 'image', phase: 'LOAD' }] });
    const result = runOf([page(PAGE_1, '/', 'AUDITED', [domEvidence, ledger])]);
    const message = `画像の読み込みに失敗しました（URL: ${IMAGE_URL}、観測: complete: true、naturalWidth: 0、naturalHeight: 0）。`;
    const relation = judge(result, findingOf('IMAGE_LOAD_FAILED', message, [domEvidence]));
    expect(relation.relation).toBe('CAUSED');
    expect(relation.reason).toBe('TARGET_REQUEST_BLOCKED');
    expect(relation.blocks[0]).toMatchObject({ requestKind: 'IMAGE', url: IMAGE_URL, phase: 'LOAD' });
  });

  it('makes a TARGET_NAVIGATION_FAILED CAUSED when the navigation to the target failed by the BeakSight block', () => {
    const target = page(PAGE_2, '/second.html', 'FAILED', [], [], {
      viewports: {
        desktop: viewportResult(fixtureUrl('/second.html'), 'FAILED', {
          navigationOutcome: 'FAILED',
          incompleteReasons: [{ code: 'NAVIGATION_FAILED', detail: `FAILED:${BLOCKED_DOCUMENT}` }],
        }),
        mobile: viewportResult(fixtureUrl('/second.html'), 'AUDITED'),
      },
    });
    const link = record('link', 1, PAGE_1, 'desktop', { links: [], omittedLinkCount: 0 });
    const result = runOf([page(PAGE_1, '/', 'AUDITED', [link]), target]);
    const message = `内部リンクの遷移先 ${fixtureUrl('/second.html')} へのナビゲーションが失敗しました（ビューポート: desktop）。リンク元: ${fixtureUrl('/')}`;
    const relation = judge(result, findingOf('TARGET_NAVIGATION_FAILED', message, [link], { viewport: null }));
    expect(relation).toEqual({
      relation: 'CAUSED',
      reason: 'TARGET_NAVIGATION_BLOCKED',
      blocks: [{ pageId: PAGE_2, viewport: 'desktop', load: { kind: 'PAGE_AUDIT' }, requestKind: 'DOCUMENT', phase: 'LOAD', method: null, url: fixtureUrl('/second.html'), mainFrameNavigation: true }],
      blockCount: 1,
    });
  });

  it('does not make a TARGET_NAVIGATION_FAILED CAUSED when the navigation failed by another error', () => {
    const target = page(PAGE_2, '/second.html', 'FAILED', [], [], {
      viewports: {
        desktop: viewportResult(fixtureUrl('/second.html'), 'FAILED', {
          navigationOutcome: 'FAILED',
          incompleteReasons: [{ code: 'NAVIGATION_FAILED', detail: `FAILED:${REFUSED}` }],
        }),
        mobile: viewportResult(fixtureUrl('/second.html'), 'AUDITED'),
      },
    });
    const link = record('link', 1, PAGE_1, 'desktop', { links: [], omittedLinkCount: 0 });
    const result = runOf([page(PAGE_1, '/', 'AUDITED', [link]), target]);
    const message = `内部リンクの遷移先 ${fixtureUrl('/second.html')} へのナビゲーションが失敗しました（ビューポート: desktop）。リンク元: ${fixtureUrl('/')}`;
    expect(judge(result, findingOf('TARGET_NAVIGATION_FAILED', message, [link], { viewport: null }))).toMatchObject({ relation: 'NONE', reason: 'NO_BLOCK_IN_LOAD' });
  });
});

describe('BN-c: POSSIBLE (a block that can change the result of the Rule)', () => {
  it('makes a load failure POSSIBLE when only some failures of the target URL were blocked by BeakSight', () => {
    const net = network(1, PAGE_1, 'desktop', [
      networkFailure(SCRIPT_URL, 'script', BLOCKED_SUBRESOURCE, { blockedByBeakSight: true, phase: 'LOAD' }),
      networkFailure(SCRIPT_URL, 'script', REFUSED, { requestId: 'second', blockedByBeakSight: false, phase: 'LOAD' }),
    ]);
    const result = runOf([page(PAGE_1, '/', 'AUDITED', [net])]);
    expect(judge(result, findingOf('SCRIPT_LOAD_FAILED', scriptMessage(SCRIPT_URL), [net]))).toMatchObject({
      relation: 'POSSIBLE',
      reason: 'TARGET_REQUEST_PARTLY_BLOCKED',
    });
  });

  it('makes a sensitive Rule POSSIBLE by a data block of the Guard records (xhr), and by a blocked fetch of the network Evidence', () => {
    const domEvidence = dom(1, PAGE_1, 'desktop', '本文', { title: null });
    const ledger = pageAuditSafety(2, { blockedRequests: [{ method: 'DELETE', url: DATA_URL, reason: 'NON_READ_METHOD', resourceType: 'xhr', phase: 'LOAD' }] });
    const fromLedger = judge(runOf([page(PAGE_1, '/', 'AUDITED', [domEvidence, ledger])]), findingOf('MISSING_TITLE', '<title> 要素がありません。', [domEvidence]));
    expect(fromLedger).toEqual({
      relation: 'POSSIBLE',
      reason: 'SENSITIVE_KIND_BLOCKED',
      blocks: [{ pageId: PAGE_1, viewport: 'desktop', load: { kind: 'PAGE_AUDIT' }, requestKind: 'DATA', phase: 'LOAD', method: 'DELETE', url: DATA_URL, mainFrameNavigation: false }],
      blockCount: 1,
    });
    const net = network(3, PAGE_1, 'desktop', [networkFailure(DATA_URL, 'fetch', BLOCKED_SUBRESOURCE, { method: 'DELETE', blockedByBeakSight: true, phase: 'LOAD' })]);
    const fromNetwork = judge(runOf([page(PAGE_1, '/', 'AUDITED', [domEvidence, net])]), findingOf('MISSING_TITLE', '<title> 要素がありません。', [domEvidence]));
    expect(fromNetwork.relation).toBe('POSSIBLE');
    expect(fromNetwork.blocks.map((block) => block.requestKind)).toEqual(['DATA']);
  });

  it('counts the same block in the Guard records and in the network Evidence once', () => {
    const domEvidence = dom(1, PAGE_1, 'desktop', '本文', { title: null });
    const ledger = pageAuditSafety(2, { blockedRequests: [{ method: 'GET', url: SCRIPT_URL, reason: 'PAGE_SUBRESOURCE_LIMIT_REACHED', resourceType: 'script', phase: 'LOAD' }] });
    const net = network(3, PAGE_1, 'desktop', [networkFailure(SCRIPT_URL, 'script', BLOCKED_SUBRESOURCE, { blockedByBeakSight: true, phase: 'LOAD' })]);
    const relation = judge(runOf([page(PAGE_1, '/', 'AUDITED', [domEvidence, ledger, net])]), findingOf('MISSING_TITLE', '<title> 要素がありません。', [domEvidence]));
    expect(relation.blockCount).toBe(1);
  });

  it('makes a PAGE_ERROR of the SharedWorker that BeakSight disabled POSSIBLE, without any block', () => {
    const consoleRecord = consoleEvidence(1, PAGE_1, 'desktop', [
      { name: SHARED_WORKER_PROPERTY_DISABLED_ERROR_NAME, message: SHARED_WORKER_PROPERTY_DISABLED_MESSAGE, stack: null, truncated: false },
    ]);
    const result = runOf([page(PAGE_1, '/', 'AUDITED', [consoleRecord, pageAuditSafety(2, {})])]);
    const message = `捕捉されない例外が発生しました（${SHARED_WORKER_PROPERTY_DISABLED_ERROR_NAME}: ${SHARED_WORKER_PROPERTY_DISABLED_MESSAGE}、発生回数: 1）。`;
    expect(judge(result, findingOf('PAGE_ERROR', message, [consoleRecord]))).toEqual({ relation: 'POSSIBLE', reason: 'DISABLED_FEATURE', blocks: [], blockCount: 0 });
  });

  it('does not make another TypeError of the page POSSIBLE by the SharedWorker judgement', () => {
    const consoleRecord = consoleEvidence(1, PAGE_1, 'desktop', [
      { name: 'TypeError', message: 'window.Missing is not a constructor', stack: null, truncated: false },
    ]);
    const result = runOf([page(PAGE_1, '/', 'AUDITED', [consoleRecord])]);
    const message = '捕捉されない例外が発生しました（TypeError: window.Missing is not a constructor、発生回数: 1）。';
    expect(judge(result, findingOf('PAGE_ERROR', message, [consoleRecord]))).toMatchObject({ relation: 'NONE', reason: 'NO_BLOCK_IN_LOAD' });
  });

  it('makes a "Failed to fetch" PAGE_ERROR POSSIBLE when a data request was blocked in the same load', () => {
    const consoleRecord = consoleEvidence(1, PAGE_1, 'desktop', [{ name: 'TypeError', message: 'Failed to fetch', stack: null, truncated: false }]);
    const ledger = pageAuditSafety(2, { blockedRequests: [{ method: 'DELETE', url: DATA_URL, reason: 'NON_READ_METHOD', resourceType: 'fetch', phase: 'LOAD' }] });
    const message = '捕捉されない例外が発生しました（TypeError: Failed to fetch、発生回数: 1）。';
    const relation = judge(runOf([page(PAGE_1, '/', 'AUDITED', [consoleRecord, ledger])]), findingOf('PAGE_ERROR', message, [consoleRecord]));
    expect(relation).toMatchObject({ relation: 'POSSIBLE', reason: 'FETCH_FAILED_WITH_DATA_BLOCK', blockCount: 1 });
  });

  it('links a layout Finding of a stress width to the load of that width, and a primary layout Finding to the page audit load', () => {
    const layout = record('layout', 1, PAGE_1, 'desktop', {
      primary: { status: 'COMPLETE', layout: null },
      stressSweep: [{ width: STRESS_WIDTH, status: 'COMPLETE', layout: null }],
    } as unknown as LayoutEvidencePayload);
    const stressLedger = safety(2, PAGE_1, 'desktop', {
      load: { kind: 'STRESS_WIDTH', width: STRESS_WIDTH },
      blockedRequests: [{ method: 'GET', url: SCRIPT_URL, reason: 'PAGE_SUBRESOURCE_LIMIT_REACHED', resourceType: 'script', phase: 'LOAD' }],
    });
    const result = runOf([page(PAGE_1, '/', 'AUDITED', [layout, pageAuditSafety(3, {}), stressLedger])]);
    const primaryMessage = '文書の幅が、ビューポートの幅を超えています。';
    const stress = judge(result, findingOf('DOCUMENT_HORIZONTAL_OVERFLOW', stressWidthFindingMessageText(formatPixels(STRESS_WIDTH), primaryMessage), [layout]));
    expect(stress).toMatchObject({ relation: 'POSSIBLE', reason: 'SENSITIVE_KIND_BLOCKED' });
    expect(stress.blocks[0]).toMatchObject({ load: { kind: 'STRESS_WIDTH', width: STRESS_WIDTH }, requestKind: 'SCRIPT' });
    expect(judge(result, findingOf('DOCUMENT_HORIZONTAL_OVERFLOW', primaryMessage, [layout]))).toMatchObject({ relation: 'NONE', reason: 'NO_BLOCK_IN_LOAD' });
  });

  // BN-R0 の M-1: 結び付けは URL と method で行い、種類は補助にする。
  it('links the Guard record and the network failure of the same request by URL and method, and takes the kind the page sees', () => {
    const domEvidence = dom(1, PAGE_1, 'desktop', '本文', { title: null });
    // Guard の記録は Worker の script を `other` と残す。network の Evidence は `script`。
    const ledger = pageAuditSafety(2, { blockedRequests: [{ method: 'GET', url: SCRIPT_URL, reason: 'PAGE_SUBRESOURCE_LIMIT_REACHED', resourceType: 'other', phase: 'LOAD' }] });
    const net = network(3, PAGE_1, 'desktop', [networkFailure(SCRIPT_URL, 'script', BLOCKED_SUBRESOURCE, { blockedByBeakSight: true, phase: 'LOAD' })]);
    const relation = judge(runOf([page(PAGE_1, '/', 'AUDITED', [domEvidence, ledger, net])]), findingOf('MISSING_TITLE', '<title> 要素がありません。', [domEvidence]));
    expect(relation.blocks).toEqual([{ pageId: PAGE_1, viewport: 'desktop', load: { kind: 'PAGE_AUDIT' }, requestKind: 'SCRIPT', phase: 'LOAD', method: 'GET', url: SCRIPT_URL, mainFrameNavigation: false }]);
    expect(relation.blockCount).toBe(1);
  });

  it('makes a sensitive Rule POSSIBLE by a block whose kind is uncertain (a prefetch or a Worker script in the Guard records), and leaves a Rule that a block cannot change NONE', () => {
    const domEvidence = dom(1, PAGE_1, 'desktop', '本文', { title: null });
    const ledger = pageAuditSafety(2, {
      blockedRequests: [{ method: 'GET', url: fixtureUrl('/prefetched.html'), reason: 'PAGE_SUBRESOURCE_LIMIT_REACHED', resourceType: 'fetch', phase: 'LOAD' }],
    });
    const result = runOf([page(PAGE_1, '/', 'AUDITED', [domEvidence, ledger])]);
    const possible = judge(result, findingOf('MISSING_TITLE', '<title> 要素がありません。', [domEvidence]));
    expect(possible).toMatchObject({ relation: 'POSSIBLE', reason: 'SENSITIVE_KIND_BLOCKED' });
    expect(possible.blocks.map((block) => block.requestKind)).toEqual([BEAKSIGHT_UNCERTAIN_BLOCK_KIND]);
    expect(judge(result, findingOf('HTTP_4XX', 'ページのナビゲーションの応答が HTTP ステータス 404 でした。', [domEvidence]))).toMatchObject({
      relation: 'NONE',
      reason: 'RULE_NOT_SENSITIVE',
    });
  });

  it('marks the kinds of the same request that do not agree as uncertain, and does not link requests of another method', () => {
    const domEvidence = dom(1, PAGE_1, 'desktop', '本文', { title: null });
    const ledger = pageAuditSafety(2, { blockedRequests: [{ method: 'GET', url: IMAGE_URL, reason: 'PAGE_SUBRESOURCE_LIMIT_REACHED', resourceType: 'script', phase: 'LOAD' }] });
    const net = network(3, PAGE_1, 'desktop', [
      networkFailure(IMAGE_URL, 'image', BLOCKED_SUBRESOURCE, { blockedByBeakSight: true, phase: 'LOAD' }),
      networkFailure(IMAGE_URL, 'image', BLOCKED_SUBRESOURCE, { requestId: 'post', method: 'POST', blockedByBeakSight: true, phase: 'LOAD' }),
    ]);
    // 表にない Rule は、すべての見える種類で変わりうる。
    const relation = judge(runOf([page(PAGE_1, '/', 'AUDITED', [domEvidence, ledger, net])]), findingOf('TEST_RULE_1', 'テストの指摘 1', [domEvidence]));
    expect(relation.blocks.map((block) => [block.method, block.requestKind])).toEqual([['GET', BEAKSIGHT_UNCERTAIN_BLOCK_KIND], ['POST', 'IMAGE']]);
  });

  it('treats a Rule that the table does not list as sensitive to every visible kind', () => {
    const domEvidence = dom(1, PAGE_1, 'desktop', '本文');
    const ledger = pageAuditSafety(2, { blockedRequests: [{ method: 'GET', url: IMAGE_URL, reason: 'PAGE_SUBRESOURCE_LIMIT_REACHED', resourceType: 'image', phase: 'LOAD' }] });
    const relation = judge(runOf([page(PAGE_1, '/', 'AUDITED', [domEvidence, ledger])]), findingOf('TEST_RULE_1', 'テストの指摘 1', [domEvidence]));
    expect(relation).toMatchObject({ relation: 'POSSIBLE', reason: 'SENSITIVE_KIND_BLOCKED' });
  });

  it('keeps at most the limited number of references, and counts all the distinct blocks', () => {
    const domEvidence = dom(1, PAGE_1, 'desktop', '本文', { title: null });
    const count = REPORT_BEAKSIGHT_BLOCK_REFERENCE_COUNT + 2;
    const blockedRequests = Array.from({ length: count }, (_value, index) => ({
      method: 'DELETE',
      url: fixtureUrl(`/api/items/${index}`),
      reason: 'NON_READ_METHOD' as const,
      resourceType: 'xhr',
      phase: 'LOAD' as const,
    }));
    const relation = judge(runOf([page(PAGE_1, '/', 'AUDITED', [domEvidence, pageAuditSafety(2, { blockedRequests })])]), findingOf('MISSING_TITLE', '<title> 要素がありません。', [domEvidence]));
    expect(relation.blocks).toHaveLength(REPORT_BEAKSIGHT_BLOCK_REFERENCE_COUNT);
    expect(relation.blockCount).toBe(count);
  });
});

describe('BN-c: NONE (not linked to a BeakSight block)', () => {
  it('makes a Finding NONE when the linked load has no block', () => {
    const domEvidence = dom(1, PAGE_1, 'desktop', '本文', { title: null });
    const relation = judge(runOf([page(PAGE_1, '/', 'AUDITED', [domEvidence, pageAuditSafety(2, {})])]), findingOf('MISSING_TITLE', '<title> 要素がありません。', [domEvidence]));
    expect(relation).toEqual({ relation: 'NONE', reason: 'NO_BLOCK_IN_LOAD', blocks: [], blockCount: 0 });
  });

  it('makes a Rule that a block cannot change NONE, even with blocks in the same load', () => {
    const net = network(1, PAGE_1, 'desktop', [networkFailure(SCRIPT_URL, 'script', BLOCKED_SUBRESOURCE, { blockedByBeakSight: true, phase: 'LOAD' })]);
    const result = runOf([page(PAGE_1, '/', 'AUDITED', [net])]);
    const message = `ページのナビゲーションの応答が HTTP ステータス 404 でした（URL: ${fixtureUrl('/')}）。`;
    expect(judge(result, findingOf('HTTP_4XX', message, [net]))).toMatchObject({ relation: 'NONE', reason: 'RULE_NOT_SENSITIVE', blocks: [], blockCount: 0 });
  });

  it('makes a failed script that BeakSight did not block NONE, even when another script was blocked in the same load', () => {
    const net = network(1, PAGE_1, 'desktop', [
      networkFailure(SCRIPT_URL, 'script', BLOCKED_SUBRESOURCE, { blockedByBeakSight: true, phase: 'LOAD' }),
      networkFailure(OTHER_SCRIPT_URL, 'script', REFUSED, { blockedByBeakSight: false, phase: 'LOAD' }),
    ]);
    const result = runOf([page(PAGE_1, '/', 'AUDITED', [net])]);
    const message = `script の読み込みに失敗しました（URL: ${OTHER_SCRIPT_URL}、エラー: ${REFUSED}）。`;
    expect(judge(result, findingOf('SCRIPT_LOAD_FAILED', message, [net]))).toMatchObject({ relation: 'NONE', reason: 'RULE_NOT_SENSITIVE' });
  });

  it('does not use the blocks while closing (blockedClosingRequests and the CLOSING phase) for POSSIBLE', () => {
    const domEvidence = dom(1, PAGE_1, 'desktop', '本文', { title: null });
    const ledger = pageAuditSafety(2, {
      blockedRequests: [{ method: 'DELETE', url: DATA_URL, reason: 'NON_READ_METHOD', resourceType: 'xhr', phase: 'CLOSING' }],
      blockedClosingRequests: { count: 2, events: [{ method: 'GET', url: SCRIPT_URL, resourceType: 'script', phase: 'CLOSING' }] },
    });
    const net = network(3, PAGE_1, 'desktop', [networkFailure(DATA_URL, 'fetch', BLOCKED_SUBRESOURCE, { blockedByBeakSight: true, phase: 'CLOSING' })]);
    const relation = judge(runOf([page(PAGE_1, '/', 'AUDITED', [domEvidence, ledger, net])]), findingOf('MISSING_TITLE', '<title> 要素がありません。', [domEvidence]));
    expect(relation).toEqual({ relation: 'NONE', reason: 'NO_BLOCK_IN_LOAD', blocks: [], blockCount: 0 });
  });

  it('does not use ping blocks (sendBeacon) for POSSIBLE', () => {
    const domEvidence = dom(1, PAGE_1, 'desktop', '本文', { title: null });
    const ledger = pageAuditSafety(2, { blockedRequests: [{ method: 'POST', url: DATA_URL, reason: 'NON_READ_METHOD', resourceType: 'ping', phase: 'LOAD' }] });
    const relation = judge(runOf([page(PAGE_1, '/', 'AUDITED', [domEvidence, ledger])]), findingOf('MISSING_TITLE', '<title> 要素がありません。', [domEvidence]));
    expect(relation).toMatchObject({ relation: 'NONE', reason: 'NO_BLOCK_IN_LOAD' });
  });

  it('does not use the blocks of the other viewport, of the Interaction loads, or of an attempt before a retry', () => {
    const domEvidence = dom(1, PAGE_1, 'desktop', '本文', { title: null });
    const dataBlock = { method: 'DELETE', url: DATA_URL, reason: 'NON_READ_METHOD' as const, resourceType: 'xhr', phase: 'LOAD' as const };
    const mobile = pageAuditSafety(2, { blockedRequests: [dataBlock] }, 'mobile');
    const interactionLoad = safety(3, PAGE_1, 'desktop', { scope: 'INTERACTION', load: { kind: 'INTERACTION', candidateIndex: 0 }, blockedRequests: [dataBlock] });
    const earlier = pageAuditSafety(4, { blockedRequests: [dataBlock] });
    const result = runOf([page(PAGE_1, '/', 'AUDITED', [earlier, domEvidence, mobile, interactionLoad])], { retries: [retry(fixtureUrl('/'), 1, [earlier])] });
    expect(judge(result, findingOf('MISSING_TITLE', '<title> 要素がありません。', [domEvidence]))).toMatchObject({ relation: 'NONE', reason: 'NO_BLOCK_IN_LOAD' });
  });
});

// BN-R1（独立レビュー）の I-1・M-1・M-2・M-3 の区分の側の直し。
describe('BN-R1: the fixes of the relation (I-1, M-1, M-2, M-3)', () => {
  const LOGOUT_URL = fixtureUrl('/admin/logout');
  const titleMessage = '<title> 要素がありません。';
  /** ページ自身が始めた main frame の移動を、監査の段の除外で止めた記録（BN-R1 の再現の `/admin/navaway`）。 */
  const navigationExclusion = (phase: 'LOAD' | 'CLOSING') => ({
    count: 1,
    events: [{ method: 'GET', url: LOGOUT_URL, mainFrameNavigation: true, reason: 'AUDIT_EXCLUDED_URL' as const, resourceType: 'document', phase }],
  });

  /** 測った時点の文書の読み込みの URL（navigation timing）が `url` の、パフォーマンスの Evidence（`observedAt` を指定する）。 */
  const performanceAt = (sequence: number, url: string, observedAt: string): EvidenceRecord => ({
    ...record('performance', sequence, PAGE_1, 'desktop', { navigationTiming: { url } } as unknown as PerformanceEvidence),
    observedAt,
  });
  const at = <TRecord extends EvidenceRecord>(evidence: TRecord, observedAt: string): TRecord => ({ ...evidence, observedAt });
  const T0 = '2026-09-24T00:00:00.000Z';
  const T1 = '2026-09-24T00:00:01.000Z';
  const T2 = '2026-09-24T00:00:02.000Z';

  it('N-1: makes a Finding CAUSED only when its Evidence was measured on the error page (after a performance Evidence of the blocked destination)', () => {
    const domBefore = at(dom(1, PAGE_1, 'desktop', '', { title: null, lang: null }), T0);
    const performance = performanceAt(3, LOGOUT_URL, T1);
    const domAfter = at(dom(4, PAGE_1, 'desktop', '', { title: null, lang: null }), T2);
    const result = runOf([page(PAGE_1, '/', 'AUDITED', [domBefore, pageAuditSafety(2, { blockedAuditExclusions: navigationExclusion('LOAD') }), performance, domAfter])]);
    // 測った後に止めたかもしれない（DOM はパフォーマンスより先に記録した）: 影響の可能性。
    for (const ruleId of ['MISSING_TITLE', 'EMPTY_VISIBLE_CONTENT', 'MISSING_HTML_LANG', 'A11Y_DOCUMENT_TITLE']) {
      const relation = judge(result, findingOf(ruleId, titleMessage, [domBefore]));
      expect(relation, ruleId).toMatchObject({ relation: 'POSSIBLE', reason: 'MAIN_FRAME_NAVIGATION_BLOCKED_UNCONFIRMED' });
      expect(relation.blocks, ruleId).toEqual([{ pageId: PAGE_1, viewport: 'desktop', load: { kind: 'PAGE_AUDIT' }, requestKind: 'DOCUMENT', phase: 'LOAD', method: 'GET', url: LOGOUT_URL, mainFrameNavigation: true }]);
    }
    // エラーの画面を測ったと分かる（パフォーマンスの Evidence と、その後の Evidence）: 遮断が原因。
    expect(judge(result, findingOf('POOR_LCP', 'LCP', [performance]))).toMatchObject({ relation: 'CAUSED', reason: 'MAIN_FRAME_NAVIGATION_BLOCKED' });
    expect(judge(result, findingOf('MISSING_TITLE', titleMessage, [domAfter]))).toMatchObject({ relation: 'CAUSED', reason: 'MAIN_FRAME_NAVIGATION_BLOCKED' });
    // 測った画面によらない Rule は除く。
    expect(judge(result, findingOf('HTTP_4XX', 'ページのナビゲーションの応答が HTTP ステータス 404 でした。', [domAfter]))).toMatchObject({ relation: 'NONE' });
    // パフォーマンスの Evidence が元の画面を測っていれば、分からない（影響の可能性）。
    const realPage = runOf([page(PAGE_1, '/', 'AUDITED', [
      pageAuditSafety(2, { blockedAuditExclusions: navigationExclusion('LOAD') }), performanceAt(3, fixtureUrl('/'), T1), domAfter,
    ])]);
    expect(judge(realPage, findingOf('MISSING_TITLE', titleMessage, [domAfter])).relation).toBe('POSSIBLE');
  });

  it('I-1: reads the main frame navigation blocks of blockedNavigations and of the network failures too, and not the ones while closing', () => {
    const domEvidence = dom(1, PAGE_1, 'desktop', '本文', { title: null });
    const external = pageAuditSafety(2, { blockedNavigations: [{ method: 'GET', url: 'https://external.test/', reason: 'EXTERNAL_MAIN_FRAME_NAVIGATION', phase: 'LOAD' }] });
    expect(judge(runOf([page(PAGE_1, '/', 'AUDITED', [domEvidence, external])]), findingOf('MISSING_TITLE', titleMessage, [domEvidence])).reason)
      .toBe('MAIN_FRAME_NAVIGATION_BLOCKED_UNCONFIRMED');
    const net = network(3, PAGE_1, 'desktop', [
      networkFailure(LOGOUT_URL, 'document', 'net::ERR_BLOCKED_BY_CLIENT', { isNavigationRequest: true, isMainFrame: true, blockedByBeakSight: true, phase: 'LOAD' }),
    ]);
    expect(judge(runOf([page(PAGE_1, '/', 'AUDITED', [domEvidence, net])]), findingOf('MISSING_TITLE', titleMessage, [domEvidence])).reason)
      .toBe('MAIN_FRAME_NAVIGATION_BLOCKED_UNCONFIRMED');
    const closing = pageAuditSafety(2, { blockedAuditExclusions: navigationExclusion('CLOSING') });
    expect(judge(runOf([page(PAGE_1, '/', 'AUDITED', [domEvidence, closing])]), findingOf('MISSING_TITLE', titleMessage, [domEvidence]))).toMatchObject({
      relation: 'NONE',
      reason: 'NO_BLOCK_IN_LOAD',
    });
  });

  it('I-1: makes a cross-page Finding that uses the title of that viewport measured on the error page CAUSED as well', () => {
    const blockedDom = at(dom(1, PAGE_1, 'desktop', '', { title: 'エラー' }), T2);
    const otherDom = dom(3, PAGE_2, 'desktop', '', { title: 'エラー' });
    const result = runOf([
      page(PAGE_1, '/', 'AUDITED', [performanceAt(4, LOGOUT_URL, T1), blockedDom, pageAuditSafety(2, { blockedAuditExclusions: navigationExclusion('LOAD') })]),
      page(PAGE_2, '/second.html', 'AUDITED', [otherDom]),
    ]);
    const duplicate = findingOf('DUPLICATE_PAGE_TITLE', 'title「エラー」が、canonical の異なるほかの 1 ページと同じです', [otherDom, blockedDom], { pageId: PAGE_2, viewport: null });
    expect(judge(result, duplicate)).toMatchObject({ relation: 'CAUSED', reason: 'MAIN_FRAME_NAVIGATION_BLOCKED' });
  });

  it('M-1: does not use a block while closing for a URL that really failed while loading (a refused script, a 404 image of the DOM)', () => {
    const closing = pageAuditSafety(3, {
      blockedClosingRequests: {
        count: 2,
        events: [{ method: 'GET', url: SCRIPT_URL, resourceType: 'script', phase: 'CLOSING' }, { method: 'GET', url: IMAGE_URL, resourceType: 'image', phase: 'CLOSING' }],
      },
    });
    const net = network(1, PAGE_1, 'desktop', [networkFailure(SCRIPT_URL, 'script', REFUSED, { blockedByBeakSight: false, phase: 'LOAD' })]);
    const script = judge(runOf([page(PAGE_1, '/', 'AUDITED', [net, closing])]), findingOf('SCRIPT_LOAD_FAILED', `script の読み込みに失敗しました（URL: ${SCRIPT_URL}、エラー: ${REFUSED}）。`, [net]));
    expect(script.relation).toBe('NONE');
    const domEvidence = dom(2, PAGE_1, 'desktop', '本文', {
      images: [{ src: IMAGE_URL, resolvedUrl: IMAGE_URL, alt: 'x', complete: true, naturalWidth: 0, naturalHeight: 0, truncated: false }],
    });
    const message = `画像の読み込みに失敗しました（URL: ${IMAGE_URL}、観測: complete: true、naturalWidth: 0、naturalHeight: 0）。`;
    expect(judge(runOf([page(PAGE_1, '/', 'AUDITED', [domEvidence, closing])]), findingOf('IMAGE_LOAD_FAILED', message, [domEvidence])).relation).toBe('NONE');
  });

  it('M-2: does not use the blocks of a prefetch (the Guard mark, or the prefetch type of the page) for POSSIBLE, and keeps an unmarked Guard fetch uncertain', () => {
    const domEvidence = dom(1, PAGE_1, 'desktop', '本文', { title: null });
    const chunk = fixtureUrl('/admin/assets/delete-chunk.js');
    const marked = pageAuditSafety(2, {
      blockedAuditExclusions: {
        count: 1,
        events: [{ method: 'GET', url: chunk, mainFrameNavigation: false, reason: 'AUDIT_EXCLUDED_URL', resourceType: 'fetch', phase: 'LOAD', speculative: true }],
      },
    });
    expect(judge(runOf([page(PAGE_1, '/', 'AUDITED', [domEvidence, marked])]), findingOf('MISSING_TITLE', titleMessage, [domEvidence])).relation).toBe('NONE');
    const unmarked = pageAuditSafety(2, {
      blockedAuditExclusions: { count: 1, events: [{ method: 'GET', url: chunk, mainFrameNavigation: false, reason: 'AUDIT_EXCLUDED_URL', resourceType: 'fetch', phase: 'LOAD' }] },
    });
    const prefetchFailure = network(3, PAGE_1, 'desktop', [networkFailure(chunk, 'prefetch', BLOCKED_SUBRESOURCE, { blockedByBeakSight: true, phase: 'LOAD' })]);
    expect(judge(runOf([page(PAGE_1, '/', 'AUDITED', [domEvidence, unmarked, prefetchFailure])]), findingOf('MISSING_TITLE', titleMessage, [domEvidence])).relation).toBe('NONE');
    const uncertain = judge(runOf([page(PAGE_1, '/', 'AUDITED', [domEvidence, unmarked])]), findingOf('MISSING_TITLE', titleMessage, [domEvidence]));
    expect(uncertain.blocks.map((block) => block.requestKind)).toEqual([BEAKSIGHT_UNCERTAIN_BLOCK_KIND]);
  });

  it('M-3: makes the missing and the exception Findings POSSIBLE by a data block, and leaves the defects of the displayed elements NONE', () => {
    const domEvidence = dom(1, PAGE_1, 'desktop', '本文', { title: null });
    const dataBlock = pageAuditSafety(2, { blockedRequests: [{ method: 'POST', url: fixtureUrl('/admin/collect'), reason: 'NON_READ_METHOD', resourceType: 'xhr', phase: 'LOAD' }] });
    const result = runOf([page(PAGE_1, '/', 'AUDITED', [domEvidence, dataBlock])]);
    // axe の欠けの Rule（題・lang・main の目印・最上位の見出し・繰り返しを飛ばす手段）は、`MISSING_TITLE` と同じ欠けのまとまり（設計者の判断）。
    for (const ruleId of [
      'MISSING_TITLE', 'EMPTY_TITLE', 'EMPTY_VISIBLE_CONTENT', 'MISSING_HTML_LANG', 'INVALID_CANONICAL_URL', 'PAGE_ERROR', 'DUPLICATE_PAGE_TITLE',
      'A11Y_DOCUMENT_TITLE', 'A11Y_HTML_HAS_LANG', 'A11Y_LANDMARK_ONE_MAIN', 'A11Y_PAGE_HAS_HEADING_ONE', 'A11Y_BYPASS',
    ]) {
      expect(judge(result, findingOf(ruleId, titleMessage, [domEvidence])).relation, ruleId).toBe('POSSIBLE');
    }
    // 表示された要素の欠陥と、サーバが返した応答の事実（`RESOURCE_4XX`・`5XX`。設計者の判断）は、データの遮断では外さない。
    for (const ruleId of [
      'DOCUMENT_HORIZONTAL_OVERFLOW', 'COLOR_CONTRAST_VIOLATION', 'A11Y_IMAGE_ALT', 'DUPLICATE_ELEMENT_ID', 'UNLABELED_REQUIRED_CONTROL', 'FORM_WITHOUT_ACTION',
      'IMAGE_LOAD_FAILED', 'RESOURCE_4XX', 'RESOURCE_5XX',
    ]) {
      expect(judge(result, findingOf(ruleId, titleMessage, [domEvidence])), ruleId).toMatchObject({ relation: 'NONE', reason: 'RULE_NOT_SENSITIVE' });
    }
    const styleBlock = pageAuditSafety(2, { blockedRequests: [{ method: 'GET', url: fixtureUrl('/a.css'), reason: 'PAGE_SUBRESOURCE_LIMIT_REACHED', resourceType: 'stylesheet', phase: 'LOAD' }] });
    const styled = runOf([page(PAGE_1, '/', 'AUDITED', [domEvidence, styleBlock])]);
    for (const ruleId of ['DOCUMENT_HORIZONTAL_OVERFLOW', 'COLOR_CONTRAST_VIOLATION', 'A11Y_IMAGE_ALT', 'DUPLICATE_ELEMENT_ID']) {
      expect(judge(styled, findingOf(ruleId, titleMessage, [domEvidence])).relation, ruleId).toBe('POSSIBLE');
    }
  });
});
