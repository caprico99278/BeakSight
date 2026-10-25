// T24d（Task 24 の設計書 4.3、7 章「ワーカーと IPC」）: IPC の契約（`src/control/worker-protocol.ts`）と、そのスキーマ
// （`schemas/control/worker-message.schema.json`）の検査。
// - 各メッセージの正しい形が通り、凍結した写しが返る（受けた値と参照を共有しない）。
// - 形の違う値（余分な項目、型の違い、上限を超える文字列、未知の種類、受けないパス、向きの違うメッセージ、写せない値）を拒む。
// - 値の一覧（メッセージの種類、理由、結果の種類、再開の判断、知らせの種類）と上限が、スキーマと一致する。
// - 契約の一覧のうち、ほかの owner の一覧の写し（結果の種類、再開の判断、失敗の種類）が、元の一覧と一致する（Gate のため、`src/control/` は
//   `src/cli/` と `src/orchestration/` を実行時に読み込めないので、写しを持つ。ずれたらここで失敗する）。
// 例の値は、匿名の値（`127.0.0.1`、`example`）だけを使う。
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AUDIT_RUN_OUTCOME_KINDS,
  AUDIT_RUN_RESUME_DECISION_KINDS,
} from '../../src/cli/audit-run.js';
import { CLI_FAILURE_KINDS } from '../../src/cli/failure.js';
import { MAX_ADDITIONAL_NAVIGATION_WAIT_MS } from '../../src/crawl/navigation-pacer.js';
import {
  MAX_WORKER_EXIT_CODE,
  MAX_WORKER_FAILURE_DETAIL_LENGTH,
  MAX_WORKER_MESSAGE_PATH_LENGTH,
  MAX_WORKER_NOTICE_URL_LENGTH,
  PARENT_TO_WORKER_MESSAGE_TYPES,
  WORKER_FAILURE_REASONS,
  WORKER_HEARTBEAT_INTERVAL_MS,
  WORKER_JOB_ID_PATTERN,
  WORKER_MESSAGE_TYPES,
  WORKER_NOTICE_KINDS,
  WORKER_OUTCOME_KINDS,
  WORKER_PROTOCOL_VERSION,
  WORKER_RESUME_DECISION_KINDS,
  WORKER_RUN_STATUSES,
  WORKER_START_TIMEOUT_MS,
  WORKER_TO_PARENT_MESSAGE_TYPES,
  TARGET_CONFIG_SHA256_PATTERN,
  targetConfigDigestOf,
  toWorkerFailureDetail,
  validateParentToWorkerMessage,
  validateWorkerToParentMessage,
  type ParentToWorkerMessage,
  type WorkerToParentMessage,
} from '../../src/control/worker-protocol.js';
import { RUN_STATUSES, type RunId } from '../../src/core/contracts.js';
import { MAX_URL_LENGTH } from '../../src/core/limits.js';

const SCHEMA_PATH = resolve(process.cwd(), 'schemas', 'control', 'worker-message.schema.json');
const SCHEMA = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8')) as Record<string, unknown>;
const RUN_SCHEMA = JSON.parse(readFileSync(resolve(process.cwd(), 'schemas', 'run.schema.json'), 'utf8')) as Record<string, unknown>;

/** JSON Pointer（RFC 6901）で値を引く（`~1` と `~0` を戻す）。 */
const pointerValue = (document: unknown, pointer: string): unknown =>
  pointer.split('/').slice(1).reduce<unknown>((value, rawKey) => {
    const key = rawKey.replaceAll('~1', '/').replaceAll('~0', '~');
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[key] : undefined;
  }, document);

const definitionOf = (name: string): Record<string, unknown> => pointerValue(SCHEMA, `/$defs/${name}`) as Record<string, unknown>;

