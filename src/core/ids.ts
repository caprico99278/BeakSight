import { createHash } from 'node:crypto';
import type { EvidenceId, EvidenceType, FindingId, PageId, RunId } from './contracts.js';

const SEQUENCE_WIDTH = 6;

const evidencePrefixes: Readonly<Record<EvidenceType, string>> = {
  accessibility: 'A11Y',
  console: 'CONSOLE',
  dom: 'DOM',
  interaction: 'INTERACTION',
  layout: 'LAYOUT',
  network: 'NET',
  performance: 'PERF',
  screenshot: 'SHOT',
  metadata: 'META',
};

export interface FindingFingerprintIdentityField {
  readonly name: string;
  readonly value: string;
}

export interface FindingFingerprintInput {
  readonly targetId: string;
  readonly ruleId: string;
  readonly ruleVersion: number;
  readonly normalizedUrl: string | null;
  readonly identityFields: readonly FindingFingerprintIdentityField[];
}

const formatSequence = (sequence: number): string => {
  if (!Number.isSafeInteger(sequence) || sequence < 0) {
    throw new RangeError('stable identifier sequence must be a non-negative safe integer');
  }

  return String(sequence).padStart(SEQUENCE_WIDTH, '0');
};

const formatEvidencePrefix = (type: EvidenceType): string => {
  const knownPrefix = evidencePrefixes[type];
  if (knownPrefix !== undefined) {
    return knownPrefix;
  }

  throw new RangeError(`unsupported evidence type: ${type}`);
};

export const createRunId = (sequence: number): RunId => `RUN-${formatSequence(sequence)}` as RunId;

export const createPageId = (sequence: number): PageId => `PAGE-${formatSequence(sequence)}` as PageId;

export const createEvidenceId = (type: EvidenceType, sequence: number): EvidenceId =>
  `EV-${formatEvidencePrefix(type)}-${formatSequence(sequence)}` as EvidenceId;

export const createFindingId = (sequence: number): FindingId => `FIND-${formatSequence(sequence)}` as FindingId;

export const createFindingFingerprint = (input: FindingFingerprintInput): string => {
  const identityFields = [...input.identityFields]
    .sort((left, right) => compareCodeUnits(left.name, right.name) || compareCodeUnits(left.value, right.value));
  const normalizedInput = JSON.stringify({
    targetId: input.targetId,
    ruleId: input.ruleId,
    ruleVersion: input.ruleVersion,
    normalizedUrl: input.normalizedUrl,
    identityFields,
  });

  return `sha256:${createHash('sha256').update(normalizedInput).digest('hex')}`;
};

const compareCodeUnits = (left: string, right: string): number => {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
};
