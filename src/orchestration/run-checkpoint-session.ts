import type { PageId } from '../core/contracts.js';
import { isRecord } from '../core/guards.js';
import { isPageId } from '../core/ids.js';
import type { RunCheckpoint, RunCheckpointPage, RunCheckpointPageWriteOptions, RunCheckpointStore } from './run-checkpoint.js';

// 再開のための保存のセッション（中断した Run の再開の設計書 4.3.1。この意味の owner）。
// 保存、再開の後始末、最後の状態の書き出しを、1つの部品にまとめる。
// - ファイルの読み書きは、注入された保存の書き手（`RunCheckpointStore`。本番は `ArtifactWriter`）に任せる（ARCH08）。
// - SPEC-2: ロックは持たない。監査中の印（出力先の排他。`src/core/run-exclusion.ts`）は、呼び出し側（CLI とワーカー）が Run の全体で
//   持つ（再開する Run を選ぶ前に取るので、選んだ Run をほかの起動が進めることはない）。
// - 作るのは CLI か、テストである。Run Coordinator は、始める、ページの保存、状態の保存だけを頼む。最後の状態の書き出し（終える）と、
//   やめるは、CLI が呼ぶ（設計書 4.3.1）。

/** `RunCheckpointSession` を作るときに受け取るもの。 */
export interface RunCheckpointSessionOptions {
  /** 保存のファイルの書き手（本番は `ArtifactWriter`）。 */
  readonly store: RunCheckpointStore;
}

/**
 * セッションの始め方の閉じた一覧。
 * - `NEW_RUN`: 新しい Run。Run のディレクトリは、作ったばかりのもの（設計書 4.4 の DEF-009）。
 * - `RESUME`: 中断した Run の再開。Run のディレクトリは、前の回のもの。後始末をしてから始める（設計書 4.5）。
 */
export const RUN_CHECKPOINT_SESSION_START_MODES = Object.freeze(['NEW_RUN', 'RESUME'] as const);
export type RunCheckpointSessionStartMode = (typeof RUN_CHECKPOINT_SESSION_START_MODES)[number];

/** 新しい Run の始め方（`NEW_RUN`）の指定。 */
export interface RunCheckpointSessionNewRunStartOptions {
  readonly mode: Extract<RunCheckpointSessionStartMode, 'NEW_RUN'>;
}

/** 再開の始め方（`RESUME`）の指定。 */
export interface RunCheckpointSessionResumeStartOptions {
  readonly mode: Extract<RunCheckpointSessionStartMode, 'RESUME'>;
  /** 再開に使う保存の、終わったページの ID（`state.json` の `completedPageIds`）。後始末で、これにないページのものを消す。 */
  readonly completedPageIds: readonly PageId[];
}

/** `RunCheckpointSession.start` の指定。 */
export type RunCheckpointSessionStartOptions = RunCheckpointSessionNewRunStartOptions | RunCheckpointSessionResumeStartOptions;

/** 新しい Run の始め方（`NEW_RUN`）の結果。 */
export interface RunCheckpointSessionNewRunStart {
  readonly ok: true;
}

/**
 * 再開の始め方（`RESUME`）の結果。`removedPaths` は、後始末で消したものの、Run のディレクトリからの相対パス（書き手の `cleanUpForResume` の
 * 結果）。
 */
export interface RunCheckpointSessionResumeStart {
  readonly ok: true;
  readonly removedPaths: readonly string[];
}

/**
 * `RunCheckpointSession.start` の結果（`NEW_RUN` なら `RunCheckpointSessionNewRunStart`、`RESUME` なら `RunCheckpointSessionResumeStart`
 * の形）。書き手が書けなかった場合は、結果を返さずに reject する。
 */
export type RunCheckpointSessionStart = RunCheckpointSessionNewRunStart | RunCheckpointSessionResumeStart;

/**
 * セッションの段階。`IDLE`（始める前、または始められなかった）→ `STARTING` → `ACTIVE` → `ENDED`（終えた、またはやめた）。
 */
type SessionPhase = 'IDLE' | 'STARTING' | 'ACTIVE' | 'ENDED';

const STORE_OPERATION_NAMES = Object.freeze([
  'writeCheckpointPage',
  'writeCheckpointState',
  'cleanUpForResume',
] as const satisfies readonly (keyof RunCheckpointStore)[]);

const hasFunctions = (value: unknown, names: readonly string[]): boolean =>
  isRecord(value) && names.every((name) => typeof value[name] === 'function');

/** 再開の始め方の、終わったページの ID の一覧を確かめる（配列でなければ `TypeError`、ページの ID の形でない項目があれば `RangeError`）。 */
function assertCompletedPageIds(value: unknown): asserts value is readonly PageId[] {
  if (!Array.isArray(value)) {
    throw new TypeError('RunCheckpointSession.start with RESUME requires the list of completed page IDs');
  }
  for (const pageId of value as readonly unknown[]) {
    if (!isPageId(pageId)) {
      throw new RangeError(`RunCheckpointSession.start with RESUME requires page IDs: ${String(JSON.stringify(pageId))}`);
    }
  }
}

/**
 * 再開のための保存のセッション（設計書 4.3.1）。1つの Run の1回の実行で、1つだけ使う。
 *
 * - `start`: 新しい Run では何も書かずに始める。再開（`RESUME`）では、後始末をしてから始める（設計書 4.5）。
 * - `savePage`・`saveState`: 保存を書き手に渡す。失敗は、呼び出し側に reject として返す。
 * - `finish`: 最後の状態を書く（CLI が、最後の出力を書き終えた後に呼ぶ）。
 * - `abandon`: 何も書かずに終える（保存の状態は `IN_PROGRESS` のまま残り、後で再開できる）。
 */
