/**
 * OP-2（設計書 `2026-10-27-beaksight-one-pass-flow-design.md` 4.1.1 の D7'、4.1.2 の「チェックの保存」、R3）: サイトの画面の「登録・更新を試せる画面」の一覧と、
 * チェックの保存の Server Functions。
 * - 一覧（`writeScreensFn`。GET。読むだけ）: 最後の操作さがしの登録の画面ごとに 1 行（API の形とフォームの形）。行は、画面の名前（やさしい形の 1 行）、チェックの
 *   状態（チェックした・チェックできる・もう一度チェックが要る・チェックできない）、チェックできない理由、前の点検の結果（登録・更新）。
 *   チェックした＝その画面の登録のシナリオ（と、その台帳に結ぶ更新のシナリオ）を承認していて、承認が今も有効。承認が無効になった行は、自動で承認し直さず、
 *   チェックを外した形で「もう一度チェックしてください」（R3）。
 * - チェックの保存（`saveWriteScreenCheckFn`。POST。CSRF は画面のサーバの middleware が確かめる）: チェックを入れたら、1 回で次を行う。
 *   1. 書き込みのモードへの切り替え（まだなら。隔離の参照は内部の「確かめていない」の固定の値。D6）。
 *   2. 書き込みの手順の自動の下書き（その画面の登録と、規則 F で決めた更新。`draftScreenForCheck`）。OP-S: 登録の手順が既にあれば、最後の操作さがしと
 *      今の自動の下書きの決まりで作り直し、中身が違えば新しい版にする（同じなら版を上げない）。
 *   3. 承認（今の承認の記録と digest。`approveScenario`。チェックの保存が承認のダイアログの代わり）。
 *   チェックを外したら、その画面の登録と更新の承認を取り消す（`revokeScenarioApproval`）。書き込みは、次の点検の最後の書き込みの段で、ジョブの管理が許可を発行して
 *   行う（ここでは許可を発行しない。Gate `approval-ssot` の (e)）。
 * - 返す値に、資格情報・Cookie・CSRF のトークン・送る値は入らない。
 */
import { createServerFn, createServerOnlyFn } from '@tanstack/react-start';
import {
  approveForCheck,
  CREATE_SCENARIO_KIND,
  DRAFT_SCENARIO_STATE,
  UPDATE_SCENARIO_KIND,
  listScenarios,
  missingVerificationItemsOf,
  readScenario,
  readScenarioApprovalStatus,
  updateLedgerScenarioIdOf,
  updateNotifyConfirmedByCheckOf,
  writeScreenMayNotifyOf,
  WRITE_AUDIT_MODE,
  type ScenarioView,
} from '../../../../src/control/approval-view.js';
import { readWriteResults } from '../../../../src/control/actions/write-result-facts.js';
import { NOT_SENT_SUBMISSION_STATE } from '../../../../src/control/actions/action-contracts.js';
import { getProfile } from '../../../../src/control/store/profile-store.js';
import { ACTIVE_PROFILE_STATUS } from '../../../../src/control/store/profile-records.js';
import {
  writeScreenNotCheckableKindOf,
  writeScreenWordOf,
  type WriteScreenKindResultView,
  type WriteScreenLastResultView,
  type WriteScreenNotCheckableKind,
  type WriteScreenUpdateState,
} from '../display/write-screen-values';
import { localUiStore } from './control-store';
import { requestOf } from './request-validation';
import { LOCAL_UI_JOB_CONSOLE_TEXT } from '../../../../src/presentation/messages.js';
import { draftScreenForCheck, redraftScreenOnChainStart, revokeApprovalOf, scenarioAutoDraftScreensOf } from './scenario-autodraft-functions';
import { approvalExternalFactsOf } from './scenario-facts';
import { loadTargetContext } from './target-config';
import { nowCompactTimestamp } from './timestamps';
import { localUiWriteModeSwitchDependencies, switchToWriteMode } from './write-mode-switch';

