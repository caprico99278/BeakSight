/**
 * T44d（Task 44 の設計書 P2-1。設計の変更の履歴の T44d の行の案 (a)）: プロファイルの画面の「監査の負荷」（ページの上限・時間の上限・読み込みの間隔）
 * の Server Functions。サーバだけで使う。
 * - 欄（`crawlLimitsPanelFn`。GET）: プロファイルが指す設定のファイルの今の値、間隔の下限、画面から書けるか（`local/targets/<id>.json` の形だけ）、
 *   ファイルの digest（`targetConfigDigestOf`。画面が見た中身を、確かめと保存で照らす）。
 * - 確かめ（`previewCrawlLimitsFn`。GET。書かない）: 欄の値を、書くときと同じ確かめ（`target-config-writer.ts` の `prepareTargetCrawlLimitsChange`）に
 *   通し、確認のダイアログに出す事実を返す。変える前と後の値と、書き込みのモードで今承認が有効なシナリオの数（設定のファイルの digest に承認が
 *   結ばれるので、変えると外れる。`TARGET_CONFIG_CHANGED`）。
 *   途中の Run（再開の候補）は、ここでは探さない。探し方の owner（`src/orchestration/run-checkpoint.ts` の `selectRunToResume` と、保存を読む
 *   `src/report/artifact-writer.ts`）は、画面のコードが読み込めない範囲（`tests/architecture/local-ui-boundary.test.ts` の (f)(g)）にあるため。
 *   ダイアログは、途中の Run があれば再開されない旨を、いつも出す（`LOCAL_UI_CRAWL_LIMITS_TEXT.resumeNotice`）。
 * - 保存（`saveCrawlLimitsFn`。POST）: 同じ確かめの後に、`replaceTargetConfig` で置き換える（画面が見た中身のときだけ）。プロファイルの改訂は変えない。
 * 入力は `ui-target-crawl-limits` のスキーマで確かめる（値の範囲はスキーマで縛らず、欄ごとの誤りとして返す）。
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createServerFn } from '@tanstack/react-start';
import type { TargetCrawlLimits, TargetCrawlLimitsChangeFailure } from '../../../../src/config/target-config-draft.js';
import { RETIRED_PROFILE_STATUS } from '../../../../src/control/store/profile-records.js';
import { getProfile, type StoredProfile } from '../../../../src/control/store/profile-store.js';
import { targetConfigDigestOf } from '../../../../src/control/worker-protocol.js';
import { localUiRepositoryRoot, localUiStore } from './control-store';
import { requestOf } from './request-validation';
// FM2e: 承認が外れるシナリオの数は、1 回の操作で自動ログインに切り替える画面と共用する部品（`scenario-facts.ts`）。
import { approvedScenarioCountOf } from './scenario-facts';
import {
  isEditableTargetConfigPath,
  prepareTargetCrawlLimitsChange,
  readTargetCrawlLimits,
  replaceTargetConfig,
  type TargetCrawlLimitProblem,
} from './target-config-writer';

/** 欄の状態（書ける、画面からは書かない形のパス、読めない・誤りがある）。 */
export type CrawlLimitsPanelState = 'EDITABLE' | 'NOT_EDITABLE' | 'UNREADABLE';

/** 「監査の負荷」の欄の値。 */
export interface CrawlLimitsPanelView {
  readonly profileId: string;
  readonly targetConfigPath: string;
  readonly state: CrawlLimitsPanelState;
  /** 今の値（読めないときは null）。 */
  readonly limits: TargetCrawlLimits | null;
  /** 読み込みの間隔の下限（ms。読めないときは null）。 */
  readonly minNavigationIntervalFloorMs: number | null;
  /** 画面が見たファイルの digest（書けるときだけ。確かめと保存で照らす）。 */
  readonly targetConfigDigest: string | null;
}

/** 確かめと保存の失敗。 */
export interface CrawlLimitsRejectionView {
  readonly ok: false;
  readonly reason: TargetCrawlLimitsChangeFailure;
  readonly problems: readonly TargetCrawlLimitProblem[];
}

/** 確かめの結果（確認のダイアログに出す事実）。 */
export type CrawlLimitsPreviewView =
  | {
    readonly ok: true;
    readonly before: TargetCrawlLimits;
    readonly after: TargetCrawlLimits;
    /** 今承認が有効なシナリオの数（変えると、承認が外れる）。 */
    readonly approvedScenarioCount: number;
  }
  | CrawlLimitsRejectionView;

/** 保存の結果。 */
export type CrawlLimitsSaveView =
  | { readonly ok: true; readonly before: TargetCrawlLimits; readonly after: TargetCrawlLimits }
  | CrawlLimitsRejectionView;

interface ProfileKeyRequest {
  readonly profileId: string;
}

interface CrawlLimitsRequest extends ProfileKeyRequest {
  readonly expectedTargetConfigDigest: string;
  readonly limits: TargetCrawlLimits;
}