export class RunCheckpointSession {
  readonly #store: RunCheckpointStore;
  #phase: SessionPhase = 'IDLE';
  #runDirectory = '';

  /** 不正な指定（書き手の 3 つの操作が関数でない）は `TypeError` を投げる。 */
  constructor(options: RunCheckpointSessionOptions) {
    const given: unknown = options;
    if (!isRecord(given)) {
      throw new TypeError('RunCheckpointSession options must be an object');
    }
    if (!hasFunctions(given.store, STORE_OPERATION_NAMES)) {
      throw new TypeError(`RunCheckpointSession store must have ${STORE_OPERATION_NAMES.join(', ')}`);
    }
    this.#store = options.store;
  }

  /**
   * セッションを始める（設計書 4.3.1、4.5）。`runDirectory` は、Run のディレクトリ（新しい Run では作ったばかりのもの、再開では前の回のもの）。
   * - 新しい Run（`NEW_RUN`）: `{ ok: true }` を返す。
   * - 再開（`RESUME`。`completedPageIds` は、再開に使う保存の終わったページの ID）: 書き手の `cleanUpForResume` で後始末を行い（保存の書き出しの
   *   前。書き出しの途中の一時ファイルを消すため）、`{ ok: true, removedPaths }`（後始末で消したもの）を返す。
   * 書き手が失敗した場合は reject し、始める前と同じ段階に戻る。始めた後のセッションでもう一度呼ぶと reject する。`runDirectory` が空なら
   * `TypeError`、`mode` が閉じた一覧にないなら `RangeError`、`RESUME` の `completedPageIds` が配列でなければ `TypeError`、ページの ID の形でない
   * 項目があれば `RangeError`（どれも、書き手に何も頼まずに投げる）。
   */
  async start(runDirectory: string, options: RunCheckpointSessionStartOptions): Promise<RunCheckpointSessionStart> {
    if (typeof runDirectory !== 'string' || runDirectory.length === 0) {
      throw new TypeError('RunCheckpointSession.start requires a non-empty run directory');
    }
    const mode: unknown = isRecord(options) ? options.mode : undefined;
    if (!(RUN_CHECKPOINT_SESSION_START_MODES as readonly unknown[]).includes(mode)) {
      throw new RangeError(`RunCheckpointSession.start mode must be one of ${RUN_CHECKPOINT_SESSION_START_MODES.join(', ')}`);
    }
    if (options.mode === 'RESUME') {
      assertCompletedPageIds(options.completedPageIds);
    }
    if (this.#phase !== 'IDLE') {
      throw new Error('RunCheckpointSession has already been started');
    }
    this.#phase = 'STARTING';
    try {
      const removedPaths = options.mode === 'NEW_RUN'
        ? null
        : Object.freeze([...await this.#store.cleanUpForResume(runDirectory, options.completedPageIds)]);
      this.#runDirectory = runDirectory;
      this.#phase = 'ACTIVE';
      return removedPaths === null
        ? Object.freeze<RunCheckpointSessionNewRunStart>({ ok: true })
        : Object.freeze<RunCheckpointSessionResumeStart>({ ok: true, removedPaths });
    } catch (error) {
      this.#phase = 'IDLE';
      throw error;
    }
  }

  /**
   * ページの保存（R2 の `createRunCheckpointPage` の値）を、書き手の `writeCheckpointPage` で書く。失敗は reject する。T44R3 の M-2: `options` は、
   * そのまま書き手に渡す（巡回が知っている URL）。
   */
  async savePage(page: RunCheckpointPage, options?: RunCheckpointPageWriteOptions): Promise<void> {
    this.#requireActive('savePage');
    await (options === undefined
      ? this.#store.writeCheckpointPage(this.#runDirectory, page)
      : this.#store.writeCheckpointPage(this.#runDirectory, page, options));
  }

  /** 状態の保存（R2 の `createRunCheckpoint` の値）を、書き手の `writeCheckpointState` で書く。失敗は reject する。 */
  async saveState(state: RunCheckpoint): Promise<void> {
    this.#requireActive('saveState');
    await this.#store.writeCheckpointState(this.#runDirectory, state);
  }

  /**
   * セッションを終える（設計書 4.3.1。CLI が、最後の出力を書き終えた後に呼ぶ）。最後の状態の保存の値（`state` が `FINISHED` か
   * `STOPPED`。作るのは呼び出し側）を `writeCheckpointState` で書く。書けなかった場合は reject する（保存の状態は `IN_PROGRESS` のまま残る）。
   * どちらの場合も、セッションは終わった段階になる。始めていないセッションでは reject する。
   */
  async finish(finalState: RunCheckpoint): Promise<void> {
    this.#requireActive('finish');
    this.#phase = 'ENDED';
    await this.#store.writeCheckpointState(this.#runDirectory, finalState);
  }

  /**
   * セッションをやめる（Run が例外で終わった場合などに、CLI が呼ぶ）。何も書かない。reject しない。始めていない、またはすでに終えた
   * セッションでは、何もしない。
   */
  async abandon(): Promise<void> {
    if (this.#phase === 'ACTIVE') {
      this.#phase = 'ENDED';
    }
  }

  #requireActive(operation: string): void {
    if (this.#phase !== 'ACTIVE') {
      throw new Error(`RunCheckpointSession.${operation} requires a started session, but the session is not active`);
    }
  }
}