/** 行のチェックの状態（閉じた一覧。文言はカタログ `LOCAL_UI_WRITE_SCREENS_TEXT.states`）。 */
export const WRITE_SCREEN_ROW_STATES = Object.freeze(['CHECKED', 'CHECKABLE', 'RECHECK_NEEDED', 'NOT_CHECKABLE'] as const);
export type WriteScreenRowState = (typeof WRITE_SCREEN_ROW_STATES)[number];

/** チェックの保存を拒む理由（閉じた一覧。文言はカタログ `LOCAL_UI_WRITE_SCREENS_TEXT.rejections`）。 */
export const WRITE_SCREEN_CHECK_REJECTIONS = Object.freeze([
  'PROFILE_NOT_FOUND',
  'MODE_SWITCH_FAILED',
  'SCREEN_NOT_DRAFTABLE',
  'FACTS_UNAVAILABLE',
  'APPROVAL_REJECTED',
] as const);
export type WriteScreenCheckRejection = (typeof WRITE_SCREEN_CHECK_REJECTIONS)[number];

/** 前の点検の結果（登録・更新。OP-F: 形は表示の値 `write-screen-values.ts` の 1 か所）。 */
export type { WriteScreenLastResultView };

/** 一覧の行 1 つ。 */
export interface WriteScreenRowView {
  /** 行の鍵（登録の候補の識別の digest）。 */
  readonly rowKey: string;
  /** 画面の名前のもと（path の、番号でない最後の区切り。名前が取れないときの、やさしい形の 1 行に使う）。 */
  readonly screenWord: string;
  /** OP-2 の修正の 1 回目（判断 2）: 操作さがしで記録した画面の名前（見出し → 題。取れなければ null で、`screenWord` の形にする）。 */
  readonly screenName: string | null;
  /** 判断 1: メール・SMS などを送ることがある画面（行に 1 行を出す。チェックがその確認を兼ねる）。 */
  readonly mayNotify: boolean;
  readonly state: WriteScreenRowState;
  /** チェックできない行の理由の鍵（今の下書きの理由。なければ null）。 */
  readonly notCheckableReason: string | null;
  /** OP-2 の修正の 2 回目（判断 2）: チェックできない行の理由の種類（やさしい 1 行。なければ null）。 */
  readonly notCheckableKind: WriteScreenNotCheckableKind | null;
  /** OP-2 の修正の 2 回目（R1）: 更新の 1 行（更新の書き込みの手順があるか、作れるときは null）。 */
  readonly updateState: WriteScreenUpdateState | null;
  readonly lastResult: WriteScreenLastResultView | null;
}

/** 一覧の値（出さないサイトは null）。 */
export interface WriteScreensView {
  readonly profileId: string;
  readonly rows: readonly WriteScreenRowView[];
}

/** チェックの保存の結果。 */
export type WriteScreenCheckResultView = { readonly ok: true } | { readonly ok: false; readonly reason: WriteScreenCheckRejection };

interface WriteScreenCheckRequest {
  readonly profileId: string;
  readonly rowKey: string;
  readonly checked: boolean;
  /** OP-F（OP-REV2 の m-1）: 画面が行を描いたときに「知らせを送ることがある」の 1 行を出していたか（省略は出していない）。 */
  readonly mayNotifyShown?: boolean;
}

interface ProfileKeyRequest {
  readonly profileId: string;
}


/**
 * シナリオの前の点検の結果（書き込みの記録がなければ null）。OP-F（設計者の判断の 4）: 送らずに締めた回（`NOT_SENT`。準備が通らなかった・止めた）は、前に試した回の
 * 結果を隠さない。最後に試した回の結果と、最後の回が送らずに締めた回ならその理由を返す。
 */