const RUN_ID = 'RUN-20261009000001' as RunId;
/** ターゲット JSON の SHA-256 の例（T24h-1 の M3）。 */
const SHA256 = targetConfigDigestOf(new TextEncoder().encode('{}'));
const COUNTS = Object.freeze({ count: 3, peakPerMinute: 2 });

const PROGRESS_REPORT = Object.freeze({
  pagesFinished: 2,
  pagesDiscovered: 5,
  maxPages: 500,
  elapsedMs: 1_234,
  navigationCount: 6,
  pacingWaitMs: 0,
  requests: { allowedOrigins: COUNTS, otherOrigins: { count: 0, peakPerMinute: 0 }, servedFromCache: 1, withheldOtherOrigins: 0 },
  recentPerMinute: { allowedOrigins: 3, otherOrigins: 0 },
});

const VALID_PARENT_MESSAGES: readonly (readonly [string, ParentToWorkerMessage])[] = [
  ['START (new)', { protocol: WORKER_PROTOCOL_VERSION, type: 'START', jobId: 'job-0001', jobKind: 'AUDIT', targetConfigPath: 'config/targets/example.json', startNew: true, targetConfigSha256: SHA256 }],
  ['START (local target)', { protocol: WORKER_PROTOCOL_VERSION, type: 'START', jobId: 'a', jobKind: 'AUDIT', targetConfigPath: 'local/targets/sub/example.json', startNew: false, targetConfigSha256: SHA256 }],
  ['START (longest job id)', { protocol: WORKER_PROTOCOL_VERSION, type: 'START', jobId: `a${'0'.repeat(63)}`, jobKind: 'AUDIT', targetConfigPath: 'config/targets/x.json', startNew: false, targetConfigSha256: SHA256 }],
  ['STOP', { protocol: WORKER_PROTOCOL_VERSION, type: 'STOP', force: false }],
  ['STOP (force)', { protocol: WORKER_PROTOCOL_VERSION, type: 'STOP', force: true }],
];

