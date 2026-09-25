// R15c: Run の ID を、開始の時刻（UTC）から作る（Task 14〜17 の設計書 5.6.7）。
// 形は `RUN-YYYYMMDDHHmmss` で、run.json のスキーマの `runId` の pattern に合う。
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { createRunId } from '../../src/core/ids.js';
import { createRunIdFromTime } from '../../src/orchestration/run-id.js';

const runSchemaUrl = new URL('../../schemas/run.schema.json', import.meta.url);

async function runIdSchemaPattern(): Promise<RegExp> {
  const schema = JSON.parse(await readFile(runSchemaUrl, 'utf8')) as {
    readonly properties: { readonly runId: { readonly pattern: string } };
  };
  return new RegExp(schema.properties.runId.pattern, 'u');
}

describe('createRunIdFromTime (R15c)', () => {
  it('formats the UTC start time as RUN-YYYYMMDDHHmmss', () => {
    expect(createRunIdFromTime(new Date('2026-09-24T12:34:56.789Z'))).toBe('RUN-20260924123456');
  });

  it('uses UTC even when the instant is given with a local offset', () => {
    // 日本時間の 2026-09-25 08:05:09 は、UTC では 2026-09-24 23:05:09 である。
    expect(createRunIdFromTime(new Date('2026-09-25T08:05:09+09:00'))).toBe('RUN-20260924230509');
  });

  it('zero-pads every month, day, hour, minute and second field', () => {
    expect(createRunIdFromTime(new Date('2027-01-02T03:04:05.000Z'))).toBe('RUN-20270102030405');
    expect(createRunIdFromTime(new Date('2027-01-01T00:00:00.000Z'))).toBe('RUN-20270101000000');
  });

  it('matches the runId pattern of the run schema', async () => {
    const pattern = await runIdSchemaPattern();

    expect(createRunIdFromTime(new Date('2026-09-24T00:00:00.000Z'))).toMatch(pattern);
    expect(createRunIdFromTime(new Date('1000-01-01T00:00:00.000Z'))).toMatch(pattern);
    expect(createRunIdFromTime(new Date('9999-12-31T23:59:59.999Z'))).toMatch(pattern);
  });

  it('shares the RUN- format with createRunId instead of writing it again', () => {
    expect(createRunIdFromTime(new Date('2026-09-24T12:34:56.000Z'))).toBe(createRunId(20260924123456));
  });

  it('rejects an invalid Date and years that do not have four digits', () => {
    expect(() => createRunIdFromTime(new Date(Number.NaN))).toThrow(RangeError);
    expect(() => createRunIdFromTime(new Date('0999-12-31T23:59:59.000Z'))).toThrow(RangeError);
    expect(() => createRunIdFromTime(new Date('+010000-01-01T00:00:00.000Z'))).toThrow(RangeError);
    expect(() => createRunIdFromTime('2026-09-24T00:00:00Z' as unknown as Date)).toThrow(RangeError);
  });
});