const lastResultOf = (scenarioId: string | null): WriteScreenKindResultView | null => {
  if (scenarioId === null) {
    return null;
  }
  const results = readWriteResults(localUiStore(), scenarioId);
  const last = results.at(-1);
  if (last === undefined) {
    return null;
  }
  const tried = [...results].reverse().find(({ submission }) => submission !== NOT_SENT_SUBMISSION_STATE);
  return { tried: tried?.result ?? null, notSentReason: last.submission === NOT_SENT_SUBMISSION_STATE ? last.blockReason : null };
};

/**
 * OP-F（安全のレビューの M-3）: 点検の中で見つかった更新を、チェックが知らせを確かめていないため自動で承認しなかった行か（判定は `updateNotifyConfirmedByCheckOf`。
 * チェックのときの行の 1 行は、チェックで承認した登録の版の画面から求める）。
 */
const updateAwaitsNotifyCheckOf = (create: ScenarioView, update: ScenarioView): boolean =>
  create.state === 'APPROVED' && update.state !== 'APPROVED'
  && !updateNotifyConfirmedByCheckOf(writeScreenMayNotifyOf(create.evidence, []), update.evidence);

/** 登録の台帳に結ぶ更新のシナリオ（すべて。一覧の順）。 */
const boundUpdatesOf = (scenarios: readonly ScenarioView[], createScenarioId: string): readonly ScenarioView[] =>
  scenarios.filter((scenario) => scenario.current.kind === UPDATE_SCENARIO_KIND && updateLedgerScenarioIdOf(scenario.current) === createScenarioId);

/**
 * OP-T fix round 2（I-2）: 行が対象にする更新のシナリオ（1 つ）。最後の操作さがしで既にある更新のうち、台帳に結ぶ最初のもの（チェックの保存が既にある更新を
 * 選ぶ順と同じ）。なければ、台帳に結ぶ承認済みの最初のもの（書き込みの段の対象の選び方 `chainWriteTargetsOf` と同じ）、なければ最初のもの。
 */
const rowUpdateOf = (scenarios: readonly ScenarioView[], createScenarioId: string, existingUpdateScenarioIds: readonly string[]): ScenarioView | null => {
  const bound = boundUpdatesOf(scenarios, createScenarioId);
  return existingUpdateScenarioIds.map((id) => bound.find(({ scenarioId }) => scenarioId === id)).find((scenario) => scenario !== undefined)
    ?? bound.find(({ state }) => state === 'APPROVED') ?? bound[0] ?? null;
};

/** OP-G（E2）: 確かめの指定がそろわない行の理由の鍵（許可の発行が拒む理由と同じ名前）。 */
const VERIFICATION_SPEC_MISSING_ROW_REASON = 'VERIFICATION_SPEC_MISSING';

/** OP-G（E2）: 登録の手順の確かめの指定（番号の取り方・答え合わせ）がそろわないか（判定は許可の発行と同じ `missingVerificationItemsOf`）。 */
const verificationMissingOf = (scenario: ScenarioView): boolean => missingVerificationItemsOf(scenario.current.verification, scenario.current).length > 0;

/** 承認が今も有効か（承認していない・読めないなら偽）。 */
const approvalValidOf = (scenarioId: string, external: Awaited<ReturnType<typeof approvalExternalFactsOf>>): boolean => {
  if (external === null) {
    return false;
  }
  const status = readScenarioApprovalStatus(localUiStore(), scenarioId, external, new Date());
  return status !== null && status.scenario.state === 'APPROVED' && status.validity.approved;
};

/** 一覧の行と、その行の登録と更新の手順（OP-T fix round 1・2: 行に結び付く手順を、まとめて実行の始めが知るため。画面には返さない）。 */
interface WriteScreenEntry {
  readonly row: WriteScreenRowView;
  readonly createScenarioId: string | null;
  /** 行が対象にする更新の手順（`rowUpdateOf`。なければ null）。 */
  readonly updateScenarioId: string | null;
}

/** 一覧の行と手順、行の判定に使った承認の事実（読めなければ null。そのときは、どの承認済みの行も「もう一度チェックが要る」になる）。 */
interface WriteScreenListing {
  readonly entries: readonly WriteScreenEntry[];
  readonly external: Awaited<ReturnType<typeof approvalExternalFactsOf>>;
}