const VALID_WORKER_MESSAGES: readonly (readonly [string, WorkerToParentMessage])[] = [
  ['READY', { protocol: WORKER_PROTOCOL_VERSION, type: 'READY' }],
  ['HEARTBEAT', { protocol: WORKER_PROTOCOL_VERSION, type: 'HEARTBEAT' }],
  // DEF-143: 「Run の終わり」の段（集計・成果物の書き出し・止めたときの片付け）に入る知らせ。
  ['RUN_FINALIZING', { protocol: WORKER_PROTOCOL_VERSION, type: 'RUN_FINALIZING' }],
  ['RUN_STARTED (new)', {
    protocol: WORKER_PROTOCOL_VERSION, type: 'RUN_STARTED', runId: RUN_ID, runDirectory: RUN_ID, resumeDecision: { kind: 'NEW_RUN', completedPages: null },
  }],
  ['RUN_STARTED (resume)', {
    protocol: WORKER_PROTOCOL_VERSION, type: 'RUN_STARTED', runId: RUN_ID, runDirectory: RUN_ID, resumeDecision: { kind: 'RESUME', completedPages: 3 },
  }],
  ['RUN_STARTED (finalize only)', {
    protocol: WORKER_PROTOCOL_VERSION, type: 'RUN_STARTED', runId: RUN_ID, runDirectory: `nested/${RUN_ID}`, resumeDecision: { kind: 'FINALIZE_ONLY', completedPages: null },
  }],
  ['PROGRESS', { protocol: WORKER_PROTOCOL_VERSION, type: 'PROGRESS', report: PROGRESS_REPORT }],
  ['NOTICE (recheck)', {
    protocol: WORKER_PROTOCOL_VERSION,
    type: 'NOTICE',
    notice: { kind: 'SITE_UNAVAILABLE_RECHECK', url: 'http://127.0.0.1:4173/a', delayMs: 30_000, attempt: 1, maxAttempts: 4 },
  }],
  ['NOTICE (recheck, longest url)', {
    protocol: WORKER_PROTOCOL_VERSION,
    type: 'NOTICE',
    notice: { kind: 'SITE_UNAVAILABLE_RECHECK', url: 'u'.repeat(MAX_WORKER_NOTICE_URL_LENGTH), delayMs: 0, attempt: 1, maxAttempts: 1 },
  }],
  ['NOTICE (slowdown)', { protocol: WORKER_PROTOCOL_VERSION, type: 'NOTICE', notice: { kind: 'SITE_UNAVAILABLE_SLOWDOWN', minIntervalMs: 10_000 } }],
  // DEF-141: 承認したサービスへの要求の 1 分あたりの上限で、次の読み込みの前に待つ（待つ時間は 1 分まで）。
  ['NOTICE (service request pacing)', {
    protocol: WORKER_PROTOCOL_VERSION,
    type: 'NOTICE',
    notice: { kind: 'SERVICE_REQUEST_PACING_WAIT', waitMs: 60_000, waitCount: 2, totalWaitMs: 75_000 },
  }],
  ['FINISHED (RAN)', {
    protocol: WORKER_PROTOCOL_VERSION, type: 'FINISHED', outcome: { kind: 'RAN', exitCode: 2, runId: RUN_ID, runDirectory: RUN_ID, runStatus: 'PARTIAL' },
  }],
  ['FINISHED (RUN_ACTIVE)', {
    protocol: WORKER_PROTOCOL_VERSION, type: 'FINISHED', outcome: { kind: 'RUN_ACTIVE', exitCode: 4, runId: RUN_ID, runDirectory: null, runStatus: null },
  }],
  // DEF-057 の開始のロック: 別の起動が開始の段にいて、実行中の Run の ID がまだ決まっていない。
  ['FINISHED (RUN_ACTIVE, the run id is not decided yet)', {
    protocol: WORKER_PROTOCOL_VERSION, type: 'FINISHED', outcome: { kind: 'RUN_ACTIVE', exitCode: 4, runId: null, runDirectory: null, runStatus: null },
  }],
  ['FINISHED (VERSION_MISMATCH)', {
    protocol: WORKER_PROTOCOL_VERSION, type: 'FINISHED', outcome: { kind: 'VERSION_MISMATCH', exitCode: 4, runId: RUN_ID, runDirectory: RUN_ID, runStatus: null },
  }],
  ['FINISHED (RUN_DIRECTORY_UNAVAILABLE)', {
    protocol: WORKER_PROTOCOL_VERSION,
    type: 'FINISHED',
    outcome: { kind: 'RUN_DIRECTORY_UNAVAILABLE', exitCode: 1, runId: RUN_ID, runDirectory: RUN_ID, runStatus: 'FAILED' },
  }],
  ['FINISHED (RESUME_UNAVAILABLE)', {
    protocol: WORKER_PROTOCOL_VERSION, type: 'FINISHED', outcome: { kind: 'RESUME_UNAVAILABLE', exitCode: 4, runId: RUN_ID, runDirectory: RUN_ID, runStatus: null },
  }],
  ['FAILED', { protocol: WORKER_PROTOCOL_VERSION, type: 'FAILED', reason: 'CONFIG_ERROR', detail: 'invalid configuration: crawl.maxPages must be positive' }],
  ['FAILED (empty detail)', { protocol: WORKER_PROTOCOL_VERSION, type: 'FAILED', reason: 'START_TIMEOUT', detail: '' }],
  ['FAILED (longest detail)', {
    protocol: WORKER_PROTOCOL_VERSION, type: 'FAILED', reason: 'UNEXPECTED_FAILURE', detail: 'd'.repeat(MAX_WORKER_FAILURE_DETAIL_LENGTH),
  }],
];

