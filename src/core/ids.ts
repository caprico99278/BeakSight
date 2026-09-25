import { createHash } from 'node:crypto';
import type { EvidenceId, EvidenceType, FindingId, PageId, RunId } from './contracts.js';
import { isNonNegativeSafeInteger } from './guards.js';
import { compareCodeUnits } from './text.js';

const SEQUENCE_WIDTH = 6;

const evidencePrefixes: Readonly<Record<EvidenceType, string>> = {
  accessibility: 'A11Y',
  color: 'COLOR',
  console: 'CONSOLE',
  dom: 'DOM',
  interaction: 'INTERACTION',
  layout: 'LAYOUT',
  link: 'LINK',
  network: 'NET',
  performance: 'PERF',
  screenshot: 'SHOT',
  scroll: 'SCROLL',
  metadata: 'META',
  safety: 'SAFETY',
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
  if (!isNonNegativeSafeInteger(sequence)) {
    throw new RangeError('stable identifier sequence must be a non-negative safe integer');
  }

  return String(sequence).padStart(SEQUENCE_WIDTH, '0');
};

const formatEvidencePrefix = (type: EvidenceType): string => {
  // 表は普通のオブジェクトなので、`constructor` や `__proto__` などの継承したプロパティ名を種類として受け付けないよう、
  // 自身のプロパティかどうかで確かめる（DEF-002）。
  if (Object.hasOwn(evidencePrefixes, type)) {
    return evidencePrefixes[type];
  }

  throw new RangeError(`unsupported evidence type: ${type}`);
};

/** Run の ID の接頭辞（`createRunId` と `isRunId` が使う。スキーマの pattern は `^RUN-[0-9]{6,}$`）。 */
const RUN_ID_PREFIX = 'RUN-';
/** ページの ID の接頭辞（`createPageId` と `isPageId` が使う。スキーマの pattern は `^PAGE-[0-9]{6,}$`）。 */
const PAGE_ID_PREFIX = 'PAGE-';
/** `formatSequence` が作る連番の形（ASCII の数字が `SEQUENCE_WIDTH` 桁以上）。 */
const sequencePattern = new RegExp(`^[0-9]{${SEQUENCE_WIDTH},}$`, 'u');

/** `value` が、接頭辞 `prefix` と、`formatSequence` が作る形の連番だけからなる文字列か。 */
const hasSequenceIdShape = (value: unknown, prefix: string): boolean =>
  typeof value === 'string' && value.startsWith(prefix) && sequencePattern.test(value.slice(prefix.length));

export const createRunId = (sequence: number): RunId => `${RUN_ID_PREFIX}${formatSequence(sequence)}` as RunId;

export const createPageId = (sequence: number): PageId => `${PAGE_ID_PREFIX}${formatSequence(sequence)}` as PageId;

/**
 * `createRunId` が作る形（`RUN-` と、6桁以上の ASCII の数字。スキーマの pattern と同じ）の文字列か（C16d）。
 * artifact のパスに使う前に、ID の形を確かめるために使う。
 */
export const isRunId = (value: unknown): value is RunId => hasSequenceIdShape(value, RUN_ID_PREFIX);

/** `createPageId` が作る形（`PAGE-` と、6桁以上の ASCII の数字。スキーマの pattern と同じ）の文字列か（C16d）。 */
export const isPageId = (value: unknown): value is PageId => hasSequenceIdShape(value, PAGE_ID_PREFIX);

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

  return createSha256Fingerprint(normalizedInput);
};

export const createRequestId = (sequence: number): string => `REQ-${formatSequence(sequence)}`;

const SHA256_FINGERPRINT_PREFIX = 'sha256:';
const sha256FingerprintPattern = /^sha256:[a-f0-9]{64}$/u;

/** `value` を UTF-8 として SHA-256 でハッシュし、`sha256:<小文字の16進64桁>` の形式で返す。 */
export const createSha256Fingerprint = (value: string): string =>
  `${SHA256_FINGERPRINT_PREFIX}${createHash('sha256').update(value).digest('hex')}`;

/**
 * バイト列（`bytes` の view の範囲）を、そのまま SHA-256 でハッシュし、`createSha256Fingerprint` と同じ
 * `sha256:<小文字の16進64桁>` の形式で返す（ChatGPT 用バンドルの manifest の `sha256`。CC-006）。入力は変えない。
 */
export const createSha256FingerprintOfBytes = (bytes: Uint8Array): string =>
  `${SHA256_FINGERPRINT_PREFIX}${createHash('sha256').update(bytes).digest('hex')}`;

/** `sha256:<小文字の16進64桁>` の形式の文字列か。 */
export const isSha256Fingerprint = (value: unknown): value is string =>
  typeof value === 'string' && sha256FingerprintPattern.test(value);