const rejection = (reason: TargetCrawlLimitsChangeFailure, problems: readonly TargetCrawlLimitProblem[] = []): CrawlLimitsRejectionView =>
  ({ ok: false, reason, problems: [...problems] });

/** 設定のファイルの中身（バイトと文字列）。読めなければ null。 */
const readTargetFile = async (targetConfigPath: string): Promise<{ readonly bytes: Uint8Array; readonly content: string } | null> => {
  try {
    const bytes = await readFile(join(localUiRepositoryRoot(), targetConfigPath));
    return { bytes, content: bytes.toString('utf8') };
  } catch {
    return null;
  }
};

/** 「監査の負荷」の欄の値。プロファイルがなければ `null`。 */
export const crawlLimitsPanelFn = createServerFn({ method: 'GET' })
  .validator(requestOf<ProfileKeyRequest>('ui-profile-key'))
  .handler(async ({ data }): Promise<CrawlLimitsPanelView | null> => {
    const stored = getProfile(localUiStore(), data.profileId);
    if (stored === null) {
      return null;
    }
    const { targetConfigPath } = stored.profile;
    const file = await readTargetFile(targetConfigPath);
    const reading = file === null ? null : readTargetCrawlLimits(file.content);
    const base = { profileId: data.profileId, targetConfigPath };
    if (file === null || reading === null || !reading.ok) {
      return { ...base, state: 'UNREADABLE', limits: null, minNavigationIntervalFloorMs: null, targetConfigDigest: null };
    }
    const editable = isEditableTargetConfigPath(targetConfigPath);
    return {
      ...base,
      state: editable ? 'EDITABLE' : 'NOT_EDITABLE',
      limits: reading.limits,
      minNavigationIntervalFloorMs: reading.minNavigationIntervalFloorMs,
      targetConfigDigest: editable ? targetConfigDigestOf(file.bytes) : null,
    };
  });

/** 確かめと保存の共通の手順の結果。 */
type CrawlLimitsChangePlan =
  | {
    readonly ok: true;
    readonly stored: StoredProfile;
    readonly content: string;
    readonly changedContent: string;
    readonly before: TargetCrawlLimits;
    readonly after: TargetCrawlLimits;
  }
  | CrawlLimitsRejectionView;

/** プロファイルとファイルを確かめ、変えた後の中身を組み立てる（書かない）。 */
const planOf = async (request: CrawlLimitsRequest): Promise<CrawlLimitsChangePlan> => {
  const stored = getProfile(localUiStore(), request.profileId);
  if (stored === null) {
    return rejection('PROFILE_NOT_FOUND');
  }
  if (stored.status === RETIRED_PROFILE_STATUS) {
    return rejection('PROFILE_RETIRED');
  }
  const { targetConfigPath } = stored.profile;
  if (!isEditableTargetConfigPath(targetConfigPath)) {
    return rejection('TARGET_CONFIG_NOT_EDITABLE');
  }
  const file = await readTargetFile(targetConfigPath);
  if (file === null) {
    return rejection('TARGET_CONFIG_INVALID');
  }
  if (targetConfigDigestOf(file.bytes) !== request.expectedTargetConfigDigest) {
    return rejection('TARGET_CONFIG_CHANGED');
  }
  const prepared = prepareTargetCrawlLimitsChange(file.content, request.limits);
  if (!prepared.ok) {
    return rejection(prepared.reason, prepared.problems);
  }
  return {
    ok: true,
    stored,
    content: file.content,
    changedContent: prepared.content,
    before: prepared.before,
    after: prepared.after,
  };
};

/** 欄の値を確かめ、確認のダイアログに出す事実を返す（書かない）。 */
export const previewCrawlLimitsFn = createServerFn({ method: 'GET' })
  .validator(requestOf<CrawlLimitsRequest>('ui-target-crawl-limits'))
  .handler(async ({ data }): Promise<CrawlLimitsPreviewView> => {
    const plan = await planOf(data);
    if (!plan.ok) {
      return plan;
    }
    return {
      ok: true,
      before: plan.before,
      after: plan.after,
      approvedScenarioCount: await approvedScenarioCountOf(plan.stored),
    };
  });

/** 欄の値を、設定のファイルに書く（画面が見た中身のときだけ置き換える）。 */
export const saveCrawlLimitsFn = createServerFn({ method: 'POST' })
  .validator(requestOf<CrawlLimitsRequest>('ui-target-crawl-limits'))
  .handler(async ({ data }): Promise<CrawlLimitsSaveView> => {
    const plan = await planOf(data);
    if (!plan.ok) {
      return plan;
    }
    const replaced = await replaceTargetConfig(localUiRepositoryRoot(), plan.stored.profile.targetConfigPath, plan.content, plan.changedContent);
    return replaced.ok ? { ok: true, before: plan.before, after: plan.after } : rejection(replaced.reason);
  });