/** 正しい形の値の写しに、`change` を加えた値（入れ子の項目は、`path` の先を置き換える）。 */
function changed(base: object, path: readonly string[], value: unknown): unknown {
  const copy = structuredClone(base) as Record<string, unknown>;
  let target: Record<string, unknown> = copy;
  for (const key of path.slice(0, -1)) {
    target = target[key] as Record<string, unknown>;
  }
  const last = path.at(-1) ?? '';
  if (value === REMOVE) {
    delete target[last];
  } else {
    target[last] = value;
  }
  return copy;
}
const REMOVE = Symbol('remove');

const messageOf = (list: readonly (readonly [string, object])[], name: string): object => {
  const found = list.find(([candidate]) => candidate === name);
  if (found === undefined) {
    throw new Error(`no example named ${name}`);
  }
  return found[1];
};
const parentExample = (name: string): object => messageOf(VALID_PARENT_MESSAGES, name);
const workerExample = (name: string): object => messageOf(VALID_WORKER_MESSAGES, name);

describe('worker protocol: valid messages', () => {
  it.each(VALID_PARENT_MESSAGES)('accepts the parent message %s, and returns a frozen copy', (_name, message) => {
    const result = validateParentToWorkerMessage(message);
    expect(result).toEqual({ ok: true, message });
    if (result.ok) {
      expect(result.message).not.toBe(message);
      expect(Object.isFrozen(result.message)).toBe(true);
    }
  });

  it.each(VALID_WORKER_MESSAGES)('accepts the worker message %s, and returns a deeply frozen copy', (_name, message) => {
    const result = validateWorkerToParentMessage(message);
    expect(result).toEqual({ ok: true, message });
    if (result.ok) {
      expect(result.message).not.toBe(message);
      expect(Object.isFrozen(result.message)).toBe(true);
      for (const value of Object.values(result.message)) {
        if (typeof value === 'object' && value !== null) {
          expect(Object.isFrozen(value)).toBe(true);
        }
      }
    }
  });
});

