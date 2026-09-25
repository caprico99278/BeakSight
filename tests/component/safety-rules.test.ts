import { describe, expect, it } from 'vitest';
import type { AuditRule, FindingDraft, PageRuleInput } from '../../src/audit/rule.js';
import { RuleEngine } from '../../src/audit/rule-engine.js';
import { SAFETY_RULES } from '../../src/audit/safety-rules.js';
import type { EvidenceRecord, ViewportProfile } from '../../src/core/contracts.js';
import type { NormalizedHttpUrlEvidence, SafetyEvidenceScope } from '../../src/core/evidence-types.js';
import { createEvidenceId, createPageId } from '../../src/core/ids.js';
import { SafetyLedger, safetyEventsEvidenceFromSnapshot } from '../../src/safety/safety-ledger.js';

const PAGE_ID = createPageId(12);
const PAGE_URL = 'http://127.0.0.1:4173/safety-rules/page' as NormalizedHttpUrlEvidence;
const ORIGIN = 'http://127.0.0.1:4173';
const EXTERNAL = 'http://127.0.0.2:4173';

const SAFETY_RULE_IDS = [
  'SAFETY_NON_READ_REQUEST_BLOCKED',
  'SAFETY_EXTERNAL_NAVIGATION_BLOCKED',
  'SAFETY_EXTERNAL_ACTION_BLOCKED',
  'SAFETY_DOWNLOAD_BLOCKED',
  'SAFETY_POPUP_BLOCKED',
  'SAFETY_WEBSOCKET_BLOCKED',
  'SAFETY_INTERACTION_CANDIDATE_EXCLUDED',
  'SAFETY_EXTERNAL_SCHEME_NAVIGATION_ATTEMPTED',
  'SAFETY_EXTERNAL_SCHEME_REDIRECT_BLOCKED',
] as const;

/** 本物の Safety Ledger に事象を記録し、その snapshot から safety の Evidence を作る。 */
const safetyRecord = (
  record: (ledger: SafetyLedger) => void,
  options: { readonly scope?: SafetyEvidenceScope; readonly sequence?: number; readonly viewport?: ViewportProfile } = {},
): EvidenceRecord => {
  const ledger = new SafetyLedger();
  record(ledger);
  return {
    evidenceId: createEvidenceId('safety', options.sequence ?? 1),
    type: 'safety',
    pageId: PAGE_ID,
    viewport: options.viewport ?? 'desktop',
    observedAt: '2026-09-24T00:00:00.000Z',
    payload: safetyEventsEvidenceFromSnapshot(ledger.snapshot(), options.scope ?? 'PASSIVE'),
  };
};

const input = (evidence: readonly EvidenceRecord[], viewport: ViewportProfile = 'desktop'): PageRuleInput => ({
  pageId: PAGE_ID,
  pageUrl: PAGE_URL,
  viewport,
  evidence,
});

const ruleById = (ruleId: string): AuditRule => {
  const rule = SAFETY_RULES.find((candidate) => candidate.ruleId === ruleId);
  expect(rule, `${ruleId} が SAFETY_RULES に登録されていること`).toBeDefined();
  return rule as AuditRule;
};

/** すべての Safety の Rule を評価し、下書きを ruleId ごとに返す。 */
const draftsByRule = (evidence: readonly EvidenceRecord[], viewport: ViewportProfile = 'desktop'): Map<string, readonly FindingDraft[]> =>
  new Map(SAFETY_RULES.map((rule) => [rule.ruleId, rule.evaluate(input(evidence, viewport))]));

/** 指定した Rule だけが下書きを作ったことを確かめ、その下書きを返す。 */
const onlyDraftOf = (ruleId: string, evidence: readonly EvidenceRecord[]): FindingDraft => {
  const drafts = draftsByRule(evidence);
  for (const [otherRuleId, otherDrafts] of drafts) {
    if (otherRuleId !== ruleId) {
      expect(otherDrafts, `${otherRuleId} は Finding を作らないこと`).toEqual([]);
    }
  }
  const own = drafts.get(ruleId) ?? [];
  expect(own).toHaveLength(1);
  return own[0] as FindingDraft;
};

