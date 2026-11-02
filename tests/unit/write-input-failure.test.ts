// OP-O（O1）: 書き込みの段で、確かめ・入力・押す操作が失敗したときの記録（`action-evidence.json` の `precheck.inputFailure`）。
// - 記録の一覧（control の契約）が、入力の部品の共通の値と理由の語（browser）からずれないこと。スキーマの enum の一致は `schema-enum-consistency.test.ts`。
// - 値の変わり方の区分（`valueChangeKindOf`。値は返さない）。
// - スキーマは、送らずに止めた回だけ記録を受け、送った回・値や長さを持つ形を拒む。
import { describe, expect, it } from 'vitest';
import { API_WRITE_INPUT_REASONS } from '../../src/browser/api-write-submitter.js';
import {
  valueChangeKindOf,
  WRITE_INPUT_FAILURE_STAGES as BROWSER_STAGES,
  WRITE_INPUT_FIELD_ATTRIBUTES as BROWSER_ATTRIBUTES,
  WRITE_INPUT_VALUE_CHANGES as BROWSER_VALUE_CHANGES,
} from '../../src/browser/form-submission-common.js';
import { WRITE_FORM_REASONS } from '../../src/browser/write-form-submitter.js';
import {
  WRITE_INPUT_FAILURE_REASONS,
  WRITE_INPUT_FAILURE_STAGES,
  WRITE_INPUT_FIELD_ATTRIBUTES,
  WRITE_INPUT_VALUE_CHANGES,
  type ActionEvidenceDocument,
  type ActionEvidenceInputFailure,
} from '../../src/control/actions/action-contracts.js';
import { validateArtifact } from '../../src/core/schema-validator.js';
import { blockedDocuments, verifiedCreateDocuments } from '../helpers/action-report-samples.js';

describe('OP-O O1: the closed lists of the input failure record', () => {
  it('are the copies of the lists of the input parts (the API reasons, then the form reasons, without duplicates)', () => {
    expect(WRITE_INPUT_FAILURE_STAGES).toEqual(BROWSER_STAGES);
    expect(WRITE_INPUT_FIELD_ATTRIBUTES).toEqual(BROWSER_ATTRIBUTES);
    expect(WRITE_INPUT_VALUE_CHANGES).toEqual(BROWSER_VALUE_CHANGES);
    expect(WRITE_INPUT_FAILURE_REASONS).toEqual([...new Set([...API_WRITE_INPUT_REASONS, ...WRITE_FORM_REASONS])]);
  });
});

describe('OP-O O1: the kind of a value change (no value is returned)', () => {
  it.each([
    ['emptied', 'T40b name', '', 'EMPTIED'],
    ['surrounding whitespace', 'T40b name', ' T40b name ', 'SURROUNDING_WHITESPACE'],
    ['digit grouping', '1000', '1,000', 'DIGIT_GROUPING'],
    ['digit grouping with spaces', '1234567', '1 234 567', 'DIGIT_GROUPING'],
    ['a dropped leading zero', '007', '7', 'NUMBER_FORMAT'],
    ['a trimmed fraction', '1.50', '1.5', 'NUMBER_FORMAT'],
    ['an exponent', '0.0000001', '1e-7', 'NUMBER_FORMAT'],
    ['another value', 'T40b name', 'T40b name!', 'OTHER'],
    ['another number', '12', '13', 'OTHER'],
  ] as const)('classifies %s', (_label, expected, actual, kind) => {
    expect(valueChangeKindOf(expected, actual)).toBe(kind);
  });
});

describe('OP-O O1: the schema of the input failure record', () => {
  const failure: ActionEvidenceInputFailure = {
    stage: 'FILL', reason: 'VALUE_CHANGED', fieldPosition: 1, fieldType: 'number', fieldAttributes: ['min', 'max'], valueChange: 'NUMBER_FORMAT',
  };
  const blockedWith = (inputFailure: unknown): ActionEvidenceDocument => {
    const { evidence } = blockedDocuments();
    return { ...evidence, precheck: { candidateDigestMatched: true, blockReason: 'PRECHECK_FAILED', inputFailure } as never, reason: 'PRECHECK_FAILED' };
  };

  it('accepts the record on a run that was not sent, with unknown facts as null', async () => {
    expect(await validateArtifact('action-evidence', blockedWith(failure))).toEqual({ ok: true });
    expect(await validateArtifact('action-evidence', blockedWith({
      stage: 'INSPECT', reason: 'FORM_CHANGED', fieldPosition: null, fieldType: null, fieldAttributes: null, valueChange: null,
    }))).toEqual({ ok: true });
  });

  it.each([
    ['a value', { ...failure, value: '12' }],
    ['the length of a value', { ...failure, valueLength: 2 }],
    ['an unknown reason', { ...failure, reason: 'MAYBE' }],
    ['an unknown stage', { ...failure, stage: 'TYPE' }],
    ['an unknown attribute', { ...failure, fieldAttributes: ['value'] }],
    ['an unknown field type', { ...failure, fieldType: 'submit' }],
    ['an unknown value change', { ...failure, valueChange: 'TRUNCATED' }],
    ['a missing item', { stage: 'FILL', reason: 'VALUE_CHANGED' }],
  ])('rejects a record with %s', async (_label, inputFailure) => {
    expect((await validateArtifact('action-evidence', blockedWith(inputFailure))).ok).toBe(false);
  });

  it('rejects the record on a sent run', async () => {
    const { evidence } = verifiedCreateDocuments();
    expect((await validateArtifact('action-evidence', { ...evidence, precheck: { ...evidence.precheck, inputFailure: failure } })).ok).toBe(false);
  });
});