/** 一覧の行と手順を求める（書き込みを試せないサイト・操作さがしがないサイトは null）。 */
const writeScreenListingOf = async (profileId: string): Promise<WriteScreenListing | null> => {
  const stored = getProfile(localUiStore(), profileId);
  if (stored === null || stored.status !== ACTIVE_PROFILE_STATUS) {
    return null;
  }
  const screens = await scenarioAutoDraftScreensOf(profileId);
  if (screens === null) {
    return null;
  }
  const scenarios = listScenarios(localUiStore(), profileId);
  const external = await approvalExternalFactsOf(stored);
  const rowOf = (screen: (typeof screens)[number]): WriteScreenRowView => {
    const create = screen.scenarioId === null ? null : scenarios.find(({ scenarioId }) => scenarioId === screen.scenarioId) ?? null;
    const update = create === null ? null : rowUpdateOf(scenarios, create.scenarioId, screen.existingUpdateScenarioIds);
    const base = {
      rowKey: screen.rowKey, screenWord: writeScreenWordOf(screen.pagePath), screenName: screen.screenName, mayNotify: screen.mayNotify,
      updateState: (update !== null
        ? create !== null && updateAwaitsNotifyCheckOf(create, update) ? 'MAY_NOTIFY' : null
        : screen.updatePossible ? null : screen.updateFound ? 'NOT_DECIDABLE' : 'NEXT_INSPECTION') as WriteScreenUpdateState | null,
    };
    const lastResult = create === null ? null : { create: lastResultOf(create.scenarioId), update: lastResultOf(update?.scenarioId ?? null) };
    // OP-G（設計書 4.1.4 の E2）: 作ったデータの番号の取り方か答え合わせのしかたを決められなかった画面は、送らない（許可が出ない）ので、チェックできない行にして理由の
    // 1 行を出す（守り `VERIFICATION_SPEC_MISSING` は変えない）。
    if (create !== null && verificationMissingOf(create)) {
      return { ...base, state: 'NOT_CHECKABLE', notCheckableReason: VERIFICATION_SPEC_MISSING_ROW_REASON, notCheckableKind: 'ANSWER_CHECK', lastResult };
    }
    if (screen.notCheckableReason !== null) {
      return {
        ...base, state: 'NOT_CHECKABLE', notCheckableReason: screen.notCheckableReason,
        notCheckableKind: writeScreenNotCheckableKindOf(screen.notCheckableReason), lastResult,
      };
    }
    // OP-T（DEF-184）: 承認した後に、承認していない新しい版になった手順（まとめて実行の始めの作り直しで、送る中身が変わった）は、チェックを外した形で、もう一度
    // チェックを求める（自動で承認し直さない。R3 と同じ表示）。
    if (create !== null && create.state === DRAFT_SCENARIO_STATE && create.lastApprovalReceiptId !== null) {
      return { ...base, state: 'RECHECK_NEEDED', notCheckableReason: null, notCheckableKind: null, lastResult };
    }
    if (create === null || create.state !== 'APPROVED') {
      return { ...base, state: 'CHECKABLE', notCheckableReason: null, notCheckableKind: null, lastResult };
    }
    const valid = approvalValidOf(create.scenarioId, external) && (update === null || update.state !== 'APPROVED' || approvalValidOf(update.scenarioId, external));
    // R3: 承認が無効になった行は、自動で承認し直さない（チェックを外した形で、もう一度チェックを求める）。
    return { ...base, state: valid ? 'CHECKED' : 'RECHECK_NEEDED', notCheckableReason: null, notCheckableKind: null, lastResult };
  };
  const entries = screens.map((screen) => ({
    row: rowOf(screen),
    createScenarioId: screen.scenarioId,
    updateScenarioId: screen.scenarioId === null ? null : rowUpdateOf(scenarios, screen.scenarioId, screen.existingUpdateScenarioIds)?.scenarioId ?? null,
  }));
  return { entries, external };
};

