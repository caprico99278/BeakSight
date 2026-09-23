export type RunId = string & { readonly __brand: 'RunId' };
export type PageId = string & { readonly __brand: 'PageId' };
export type EvidenceId = string & { readonly __brand: 'EvidenceId' };
export type FindingId = string & { readonly __brand: 'FindingId' };

export type RunStatus = 'COMPLETE' | 'PARTIAL' | 'FAILED' | 'ABORTED_BY_SAFETY';
export type PageAuditStatus = 'AUDITED' | 'PARTIAL' | 'SKIPPED' | 'FAILED';
export type Severity = 'ERROR' | 'WARN' | 'INFO' | 'SAFETY';
export type InteractionStatus =
  | 'VERIFIED'
  | 'REJECTED_UNSAFE'
  | 'BLOCKED_BY_SAFETY'
  | 'NOT_VERIFIABLE'
  | 'EXECUTION_FAILED';

export interface NetworkEvidencePayload {
  readonly requestUrl: string;
  readonly status: number | null;
}

export interface ConsoleEvidencePayload {
  readonly level: 'ERROR' | 'WARN' | 'INFO';
  readonly message: string;
}

export interface DomEvidencePayload {
  readonly title: string | null;
  readonly visibleText: string;
}

export interface LayoutEvidencePayload {
  readonly condition: string;
  readonly affectedSelectors: readonly string[];
}

export interface PerformanceEvidencePayload {
  readonly metric: string;
  readonly value: number | null;
  readonly status: 'OBSERVED' | 'NOT_OBSERVED';
}

export interface AccessibilityEvidencePayload {
  readonly ruleId: string;
  readonly impact: string | null;
  readonly targetSelectors: readonly string[];
}

export interface InteractionEvidencePayload {
  readonly candidateId: string;
  readonly status: InteractionStatus;
}

export interface ScreenshotEvidencePayload {
  readonly relativePath: string;
  readonly captureType: 'VIEWPORT' | 'FULL_PAGE';
}

export interface MetadataEvidencePayload {
  readonly source: string;
  readonly value: string;
}

export interface EvidencePayloadByType {
  readonly network: NetworkEvidencePayload;
  readonly console: ConsoleEvidencePayload;
  readonly dom: DomEvidencePayload;
  readonly layout: LayoutEvidencePayload;
  readonly performance: PerformanceEvidencePayload;
  readonly accessibility: AccessibilityEvidencePayload;
  readonly interaction: InteractionEvidencePayload;
  readonly screenshot: ScreenshotEvidencePayload;
  readonly metadata: MetadataEvidencePayload;
}

export type EvidenceType = keyof EvidencePayloadByType;

export interface EvidenceRecordFor<TType extends EvidenceType> {
  readonly evidenceId: EvidenceId;
  readonly type: TType;
  readonly pageId: PageId;
  readonly viewport: string;
  readonly observedAt: string;
  readonly payload: EvidencePayloadByType[TType];
}

export type EvidenceRecord = {
  readonly [TType in EvidenceType]: EvidenceRecordFor<TType>;
}[EvidenceType];

export interface Finding {
  readonly schemaVersion: 'finding-schema/1.0';
  readonly findingId: FindingId;
  readonly fingerprint: string;
  readonly ruleId: string;
  readonly ruleVersion: number;
  readonly category: string;
  readonly severity: Severity;
  readonly pageId: PageId | null;
  readonly pageUrl: string | null;
  readonly viewport: string | null;
  readonly message: string;
  readonly evidenceRefs: readonly EvidenceId[];
}

export interface PageAuditResult {
  readonly schemaVersion: 'page-schema/1.0';
  readonly pageId: PageId;
  readonly pageUrl: string;
  readonly status: PageAuditStatus;
  readonly evidence: readonly EvidenceRecord[];
  readonly findings: readonly Finding[];
  readonly incompleteReasons: readonly string[];
}

export interface RunSummary {
  readonly schemaVersion: 'run-schema/1.0';
  readonly runId: RunId;
  readonly runStatus: RunStatus;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly discoveredPageCount: number;
  readonly auditedPageCount: number;
  readonly failedPageCount: number;
  readonly skippedPageCount: number;
  readonly incompleteReasons: readonly string[];
}
