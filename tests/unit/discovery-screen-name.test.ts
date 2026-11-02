// OP-2 の修正の 1 回目（判断 2）: 操作さがしで記録する画面の名前（見出し h1 と題 title）の形（`src/discovery/discovery-result.ts`）。
// - 空白をまとめ、長さの上限（`MAX_DISCOVERY_SCREEN_NAME_LENGTH`）で切る。空・文字でない値は null。
// - 秘密に見える文（`isSecretLikeText`）は記録しない（null）。
// - 一覧の行の名前は、その画面の見出し → 題の順（`discoveryPageScreenNameOf`）。読んだ画面がない・名前がないときは null。
// - 成果物のスキーマに通る（`screenName` は任意の項目）。
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateArtifact } from '../../src/core/schema-validator.js';
import {
  DISCOVERY_ARTIFACT_SCHEMA_VERSION,
  MAX_DISCOVERY_SCREEN_NAME_LENGTH,
  discoveryPageScreenNameOf,
  discoveryScreenNameOf,
  withIncompleteReason,
  withServiceReadRefused,
  type DiscoveryDocument,
  type DiscoveryReadPageRecord,
} from '../../src/discovery/discovery-result.js';
import { notObservedSubmissionProbeOf, withSubmissionProbes } from '../../src/discovery/submission-probe-contracts.js';
import { candidateOf } from './approval-samples.js';
import { NO_JS_BINDING, sampleButton } from './discovery-candidate-samples.js';

import { SAMPLE_ORIGIN as ORIGIN } from './discovery-candidate-samples.js';

const documentOf = (pages: DiscoveryDocument['pages']): DiscoveryDocument => ({
  schemaVersion: DISCOVERY_ARTIFACT_SCHEMA_VERSION,
  jobId: 'job-1',
  runId: 'RUN-20261027010000',
  startedAt: '20261027010000',
  finishedAt: '20261027010100',
  runStatus: 'COMPLETE',
  endReason: 'COMPLETED',
  maxPages: 10,
  pages,
  omittedUnreadPages: 0,
});

const readPage = (path: string, screenName?: { heading: string | null; title: string | null }): DiscoveryDocument['pages'][number] => ({
  url: `${ORIGIN}${path}`,
  state: 'READ',
  record: { location: { origin: ORIGIN, path }, incompleteReasons: [], candidates: [], ...(screenName === undefined ? {} : { screenName }) },
  blockedRequests: 0,
} as DiscoveryDocument['pages'][number]);

describe('discoveryScreenNameOf (OP-2 fix round 1, the decision 2)', () => {
  it('folds the white space and keeps a plain heading and title', () => {
    expect(discoveryScreenNameOf('  会員の\n  登録 ', '会員')).toEqual({ heading: '会員の 登録', title: '会員' });
  });

  it('gives null for an empty or a non-text value', () => {
    expect(discoveryScreenNameOf('   ', null)).toEqual({ heading: null, title: null });
    expect(discoveryScreenNameOf(3, { text: 'x' })).toEqual({ heading: null, title: null });
  });

  it('cuts a long name at the limit', () => {
    const long = 'あ'.repeat(MAX_DISCOVERY_SCREEN_NAME_LENGTH + 20);
    const name = discoveryScreenNameOf(long, long);
    expect(MAX_DISCOVERY_SCREEN_NAME_LENGTH).toBe(60);
    expect(name.heading).toHaveLength(MAX_DISCOVERY_SCREEN_NAME_LENGTH);
    expect(name.title).toHaveLength(MAX_DISCOVERY_SCREEN_NAME_LENGTH);
  });

  it('does not keep a name that looks like a secret', () => {
    expect(discoveryScreenNameOf('token=Abc123secret の画面', 'https://user:pass@example.test/')).toEqual({ heading: null, title: null });
    expect(discoveryScreenNameOf('Bearer AbCd123xyz', '会員')).toEqual({ heading: null, title: '会員' });
  });
});