/** 一覧の値を求める（書き込みを試せないサイト・操作さがしがないサイトは null）。 */
const writeScreensOf = async (profileId: string): Promise<WriteScreensView | null> => {
  const listing = await writeScreenListingOf(profileId);
  return listing === null ? null : { profileId, rows: listing.entries.map(({ row }) => row) };
};

/** 書き込みのモードへ切り替える（まだなら。隔離の参照は内部の固定の値。D6）。切り替えられなければ偽。 */
const ensureWriteMode = async (profileId: string): Promise<boolean> => {
  const stored = getProfile(localUiStore(), profileId);
  if (stored === null) {
    return false;
  }
  if (stored.profile.mode === WRITE_AUDIT_MODE) {
    return true;
  }
  const { targetConfigPath } = stored.profile;
  const { context } = await loadTargetContext(targetConfigPath);
  const switched = switchToWriteMode(localUiWriteModeSwitchDependencies(), { profileId, expectedRevision: stored.profile.revision }, {
    resolveContext: (path) => (path === targetConfigPath ? context : undefined),
  });
  return switched.ok;
};

/** 画面の登録と更新を承認する（承認が今も有効なものは、そのまま）。OP-2 の修正の 3 回目: 中身は共有の部品（`approveForCheck`。ジョブの管理と同じ 1 か所）。 */
const approveScreen = async (profileId: string, scenarioIds: readonly string[]): Promise<WriteScreenCheckResultView> => {
  const stored = getProfile(localUiStore(), profileId);
  const external = stored === null ? null : await approvalExternalFactsOf(stored);
  if (external === null) {
    return { ok: false, reason: 'FACTS_UNAVAILABLE' };
  }
  return approveForCheck(localUiStore(), scenarioIds, external, nowCompactTimestamp);
};

/**
 * 登録の手順と、その台帳に結ぶ承認済みの更新の手順の、すべての承認を取り消す（OP-T fix round 2 の I-2。承認していないものは、そのまま。取り消しの部品は
 * 作り直しと同じ `revokeApprovalOf`）。すべて取り消せたか（取り消しの口が拒んだものがあれば偽）を返す。
 */
const revokeCreateAndUpdates = (scenarios: readonly ScenarioView[], create: ScenarioView): boolean =>
  [create, ...boundUpdatesOf(scenarios, create.scenarioId)]
    .map((scenario) => revokeApprovalOf(scenario, 'write screen uncheck time') !== null)
    .every((revoked) => revoked);

/** 画面の登録と、その台帳の更新の承認を取り消す（承認していないものは、そのまま）。 */
const revokeScreen = (profileId: string, rowKey: string): WriteScreenCheckResultView => {
  const scenarios = listScenarios(localUiStore(), profileId);
  const create = scenarios.find((scenario) => scenario.current.kind === CREATE_SCENARIO_KIND && scenario.current.candidate.identityDigest === rowKey) ?? null;
  if (create === null) {
    return { ok: true };
  }
  revokeCreateAndUpdates(scenarios, create);
  return { ok: true };
};

/** OP-T: まとめて実行の始めの作り直しが、誤りで止まったときにログに残す理由のコード（値・URL は残さない）。 */
const CHAIN_START_REDRAFT_FAILED_CODE = 'CHECKED_SCREEN_REDRAFT_FAILED';
/** OP-T fix round 1: 一覧にチェックとして出ない承認済みの手順の承認を取り消したときに、ログに残す理由のコード。 */
const UNLISTED_APPROVAL_REVOKED_CODE = 'UNLISTED_APPROVAL_REVOKED';
/** OP-T fix round 2（I-1・Minor 2）: 取り消しの守りを終えられなかった（開始を拒む）ときに、ログに残す理由のコード。 */
const UNLISTED_APPROVAL_GUARD_FAILED_CODE = 'UNLISTED_APPROVAL_GUARD_FAILED';
/** OP-T fix round 2（Minor 6）: 作り直しの後に承認し直せず、その画面の承認を取り消したときに、ログに残す理由のコード。 */
const CHECKED_SCREEN_REAPPROVAL_FAILED_CODE = 'CHECKED_SCREEN_REAPPROVAL_FAILED';

