/**
 * T27d round 2（Task 27 の設計書の変更履歴「Blocker: T27d」の行の (1)）: ビルドした画面のサーバ（`apps/local-ui/dist`）の chunk の中の、成果物の
 * スキーマの検証（`src/core/schema-validator.ts` の `validateArtifact`）が、スキーマのファイルを読めること。
 * - 画面のサーバは、発見のジョブの終わりに、ワーカーが書いた `discovery.json` を `validateArtifact('discovery')` で確かめる（ジョブの管理）。
 *   検証は chunk の場所から `../../schemas/` を読むので、ビルドの出力に、成果物のスキーマ（`schemas/*.schema.json`）と、それが参照する Control の
 *   スキーマ（`schemas/control/`）が写っていなければならない（`build-tools/control-schemas-plugin.ts`）。
 * - 一時の root（`createTemporaryUiRoot('built')`。リポジトリの外）に写したビルドの出力の chunk を、別の Node の process で import し、検証の関数を
 *   呼ぶ（画面のサーバは起動しない）。chunk の中の検証の関数の名前は、chunk の export の一覧（`validateArtifact as <名前>`）から読む。
 * 先に `npm run build:ui` と `npm run build` が要る（`createTemporaryUiRoot` が確かめる）。
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DISCOVERY_ARTIFACT_SCHEMA_VERSION } from '../../../src/discovery/discovery-result.js';
import { createTemporaryUiRoot, type TemporaryUiRoot } from './helpers/local-server';

/** chunk の export の一覧の、検証の関数の項目（`validateArtifact as <名前>`）。 */
const VALIDATE_ARTIFACT_EXPORT = /\bvalidateArtifact as ([A-Za-z_$][\w$]*)/u;

/** 子の process が、検証の結果を 1 行の JSON で書く。 */
const CHILD_SOURCE = String.raw`
const [chunkUrl, exportName, valuesJson] = process.argv.slice(1);
const module = await import(chunkUrl);
const validate = module[exportName];
const results = [];
for (const [schemaName, value] of JSON.parse(valuesJson)) {
  try {
    results.push({ schemaName, result: await validate(schemaName, value) });
  } catch (error) {
    results.push({ schemaName, thrown: String(error && error.message) });
  }
}
process.stdout.write(JSON.stringify(results));
`;

/** 成果物の検証の名前（`ArtifactSchemaName`）のすべて。 */
const ARTIFACT_SCHEMA_NAMES = ['run', 'audit', 'page', 'finding', 'checkpoint', 'checkpoint-page', 'site-unavailable-diagnostic', 'discovery'] as const;

const DISCOVERY_DOCUMENT = Object.freeze({
  schemaVersion: DISCOVERY_ARTIFACT_SCHEMA_VERSION,
  jobId: 'job-built-1',
  runId: 'RUN-20261011010000',
  startedAt: '20261011010000',
  finishedAt: '20261011010100',
  runStatus: 'COMPLETE',
  endReason: 'COMPLETED',
  maxPages: 1,
  pages: [{
    url: 'http://127.0.0.1:4173/admin',
    state: 'READ',
    record: { location: { origin: 'http://127.0.0.1:4173', path: '/admin' }, incompleteReasons: [], candidates: [] },
    blockedRequests: 0,
  }],
  omittedUnreadPages: 0,
});

interface ChildResult {
  readonly schemaName: string;
  readonly result?: { readonly ok: boolean; readonly errors?: readonly string[] };
  readonly thrown?: string;
}

describe('T27d round 2: the artifact schema validation in the built UI server', () => {
  let root: TemporaryUiRoot | undefined;

  beforeAll(() => {
    root = createTemporaryUiRoot('built');
  });

  afterAll(() => {
    root?.remove();
  });

  /** 一時の root のビルドの出力の chunk で、値を検証する。 */
  const validateInBuiltChunk = (values: readonly (readonly [string, unknown])[]): readonly ChildResult[] => {
    const assets = `${root?.root ?? ''}/apps/local-ui/dist/server/assets`;
    const chunks = readdirSync(assets)
      .filter((name) => name.endsWith('.js'))
      .flatMap((name) => {
        const match = VALIDATE_ARTIFACT_EXPORT.exec(readFileSync(`${assets}/${name}`, 'utf8'));
        return match?.[1] === undefined ? [] : [{ name, exportName: match[1] }];
      });
    // 検証の関数を定義する chunk（export の一覧に `validateArtifact as` を持つ chunk）は 1 つ。
    expect(chunks).toHaveLength(1);
    const [chunk] = chunks;
    const child = spawnSync(process.execPath, [
      '--input-type=module',
      '-e',
      CHILD_SOURCE,
      pathToFileURL(`${assets}/${chunk?.name ?? ''}`).href,
      chunk?.exportName ?? '',
      JSON.stringify(values),
    ], { cwd: root?.root, encoding: 'utf8' });
    expect(child.status, child.stderr).toBe(0);
    return JSON.parse(child.stdout) as readonly ChildResult[];
  };

  it('accepts a discovery.json and rejects a broken one (the schema files are readable from the chunk)', () => {
    const results = validateInBuiltChunk([
      ['discovery', DISCOVERY_DOCUMENT],
      ['discovery', { ...DISCOVERY_DOCUMENT, cookies: [] }],
    ]);
    expect(results.map(({ thrown }) => thrown ?? null)).toEqual([null, null]);
    expect(results.map(({ result }) => result?.ok)).toEqual([true, false]);
  });

  it('loads every artifact schema in the built chunk (a sample that does not match is rejected, nothing throws)', () => {
    const results = validateInBuiltChunk(ARTIFACT_SCHEMA_NAMES.map((name) => [name, null] as const));
    expect(results).toEqual(ARTIFACT_SCHEMA_NAMES.map((schemaName) => expect.objectContaining({
      schemaName,
      result: expect.objectContaining({ ok: false }) as unknown,
    })));
  });
});