describe('discoveryPageScreenNameOf (OP-2 fix round 1, the decision 2)', () => {
  it('uses the heading, then the title, of the read page with the path', () => {
    const document = documentOf([
      readPage('/members/new', { heading: '会員の登録', title: 'members' }),
      readPage('/items/new', { heading: null, title: '品物' }),
      readPage('/old'),
    ]);
    expect(discoveryPageScreenNameOf(document, '/members/new')).toBe('会員の登録');
    expect(discoveryPageScreenNameOf(document, '/items/new')).toBe('品物');
    expect(discoveryPageScreenNameOf(document, '/old')).toBeNull();
    expect(discoveryPageScreenNameOf(document, '/none')).toBeNull();
    expect(discoveryPageScreenNameOf(null, '/members/new')).toBeNull();
  });

  it('passes the discovery schema with the screen name, and rejects a name over the limit', async () => {
    const document = documentOf([readPage('/members/new', { heading: '会員の登録', title: null })]);
    const result = await validateArtifact('discovery', JSON.parse(JSON.stringify(document)));
    expect(result.ok ? [] : result.errors).toEqual([]);
    const tooLong = documentOf([readPage('/members/new', { heading: 'あ'.repeat(MAX_DISCOVERY_SCREEN_NAME_LENGTH + 1), title: null })]);
    expect((await validateArtifact('discovery', JSON.parse(JSON.stringify(tooLong)))).ok).toBe(false);
  });
});

// OP-K（K1）: 押して確かめた画面（API の登録の行は、どれもこれに当たる）と、読み切れなかった理由を後から足した画面でも、画面の名前を落とさない（前は、記録を
// 作り直す 2 つの部品が `screenName` を写さず、一覧の行の名前が「登録の画面（1）」になっていた）。
describe('OP-K (K1): the screen name stays when the record is rebuilt', () => {
  const screenName = { heading: '会員の登録', title: '管理' };
  const record: DiscoveryReadPageRecord = {
    location: { origin: ORIGIN, path: '/admin/members/new' },
    incompleteReasons: [],
    candidates: [candidateOf(sampleButton({ page: { origin: ORIGIN, path: '/admin/members/new' }, submitterText: '保存', jsBinding: { ...NO_JS_BINDING, submitter: ['click'] } }))],
    screenName,
  };

  it('keeps the screen name with the probe results of the pressed candidates', () => {
    const probed = withSubmissionProbes(record, new Map([[0, notObservedSubmissionProbeOf('PAGE_CHANGED', { filledFieldCount: 0, skippedFieldCount: 0 }, [])]]));
    expect(probed.candidates[0]?.submissionProbe).toBeDefined();
    expect(probed.screenName).toEqual(screenName);
  });

  it('keeps the screen name with an incomplete reason added after the page closed', () => {
    expect(withIncompleteReason(record, 'INCOMPLETE_PAGE_NAVIGATION_LIMIT').screenName).toEqual(screenName);
    expect(withServiceReadRefused(record).screenName).toEqual(screenName);
  });

  it('adds no screen name to a record without one', () => {
    const { screenName: _name, ...unnamed } = record;
    expect('screenName' in withIncompleteReason(unnamed, 'INCOMPLETE_PAGE_NAVIGATION_LIMIT')).toBe(false);
    expect('screenName' in withSubmissionProbes(unnamed, new Map([[0, notObservedSubmissionProbeOf('PAGE_CHANGED', { filledFieldCount: 0, skippedFieldCount: 0 }, [])]]))).toBe(false);
  });
});

describe('the discovery schema limit of the screen name (OP-2 fix round 1)', () => {
  it('uses the same limit as the constant', () => {
    const schema = JSON.parse(readFileSync(resolve(process.cwd(), 'schemas', 'discovery.schema.json'), 'utf8')) as {
      $defs: { record: { properties: { screenName: { properties: Record<'heading' | 'title', { anyOf: readonly { maxLength?: number }[] }> } } } };
    };
    const { heading, title } = schema.$defs.record.properties.screenName.properties;
    expect([heading.anyOf[0]?.maxLength, title.anyOf[0]?.maxLength]).toEqual([MAX_DISCOVERY_SCREEN_NAME_LENGTH, MAX_DISCOVERY_SCREEN_NAME_LENGTH]);
  });
});