/** 理由のコードだけをログに残す（値・URL は残さない）。 */
const logReasonCode = (code: string): void => {
  console.error(LOCAL_UI_JOB_CONSOLE_TEXT.backgroundError, code);
};

/** OP-T fix round 2（Minor 6）: 承認し直せなかった画面の、登録と台帳に結ぶ更新の承認を取り消す（理由のコードを残す）。 */
const revokeAfterReapprovalFailed = (profileId: string, createScenarioId: string): void => {
  const scenarios = listScenarios(localUiStore(), profileId);
  const create = scenarios.find(({ scenarioId }) => scenarioId === createScenarioId);
  if (create !== undefined) {
    revokeCreateAndUpdates(scenarios, create);
  }
  logReasonCode(CHECKED_SCREEN_REAPPROVAL_FAILED_CODE);
};

/**
 * OP-T（DEF-184）: チェックした画面 1 つの作り直しを確かめる（作り直しの口は OP-S の 1 か所 `redraftScreenOnChainStart`。チェックの保存と同じ部品）。
 * 1. 今の版と同じ: 何もしない。
 * 2. 照合の READ だけが違う: 新しい版を承認する（チェックの承認の範囲。承認の口は `approveForCheck`。行が対象にしていた承認済みの更新も、その範囲で承認し直す）。
 * 3. 送る中身が違う: 自動で承認しない。画面の承認を取り消す（新しい版は承認していない版のまま。行は「もう一度チェックが要る」）。
 * 4. 作り直せない: 今の版のまま（作り直しの途中で取り消した承認は、チェックの保存と同じ口で今の版に戻す）。
 * 2・4 で承認し直せなかったら、その画面の登録と更新の承認を取り消す（Minor 6）。取り消しを終えられなかったものは、続く `revokeUnlistedApprovals` が扱う。
 */
const redraftCheckedScreen = async (profileId: string, entry: WriteScreenEntry, createScenarioId: string): Promise<void> => {
  const before = readScenario(localUiStore(), createScenarioId);
  if (before === null) {
    return;
  }
  const update = entry.updateScenarioId === null ? null : readScenario(localUiStore(), entry.updateScenarioId);
  const outcome = await redraftScreenOnChainStart(profileId, entry.row.rowKey);
  switch (outcome) {
    case 'SAME':
      return;
    case 'READ_CHANGED': {
      const approved = await approveScreen(profileId, [before.scenarioId, ...(update !== null && update.state === 'APPROVED' ? [update.scenarioId] : [])]);
      if (!approved.ok) {
        revokeAfterReapprovalFailed(profileId, before.scenarioId);
      }
      return;
    }
    case 'SENT_CHANGED': {
      const after = readScenario(localUiStore(), before.scenarioId);
      revokeCreateAndUpdates(listScenarios(localUiStore(), profileId), after ?? before);
      return;
    }
    case 'NOT_REDRAFTED': {
      const after = readScenario(localUiStore(), before.scenarioId);
      if (after !== null && after.revision === before.revision && after.state !== 'APPROVED' && !(await approveScreen(profileId, [before.scenarioId])).ok) {
        revokeAfterReapprovalFailed(profileId, before.scenarioId);
      }
    }
  }
};

