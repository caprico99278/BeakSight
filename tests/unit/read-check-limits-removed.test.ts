// L4・COV-7（設計書 `2026-11-09-beaksight-remove-limits-design.md` 4・5 と、`2026-11-09-beaksight-coverage-by-state-design.md` 3.3 の READ の行）: READ の確かめの
// 上限・期限を置かない。
// - 自動の下書きは、定義の数で止まらない（`LIMIT_REACHED` にならない。上限を渡さない呼び出し）。
// - 構造の読み取りは期限を置かず、L0 の進みの見張り（`watchedPageRead`）で包む。進む間は 10 秒を過ぎても待ち、全く反応がないときだけ終える（偽の時計）。
// - 定義と成果物のスキーマは、件数の上限を持たない（定義の数・送る値の数・期待の数・構造ごとの数・START の定義の数）。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { autoDraftReadCheckChoiceOf, autoDraftReadCheckDefinitionOf } from '../../src/control/approval/api-scenario-autodraft.js';
import { autoDraftDefinitionChoiceOf } from '../../src/control/approval/autodraft-shared.js';
import { validateControlDocument } from '../../src/control/control-schema-validator.js';
import type { Page } from 'playwright';
import { wait } from '../../src/core/deadline.js';
import { PROGRESS_WATCH_QUIET_LIMIT_MS } from '../../src/core/progress-watch.js';
import { validateArtifact } from '../../src/core/schema-validator.js';
import { READ_EVIDENCE_ARTIFACT_SCHEMA_VERSION } from '../../src/discovery/read-check-evaluation.js';
import { watchedPageRead, type ReadWatchEnd } from '../../src/discovery/read-executor.js';

/** 前の期限（10 秒）を十分に超える時間（ms）。 */
const LONG_READ_MS = 10 * 60_000;
const MANY = 25;

afterEach(() => {
  vi.useRealTimers();
});

describe('L4: the automatic draft does not stop at a number of definitions', () => {
  const definitions = Array.from({ length: MANY }, (_value, index) => ({ readCheckId: `read-${index}`, revision: 1, targetPagePath: null }));

  it('creates the template definition with more than 20 definitions', () => {
    expect(autoDraftReadCheckChoiceOf({ createPagePath: '/admin/members/new', readPagePaths: ['/admin/members/12'], definitions })).toEqual({
      kind: 'CREATE',
      template: { value: '/admin/members/{id}', origin: 'INFERRED', ground: 'READ_PAGE_TEMPLATE_FROM_READ_PATH' },
      definition: autoDraftReadCheckDefinitionOf('/admin/members/{id}'),
    });
    expect(autoDraftDefinitionChoiceOf({ definitions, isSame: () => false, definition: 'new' })).toEqual({ kind: 'CREATE', definition: 'new' });
  });
});

describe('L4: the structure read waits as long as it goes on, and ends only when nothing responds (the progress watch of L0)', () => {
  /** ページの自発の変化の印を付けない偽のページ（閉じているので、画面の変化を読みに行かない）。 */
  const quietPage = { on: (): void => undefined, off: (): void => undefined, isClosed: (): boolean => true } as unknown as Page;
  const ended = (end: ReadWatchEnd): string => `ENDED ${end}`;

  it('still waits after 10 seconds and more while the read goes on (fake clock)', async () => {
    vi.useFakeTimers();
    const outcome = watchedPageRead(quietPage, async (signals) => {
      // 1 分ごとに、読み取りの部分が進む（反応なしの長さより短い間隔）。
      for (let minute = 0; minute < LONG_READ_MS / 60_000; minute += 1) {
        await wait(60_000);
        signals.mark('READ_PART');
      }
      return 'read';
    }, ended, 'failed');
    await vi.advanceTimersByTimeAsync(LONG_READ_MS);
    expect(await outcome).toBe('read');
  });

  it('ends the read as unresponsive only after the quiet limit with no sign at all (fake clock)', async () => {
    vi.useFakeTimers();
    let settled = false;
    const outcome = watchedPageRead(quietPage, () => new Promise<string>(() => undefined), ended, 'failed').then((value) => {
      settled = true;
      return value;
    });
    await vi.advanceTimersByTimeAsync(PROGRESS_WATCH_QUIET_LIMIT_MS - 1_000);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await outcome).toBe('ENDED STAGE_UNRESPONSIVE');
  });
});

describe('L4: the schemas have no count limit of the READ checks', () => {
  const expectation = { kind: 'ROW_COUNT_AT_LEAST', count: 1 } as const;

  it('accepts a definition with many parameters and expectations', () => {
    const parameters = Object.fromEntries(Array.from({ length: 60 }, (_value, index) => [`field${index}`, 'x']));
    const definition = { targetIdentityDigest: `sha256:${'a'.repeat(64)}`, parameters, expectations: Array.from({ length: 12 }, () => expectation) };
    expect(validateControlDocument('read-check-definition', definition).ok).toBe(true);
  });

  it('accepts read-evidence.json with more than 20 checks and more than 50 counts of each structure', async () => {
    const check = {
      readCheckId: 'read-1', readCheckRevision: 1, targetKind: 'PAGE', targetPagePath: '/admin/list', state: 'EXECUTED', result: 'MATCHED',
      detail: 'EXPECTATIONS_EVALUATED', url: 'http://127.0.0.1:4173/admin/list', httpStatus: 200, blockedRequests: 0,
      structure: {
        region: 'MAIN', tables: 60, tableRowCounts: Array.from({ length: 60 }, () => 1), lists: 0, listItemCounts: [], detailFields: 0, textLength: 1,
        limitReached: false, settled: true,
      },
      expectations: [],
    };
    const document = {
      schemaVersion: READ_EVIDENCE_ARTIFACT_SCHEMA_VERSION, jobId: 'job-read-1', runId: 'RUN-20261109000000', startedAt: '20261109000000',
      finishedAt: '20261109000100', runStatus: 'COMPLETE', endReason: 'COMPLETED',
      checks: Array.from({ length: MANY }, (_value, index) => ({ ...check, readCheckId: `read-${index}` })),
      // RCA-5: 版 1.3 は検索の確かめの組（`searchChecks`）を必ず持つ。
      searchChecks: [],
    };
    expect(await validateArtifact('read-evidence', document)).toEqual({ ok: true });
  });
});