const expectSafetyDraft = (draft: FindingDraft, ruleId: string, evidence: readonly EvidenceRecord[]): void => {
  expect(draft).toMatchObject({
    ruleId,
    ruleVersion: 1,
    category: 'SAFETY',
    severity: 'SAFETY',
    identityFields: [],
  });
  expect([...draft.evidenceRefs].sort()).toEqual(evidence.map((record) => record.evidenceId).sort());
};

const TRUNCATION_NOTE = '実際の件数は、この件数より多い可能性があります';

describe('SAFETY_RULES', () => {
  it('設計書 5.4 の7つの Rule と C18a・C18g の2つの Rule が、category SAFETY・severity SAFETY・version 1 で登録されている', () => {
    expect(SAFETY_RULES.map((rule) => rule.ruleId).sort()).toEqual([...SAFETY_RULE_IDS].sort());
    for (const ruleId of SAFETY_RULE_IDS) {
      expect(ruleById(ruleId)).toMatchObject({ category: 'SAFETY', severity: 'SAFETY', version: 1 });
      expect(ruleById(ruleId).ruleIdPrefix).toBeUndefined();
    }
  });

  it('Evidence がない入力、事象のない Evidence、ほかの種類の Evidence からは、例外を投げずに Finding を作らない', () => {
    const empty = safetyRecord(() => undefined);
    const metadata: EvidenceRecord = {
      evidenceId: createEvidenceId('metadata', 1),
      type: 'metadata',
      pageId: PAGE_ID,
      viewport: null,
      observedAt: '2026-09-24T00:00:00.000Z',
      payload: {
        kind: 'ROBOTS_TXT',
        url: 'https://fixture.test/robots.txt',
        outcome: 'OK',
        httpStatus: 200,
        text: '',
        textTruncated: false,
        sitemapUrls: null,
        sitemapUrlsTruncated: false,
      },
    };
    for (const rule of SAFETY_RULES) {
      expect(rule.evaluate(input([]))).toEqual([]);
      expect(rule.evaluate(input([empty]))).toEqual([]);
      expect(rule.evaluate(input([metadata]))).toEqual([]);
    }
  });

  it('不変条件の違反だけを記録した Ledger からは、Finding を作らない', () => {
    const record = safetyRecord((ledger) => {
      ledger.recordInvariantViolation({ code: 'HTTP_ABORT_FAILED', message: 'abort failed' });
    });
    for (const drafts of draftsByRule([record]).values()) {
      expect(drafts).toEqual([]);
    }
  });

  describe('SAFETY_NON_READ_REQUEST_BLOCKED', () => {
    it('Passive で遮断した読み取り以外のリクエストの件数と、メソッドと URL を文言に含める', () => {
      const record = safetyRecord((ledger) => {
        ledger.recordBlockedRequest({ method: 'POST', url: `${ORIGIN}/api/b`, reason: 'NON_READ_METHOD' });
        ledger.recordBlockedRequest({ method: 'PUT', url: `${ORIGIN}/api/a`, reason: 'NON_READ_METHOD' });
      });
      const draft = onlyDraftOf('SAFETY_NON_READ_REQUEST_BLOCKED', [record]);
      expectSafetyDraft(draft, 'SAFETY_NON_READ_REQUEST_BLOCKED', [record]);
      expect(draft.message).toContain('2 件');
      expect(draft.message).toContain('POST');
      expect(draft.message).toContain('PUT');
      expect(draft.message).toContain(`${ORIGIN}/api/b`);
      expect(draft.message).not.toContain(TRUNCATION_NOTE);
    });

    it('Interaction の凍結中に遮断したリクエストは、GET・HEAD 以外だけを数え、Passive と1つの Finding にまとめる', () => {
      const passive = safetyRecord((ledger) => {
        ledger.recordBlockedRequest({ method: 'POST', url: `${ORIGIN}/api/passive`, reason: 'NON_READ_METHOD' });
      }, { sequence: 1 });
      const interaction = safetyRecord((ledger) => {
        ledger.recordBlockedInteractionRequest({ method: 'GET', url: `${ORIGIN}/frozen-get`, reason: 'INTERACTION_FROZEN' });
        ledger.recordBlockedInteractionRequest({ method: 'HEAD', url: `${ORIGIN}/frozen-head`, reason: 'INTERACTION_FROZEN' });
        ledger.recordBlockedInteractionRequest({ method: 'DELETE', url: `${ORIGIN}/frozen-delete`, reason: 'INTERACTION_FROZEN' });
      }, { scope: 'INTERACTION', sequence: 2 });
      const draft = onlyDraftOf('SAFETY_NON_READ_REQUEST_BLOCKED', [passive, interaction]);
      expectSafetyDraft(draft, 'SAFETY_NON_READ_REQUEST_BLOCKED', [passive, interaction]);
      expect(draft.message).toContain('2 件');
      expect(draft.message).toContain('DELETE');
      expect(draft.message).not.toContain('frozen-get');
      expect(draft.message).not.toContain('frozen-head');
    });

    it('凍結中に遮断した GET・HEAD のリクエストと遷移だけなら、どの Rule も Finding を作らない', () => {
      const interaction = safetyRecord((ledger) => {
        ledger.recordBlockedInteractionRequest({ method: 'GET', url: `${ORIGIN}/next`, reason: 'INTERACTION_FROZEN' });
        ledger.recordBlockedInteractionNavigation({ method: 'GET', url: `${ORIGIN}/next`, reason: 'INTERACTION_FROZEN' });
        ledger.recordBlockedInteractionRequest({ method: 'head', url: `${ORIGIN}/probe`, reason: 'INTERACTION_FROZEN' });
      }, { scope: 'INTERACTION' });
      for (const drafts of draftsByRule([interaction]).values()) {
        expect(drafts).toEqual([]);
      }
    });

    it('凍結中に遮断した GET 以外の遷移（blockedInteractionNavigations）そのものは数えない', () => {
      const interaction = safetyRecord((ledger) => {
        ledger.recordBlockedInteractionNavigation({ method: 'POST', url: `${ORIGIN}/nav`, reason: 'INTERACTION_FROZEN' });
      }, { scope: 'INTERACTION' });
      for (const drafts of draftsByRule([interaction]).values()) {
        expect(drafts).toEqual([]);
      }
    });
  });

  describe('SAFETY_EXTERNAL_NAVIGATION_BLOCKED', () => {
    it('許可Originの外への遷移の遮断の件数と URL を文言に含める', () => {
      const record = safetyRecord((ledger) => {
        ledger.recordBlockedNavigation({ method: 'GET', url: `${EXTERNAL}/landing`, reason: 'EXTERNAL_MAIN_FRAME_NAVIGATION' });
      });
      const draft = onlyDraftOf('SAFETY_EXTERNAL_NAVIGATION_BLOCKED', [record]);
      expectSafetyDraft(draft, 'SAFETY_EXTERNAL_NAVIGATION_BLOCKED', [record]);
      expect(draft.message).toContain('1 件');
      expect(draft.message).toContain(`${EXTERNAL}/landing`);
    });

    it('遷移の遮断がなければ、Finding を作らない', () => {
      const record = safetyRecord((ledger) => {
        ledger.recordBlockedRequest({ method: 'POST', url: `${ORIGIN}/api`, reason: 'NON_READ_METHOD' });
      });
      expect(ruleById('SAFETY_EXTERNAL_NAVIGATION_BLOCKED').evaluate(input([record]))).toEqual([]);
    });
  });

  describe('SAFETY_EXTERNAL_ACTION_BLOCKED', () => {
    it('実行しなかった外部アクションの件数、理由、候補、URL を文言に含める', () => {
      const record = safetyRecord((ledger) => {
        ledger.recordBlockedExternalAction({ candidateId: 'candidate-tel', url: 'tel:0000000000', reason: 'EXTERNAL_ACTION' });
        ledger.recordBlockedExternalAction({ candidateId: 'candidate-file', url: null, reason: 'DOWNLOAD' });
      }, { scope: 'INTERACTION' });
      const draft = onlyDraftOf('SAFETY_EXTERNAL_ACTION_BLOCKED', [record]);
      expectSafetyDraft(draft, 'SAFETY_EXTERNAL_ACTION_BLOCKED', [record]);
      expect(draft.message).toContain('2 件');
      expect(draft.message).toContain('EXTERNAL_ACTION');
      expect(draft.message).toContain('DOWNLOAD');
      expect(draft.message).toMatch(/candidate-(tel|file)/u);
    });

    it('外部アクションの記録がなければ、Finding を作らない', () => {
      const record = safetyRecord((ledger) => {
        ledger.recordExcludedInteractionCandidate({ candidateId: 'candidate-submit', reason: 'SUBMISSION_CONTROL' });
      }, { scope: 'INTERACTION' });
      expect(ruleById('SAFETY_EXTERNAL_ACTION_BLOCKED').evaluate(input([record]))).toEqual([]);
    });
  });

  describe('SAFETY_DOWNLOAD_BLOCKED', () => {
    it('Passive と Interaction のダウンロードの遮断を、1つの Finding にまとめて数える', () => {
      const passive = safetyRecord((ledger) => {
        ledger.recordBlockedDownload({ url: `${ORIGIN}/files/a.pdf`, suggestedFilename: 'a.pdf', reason: 'PASSIVE_DOWNLOAD' });
      }, { sequence: 1 });
      const interaction = safetyRecord((ledger) => {
        ledger.recordBlockedDownload({ url: `${ORIGIN}/files/b.zip`, suggestedFilename: 'b.zip', reason: 'INTERACTION_FROZEN' });
      }, { scope: 'INTERACTION', sequence: 2 });
      const draft = onlyDraftOf('SAFETY_DOWNLOAD_BLOCKED', [passive, interaction]);
      expectSafetyDraft(draft, 'SAFETY_DOWNLOAD_BLOCKED', [passive, interaction]);
      expect(draft.message).toContain('2 件');
      expect(draft.message).toContain('PASSIVE_DOWNLOAD');
      expect(draft.message).toContain('INTERACTION_FROZEN');
      expect(draft.message).toContain(`${ORIGIN}/files/a.pdf`);
    });

    it('ダウンロードの遮断がなければ、Finding を作らない', () => {
      const record = safetyRecord((ledger) => {
        ledger.recordBlockedPopup({ url: `${ORIGIN}/popup`, reason: 'INTERACTION_FROZEN' });
      }, { scope: 'INTERACTION' });
      expect(ruleById('SAFETY_DOWNLOAD_BLOCKED').evaluate(input([record]))).toEqual([]);
    });
  });

  describe('SAFETY_POPUP_BLOCKED', () => {
    it('popup の遮断の件数と URL を文言に含める', () => {
      const record = safetyRecord((ledger) => {
        ledger.recordBlockedPopup({ url: `${ORIGIN}/popup`, reason: 'INTERACTION_FROZEN' });
      }, { scope: 'INTERACTION' });
      const draft = onlyDraftOf('SAFETY_POPUP_BLOCKED', [record]);
      expectSafetyDraft(draft, 'SAFETY_POPUP_BLOCKED', [record]);
      expect(draft.message).toContain('1 件');
      expect(draft.message).toContain(`${ORIGIN}/popup`);
    });

    it('popup の遮断がなければ、Finding を作らない', () => {
      const record = safetyRecord((ledger) => {
        ledger.recordBlockedDownload({ url: `${ORIGIN}/files/a.pdf`, suggestedFilename: 'a.pdf', reason: 'PASSIVE_DOWNLOAD' });
      });
      expect(ruleById('SAFETY_POPUP_BLOCKED').evaluate(input([record]))).toEqual([]);
    });
  });

  describe('SAFETY_WEBSOCKET_BLOCKED', () => {
    it('Passive と Interaction の WebSocket の遮断を、1つの Finding にまとめて数える', () => {
      const passive = safetyRecord((ledger) => {
        ledger.recordBlockedWebSocket({ url: 'ws://127.0.0.1:4173/socket', reason: 'PASSIVE_WEBSOCKET' });
      }, { sequence: 1 });
      const interaction = safetyRecord((ledger) => {
        ledger.recordBlockedInteractionWebSocket({ url: 'ws://127.0.0.1:4173/live', reason: 'INTERACTION_FROZEN' });
        ledger.recordBlockedInteractionWebSocket({ url: 'ws://127.0.0.1:4173/live', reason: 'INTERACTION_FROZEN' });
      }, { scope: 'INTERACTION', sequence: 2 });
      const draft = onlyDraftOf('SAFETY_WEBSOCKET_BLOCKED', [passive, interaction]);
      expectSafetyDraft(draft, 'SAFETY_WEBSOCKET_BLOCKED', [passive, interaction]);
      expect(draft.message).toContain('3 件');
      expect(draft.message).toMatch(/ws:\/\/127\.0\.0\.1:4173\/(socket|live)/u);
    });

    it('WebSocket の遮断がなければ、Finding を作らない', () => {
      const record = safetyRecord((ledger) => {
        ledger.recordBlockedNavigation({ method: 'GET', url: `${EXTERNAL}/`, reason: 'EXTERNAL_MAIN_FRAME_NAVIGATION' });
      });
      expect(ruleById('SAFETY_WEBSOCKET_BLOCKED').evaluate(input([record]))).toEqual([]);
    });
  });

  describe('SAFETY_INTERACTION_CANDIDATE_EXCLUDED', () => {
    it('機械的に除外した候補の件数と理由を文言に含める', () => {
      const record = safetyRecord((ledger) => {
        ledger.recordExcludedInteractionCandidate({ candidateId: 'candidate-submit', reason: 'SUBMISSION_CONTROL' });
        ledger.recordExcludedInteractionCandidate({ candidateId: 'candidate-form', reason: 'FORM_ASSOCIATED' });
      }, { scope: 'INTERACTION' });
      const draft = onlyDraftOf('SAFETY_INTERACTION_CANDIDATE_EXCLUDED', [record]);
      expectSafetyDraft(draft, 'SAFETY_INTERACTION_CANDIDATE_EXCLUDED', [record]);
      expect(draft.message).toContain('2 件');
      expect(draft.message).toContain('SUBMISSION_CONTROL');
      expect(draft.message).toContain('FORM_ASSOCIATED');
    });

    it('除外した候補がなければ、Finding を作らない', () => {
      const record = safetyRecord((ledger) => {
        ledger.recordBlockedExternalAction({ candidateId: 'candidate-tel', url: 'tel:0000000000', reason: 'EXTERNAL_ACTION' });
      }, { scope: 'INTERACTION' });
      expect(ruleById('SAFETY_INTERACTION_CANDIDATE_EXCLUDED').evaluate(input([record]))).toEqual([]);
    });
  });

  // C18a（DEF-012。Task 19 の前の整理の設計書 4.2）: 外部スキームへの移動の試みは、`blockedExternalActions` と同じ考え方で、
  // ページ・ビューポートごとに1つの SAFETY の Finding にまとめる。
  describe('SAFETY_EXTERNAL_SCHEME_NAVIGATION_ATTEMPTED', () => {
    it('Passive と Interaction の外部スキームへの移動の試みを、1つの Finding にまとめ、件数、スキーム、URL を文言に含める', () => {
      const passive = safetyRecord((ledger) => {
        ledger.recordExternalSchemeNavigation({
          url: 'tel:+10000000000',
          scheme: 'tel',
          frame: 'MAIN',
          phase: 'PASSIVE',
          reason: 'EXTERNAL_SCHEME_NAVIGATION',
        });
      }, { sequence: 1 });
      const interaction = safetyRecord((ledger) => {
        ledger.recordExternalSchemeNavigation({
          url: 'mailto:nobody@example.invalid',
          scheme: 'mailto',
          frame: 'SUB',
          phase: 'INTERACTION',
          reason: 'EXTERNAL_SCHEME_NAVIGATION',
        });
      }, { scope: 'INTERACTION', sequence: 2 });
      const draft = onlyDraftOf('SAFETY_EXTERNAL_SCHEME_NAVIGATION_ATTEMPTED', [passive, interaction]);
      expectSafetyDraft(draft, 'SAFETY_EXTERNAL_SCHEME_NAVIGATION_ATTEMPTED', [passive, interaction]);
      expect(draft.message).toContain('2 件');
      expect(draft.message).toContain('mailto、tel');
      expect(draft.message).toContain('mailto:nobody@example.invalid');
      expect(draft.message).not.toContain(TRUNCATION_NOTE);
    });

    it('外部スキームへの移動の記録がなければ、Finding を作らない', () => {
      const record = safetyRecord((ledger) => {
        ledger.recordBlockedExternalAction({ candidateId: 'candidate-tel', url: 'tel:0000000000', reason: 'EXTERNAL_ACTION' });
      }, { scope: 'INTERACTION' });
      expect(ruleById('SAFETY_EXTERNAL_SCHEME_NAVIGATION_ATTEMPTED').evaluate(input([record]))).toEqual([]);
    });

    it('記録の上限に達した Evidence からは、実際の件数がより多い可能性を文言に書く', () => {
      const record = safetyRecord((ledger) => {
        for (let index = 0; index < 300; index += 1) {
          ledger.recordExternalSchemeNavigation({
            url: `beaksight-test-app:probe-${index}`,
            scheme: 'beaksight-test-app',
            frame: 'MAIN',
            phase: 'PASSIVE',
            reason: 'EXTERNAL_SCHEME_NAVIGATION',
          });
        }
      });
      const draft = onlyDraftOf('SAFETY_EXTERNAL_SCHEME_NAVIGATION_ATTEMPTED', [record]);
      expect(draft.message).toContain('256 件');
      expect(draft.message).toContain(TRUNCATION_NOTE);
    });
  });

  // C18g（RC18a の指摘1。Task 19 の前の整理の設計書 4.2、4.2.1）: Guard がたどる前に止めた、外部スキームへのサーバのリダイレクト
  // （理由 `EXTERNAL_SCHEME_REDIRECT_BLOCKED`）は、ページによる移動の試み（`EXTERNAL_SCHEME_NAVIGATION`）と区別して、止めた事象の
  // Finding にする。移動の試みの Rule は、止めたリダイレクトを数えない。
  describe('SAFETY_EXTERNAL_SCHEME_REDIRECT_BLOCKED', () => {
    const redirect = (url: string, scheme: string, frame: 'MAIN' | 'SUB', phase: 'PASSIVE' | 'INTERACTION') => ({
      url,
      scheme,
      frame,
      phase,
      reason: 'EXTERNAL_SCHEME_REDIRECT_BLOCKED',
    } as const);

    it('止めたリダイレクトを1つの Finding にまとめ、件数、スキーム、URL を文言に含め、止めたことが分かる文言にする', () => {
      const passive = safetyRecord((ledger) => {
        ledger.recordExternalSchemeNavigation(redirect('tel:+10000000000', 'tel', 'SUB', 'PASSIVE'));
        ledger.recordExternalSchemeNavigation(redirect('beaksight-test-app:probe', 'beaksight-test-app', 'MAIN', 'PASSIVE'));
      }, { sequence: 1 });
      const interaction = safetyRecord((ledger) => {
        ledger.recordExternalSchemeNavigation(redirect('mailto:nobody@example.invalid', 'mailto', 'SUB', 'INTERACTION'));
      }, { scope: 'INTERACTION', sequence: 2 });
      const draft = onlyDraftOf('SAFETY_EXTERNAL_SCHEME_REDIRECT_BLOCKED', [passive, interaction]);
      expectSafetyDraft(draft, 'SAFETY_EXTERNAL_SCHEME_REDIRECT_BLOCKED', [passive, interaction]);
      expect(draft.message).toContain('3 件');
      expect(draft.message).toContain('beaksight-test-app、mailto、tel');
      expect(draft.message).toContain('beaksight-test-app:probe');
      expect(draft.message).toContain('リダイレクト');
      expect(draft.message).toContain('止めました');
      expect(draft.message).not.toContain(TRUNCATION_NOTE);
    });

    it('ページによる移動の試みと止めたリダイレクトが両方あれば、それぞれの Rule が自分の理由の事象だけを数える', () => {
      const record = safetyRecord((ledger) => {
        ledger.recordExternalSchemeNavigation({
          url: 'tel:+10000000000',
          scheme: 'tel',
          frame: 'MAIN',
          phase: 'PASSIVE',
          reason: 'EXTERNAL_SCHEME_NAVIGATION',
        });
        ledger.recordExternalSchemeNavigation(redirect('mailto:nobody@example.invalid', 'mailto', 'SUB', 'PASSIVE'));
      });
      const drafts = draftsByRule([record]);
      const attempted = drafts.get('SAFETY_EXTERNAL_SCHEME_NAVIGATION_ATTEMPTED') ?? [];
      const blocked = drafts.get('SAFETY_EXTERNAL_SCHEME_REDIRECT_BLOCKED') ?? [];
      expect(attempted).toHaveLength(1);
      expect(attempted[0]?.message).toContain('1 件');
      expect(attempted[0]?.message).toContain('tel:+10000000000');
      expect(attempted[0]?.message).not.toContain('mailto');
      expect(blocked).toHaveLength(1);
      expect(blocked[0]?.message).toContain('1 件');
      expect(blocked[0]?.message).toContain('mailto:nobody@example.invalid');
      expect(blocked[0]?.message).not.toContain('tel:');
    });

    it('止めたリダイレクトの記録がなければ、Finding を作らない', () => {
      const record = safetyRecord((ledger) => {
        ledger.recordExternalSchemeNavigation({
          url: 'tel:+10000000000',
          scheme: 'tel',
          frame: 'MAIN',
          phase: 'PASSIVE',
          reason: 'EXTERNAL_SCHEME_NAVIGATION',
        });
      });
      expect(ruleById('SAFETY_EXTERNAL_SCHEME_REDIRECT_BLOCKED').evaluate(input([record]))).toEqual([]);
    });
  });

  it('記録の上限に達した Evidence から作る Finding は、実際の件数がより多い可能性を文言に書く', () => {
    const record = safetyRecord((ledger) => {
      for (let index = 0; index < 300; index += 1) {
        ledger.recordBlockedPopup({ url: `${ORIGIN}/popup/${index}`, reason: 'INTERACTION_FROZEN' });
      }
    }, { scope: 'INTERACTION' });
    expect(record.type === 'safety' && record.payload.recordLimits.truncated).toBe(true);
    const draft = onlyDraftOf('SAFETY_POPUP_BLOCKED', [record]);
    expect(draft.message).toContain('256 件');
    expect(draft.message).toContain(TRUNCATION_NOTE);
  });

  it('上限に達していない Evidence だけから作る Finding には、その注意を書かない', () => {
    const truncatedOtherViewport = safetyRecord((ledger) => {
      for (let index = 0; index < 300; index += 1) {
        ledger.recordBlockedPopup({ url: `${ORIGIN}/popup/${index}`, reason: 'INTERACTION_FROZEN' });
      }
    }, { scope: 'INTERACTION', sequence: 1, viewport: 'mobile' });
    const record = safetyRecord((ledger) => {
      ledger.recordBlockedPopup({ url: `${ORIGIN}/popup`, reason: 'INTERACTION_FROZEN' });
    }, { scope: 'INTERACTION', sequence: 2 });
    const draft = onlyDraftOf('SAFETY_POPUP_BLOCKED', [truncatedOtherViewport, record]);
    expect(draft.evidenceRefs).toEqual([record.evidenceId]);
    expect(draft.message).toContain('1 件');
    expect(draft.message).not.toContain(TRUNCATION_NOTE);
  });

  it('入力のビューポートと異なるビューポートの Evidence は、判定に使わない', () => {
    const mobile = safetyRecord((ledger) => {
      ledger.recordBlockedRequest({ method: 'POST', url: `${ORIGIN}/api`, reason: 'NON_READ_METHOD' });
    }, { viewport: 'mobile' });
    expect(ruleById('SAFETY_NON_READ_REQUEST_BLOCKED').evaluate(input([mobile], 'desktop'))).toEqual([]);
    expect(ruleById('SAFETY_NON_READ_REQUEST_BLOCKED').evaluate(input([mobile], 'mobile'))).toHaveLength(1);
  });

  it('入力の Evidence の順序が変わっても、同じ下書きを作る', () => {
    const first = safetyRecord((ledger) => {
      ledger.recordBlockedWebSocket({ url: 'ws://127.0.0.1:4173/b', reason: 'PASSIVE_WEBSOCKET' });
      ledger.recordBlockedRequest({ method: 'PATCH', url: `${ORIGIN}/api/z`, reason: 'NON_READ_METHOD' });
    }, { sequence: 1 });
    const second = safetyRecord((ledger) => {
      ledger.recordBlockedInteractionWebSocket({ url: 'ws://127.0.0.1:4173/a', reason: 'INTERACTION_FROZEN' });
      ledger.recordBlockedInteractionRequest({ method: 'POST', url: `${ORIGIN}/api/a`, reason: 'INTERACTION_FROZEN' });
    }, { scope: 'INTERACTION', sequence: 2 });
    const normalize = (drafts: readonly FindingDraft[]): unknown =>
      drafts.map((draft) => ({ ...draft, evidenceRefs: [...draft.evidenceRefs].sort() }));
    for (const rule of SAFETY_RULES) {
      expect(normalize(rule.evaluate(input([second, first])))).toEqual(normalize(rule.evaluate(input([first, second]))));
    }
  });

  it('既定の Rule Engine で、ページとビューポートと Rule の組ごとに1つの SAFETY の Finding になる', () => {
    const passive = safetyRecord((ledger) => {
      ledger.recordBlockedRequest({ method: 'POST', url: `${ORIGIN}/api/1`, reason: 'NON_READ_METHOD' });
      ledger.recordBlockedRequest({ method: 'POST', url: `${ORIGIN}/api/2`, reason: 'NON_READ_METHOD' });
      ledger.recordBlockedDownload({ url: `${ORIGIN}/files/a.pdf`, suggestedFilename: 'a.pdf', reason: 'PASSIVE_DOWNLOAD' });
    }, { sequence: 1 });
    const interaction = safetyRecord((ledger) => {
      ledger.recordBlockedInteractionRequest({ method: 'PUT', url: `${ORIGIN}/api/3`, reason: 'INTERACTION_FROZEN' });
      ledger.recordBlockedDownload({ url: `${ORIGIN}/files/b.zip`, suggestedFilename: 'b.zip', reason: 'INTERACTION_FROZEN' });
    }, { scope: 'INTERACTION', sequence: 2 });
    const engine = new RuleEngine({ targetId: 'safety-rules-test', firstFindingSequence: 1 });
    const result = engine.evaluate(input([passive, interaction]));
    expect(result.failures).toEqual([]);
    const safetyFindings = result.findings.filter((finding) => finding.severity === 'SAFETY');
    expect(safetyFindings.map((finding) => finding.ruleId).sort()).toEqual([
      'SAFETY_DOWNLOAD_BLOCKED',
      'SAFETY_NON_READ_REQUEST_BLOCKED',
    ]);
    for (const finding of safetyFindings) {
      expect(finding).toMatchObject({ category: 'SAFETY', pageId: PAGE_ID, viewport: 'desktop' });
      expect(finding.evidenceRefs).toEqual([passive.evidenceId, interaction.evidenceId].sort());
    }
  });
});