/**
 * OP-T fix round 1・2: 一覧にチェックとして出ない承認済みの手順の承認を取り消す。書き込みの段の対象は承認した登録（と、その台帳に結ぶ承認済みの更新）から
 * 決まるので、「一覧でチェックした画面だけに書き込む」を保つ。
 * - 登録: どの `CHECKED` の行にも結び付かないもの（送る中身の形が変わって別の画面の扱いになった古い手順・手で作った手順など）。
 * - 更新（I-2）: `CHECKED` の行が対象にする更新（`rowUpdateOf`）でないもの（同じ登録に結ぶ、ほかの承認済みの更新も含む）。
 * 取り消したら、理由のコードだけをログに残す。すべて取り消せたかを返す（取り消しの口が拒んだら偽）。行は今の決まりのとおりに出る（`CHECKABLE` か
 * `RECHECK_NEEDED`）。
 */
const revokeUnlistedApprovals = (profileId: string, entries: readonly WriteScreenEntry[]): boolean => {
  const checked = entries.filter(({ row }) => row.state === 'CHECKED');
  const listedCreates = new Set(checked.flatMap(({ createScenarioId }) => (createScenarioId === null ? [] : [createScenarioId])));
  const listedUpdates = new Set(checked.flatMap(({ updateScenarioId }) => (updateScenarioId === null ? [] : [updateScenarioId])));
  let allRevoked = true;
  for (const scenario of listScenarios(localUiStore(), profileId)) {
    const { kind } = scenario.current;
    const unlisted = kind === CREATE_SCENARIO_KIND ? !listedCreates.has(scenario.scenarioId) : kind === UPDATE_SCENARIO_KIND && !listedUpdates.has(scenario.scenarioId);
    if (scenario.state !== 'APPROVED' || !unlisted) {
      continue;
    }
    if (revokeApprovalOf(scenario, 'unlisted approval revoke time') === null) {
      allRevoked = false;
      continue;
    }
    logReasonCode(UNLISTED_APPROVAL_REVOKED_CODE);
  }
  return allRevoked;
};

/** 承認の判定の事実を読めた一覧の行（読めなければ null。一覧を出さないサイトは、行のない一覧）。 */
const entriesWithFactsOf = async (profileId: string): Promise<readonly WriteScreenEntry[] | null> => {
  const listing = await writeScreenListingOf(profileId);
  if (listing === null) {
    return [];
  }
  return listing.external === null ? null : listing.entries;
};

/** 取り消しの守りの中身（守りを終えたか）。 */
const guardCheckedScreens = async (profileId: string): Promise<boolean> => {
  const stored = getProfile(localUiStore(), profileId);
  // 書き込みの段がない（書き込みのモードでない・使えるサイトでない）か、承認済みの手順がなければ、守るものはない（開始の判断はジョブの管理に任せる）。
  if (stored === null || stored.status !== ACTIVE_PROFILE_STATUS || stored.profile.mode !== WRITE_AUDIT_MODE
    || !listScenarios(localUiStore(), profileId).some(({ state }) => state === 'APPROVED')) {
    return true;
  }
  // Minor 2: 承認の判定の事実を読めないときは、作り直しも取り消しもしない（チェックを消さない）。開始を拒む。
  if (await approvalExternalFactsOf(stored) === null) {
    return false;
  }
  const entries = await entriesWithFactsOf(profileId);
  if (entries === null) {
    return false;
  }
  for (const entry of entries) {
    if (entry.row.state !== 'CHECKED' || entry.createScenarioId === null) {
      continue;
    }
    try {
      await redraftCheckedScreen(profileId, entry, entry.createScenarioId);
    } catch {
      // 作り直しの誤りは、その画面を今の版のままにして進む（続く取り消しが、一覧に出ない承認を扱う）。
      logReasonCode(CHAIN_START_REDRAFT_FAILED_CODE);
    }
  }
  const after = await entriesWithFactsOf(profileId);
  return after !== null && revokeUnlistedApprovals(profileId, after);
};