describe('worker protocol: rejected messages (fail-closed)', () => {
  const start = parentExample('START (new)');
  const stop = parentExample('STOP');

  it.each([
    ['not an object', 'START'],
    ['null', null],
    ['an array', [start]],
    ['an unknown type', { ...start, type: 'RESTART' }],
    // T30e: 版を `/2` に上げた（前の版 `/1` は受けない）。
    ['a wrong protocol version', { ...start, protocol: 'beaksight-worker-message/1' }],
    ['no protocol version', changed(start, ['protocol'], REMOVE)],
    ['an extra property', { ...start, headed: true }],
    ['an extra property on STOP', { ...stop, reason: 'user' }],
    ['startNew as a string', { ...start, startNew: 'true' }],
    ['force as a number', { ...stop, force: 1 }],
    ['no jobId', changed(start, ['jobId'], REMOVE)],
    ['an empty jobId', { ...start, jobId: '' }],
    ['a jobId with an upper case letter', { ...start, jobId: 'Job-1' }],
    ['a jobId starting with a hyphen', { ...start, jobId: '-job' }],
    ['a jobId that is too long', { ...start, jobId: `a${'0'.repeat(64)}` }],
    ['a target path with ..', { ...start, targetConfigPath: 'config/targets/../x.json' }],
    ['a target path outside the target directories', { ...start, targetConfigPath: 'config/x.json' }],
    ['an absolute target path', { ...start, targetConfigPath: 'C:/config/targets/x.json' }],
    ['a target path with a backslash', { ...start, targetConfigPath: 'config\\targets\\x.json' }],
    ['a target path that is not JSON', { ...start, targetConfigPath: 'config/targets/x.txt' }],
    ['a target path with a stream', { ...start, targetConfigPath: 'config/targets/x.json:s' }],
    ['a target path that is too long', { ...start, targetConfigPath: `config/targets/${'a'.repeat(MAX_WORKER_MESSAGE_PATH_LENGTH)}.json` }],
    ['a worker message (READY) sent to the worker', workerExample('READY')],
    ['a worker message (FINISHED) sent to the worker', workerExample('FINISHED (RAN)')],
    ['a function value', { ...start, startNew: () => true }],
    // T24h-1 の M3: 設定の SHA-256 は必須で、小文字の 16 進の 64 文字だけ。
    ['no config digest', changed(start, ['targetConfigSha256'], REMOVE)],
    ['a config digest in upper case', { ...start, targetConfigSha256: SHA256.toUpperCase() }],
    ['a config digest that is too short', { ...start, targetConfigSha256: SHA256.slice(1) }],
    ['a config digest that is not hexadecimal', { ...start, targetConfigSha256: 'g'.repeat(SHA256.length) }],
  ] as const)('rejects a parent message with %s', (_name, value) => {
    const result = validateParentToWorkerMessage(value);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.length).toBeGreaterThan(0);
    }
  });

  it('rejects a Proxy and a getter without returning the original object', () => {
    const proxy = new Proxy({ ...start }, {});
    expect(validateParentToWorkerMessage(proxy).ok).toBe(false);
    let reads = 0;
    const withGetter = { ...start, get startNew() { reads += 1; return true; } };
    const result = validateParentToWorkerMessage(withGetter);
    // getter は写しを取るときに 1 回だけ読む（確かめと使う時とで 2 回読まない）。
    expect(reads).toBe(1);
    if (result.ok) {
      expect(result.message).not.toBe(withGetter);
    }
  });

  const runStarted = workerExample('RUN_STARTED (new)');
  const resumed = workerExample('RUN_STARTED (resume)');
  const progress = workerExample('PROGRESS');
  const recheck = workerExample('NOTICE (recheck)');
  const ran = workerExample('FINISHED (RAN)');
  const active = workerExample('FINISHED (RUN_ACTIVE)');
  const failed = workerExample('FAILED');

  it.each([
    ['a parent message (START) sent to the parent', start],
    ['an extra property on READY', { ...workerExample('READY'), pid: 1 }],
    ['an extra property on HEARTBEAT', { ...workerExample('HEARTBEAT'), at: 1 }],
    ['an extra property on RUN_FINALIZING', { ...workerExample('RUN_FINALIZING'), pages: 1 }],
    ['an invalid run id', changed(runStarted, ['runId'], 'RUN-1')],
    ['a run directory with ..', changed(runStarted, ['runDirectory'], `${RUN_ID}/..`)],
    ['a run directory that goes up', changed(runStarted, ['runDirectory'], `../${RUN_ID}`)],
    ['an absolute run directory', changed(runStarted, ['runDirectory'], `C:/${RUN_ID}`)],
    ['a run directory with a backslash', changed(runStarted, ['runDirectory'], `out\\${RUN_ID}`)],
    ['a run directory that is a device name', changed(runStarted, ['runDirectory'], 'CON')],
    ['a run directory that is too long', changed(runStarted, ['runDirectory'], 'a'.repeat(MAX_WORKER_MESSAGE_PATH_LENGTH + 1))],
    ['an unknown resume decision', changed(runStarted, ['resumeDecision', 'kind'], 'MAYBE')],
    ['a NEW_RUN decision with completed pages', changed(runStarted, ['resumeDecision', 'completedPages'], 1)],
    ['a RESUME decision without completed pages', changed(resumed, ['resumeDecision', 'completedPages'], null)],
    ['a progress count that is negative', changed(progress, ['report', 'pagesFinished'], -1)],
    ['a progress count that is not an integer', changed(progress, ['report', 'elapsedMs'], 1.5)],
    ['a progress count that is not a safe integer', changed(progress, ['report', 'pagesDiscovered'], Number.MAX_SAFE_INTEGER + 2)],
    ['a progress count as a string', changed(progress, ['report', 'maxPages'], '500')],
    ['a progress report with an extra property', changed(progress, ['report', 'extra'], 1)],
    ['a progress report without a property', changed(progress, ['report', 'recentPerMinute'], REMOVE)],
    ['nested request counts with an extra property', changed(progress, ['report', 'requests', 'allowedOrigins', 'extra'], 1)],
    ['an unknown notice kind', changed(recheck, ['notice', 'kind'], 'SITE_DOWN')],
    ['a notice url that is too long', changed(recheck, ['notice', 'url'], 'u'.repeat(MAX_WORKER_NOTICE_URL_LENGTH + 1))],
    ['a notice url with a lone surrogate', changed(recheck, ['notice', 'url'], 'http://127.0.0.1/\ud800')],
    ['a slowdown notice with a url', { ...workerExample('NOTICE (slowdown)'), notice: { kind: 'SITE_UNAVAILABLE_SLOWDOWN', minIntervalMs: 1, url: 'x' } }],
    // DEF-141: 待つ時間は 1 分（`MAX_ADDITIONAL_NAVIGATION_WAIT_MS`）まで。0 の待ちは知らせない。URL は持たない。
    ['a pacing notice over one minute', changed(workerExample('NOTICE (service request pacing)'), ['notice', 'waitMs'], 60_001)],
    ['a pacing notice of no wait', changed(workerExample('NOTICE (service request pacing)'), ['notice', 'waitMs'], 0)],
    ['a pacing notice with a url', changed(workerExample('NOTICE (service request pacing)'), ['notice', 'url'], 'x')],
    ['a pacing notice without the total', changed(workerExample('NOTICE (service request pacing)'), ['notice', 'totalWaitMs'], REMOVE)],
    ['an unknown outcome kind', changed(ran, ['outcome', 'kind'], 'DONE')],
    ['an unknown run status', changed(ran, ['outcome', 'runStatus'], 'DONE')],
    ['a RAN outcome without a run status', changed(ran, ['outcome', 'runStatus'], null)],
    ['a RAN outcome without a run id', changed(ran, ['outcome', 'runId'], null)],
    ['a RUN_ACTIVE outcome with an invalid run id', changed(active, ['outcome', 'runId'], 'RUN-')],
    ['a RAN outcome without a run directory', changed(ran, ['outcome', 'runDirectory'], null)],
    ['a RUN_ACTIVE outcome with a run directory', changed(active, ['outcome', 'runDirectory'], RUN_ID)],
    ['a RUN_ACTIVE outcome with a run status', changed(active, ['outcome', 'runStatus'], 'COMPLETE')],
    ['an exit code that is negative', changed(ran, ['outcome', 'exitCode'], -1)],
    ['an exit code that is too large', changed(ran, ['outcome', 'exitCode'], MAX_WORKER_EXIT_CODE + 1)],
    ['an outcome with the cause of an exception', changed(ran, ['outcome', 'cause'], 'Error: x')],
    ['an unknown failure reason', changed(failed, ['reason'], 'CRASHED')],
    ['a failure detail that is too long', changed(failed, ['detail'], 'd'.repeat(MAX_WORKER_FAILURE_DETAIL_LENGTH + 1))],
    ['a failure detail with a line break', changed(failed, ['detail'], 'a\nb')],
    ['a failure detail with a lone surrogate', changed(failed, ['detail'], 'a\udc00')],
    ['a failure detail that is not a string', changed(failed, ['detail'], { message: 'x' })],
  ] as const)('rejects a worker message with %s', (_name, value) => {
    const result = validateWorkerToParentMessage(value);
    expect(result.ok).toBe(false);
  });
});

