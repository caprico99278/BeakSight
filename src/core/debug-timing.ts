// DBG-1（設計書 `2026-11-20-beaksight-discovery-skip-and-debug-timing-design.md` 2.2）: デバッグ・測りのための記録（時間の内訳など）の共通部品。測りの記録は、
// この部品だけを通して書く。
// - 入切（2026-11-21 のユーザーの判断で、環境変数から設定ファイルに替えた）: 既定は切。入れるのは、Git の管理の外の設定ファイル `local/debug-settings.json` の
//   `{ "debugTiming": true }` だけ。ファイルを読むのは `debugTimingSwitchOf` の 1 か所で、呼ぶのは起動の入口（CLI の `src/cli/index.ts` とワーカーの
//   `src/worker/audit-worker-process.ts`）が作る口だけ。口は依存の注入で下へ渡し、Run（段）の始めに 1 回呼ぶ（`tests/architecture/debug-timing-switch.test.ts`）。
//   利用者の画面に入切の口は作らない。
// - 切: ファイルの読み書きをしない。時刻の取得も記録の組み立てもしない（`measure` は処理をそのまま待つだけ、`record` は組み立ての関数を呼ばない）。
// - 入: Run のフォルダの 1 つのファイル（`debug-timing.jsonl`）へ、メモリにためた行をまとめて足す（行ごとに開かない。呼ぶ側が段の終わりと Run の終わりに
//   `flush` する。SLIM: 操作さがしは画面 1 枚ごとの保存（`persist`）の先頭、監査の段は 1 ページごとの輪の先頭でも `flush` する）。書けなくても Run を止めない。ChatGPT 用のバンドルと報告には入れない（バンドルは決まったファイルだけを入れる）。
// - 記録に URL・入力した値・秘密を書かない: 画面の印は `pageId`・`stateId`（ID と digest の形の文字だけ。`?`・`=`・`/` などを含む値は捨てる）、区分の名前
//   （`part`。コードの定数）、数（`ms`・`counts`）だけ。
import { appendFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** 測りの記録のファイルの名前（Run のフォルダの直下）。 */
export const DEBUG_TIMING_FILE_NAME = 'debug-timing.jsonl';

/** 測りの点の閉じた一覧。 */
export const DEBUG_TIMING_POINTS = Object.freeze([
  /** 監査の段の 1 画面の段（`part` は段の名前。読み込み・落ち着き・axe・撮影・開いた状態の確かめなど）。 */
  'AUDIT_STAGE',
  /** 監査の段の 1 つのビューポート（Desktop・Mobile。`stateId` でビューポートが分かる）。 */
  'AUDIT_VIEWPORT',
  /** 監査の段の幅の走査の 1 つの幅（`counts.width`）。 */
  'AUDIT_STRESS_WIDTH',
  /** 読み込みの間隔の待ち（段の間の待ち）。 */
  'PACING_WAIT',
  /** 操作さがしの 1 画面の区分（`part` は DTIME の区分。準備の確かめ・見届けの窓・落ち着きなど）。 */
  'DISCOVERY_PART',
  /** 操作さがしの 1 押下（入れて押す 1 回）。 */
  'PRESS',
  /** 操作さがしの状態の作り直し（押下の並びの押し直しの 1 手）。 */
  'STATE_REBUILD',
  /** 操作さがしの候補の読み直し。 */
  'REREAD',
  /** 操作さがしの 1 画面の時間の内訳（DTIME の `timeBreakdown`。`counts` に入れる）。 */
  'DISCOVERY_PAGE',
  /**
   * QUIET-4: 1 画面の見張りが画面を終えた（`part` は `<終わりの理由>:<最後のページの印の種類か NONE>`。`counts` は最後の中身の進みとページの印からの ms）。
   */
  'DISCOVERY_STAGE_END',
  /** QUIET-4: 見張りが画面を終えたときに待っていた 1 手（`part` は `<操作>:<役割>`。`counts` は locator の数と待った ms）。 */
  'DISCOVERY_PENDING_STEP',
  /**
   * PREADY（設計書 `2026-11-25-beaksight-discovery-press-readiness-design.md` 2.3）: 押す前の準備の確かめの 1 回（`part` は `<結果>:<役割>:<道>:<hit>`。
   * `counts` は確かめの ms と、同じ文書の同じ対象の何回目の確かめか）。
   */
  'DISCOVERY_READINESS',
  /**
   * SLIM（設計書 `2026-11-25-beaksight-discovery-input-check-slim-design.md` 2.3）: 押した後の見届けの窓の 1 回（押下 1 回と、打つだけの欄 1 つごと）。`part` は
   * `<最初の反応>:<道>:<組>`。`counts` は最初の反応までの ms・反応ごとの ms・最短の待ち・窓の ms・兄弟の数。
   */
  'DISCOVERY_PRESS_REACTION',
  /** SLIM（設計書 2.3）: 入力の確かめの 1 回（`part` は `TYPE`・`SURVEY`・`CHOOSE`。`counts` は欄・確かめた欄・省いた欄・入れた・選んだ数など）。 */
  'DISCOVERY_INPUT_CHECK',
] as const);
export type DebugTimingPoint = (typeof DEBUG_TIMING_POINTS)[number];

/** 記録の 1 行（`point` のほかは任意）。 */
export interface DebugTimingEntry {
  readonly point: DebugTimingPoint;
  readonly pageId?: string;
  readonly stateId?: string;
  readonly part?: string;
  readonly ms?: number;
  readonly counts?: Readonly<Record<string, number>>;
}

/** 測りの点の、行の残り（`point` と `ms` のほか）。 */
export type DebugTimingScope = Omit<DebugTimingEntry, 'point' | 'ms'>;

/** 測りの記録の口。 */
export interface DebugTimingLog {
  readonly enabled: boolean;
  /** `work` を測り、1 行を足す（値と例外はそのまま返す）。切なら `work` をそのまま待つ（`scope` を呼ばない）。 */
  measure<T>(point: DebugTimingPoint, scope: () => DebugTimingScope, work: () => PromiseLike<T>): Promise<T>;
  /** 1 行を足す。切なら `build` を呼ばない。 */
  record(build: () => DebugTimingEntry): void;
  /** ためた行を、ファイルにまとめて足す（ためた行がなければ書かない。書けなくても例外を投げない）。 */
  flush(): Promise<void>;
}

/** 切の口（何もしない）。 */
export const DEBUG_TIMING_OFF: DebugTimingLog = Object.freeze<DebugTimingLog>({
  enabled: false,
  measure: <T>(_point: DebugTimingPoint, _scope: () => DebugTimingScope, work: () => PromiseLike<T>): Promise<T> => Promise.resolve(work()),
  record: () => undefined,
  flush: async () => undefined,
});

/** 入切の設定ファイルの、リポジトリの根からの置き場（Git の管理の外の `local/`。名前を書くのはここだけ）。 */
const DEBUG_SETTINGS_RELATIVE_PATH = ['local', 'debug-settings.json'] as const;

/** 入切の設定ファイルの場所（`repositoryRoot` は、起動の入口の今の決め方のリポジトリの根。CLI もワーカーも作業のフォルダ）。 */
export const debugSettingsPathOf = (repositoryRoot: string): string => join(repositoryRoot, ...DEBUG_SETTINGS_RELATIVE_PATH);

/** 入切を読む口（起動の入口が作って依存の注入で渡し、Run（段）の始めに 1 回呼ぶ）。 */
export type DebugTimingSwitch = () => Promise<boolean>;

/**
 * 起動の入口が作る口から、Run（段）の始めに 1 回呼ぶ: 設定ファイル（`{ "debugTiming": true }`）で測りの記録が入か。ファイルがない・JSON として読めない・
 * `debugTiming` が `true` でないときは切（例外を投げない）。
 */
export async function debugTimingSwitchOf(settingsPath: string): Promise<boolean> {
  try {
    const parsed: unknown = JSON.parse(await readFile(settingsPath, 'utf8'));
    return typeof parsed === 'object' && parsed !== null && (parsed as Record<string, unknown>)['debugTiming'] === true;
  } catch {
    return false;
  }
}

/** 記録してよい印の形（ID と digest の文字だけ。URL・query・値を運べない）。 */
const SAFE_LABEL = /^[A-Za-z0-9:_.-]{1,200}$/u;

/** 行を、書いてよい項目だけにする（形の違う印・数は捨てる）。 */
const sanitizedEntryOf = (entry: DebugTimingEntry): DebugTimingEntry => {
  const label = (value: string | undefined): string | undefined => (value !== undefined && SAFE_LABEL.test(value) ? value : undefined);
  const counts = entry.counts === undefined
    ? undefined
    : Object.fromEntries(Object.entries(entry.counts).filter(([name, value]) => SAFE_LABEL.test(name) && Number.isFinite(value)));
  const pageId = label(entry.pageId);
  const stateId = label(entry.stateId);
  const part = label(entry.part);
  return {
    point: entry.point,
    ...(pageId === undefined ? {} : { pageId }),
    ...(stateId === undefined ? {} : { stateId }),
    ...(part === undefined ? {} : { part }),
    ...(entry.ms === undefined || !Number.isFinite(entry.ms) ? {} : { ms: Math.max(0, entry.ms) }),
    ...(counts === undefined ? {} : { counts }),
  };
};

/** 測りの記録の口の作り方の指定。 */
export interface DebugTimingLogOptions {
  /** 入切（起動の入口が `debugTimingSwitchOf` で決めた値）。 */
  readonly enabled: boolean;
  /** 書く先の Run のフォルダ。 */
  readonly directory: string;
  /** 差し込める時計（ms）。 */
  readonly now: () => number;
  /** テストだけの口: ファイルに足す関数（省略は `appendFile`）。 */
  readonly append?: (path: string, text: string) => Promise<void>;
}

/** 測りの記録の口を作る（切なら `DEBUG_TIMING_OFF`）。 */
export function createDebugTimingLog(options: DebugTimingLogOptions): DebugTimingLog {
  if (!options.enabled) {
    return DEBUG_TIMING_OFF;
  }
  const { now } = options;
  const append = options.append ?? ((path: string, text: string) => appendFile(path, text, 'utf8'));
  const path = join(options.directory, DEBUG_TIMING_FILE_NAME);
  let lines: string[] = [];
  const record = (build: () => DebugTimingEntry): void => {
    try {
      lines.push(JSON.stringify(sanitizedEntryOf(build())));
    } catch {
      // 測りの記録は Run を止めない。
    }
  };
  return Object.freeze<DebugTimingLog>({
    enabled: true,
    async measure<T>(point: DebugTimingPoint, scope: () => DebugTimingScope, work: () => PromiseLike<T>): Promise<T> {
      const startedAt = now();
      try {
        return await work();
      } finally {
        record(() => ({ ...scope(), point, ms: now() - startedAt }));
      }
    },
    record,
    async flush(): Promise<void> {
      if (lines.length === 0) return;
      const text = `${lines.join('\n')}\n`;
      lines = [];
      try {
        await append(path, text);
      } catch {
        // 書けなくても Run を止めない。
      }
    },
  });
}