/**
 * OP-T（DEF-184）: まとめて実行を始める前に、そのサイトの一覧でチェックした画面（`CHECKED`）の手順の作り直しを確かめる（一覧を開く GET では行わない。GET で
 * 承認を変えないため）。チェックの保存（`saveWriteScreenCheckFn`）の振る舞いは変えない。作り直しの誤りで始める処理を止めない（その画面は今の版のまま。理由の
 * コードだけをログに残す）。OP-T fix round 1: その後に、一覧にチェックとして出ない承認済みの手順の承認を取り消す（`revokeUnlistedApprovals`）。
 * OP-T fix round 2（I-1・Minor 2）: 取り消しの守りを終えられなかったとき（承認の判定の事実を読めない、一覧の読み出しや取り消しの誤り、取り消しの口が拒んだ）は、
 * 偽を返す（呼ぶ側が開始を拒む。fail-closed）。理由のコードだけをログに残す。
 */
export const redraftCheckedScreensOnChainStart = createServerOnlyFn(async (profileId: string): Promise<boolean> => {
  try {
    if (await guardCheckedScreens(profileId)) {
      return true;
    }
  } catch {
    // 下で、守りを終えられなかった理由のコードを残す。
  }
  logReasonCode(UNLISTED_APPROVAL_GUARD_FAILED_CODE);
  return false;
});

/** 一覧の値（読むだけ）。出さないサイトは null。 */
export const writeScreensFn = createServerFn({ method: 'GET' })
  .validator(requestOf<ProfileKeyRequest>('ui-profile-key'))
  .handler(({ data }): Promise<WriteScreensView | null> => writeScreensOf(data.profileId));

/** チェックの保存（POST だけ）。入れたら、切り替え・下書き・承認を 1 回で。外したら、承認の取り消し。 */
export const saveWriteScreenCheckFn = createServerFn({ method: 'POST' })
  .validator(requestOf<WriteScreenCheckRequest>('ui-write-screen-check'))
  .handler(async ({ data }): Promise<WriteScreenCheckResultView> => {
    if (getProfile(localUiStore(), data.profileId) === null) {
      return { ok: false, reason: 'PROFILE_NOT_FOUND' };
    }
    if (!data.checked) {
      return revokeScreen(data.profileId, data.rowKey);
    }
    if (!await ensureWriteMode(data.profileId)) {
      return { ok: false, reason: 'MODE_SWITCH_FAILED' };
    }
    // OP-F（M-3）: 行に出していた「知らせを送ることがある」の 1 行（チェックがその確かめを兼ねる）。下書きの前の行の値で決める。OP-REV2 の m-1: 画面が描いたときの値
    // （要求の `mayNotifyShown`）がサーバの今の値と違えば（古い画面から保存した）、利用者が見ていない 1 行を根拠にしないので、更新は承認しない。
    const serverLine = (await scenarioAutoDraftScreensOf(data.profileId))?.find(({ rowKey }) => rowKey === data.rowKey)?.mayNotify ?? false;
    const sameLine = (data.mayNotifyShown ?? false) === serverLine;
    const drafted = await draftScreenForCheck(data.profileId, data.rowKey);
    if (!drafted.ok || drafted.createScenarioId === null) {
      return { ok: false, reason: 'SCREEN_NOT_DRAFTABLE' };
    }
    // OP-G（E2）: 確かめの指定がそろわない画面は、承認しない（送らない画面をチェックした形にしない）。
    const created = readScenario(localUiStore(), drafted.createScenarioId);
    if (created === null || verificationMissingOf(created)) {
      return { ok: false, reason: 'SCREEN_NOT_DRAFTABLE' };
    }
    const update = drafted.updateScenarioId === null ? null : readScenario(localUiStore(), drafted.updateScenarioId);
    // 更新の画面の知らせを、行の 1 行が示していなければ、登録だけを承認する（行に「もう一度チェックすると、更新も試します」の 1 行が出る）。
    const withUpdate = update !== null && sameLine && updateNotifyConfirmedByCheckOf(serverLine, update.evidence);
    return approveScreen(data.profileId, [drafted.createScenarioId, ...(withUpdate && drafted.updateScenarioId !== null ? [drafted.updateScenarioId] : [])]);
  });