describe('worker protocol: failure detail', () => {
  it('replaces control characters and lone surrogates, and cuts the detail at the limit', () => {
    expect(toWorkerFailureDetail('a\r\nb\u0000c\u2028d')).toBe('a  b c d');
    expect(toWorkerFailureDetail('x\ud800')).toBe('x\ufffd');
    expect(toWorkerFailureDetail('e'.repeat(MAX_WORKER_FAILURE_DETAIL_LENGTH + 10))).toHaveLength(MAX_WORKER_FAILURE_DETAIL_LENGTH);
    // 切った後に、対になっていないサロゲートを残さない。
    const cut = toWorkerFailureDetail(`${'e'.repeat(MAX_WORKER_FAILURE_DETAIL_LENGTH - 1)}\u{1F600}`);
    expect(cut.isWellFormed()).toBe(true);
    expect(cut.length).toBeLessThanOrEqual(MAX_WORKER_FAILURE_DETAIL_LENGTH);
    const message = { protocol: WORKER_PROTOCOL_VERSION, type: 'FAILED', reason: 'UNEXPECTED_FAILURE', detail: cut };
    expect(validateWorkerToParentMessage(message).ok).toBe(true);
  });
});

describe('worker protocol: value lists, limits and the schema', () => {
  it('splits the message types into the two directions without overlap, in the order of the schema', () => {
    expect([...PARENT_TO_WORKER_MESSAGE_TYPES, ...WORKER_TO_PARENT_MESSAGE_TYPES]).toEqual([...WORKER_MESSAGE_TYPES]);
    expect(new Set(WORKER_MESSAGE_TYPES).size).toBe(WORKER_MESSAGE_TYPES.length);
    const branches = SCHEMA.oneOf as readonly { readonly $ref: string }[];
    const types = branches.map(({ $ref }) => {
      const definition = pointerValue(SCHEMA, $ref.slice(1)) as Record<string, unknown>;
      return pointerValue(definition, '/properties/type/const');
    });
    expect(types).toEqual([...WORKER_MESSAGE_TYPES]);
    for (const list of [PARENT_TO_WORKER_MESSAGE_TYPES, WORKER_TO_PARENT_MESSAGE_TYPES, WORKER_MESSAGE_TYPES]) {
      expect(Object.isFrozen(list)).toBe(true);
    }
  });

  it('has the protocol version, the limits and the patterns of the schema', () => {
    expect(pointerValue(SCHEMA, '/$id')).toBe('urn:beaksight:schema:control:worker-message:1');
    expect(definitionOf('protocol')).toEqual({ const: WORKER_PROTOCOL_VERSION });
    // T30e: 書き込みのジョブの指定と、確かめ直しの往復と、送信の報告を足したので、版を上げた。
    expect(WORKER_PROTOCOL_VERSION).toBe('beaksight-worker-message/2');
    expect(pointerValue(SCHEMA, '/$defs/start/properties/jobId/pattern')).toBe(WORKER_JOB_ID_PATTERN.source);
    expect(pointerValue(SCHEMA, '/$defs/start/properties/targetConfigSha256/pattern')).toBe(TARGET_CONFIG_SHA256_PATTERN.source);
    // 要約は、内容の SHA-256 の 16 進（Node の crypto と同じ値）。
    expect(targetConfigDigestOf(new TextEncoder().encode('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(TARGET_CONFIG_SHA256_PATTERN.test(SHA256)).toBe(true);
    expect(pointerValue(SCHEMA, '/$defs/path/maxLength')).toBe(MAX_WORKER_MESSAGE_PATH_LENGTH);
    expect(pointerValue(SCHEMA, '/$defs/failed/properties/detail/maxLength')).toBe(MAX_WORKER_FAILURE_DETAIL_LENGTH);
    expect(pointerValue(SCHEMA, '/$defs/siteUnavailableRecheck/properties/url/maxLength')).toBe(MAX_WORKER_NOTICE_URL_LENGTH);
    expect(MAX_WORKER_NOTICE_URL_LENGTH).toBe(MAX_URL_LENGTH);
    // DEF-141: 待ちの知らせの待つ時間の上限は、読み込みの前の別の待ちの上限（1 分）と同じ。
    expect(pointerValue(SCHEMA, '/$defs/serviceRequestPacingWait/properties/waitMs/maximum')).toBe(MAX_ADDITIONAL_NAVIGATION_WAIT_MS);
    expect(pointerValue(SCHEMA, '/$defs/outcome/properties/exitCode/maximum')).toBe(MAX_WORKER_EXIT_CODE);
    expect(pointerValue(SCHEMA, '/$defs/count/maximum')).toBe(Number.MAX_SAFE_INTEGER);
    // Run の ID の形は、run.json のスキーマと同じ。
    expect(pointerValue(SCHEMA, '/$defs/runId/pattern')).toBe(pointerValue(RUN_SCHEMA, '/properties/runId/pattern'));
  });

  it('has the notice kinds of the schema branches, in order', () => {
    const branches = pointerValue(SCHEMA, '/$defs/notice/properties/notice/oneOf') as readonly { readonly $ref: string }[];
    expect(branches.map(({ $ref }) => pointerValue(SCHEMA, `${$ref.slice(1)}/properties/kind/const`))).toEqual([...WORKER_NOTICE_KINDS]);
  });

  it('copies the lists of the other owners exactly (the outcome kinds, the resume decisions, the run statuses, the failures)', () => {
    expect([...WORKER_OUTCOME_KINDS]).toEqual([...AUDIT_RUN_OUTCOME_KINDS]);
    expect([...WORKER_RESUME_DECISION_KINDS]).toEqual([...AUDIT_RUN_RESUME_DECISION_KINDS]);
    expect(WORKER_RUN_STATUSES).toBe(RUN_STATUSES);
    // 失敗の理由は、監査の外の失敗の種類（`classifyCliFailure`）のすべてと、IPC の契約の理由。
    expect(WORKER_FAILURE_REASONS.slice(0, CLI_FAILURE_KINDS.length)).toEqual([...CLI_FAILURE_KINDS]);
    // T25d: 認証の設定の変化と、ログインの段の終わり方（`WORKER_LOGIN_FAILURE_STATES`）を足した。
    expect(WORKER_FAILURE_REASONS.slice(CLI_FAILURE_KINDS.length)).toEqual([
      'PROTOCOL_VIOLATION',
      'START_TIMEOUT',
      'CONFIG_CHANGED',
      'AUTH_SETUP_CHANGED',
      'AUTH_SETUP_REQUIRED',
      'UNSUPPORTED_AUTH_STATE',
      'LOGIN_TIMEOUT',
      'LOGIN_ATTEMPTS_EXCEEDED',
      // T26d-2: 自動ログインの成功以外の結果（`AUTOMATED_LOGIN_FAILURE_RESULTS`）。
      'INVALID_CREDENTIALS',
      'ACCOUNT_LOCKED',
      'MFA_REQUIRED',
      'CREDENTIAL_EXPIRED',
      'RATE_LIMITED',
      'AUTH_RESULT_UNKNOWN',
      'LOGIN_FORM_INVALID',
      'LOGIN_FORM_INPUT_FAILED',
      'CREDENTIAL_CHANGED',
      'CREDENTIAL_UNAVAILABLE',
      // T26g-1
      'UNEXPECTED_LOGIN_REQUEST',
      // T27c: ワーカーがまだ対応していない種類の START を拒む理由。
      'JOB_KIND_NOT_SUPPORTED',
    ]);
  });

  it('names the timing of the worker (the start limit is longer than the heartbeat interval)', () => {
    expect(Number.isSafeInteger(WORKER_START_TIMEOUT_MS) && WORKER_START_TIMEOUT_MS > 0).toBe(true);
    expect(Number.isSafeInteger(WORKER_HEARTBEAT_INTERVAL_MS) && WORKER_HEARTBEAT_INTERVAL_MS > 0).toBe(true);
    expect(WORKER_START_TIMEOUT_MS).toBeGreaterThan(WORKER_HEARTBEAT_INTERVAL_MS);
  });
});
