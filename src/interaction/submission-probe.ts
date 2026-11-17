// 送らずに観察する probe の操作の部品（T37c。Task 37 の設計書 3.2 の「どこで」「対象」「入力」「押下」、4 章、5 章）。ページを操作してよいファイルの
// 閉じた一覧（`tests/architecture/worker-login-hooks.test.ts` の (q)）の 1 つ。`src/discovery/` はページを操作しない（同じ Gate の (w)）ので、押す操作は
// このファイルに置き、発見の流れ（`src/worker/discovery-run.ts`）が、1 画面の流れの最後（候補の分類と `discoverLinks` の後）に呼ぶ。
// 1. 前提: 凍結した PRIMARY の Context（`activateInteractionFreeze` の後。凍結の後は、ページの JS の読み取りでない送信と main frame の移動を Guard が止める。DEF-208-1（設計書 `2026-11-05-beaksight-discovery-coverage-design.md` 3.1）から、
//    許可 Origin と承認したサービスの Origin への読み取り（GET・HEAD。子の frame の文書を含む）は、凍結の読み取りの判定 `isFrozenReadAdmissible` と監査の段の判定で
//    通す。目印を運ぶ読み取りも通す）と、factory が
//    その Context に渡した観察の口（`SubmissionObservation`。T37b）。押す前に、Guard が凍結の段にあることを確かめる（`interactionFreezeHolds`。凍結の段でなければ
//    押さずに `PRESS_FAILED`）。読み込み直しはしない（1 画面 1 読み込みのまま）。
// 2. 対象（`isSubmissionProbeTarget`。契約は `src/discovery/submission-probe-contracts.ts`）を、押す前に isolated world でもう一度読み（発見の probe
//    `probePageCandidatesWithSubmitters`。LU-SFIX2-A fix round 1: 送信ボタンの番号も同じ読み取りから受け、見えるか・窓の中か・欄の範囲は、位置で引き直さずに
//    その要素を読む。欄の範囲を読む直前にも同じ読み方で読み直し、同じ候補の要素そのものを押す）、同じ識別の digest（`probedCandidateIdentityDigestOf`。送信ボタンの語を含むので、削除の語に変わったボタンは別の候補）で
//    同じ候補を探し、押す順（`submissionProbePressOrderOf`。DEF-142: 登録・更新の語のあるもの、文字のあるそのほか、文字のないもの、の順。同じ段の中は
//    送信ボタンの位置の文書の順）に並べて押す（COV-1: 押す数の上限はない。終わりは 12 の状態の鍵で決める）。
//    見つからない・送信ボタンがない候補は `TARGET_NOT_FOUND`。DEF-142: 押す前に送信ボタンが見えない（か範囲を読めない）候補も `TARGET_NOT_FOUND` で、
//    押す回数を使わずに次の候補へ進む。T44c（Task 44 の設計書 P1-3）: 押す順に並べる前に、見つけた対象の送信ボタンが見えるかを 1 回で読み、見えない対象を
//    除く（`TARGET_NOT_FOUND`。押す数の上限の後に並んでいても `PRESS_LIMIT_REACHED` にしない）。押す順と上限は、見える対象だけで数える。
// 3. 入力: 押す前に、その候補の範囲の欄（`FORM` はその form の欄、`BUTTON` は画面の form の外の欄）を isolated world で読み（要素の橋渡しの部品
//    `readElementsInIsolatedWorld`。標準の getter で読む）、見えて編集できる text 系の欄に欄ごとに違う目印（`submissionProbeMarkerOf`。1 画面で 32 まで）を
//    入れ、`select` は空でない最初の選択肢を選ぶ。password・file・hidden・checkbox・radio とほかの型、見えない・編集できない欄、目印の上限を超えた欄は
//    触らない（数を記録する）。目印の値は、観察の口に渡すほかは、どこにも記録しない。
//    T38a（Task 38 の設計書 3.1）: 目印の値は押下ごとに新しく作り（前の押下の目印と同じ値を使わない）、番号は押下ごとに 0 から振る（型の digest が前の押下に
//    左右されない）。入れた欄ごとに、`name`、その画面で一意な CSS（T43c の組み立て `entrySelectorCandidatesOf` を `src/discovery/selector-count.ts` で数えて
//    選ぶ）、種類、目印の番号を `inputFields` に記録する（`BUTTON` の候補では、これが候補の欄の範囲。値は記録しない）。
// 4. 押下: 観察の口を有効にして（`begin`。画面の path（query なし）と、その画面で使ったすべての目印）、合図つきの Locator（`withSignaledElements` と
//    `elementPathSelectorOf`。位置の要素が読んだ要素のときだけ要素を返す）で入れて押し（`click`）、静まるまで名前つきの時間（既定
//    `SUBMISSION_PROBE_QUIET_WAIT_MS`）待ってから、口を閉じる（`end`）。Guard は、承認した API の Origin への事前確認を満たし、本番の要求を止めて型を口に渡す
//    （読み取りでない送信は、サーバへ何も届かない。DEF-208-1: 押下の後の読み取りは届く。保存の前に読み取りを待つ画面も、保存の送信まで進む）。結果は T37b の分類で写す（`observedSubmissionProbeOf`）。入れるか押す操作が失敗したら `PRESS_FAILED`。
// 5. 押した後に main frame の URL が変わったら（画面を移る保存。止めた移動のために Chromium の誤りの画面に替わることもある）、その押下は `PAGE_CHANGED`
//    にし、その画面の残りの対象は押さない（`PAGE_CHANGED`）。
// 6. DEF-144（設計書 `2026-10-20-beaksight-probe-external-scheme-design.md` 2.1・2.3）: 押す前の読み直しで、送信ボタンと祖先の `<a>`・`<area>` の `href`、
//    `formaction`、form の `action` を読み、外部スキーム（Guard の判定 `externalNavigationScheme`。`javascript:` は今の扱いのまま）を指す対象は押さずに
//    `NOT_EXECUTABLE`・`EXTERNAL_SCHEME`（押す回数を使わない）。Guard が Context を閉じ始めた後の対象は `CONTEXT_CLOSED_BY_GUARD`（`PAGE_CHANGED` と分ける）。
//    読み込み直した画面では、指定の対象（`onlyCandidates`）を押す（COV-1: `maxPresses` は使わない）。
// 7. DEF-145（設計書 `2026-10-21-beaksight-probe-navigation-and-dialog-design.md` 2.2）: 押下が何も送らず（`NO_REQUEST`）回数が残っていれば、押す前は見えな
//    かった（かなかった）登録・更新の語の対象を読み直し、押下で開いたダイアログなどで見つかったものを先に押す（1 対象 1 回まで。回数は合わせて 1 画面 3 回）。
//    結果は元の候補に記録する。読み込み直しはしない。DEF-186（設計書 `2026-11-02-beaksight-list-row-update-design.md` 5.1 の 4）: 開き手の語だけの候補の
//    押下が登録の形を出した（開くとサイトが下書きを送る。`OPENER_SIDE_REQUEST`）ときも、同じく読み直す。
// 8. LU-4（設計書 `2026-11-02-beaksight-list-row-update-design.md` 4.0 の D7、5.1 の 1・2）: 押す前の読み直しで見つけた対象のうち、名前（見える文字・
//    `aria-label`・`title`。読み直しの `hasSubmitterText`）があり、開き手の語だけを持つ（`isOpenerOnlySubmitter`。DEF-189）同じ識別の digest の対象は、
//    文書の順で最初の 1 つだけを残し、残りは押さずに
//    `SAME_IDENTITY_PRESSED`（押す回数を使わない。fix round 1: 名前のない対象は、見た目の違うアイコンが同じ識別になりうるので、今までどおり 1 つずつ）。
//    7 の読み直しで押した対象の記録には、開き手の事実（`opener`。識別の digest・名前があるか・開き手の語。値は持たない）を写し、その分類には
//    `openedFromRow` を渡す（契約の `observedSubmissionProbeOf`）。
// 9. LU-4（設計書 4.0.1 の K6、5.1 の 3）: 7 の読み直しでは、押す前の記録になかったボタンのうち、開いた窓（`<dialog open>`・`role="dialog"`・
//    `aria-modal="true"`）の中にあるものも、発見の入口と同じ組み立て（`classifyProbedCandidates`）で候補にし、記録の末尾に足す。対象の条件
//    （`isSubmissionProbeTarget`）と登録・更新の語のあるものだけを、待ち行列の先頭に入れる。DEF-221: 窓の外に新しく現れたボタンは、確定の語のあるものだけ足す。
// 11. DEF-221（設計書 `2026-11-08-beaksight-same-origin-api-and-spa-routes-design.md` 3.2）: 押した後に、同じ文書のまま main frame の URL が変わった
//    （`pushState`・`replaceState`・ハッシュ。isolated world で読む文書の印で見分ける）ときは、その URL を呼ぶ側に渡す（`onSameDocumentUrlChanged`）。
//    押した対象と残りの対象は、今のとおり `PAGE_CHANGED`。
// 10. LU-11 fix round 2（設計書 `2026-11-02-beaksight-list-row-update-design.md` 5.4 の 4、D5。設計者の判断）: 開き手の語のある押下の後の 7 の読み直しで、
//    その開き手に結ばれた行の下に広がるフォーム（`rowOpener`）の、見えるようになった欄の見え方を記録し直す（`withRevealedRowFormFields`。押す回数は使わない）。
// 12. COV-1（網羅の設計書 `2026-11-09-beaksight-coverage-by-state-design.md` 3.2・3.3、DEF-238 の設計書 3.1）: 押す数の上限と、入れたのに押せなかった回の
//    上限を外し、状態の鍵で終える。
//    - 状態の構造の鍵（`stateStructureKeyOf`。path の型・query の名前・候補の識別・見える欄・開いた窓・見出し・landmark。文字の値は入れない）を、押す前と、
//      押すたびに読む。1 つの状態の中で、（構造の鍵・候補の識別・同じ識別の中の順番）は 1 回だけ押しにかかる。
//    - 押下の記録は、押した後に同じ文書のまま URL が変わっても `PAGE_CHANGED` にせず、観察した送信の形を残す（11 の画面の移り）。path が同じまま
//      （query・ハッシュだけ）URL が変わったか、構造の鍵が変わったら（path が変わったときは、移った先を発見の流れが別の画面として読み、残りは `PAGE_CHANGED`）、
//      新しい段として画面を読み直し、新しく出た候補（窓の中か外か、語は問わない）を記録の末尾に足し、まだ押しにかかっていない組を押す（まだ押せていない
//      対象を先に）。押せる組がなくなったら終える（同じ構造の鍵に戻った道も、残りの組だけを押す）。文書が替わった移動は、今のとおり残りを `PAGE_CHANGED`。
//    - 2 段目から後の記録には、段の番号と、その押下の前の押下の並びを付ける（`stage`）。段をまたいで同じ候補を押したら、強い記録を残す。
//    - radio は、名前の組ごとに、まだ選ばれていなければ最初の選択肢を選ぶ。
//    - 同じ語の組（DEF-208-2）・共通の枠（DEF-208-4）・同じ識別の開き手（LU-4 の D7）の決まりの鍵に、状態の構造の鍵を入れる（構造の鍵が違う状態では押す）。
// 13. COV-2c（SREV-COV の指摘の直し。網羅の設計書）:
//    - I-1: 押した後に、新しい作りの印（L9 の `structureSignaturesInPage` と `scrollStructureSignaturesOf`。値を含まない）が出ず、状態の語のほかの構造の鍵
//      （数を入れない集合）も変わらなければ、同じ作りの部品が増えただけ（数・状態の語だけの変化を含む）として、新しい状態（新しい段）とみなさず、新しく出た
//      ボタンも候補にしない（押下の鎖を閉じ、その押下の記録に `chainEnd: NO_NEW_STRUCTURE`）。同じ文書のまま URL が変わったときは、今のとおり新しい段にする。押す輪の中でも、利用者の停止と Run の時間の上限
//      （`shouldStop`）を見る（押していない対象には記録を付けない）。
//    - I-2: 押す時点の確かめが止めた押下（押していない）は、押した組に入れない。
//    - I-3・I-4: 押下から生まれた移り先（同じ文書のまま変わった URL・文書の移動）には、値に目印を含む query の名前と、移り先を出した押下までの並びを付けて渡す。
//      再開の後は、その並びを押し直して移り先を作り直す（`replaySubmissionProbeMove`）。
//    - M1: 読み込み直した画面のたどり直しの押下も、押下の並び（`stage.priorPresses`）に入れる。
// 例外を投げない（予期しない誤りは、残りの対象を `PRESS_FAILED` にする）。Playwright の誤りの文は値を含みうるので捨てる。
import type { Frame, Page, Request } from 'playwright';
import { PAGE_SETTLING_PACING } from '../core/limits.js';
import { wait } from '../core/deadline.js';
import { isRecord } from '../core/guards.js';
import { VISIBILITY_CHECK_OPTIONS } from '../core/visibility.js';
import { scrollStructureSignaturesOf, structureSignaturesInPage } from '../browser/controlled-scroll.js';
import { elementPathSelectorOf } from '../browser/element-path-engine.js';
import { attachPageProgressSignals } from '../browser/page-progress-signals.js';
import { waitForPageSettled, type DataActivity } from '../browser/page-settling.js';
import { watchProgress, type ProgressSignals } from '../core/progress-watch.js';
import { openReadDeadline } from '../orchestration/stage-deadline.js';
import { composeInPage, type LayoutLandmarkCriteria, type StandardReaders, type StateFieldCriteria } from '../browser/in-page-readers.js';
import {
  CANDIDATE_FIELD_TYPES,
  SELECT_FIELD_TYPES,
  type CandidateFieldType,
  type CandidateLocation,
  type DiscoveryCandidate,
} from '../discovery/candidate-contracts.js';
import {
  classifyProbedCandidates,
  documentGoneOf,
  probedCandidateIdentityDigestOf,
  probedCandidateStateTemplateDigestOf,
  probedIncompleteReasonsOf,
  withRevealedRowFormFields,
} from '../discovery/discover-page.js';
import type { CoveragePressKey } from '../discovery/coverage-queue.js';
import { createSha256Fingerprint } from '../core/ids.js';
import {
  DISCOVERY_OPTION_FIELD_KINDS,
  type DiscoveryOptionChoiceRecord,
  type DiscoveryOptionFieldKind,
  type DiscoveryReadPageRecord,
} from '../discovery/discovery-result.js';
import { entrySelectorCandidatesOf, uniqueEntrySelectorOf, type EntryElementFacts } from '../discovery/entry-check-selectors.js';
import {
  pressWithPressTimeGuard,
  readElementsInIsolatedWorld,
  readInIsolatedWorld,
  withSignaledElements,
  type InPageElementsResult,
} from '../discovery/isolated-read.js';
import { destructiveActionFactsFrom, isDestructiveAction, textsHaveDestructiveActionWord } from '../discovery/destructive-action.js';
import { SCOPED_LANDMARK_NAMES, SECTIONING_SCOPE_SELECTOR } from './notification-overlay.js';
import {
  probePageCandidates,
  probePageCandidatesWithSubmitters,
  type PageProbeOutcome,
  type PageProbeWithSubmittersOutcome,
  type ProbedCandidate,
} from '../discovery/probe.js';
import { screenWatchEnded, screenWatchOf, trackOnScreen } from '../discovery/screen-watch.js';
import { STATE_LANDMARK_ROLES, STATE_WORDS, stateStructureKeyOf, type StateStructureFacts, type StateStructureField } from '../discovery/state-keys.js';
import { countReadingOf, countSelectorsInPage } from '../discovery/selector-count.js';
import {
  OPENER_SIDE_REQUEST_PROBE_REASON,
  SAME_IDENTITY_PRESSED_PROBE_REASON,
  DISABLED_SUBMITTER_PROBE_REASON,
  COVERED_BY_OTHER_PROBE_REASON,
  DESTRUCTIVE_ACTION_SKIPPED_PROBE_REASON,
  submitterHitJudgementOf,
  submitterHitPointsOf,
  type SubmitterHitTopRelation,
  SAME_WORDS_NO_REQUEST_PROBE_REASON,
  SHARED_LAYOUT_PRESSED_PROBE_REASON,
  SAME_STATE_PRESSED_PROBE_REASON,
  sharedLayoutIdentityDigestOf,
  sharedLayoutStateKeyOf,
  sharedLayoutStructureKeyOf,
  submissionProbeStrengthOf,
  withSubmissionProbeChainEnd,
  withSubmissionProbeStage,
  type SubmissionProbePressStep,
  submissionProbeWordsKeyOf,
  SUBMISSION_PROBE_FILL_FIELD_TYPES,
  SUBMISSION_PROBE_QUIET_WAIT_MS,
  externalSchemeSubmissionProbeOf,
  hasSubmissionProbeConfirmWord,
  hasSubmissionProbePriorityWord,
  isOpenerOnlySubmitter,
  isSubmissionProbeTarget,
  notObservedSubmissionProbeOf,
  observedSubmissionProbeOf,
  submissionProbeMarkerOf,
  submissionProbeOpenerOf,
  submissionProbePressOrderOf,
  withOptionChoices,
  withSubmissionProbes,
  type SubmissionProbeFieldCounts,
  type SubmissionProbeInputField,
  type SubmissionProbeNotObservedReason,
  type SubmissionProbeOpener,
  type SubmissionProbePressEntry,
  type SubmissionProbeRecord,
  type SubmissionProbeTargetPolicy,
} from '../discovery/submission-probe-contracts.js';
import { isClosingOrInvalidatingPhase, passiveRequestGuardStageOf, pointsToExternalScheme } from '../safety/passive-request-guard.js';
import type { SubmissionObservation, SubmissionObservationResult } from '../safety/submission-observation.js';

// L6/L3-1（設計書 `2026-11-09-beaksight-remove-limits-design.md` 5 の 1）: 押す前の読み直しと欄の読み取りの時間の上限（前は 10 秒）と、欄に入れる・
// 選ぶ・押す操作の時間の上限（前は 5 秒）は撤廃した（読み取りは進んでいる間は待つ。固まった画面は 1 画面の見張り `src/discovery/screen-watch.ts` が
// 終える）。定数は LZ-1 で消した。
/**
 * L6/L3-1: Playwright の 1 手（入れる・選ぶ・押す・押せるかの読み取り）に渡す `timeout`。0 は期限なし（Playwright の既定の期限にも頼らない）。1 手は
 * 1 画面の見張りの口（`trackOnScreen`）を通して待ち、全く反応がないときは見張りが画面を終える。
 */
const NO_STEP_TIMEOUT = 0;

/** 押す部品の指定。 */
export interface SubmissionProbeOptions {
  /** 対象の選び方（許可 Origin とログインの画面）。 */
  readonly targetPolicy: SubmissionProbeTargetPolicy;
  /**
   * 押した後の最短の観察の長さ（ms。省略すると `SUBMISSION_PROBE_QUIET_WAIT_MS`）。L6/L3-1 の続き（T18。設計者の判断 C）: この長さの後に、ページが落ち着くまで
   * 待つ（`waitAfterPress`。要求の数は `dataActivity`）。上限ではない。
   */
  readonly quietWaitMs?: number | undefined;
  /**
   * DEF-144: 1 つの対象に入れて押しにかかる直前に、記録の候補の位置（返す記録の `candidates` の添字）と、その候補で呼ぶ（安全の違反を、押しにかかった候補に
   * 結びつけるため）。LU-4（K6）: 押した後に開いた窓の中の候補は、入力の記録の末尾に足すので、入力の記録では引けない。候補そのものも渡す。省略すると呼ばない。
   * SREV-1105-3 の Important-2: 呼ぶのは、欄に入れる前（欄の読み取りと、外部スキームと、入れる前から押せないかの見分けの後）。押せずに押さなかった候補でも呼ぶ
   * （欄に入れる間の違反も、その候補に結びつける）。押す回数は数えない（`onPressCounted`）。
   */
  readonly onPress?: ((candidateIndex: number, candidate: DiscoveryCandidate | undefined) => void) | undefined;
  /** SREV-1105-3 の Important-2: 押す回数を使った押下（押したか、押したかが分からない）のたびに、記録の候補の位置で呼ぶ。省略すると呼ばない。 */
  readonly onPressCounted?: ((candidateIndex: number) => void) | undefined;
  /** DEF-144: 読み込み直した画面で、押してよい対象（記録の候補の位置）。省略すると、すべての対象。 */
  readonly onlyCandidates?: ReadonlySet<number> | undefined;
  /**
   * COV-2（網羅の設計書 3.2 の 2・3.3）: 操作さがし全体の押す組の記録（`CoverageQueue` の `hasPressed`・`acceptPress`。組は、状態の構造の鍵・候補の型にした
   * 識別と位置の手がかりの digest・同じ digest の中の順番）。見た組の対象は押さない（`SAME_STATE_PRESSED`）。押した組を記録する。省略すると、この画面の中だけで
   * 見分ける。
   */
  readonly pressRegistry?: SubmissionProbePressRegistry | undefined;
  /**
   * COV-2（設計書 3.2 の 2）: 段が移って押さないまま残った対象（`PAGE_CHANGED`・`CONTEXT_CLOSED_BY_GUARD`）の記録の候補の位置と、その対象のあった状態を作り直す
   * 押下の並び（呼ぶ側が読み込み直し、`replay` に渡す）。省略すると呼ばない。
   */
  readonly onLeftBehind?: ((candidateIndex: number, replay: readonly SubmissionProbeReplayStep[]) => void) | undefined;
  /** COV-2: 読み込み直した画面で、残りの対象を押す前に、たどって押し直す押下の並び（`onLeftBehind` の値）。省略すると押し直さない。 */
  readonly replay?: readonly SubmissionProbeReplayStep[] | undefined;
  /** COV-2: 前の読み込みで決めた、候補の見分けの鍵（記録の候補の位置ごと。`onCandidateKeys` の値）。省略すると、この読み込みで決める。 */
  readonly candidateKeys?: ReadonlyMap<number, string> | undefined;
  /** COV-2: この画面で決めた候補の見分けの鍵を、終わりに知らせる（読み込み直しの `candidateKeys` に渡す）。省略すると呼ばない。 */
  readonly onCandidateKeys?: ((keys: ReadonlyMap<number, string>) => void) | undefined;
  /**
   * DEF-190（一覧の行の更新の設計書 5.8 の 1）: 開き手の語だけの対象（`isOpenerOnlySubmitter`）を押した後に main frame の URL が変わったとき（`PAGE_CHANGED`）、
   * 移った先の URL で呼ぶ（main frame の URL が http(s) でなければ、押下の間に main frame が始めた最後の移動の URL。分からなければ呼ばない）。DEF-208-3（G）: URL が
   * 変わらなかったときも、押下の間に Guard が止めた GET の文書の移動（押下で開いた別の page を含む）があれば、その行き先で呼ぶ。読むかどうかは
   * 呼ぶ側が決める（この部品は URL を記録に入れない）。省略すると呼ばない。
   */
  readonly onOpenerPageChanged?: ((movedUrl: string, move: SubmissionProbeOpenerMoveFacts) => void) | undefined;
  /**
   * DEF-221（設計書 `2026-11-08-beaksight-same-origin-api-and-spa-routes-design.md` 3.2 の 1）: 押した後に、同じ文書のまま main frame の URL が変わったとき
   * （`pushState`・`replaceState`・ハッシュ。押した対象と残りの対象は今のとおり `PAGE_CHANGED`）、変わった後の URL（http(s)）で呼ぶ。同じ文書かは、押す前と
   * 押した後に isolated world で読む文書の印（`documentMarkerOf`）で見分ける。読めなければ同じ文書とせず、今のまま（`onOpenerPageChanged`）。同じ文書の
   * 変化のときは `onOpenerPageChanged` を呼ばない（DEF-190 の狭い条件を当てない）。読むかどうかは呼ぶ側が決める。省略すると、今のまま（印も読まない）。
   */
  readonly onSameDocumentUrlChanged?: ((url: string, move: SubmissionProbeMoveFacts) => void) | undefined;
  /**
   * COV-2c（SREV-COV の I-1 の 3）: 利用者の停止か、利用者が指定した Run の時間の上限に届いたか（押す輪の中で、押す前ごとに見る）。真なら、残りの対象を押さずに
   * 終える（押していない対象には記録を付けない）。省略すると見ない。
   */
  readonly shouldStop?: (() => boolean) | undefined;
  /**
   * COV-2b（網羅の設計書 3.2 の 1）: 開き手の語だけの対象でない押下の間に、GET の文書の移動（押した page か、押下で開いた別の page の main frame。凍結の間は
   * Guard が止める）があったとき、その行き先（最後の 1 つ）と、値に目印を含む query の名前で呼ぶ。読むかどうかは呼ぶ側が決める。省略すると見ない。
   */
  readonly onPageMoved?: ((moved: SubmissionProbeMovedPage) => void) | undefined;
  /**
   * COV-3（網羅の設計書 3.3）: 選択肢を選ぶと、まだ見ていない構造の鍵の状態になった（新しい段）とき、その状態を作る並び（その状態を作る押下の並びと、最後に選ぶ
   * 選択肢。`choiceReplayStepOf`）で呼ぶ。呼ぶ側は、読み込み直し、この並びをたどって（`replay`）、その段で押す。省略すると呼ばない（選択肢は選んで記録だけする）。
   */
  readonly onOptionStage?: ((trail: readonly SubmissionProbeReplayStep[]) => void) | undefined;
  /**
   * COV-3: 要求の今の数（進行中の数と、始まりと終わりの通しの数）。選んだ後の落ち着きの待ち（`waitForPageSettled` の `dataActivity`）に渡す。省略すると、
   * 要求の数を見ずに、作りの印と高さの静まりだけで決める。
   */
  readonly dataActivity?: (() => DataActivity) | undefined;
  /**
   * DEF-208-4（設計書 `2026-11-05-beaksight-discovery-coverage-design.md` 3.7 の A）: 操作さがし全体の、共通の枠のボタンの押した識別（`sharedLayoutIdentityDigestOf`）。
   * この画面を始めた時点で `pressed` にある識別の枠のボタンは押さない（`SHARED_LAYOUT_PRESSED`。押す回数を使わない）。この画面で押した枠のボタンの識別を
   * `onPressed` で知らせる（同じ画面の中の同じ識別のボタンは、今のとおり押す）。省略すると、今のまま。
   */
  readonly sharedLayout?: {
    readonly pressed: ReadonlySet<string>;
    readonly onPressed: (digest: string) => void;
  } | undefined;
  /**
   * L6/L3-1（設計書 `2026-11-09-beaksight-remove-limits-design.md` 5 の 1）: 押し始める前に、その時点までの記録を作る関数を知らせる（1 画面の見張りが画面を
   * 終えたときに、呼ぶ側が使う）。関数は、押しにかかった対象の記録を残し、まだ記録のない対象を、渡した理由（`STAGE_UNRESPONSIVE`・`STAGE_NEVER_QUIET`）で
   * 押せなかったとした記録を返す（押す部品の中の記録は変えない）。省略すると知らせない。
   */
  readonly onRecordSnapshot?: ((snapshot: (reason: SubmissionProbeNotObservedReason) => DiscoveryReadPageRecord) => void) | undefined;
  /**
   * L10 の調べの直し: Safety の記録から、この文書を使うのをやめるか（呼ぶ側が Ledger を見る。外部スキーム・frame の判定の失敗の記録が、押す輪の中で入った）。真に
   * なったら、入れる・押す 1 手を待つのをやめ、残りの対象は押さずに `PAGE_CHANGED`（読み込み直した文書で押す）にする。省略すると記録は見ない。
   */
  readonly documentUnusable?: (() => boolean) | undefined;
}

/**
 * 押す対象（記録の候補の位置と、読み直した候補。DEF-142: 押す順を決める、送信ボタンの語と文字があるか）。LU-SFIX2-A fix round 1: 押す直前に同じ候補を探し直す
 * ための、識別の digest と、読み直しの中の同じ digest の候補の中の順番（`ordinal`）。
 */
export interface PressTarget extends SubmissionProbePressEntry {
  readonly index: number;
  /** SREV-1105-3 の Minor-1: 同じ語の組の決まりの範囲（form の位置か、form の外）。 */
  readonly scopeKey: string;
  readonly kind: ProbedCandidate['kind'];
  readonly identityDigest: string;
  /**
   * COV-2（文字のないボタンの段またぎ）: 候補の見分けの鍵（`matchKeyOf`。識別の digest と、構造の中の位置の手がかり）と、読み直しの中の同じ鍵の候補の中の順番。
   * 押す直前に同じ候補を探すのも、この組で行う。
   */
  readonly matchKey: string;
  readonly ordinal: number;
  /** COV-2: 押す組の digest（`pressDigestOf`。型にした識別と位置の手がかり）と、読み直しの中の同じ digest の候補の中の順番。 */
  readonly pressDigest: string;
  readonly pressOrdinal: number;
  /** COV-2b: 読み直しで受けた送信の要素の番号（同じ文書の中で同じ要素を探すのに先に使う。分からなければ `undefined`）。 */
  readonly nodeId: number | undefined;
}

/** COV-2: 操作さがし全体の押す組の記録（`CoverageQueue` の口と同じ形）。 */
export interface SubmissionProbePressRegistry {
  readonly hasPressed: (key: CoveragePressKey) => boolean;
  readonly acceptPress: (key: CoveragePressKey) => boolean;
}

/** COV-2: 押さないまま残った対象のあった状態を作り直す、押下の 1 つ（記録の候補の位置と、見分けの鍵と順番。値を持たない）。 */
export interface SubmissionProbeReplayStep {
  readonly index: number;
  readonly matchKey: string;
  readonly ordinal: number;
}

/**
 * COV-2c（SREV-COV の I-3・I-4）: 押下から生まれた移り先の事実（値を持たない）。`markerQueryNames` は、値に目印を含む query の名前。`trail` は、その画面の
 * 読み込みの最初から、移り先を出した押下までの押下の並び（最後の 1 つが移り先を出した押下。呼ぶ側が再開の後に押し直して移り先を作り直す）。
 */
export interface SubmissionProbeMoveFacts {
  readonly markerQueryNames: readonly string[];
  readonly trail: readonly SubmissionProbeReplayStep[];
  /**
   * COV-2c fix round 5（SREV-COV 4 回目の I-1）: この文書で、移り先を出すまでに入れた目印の値（呼ぶ側がメモリの中だけに持ち、子孫の辺を値で伏せるのに使う。記録・
   * checkpoint には書かない）。
   */
  readonly markerValues: readonly string[];
}

/**
 * COV-2c fix round 3: 開き手の押下の移り先の事実。`markedDocument` は、目印を入れた文書で押したか（目印を入れる押下でたどり着いた状態の開き手。呼ぶ側は、その
 * 移り先を凍結の中で読む）。
 */
export interface SubmissionProbeOpenerMoveFacts extends SubmissionProbeMoveFacts {
  readonly markedDocument: boolean;
}

/** COV-2b: 押下で文書が替わった GET の移り先（`onPageMoved`）。`markerQueryNames` は、値に目印を含む query の名前（値は持たない）。 */
export interface SubmissionProbeMovedPage extends SubmissionProbeMoveFacts {
  readonly url: string;
}

/** COV-2b: URL の query のうち、値に目印（この画面の押下で入れた目印）を含む名前（重なりなし。読めなければ空）。 */
const markerQueryNamesOf = (url: string, markers: readonly string[]): readonly string[] => {
  try {
    const names = new Set<string>();
    for (const [name, value] of new URL(url).searchParams) {
      if (markers.some((marker) => value.includes(marker))) names.add(name);
    }
    return [...names];
  } catch {
    return [];
  }
};

/** COV-2: 押す組の digest の入力の形の印（版つき。COV-2b: 位置の手がかりを強めたので 2）。 */
const PRESS_DIGEST_FORMAT = 'beaksight-probe-press-candidate/2';

/**
 * COV-2・COV-2b: 構造の中の位置の手がかり（値を含まない）。文字のないボタン（語のないボタン）は識別の digest が同じになりやすいので、段をまたいで、別の区画に
 * 出た別のボタンを同じ候補とみなさないために使う。送信の要素の文書の中の深さと、ページの中で読んだ構造の手がかり（`readStructureHintsInPage`。祖先の要素の名前と
 * role の道、文書の順で直前の見出しの段。読めなければ `null`）の組。
 */
const positionHintOf = (probed: ProbedCandidate, structure: string | null): string => JSON.stringify([probed.submitter?.path.length ?? -1, structure]);

/** COV-2: 候補の見分けの鍵（識別の digest と位置の手がかり。押す部品の中だけで使う。識別の digest は変えない）。 */
const matchKeyOf = (location: CandidateLocation, probed: ProbedCandidate, structure: string | null): string =>
  JSON.stringify([probedCandidateIdentityDigestOf(location, probed), positionHintOf(probed, structure)]);

/** COV-2: 押す組の digest（型にした識別と位置の手がかり。番号だけ違う同じ作りの画面の候補で同じ）。 */
const pressDigestOf = (location: CandidateLocation, probed: ProbedCandidate, structure: string | null): string =>
  createSha256Fingerprint(JSON.stringify([PRESS_DIGEST_FORMAT, probedCandidateStateTemplateDigestOf(location, probed), positionHintOf(probed, structure)]));

/** COV-2b: 構造の手がかりの読み取りの入力（role は小文字の英字だけを手がかりにする。値の入った属性は読まない）。 */
interface StructureHintInput {
  readonly headingSelector: string;
  readonly maxRoleLength: number;
}

const STRUCTURE_HINT_INPUT: StructureHintInput = Object.freeze({ headingSelector: 'h1, h2, h3, h4, h5, h6', maxRoleLength: 32 });

/**
 * COV-2b: 送信の要素ごとに、構造の手がかりを読む（ページの中で動く。標準の getter とメソッドで読み、ページに何も書かない。文字の値は読まない）。
 * - 祖先の道: 親から body の手前までの、要素の名前と role（小文字の英字だけ。ほかは空）の並び。
 * - 直前の見出しの段: 文書の順で、その要素より前にある最後の見出し（h1〜h6）の段（なければ 0）。
 * 文書から外れた要素は `null`。
 */
const readStructureHintsInPage = composeInPage((R: StandardReaders, input: StructureHintInput, given?: readonly Element[]): InPageElementsResult => {
  const localNameOf = R.standardGetter<string>(Element.prototype, 'localName');
  const parentOf = R.standardGetter<Element | null>(Node.prototype, 'parentElement');
  const isConnected = R.standardGetter<boolean>(Node.prototype, 'isConnected');
  const nodeListLengthOf = R.standardGetter<number>(NodeList.prototype, 'length');
  const headings = Document.prototype.querySelectorAll.call(document, input.headingSelector);
  const headingCount = nodeListLengthOf(headings);
  return {
    value: (given ?? []).map((element) => {
      if (!(element instanceof Element) || !isConnected(element)) return null;
      const chain: string[] = [];
      for (let node: Element | null = parentOf(element); node !== null; node = parentOf(node)) {
        const name = localNameOf(node);
        if (name === 'body' || name === 'html') break;
        const roleValue: unknown = Element.prototype.getAttribute.call(node, 'role');
        const role = typeof roleValue === 'string' && roleValue.length <= input.maxRoleLength && /^[a-z]+$/u.test(roleValue) ? roleValue : '';
        chain.push(name + '[' + role + ']');
      }
      let level = 0;
      for (let index = 0; index < headingCount; index += 1) {
        const heading = NodeList.prototype.item.call(headings, index);
        // DOCUMENT_POSITION_FOLLOWING（4）: その要素が見出しの後にある。
        if (heading instanceof Element && (Node.prototype.compareDocumentPosition.call(heading, element) & 4) !== 0) {
          level = Number(localNameOf(heading).slice(1));
        }
      }
      return [chain, level];
    }),
    elements: [],
  };
});

/** COV-2b: 読み直した候補と、送信の要素の番号（候補の位置ごと）と、見分けの鍵（構造の手がかりつき）。 */
export interface ProbedRead {
  /** L6/L3-1: 押せる位置の送信の要素（`chosen`）も持つ形（状態の構造の鍵の読み取りが、同じ読み取りを使えるように）。 */
  readonly outcome: Extract<PageProbeWithSubmittersOutcome, { readonly status: 'READ' }>;
  readonly candidates: readonly ProbedCandidate[];
  /** 送信の要素の番号（同じ文書の中で同じ要素を指す。押せる位置の送信の要素のある候補だけ）。 */
  readonly nodeIds: ReadonlyMap<number, number>;
  readonly keys: RereadKeys;
}

/** 押せる位置（shadow root の外）の送信の要素があるか。 */
const hasPressableSubmitter = (probed: ProbedCandidate): boolean => probed.submitter !== null && probed.submitter.path.every((step) => step >= 0);

/**
 * COV-2b: 画面の候補を読み直し（`probePageCandidatesWithSubmitters`。押せる位置の送信の要素のある候補の要素を、同じ読み取りから受ける）、構造の手がかりを読んで、
 * 見分けの鍵を付ける。読めなければ null（構造の手がかりだけを読めなければ、手がかりなしの鍵）。
 */
async function readProbed(page: Page, location: CandidateLocation): Promise<ProbedRead | null> {
  const read = await probePageCandidatesWithSubmitters(page, openReadDeadline(), (candidates) =>
    candidates.flatMap((probed, index) => (hasPressableSubmitter(probed) ? [index] : [])));
  if (read.status !== 'READ') {
    return null;
  }
  const structures = new Map<number, string>();
  if (read.chosen.length > 0) {
    const outcome = await readElementsInIsolatedWorld(page, readStructureHintsInPage, STRUCTURE_HINT_INPUT, openReadDeadline(),
      { argumentElements: read.chosen.map(({ element }) => element.backendNodeId) });
    const hints: unknown = outcome.status === 'READ' ? outcome.value : null;
    if (Array.isArray(hints) && hints.length === read.chosen.length) {
      read.chosen.forEach(({ candidateIndex }, at) => {
        const hint: unknown = hints[at];
        if (Array.isArray(hint)) structures.set(candidateIndex, JSON.stringify(hint));
      });
    }
  }
  return probedReadOf(location, read, structures);
}

/**
 * RB-13: 読み直しの結果と構造の手がかり（送信の要素ごと）から、見分けの鍵を付けた読み直しを作る（純粋。本物の口の `readProbed` と、偽の口が使う）。
 */
export const probedReadOf = (location: CandidateLocation, read: ProbedRead['outcome'], structures: ReadonlyMap<number, string>): ProbedRead => ({
  outcome: read,
  candidates: read.candidates,
  nodeIds: new Map(read.chosen.map(({ candidateIndex, element }) => [candidateIndex, element.backendNodeId] as const)),
  keys: rereadKeysOf(location, read.candidates, structures),
});

/** COV-2: 読み直しの候補ごとの、見分けの鍵と押す組の digest と、それぞれの中の順番（文書の順）。 */
export interface RereadKeys {
  readonly match: readonly string[];
  readonly matchOrdinal: readonly number[];
  readonly press: readonly string[];
  readonly pressOrdinal: readonly number[];
}

const ordinalsOf = (keys: readonly string[]): number[] => {
  const seen = new Map<string, number>();
  return keys.map((key) => {
    const ordinal = seen.get(key) ?? 0;
    seen.set(key, ordinal + 1);
    return ordinal;
  });
};

const rereadKeysOf = (location: CandidateLocation, candidates: readonly ProbedCandidate[], structures: ReadonlyMap<number, string>): RereadKeys => {
  const match = candidates.map((probed, index) => matchKeyOf(location, probed, structures.get(index) ?? null));
  const press = candidates.map((probed, index) => pressDigestOf(location, probed, structures.get(index) ?? null));
  return { match, matchOrdinal: ordinalsOf(match), press, pressOrdinal: ordinalsOf(press) };
};

/**
 * 欄の読み取りの入力（ページの中の関数は外を参照できないので、値はすべてここで渡す）。LU-SFIX2-A fix round 1: 送信ボタンは位置で引き直さず、押す直前の
 * 読み直しで確かめた要素そのもの（読み取りの 2 つ目の引数の 1 つ目）を受ける。form は、その送信ボタンの持ち主の form。
 */
interface ScopeReadInput {
  readonly kind: ProbedCandidate['kind'];
  readonly visibilityOptions: CheckVisibilityOptions;
  readonly fieldSelector: string;
  readonly fieldTypes: readonly string[];
  readonly fillTypes: readonly string[];
  readonly selectTypes: readonly string[];
}

/** 欄の読み取りで、入れるか選ぶ欄の事実（値は持たない）。 */
interface ScopeField {
  readonly type: CandidateFieldType;
  /** select の、空でない最初の選択肢の位置（ほかの欄は null）。 */
  readonly optionIndex: number | null;
  /** COV-1: 選ぶ radio（組ごとに最初の選択肢）。 */
  readonly check?: true;
  /** T38a: CSS の組み立てに使う属性（要素の名前、`id`・`name`・`type` の属性。値は読まない。ないときは空文字列）。 */
  readonly facts: EntryElementFacts;
}

/** 欄の要素の名前。 */
const FIELD_SELECTOR = 'input, textarea, select';

/**
 * 候補の範囲の欄を読む（ページの中で動く。標準の getter とメソッドで読み、ページに何も書かない）。要素の参照は、送信ボタン、入れるか選ぶ欄の順。
 * 値は `{ fields, skipped }`（送信ボタンか form が見つからなければ null）。
 */
const readProbeScopeInPage = composeInPage((R: StandardReaders, input: ScopeReadInput, given?: readonly Element[]): InPageElementsResult => {
  const getterOf = R.standardGetter;
  const localNameOf = getterOf<string>(Element.prototype, 'localName');
  const inputTypeOf = getterOf<string>(HTMLInputElement.prototype, 'type');
  const selectTypeOf = getterOf<string>(HTMLSelectElement.prototype, 'type');
  const inputFormOf = getterOf<unknown>(HTMLInputElement.prototype, 'form');
  const textAreaFormOf = getterOf<unknown>(HTMLTextAreaElement.prototype, 'form');
  const selectFormOf = getterOf<unknown>(HTMLSelectElement.prototype, 'form');
  const inputReadOnlyOf = getterOf<boolean>(HTMLInputElement.prototype, 'readOnly');
  const textAreaReadOnlyOf = getterOf<boolean>(HTMLTextAreaElement.prototype, 'readOnly');
  const formElementsOf = getterOf<unknown>(HTMLFormElement.prototype, 'elements');
  const collectionLengthOf = getterOf<number>(HTMLCollection.prototype, 'length');
  const nodeListLengthOf = getterOf<number>(NodeList.prototype, 'length');
  const selectOptionsOf = getterOf<unknown>(HTMLSelectElement.prototype, 'options');
  const optionValueOf = getterOf<string>(HTMLOptionElement.prototype, 'value');
  const optionDisabledOf = getterOf<boolean>(HTMLOptionElement.prototype, 'disabled');
  const submitter = given?.[0] ?? null;
  // DEF-142: 見えない送信ボタンは押さない（押す前に見えない対象は `TARGET_NOT_FOUND`。押す回数を使わない）。LU-SFIX2-A: 文書から外れた要素も押さない。
  if (!(submitter instanceof Element) || !getterOf<boolean>(Node.prototype, 'isConnected')(submitter)
    || !Element.prototype.checkVisibility.call(submitter, input.visibilityOptions)) {
    return { value: null, elements: [] };
  }
  // LU-SFIX2-A: 送信ボタンの持ち主の form（probe が FORM の候補を組んだのと同じ決まり。位置で引き直さない）。
  const submitterName = localNameOf(submitter);
  const ownerOf: unknown = submitterName === 'button'
    ? getterOf<unknown>(HTMLButtonElement.prototype, 'form')(submitter)
    : (submitterName === 'input' ? inputFormOf(submitter) : null);
  const submitterForm = ownerOf instanceof Element ? ownerOf : null;
  // DEF-144: 押すと移りうる先（送信ボタンと祖先の `<a>`・`<area>` の `href`、送信ボタンの `formaction`、form の `action`）。属性の書かれたままの値を読む
  // （外部スキームかの判定は Node の側。URL-LEN: 長さでは切り詰めない。L13 fix round 1: 数でも止めず、全部読む。前は 16 個（`MAX_SUBMISSION_PROBE_NAVIGATION_TARGETS`）
  // までで、17 個目からの先は確かめずに押していた）。
  const parentOf = getterOf<Element | null>(Node.prototype, 'parentElement');
  const targets: string[] = [];
  const pushTarget = (element: Element | null, attribute: string): void => {
    if (element === null) return;
    const value: unknown = Element.prototype.getAttribute.call(element, attribute);
    if (typeof value === 'string') targets.push(value);
  };
  for (let node: Element | null = submitter; node !== null; node = parentOf(node)) {
    const name = localNameOf(node);
    if (name === 'a' || name === 'area') pushTarget(node, 'href');
  }
  pushTarget(submitter, 'formaction');
  const ownerForm = input.kind === 'FORM' ? submitterForm : Element.prototype.closest.call(submitter, 'form');
  pushTarget(ownerForm, 'action');
  // L13（N28）: 欄の数で読むのをやめない（前は `MAX_CANDIDATE_FIELDS` 個目の後を触らなかった欄に数えた）。
  const controls: Element[] = [];
  const push = (element: Element | null): void => {
    if (element === null) return;
    const name = localNameOf(element);
    if (name !== 'input' && name !== 'textarea' && name !== 'select') return;
    controls.push(element);
  };
  if (input.kind === 'FORM') {
    const form = submitterForm;
    if (form === null || localNameOf(form) !== 'form') {
      return { value: null, elements: [] };
    }
    const collection = formElementsOf(form);
    const length = collectionLengthOf(collection);
    for (let index = 0; index < length; index += 1) {
      push(HTMLCollection.prototype.item.call(collection as HTMLCollection, index));
    }
  } else {
    const all = Document.prototype.querySelectorAll.call(document, input.fieldSelector);
    const length = nodeListLengthOf(all);
    for (let index = 0; index < length; index += 1) {
      const element = NodeList.prototype.item.call(all, index) as Element | null;
      if (element === null) continue;
      const name = localNameOf(element);
      const owner = name === 'input' ? inputFormOf(element) : (name === 'textarea' ? textAreaFormOf(element) : selectFormOf(element));
      if (owner === null) push(element);
    }
  }
  const fields: {
    type: string; optionIndex: number | null; check?: true; group?: string; choiceTexts?: string[]; optionChoices?: { index: number; texts: string[] }[];
    facts: { tag: string; id: string; name: string; type: string };
  }[] = [];
  const elements: Element[] = [submitter];
  // REV-SD の I-4 (a): radio のラベルの文字。
  const labelTextsOf = (element: Element): string[] => {
    const labels = getterOf<NodeList | null>(HTMLInputElement.prototype, 'labels')(element);
    const texts: string[] = [];
    for (let index = 0; labels !== null && index < nodeListLengthOf(labels); index += 1) {
      const label = NodeList.prototype.item.call(labels, index);
      if (label instanceof HTMLElement) texts.push(getterOf<string>(HTMLElement.prototype, 'innerText')(label));
    }
    return texts;
  };
  const inputCheckedOf = getterOf<boolean>(HTMLInputElement.prototype, 'checked');
  /** COV-1: 選んだ radio の組の名前。 */
  const chosenRadioGroups: string[] = [];
  let skipped = 0;
  // T38a: CSS の組み立てに使う属性（値は読まない）。
  const attributeOf = (element: Element, attribute: string): string => {
    const value: unknown = Element.prototype.getAttribute.call(element, attribute);
    return typeof value === 'string' ? value : '';
  };
  const factsOf = (element: Element) => ({
    tag: localNameOf(element), id: attributeOf(element, 'id'), name: attributeOf(element, 'name'), type: attributeOf(element, 'type'),
  });
  for (const element of controls) {
    const name = localNameOf(element);
    const type = name === 'input' ? inputTypeOf(element) : (name === 'textarea' ? 'textarea' : selectTypeOf(element));
    if (name === 'input' && !input.fieldTypes.includes(type)) {
      // 送信ボタンなどの形（欄でない）は数えない。
      continue;
    }
    const visible = Element.prototype.checkVisibility.call(element, input.visibilityOptions);
    const disabled = Element.prototype.matches.call(element, ':disabled');
    const readOnly = name === 'input' ? inputReadOnlyOf(element) : (name === 'textarea' ? textAreaReadOnlyOf(element) : false);
    if (!visible || disabled || readOnly) {
      skipped += 1;
      continue;
    }
    // COV-1（DEF-238 の設計書 3.1 の 5）: radio は、名前の組ごとに、まだどれも選ばれていなければ、最初の見えて選べる選択肢を選ぶ（既にある値を選ぶ形。
    // 選択肢ごとに広げるのは COV-3）。組のほかの選択肢と、名前のない radio は、今までどおり触らない。
    // REV-SD の I-4 (a): 組の選べる選択肢を全部、値とラベルの文字つきで返す（どれを選ぶかは Node の側が、削除の語の選択肢を避けて決める）。
    if (name === 'input' && type === 'radio') {
      const group = attributeOf(element, 'name');
      const groupChecked = group !== '' && controls.some((other) => localNameOf(other) === 'input' && inputTypeOf(other) === 'radio'
        && attributeOf(other, 'name') === group && inputCheckedOf(other));
      if (group !== '' && !groupChecked) {
        if (!chosenRadioGroups.includes(group)) chosenRadioGroups.push(group);
        fields.push({ type, optionIndex: null, check: true, group, choiceTexts: [attributeOf(element, 'value'), ...labelTextsOf(element)], facts: factsOf(element) });
        elements.push(element);
      } else {
        skipped += 1;
      }
      continue;
    }
    if (input.fillTypes.includes(type)) {
      fields.push({ type, optionIndex: null, facts: factsOf(element) });
      elements.push(element);
    } else if (input.selectTypes.includes(type)) {
      const options = selectOptionsOf(element);
      const length = collectionLengthOf(options);
      // REV-SD の I-4 (a): 空でない選べる選択肢を全部、文字と値つきで返す（どれを選ぶかは Node の側が、削除の語の選択肢を避けて決める）。
      const optionChoices: { index: number; texts: string[] }[] = [];
      for (let index = 0; index < length; index += 1) {
        const option = HTMLCollection.prototype.item.call(options as HTMLCollection, index);
        if (option !== null && optionValueOf(option) !== '' && !optionDisabledOf(option)) {
          optionChoices.push({ index, texts: [optionValueOf(option), getterOf<string>(HTMLOptionElement.prototype, 'text')(option)] });
        }
      }
      if (optionChoices.length === 0) {
        skipped += 1;
        continue;
      }
      fields.push({ type, optionIndex: optionChoices[0]?.index ?? null, optionChoices, facts: factsOf(element) });
      elements.push(element);
    } else {
      skipped += 1;
    }
  }
  return { value: { fields, skipped, targets }, elements };
});

/**
 * DEF-208-4（A）: 枠の目印にする要素の名前と role、本文の印（その中のボタンは枠のボタンにしない）にする要素の名前と role。NO-2（ARIA の決まり）: 区分の中では
 * landmark にならない要素の名前と、その区分の selector（通知の枠の見分け方と同じ定義）。
 */
const LAYOUT_LANDMARK_INPUT: LayoutLandmarkCriteria = Object.freeze({
  layoutNames: Object.freeze(['nav', 'aside', 'header', 'footer']),
  layoutRoles: Object.freeze(['navigation', 'banner', 'complementary', 'contentinfo']),
  bodyNames: Object.freeze(['main', 'dialog', 'form']),
  bodyRoles: Object.freeze(['main', 'dialog', 'alertdialog']),
  scopedNames: SCOPED_LANDMARK_NAMES,
  sectioningScopeSelector: SECTIONING_SCOPE_SELECTOR,
});

/**
 * DEF-208-4（A）: 送信ボタンごとに、祖先の枠の目印（内から外の順。要素の名前と role の組）を読む（ページの中で動く。標準の getter とメソッドで読み、ページに
 * 何も書かない）。本文の印の中のボタン、目印のないボタン、文書から外れたボタンは空。SREV-1105-3 の再レビューの Minor-B: あわせて、送信ボタンの祖先の form
 * （`closest('form')`）の、文書の中の form の並びの位置を読む（ないか読めなければ -1）。
 */
const readLayoutLandmarksInPage = composeInPage((R: StandardReaders, input: LayoutLandmarkCriteria, given?: readonly Element[]): InPageElementsResult => {
  const isConnected = R.standardGetter<boolean>(Node.prototype, 'isConnected');
  const nodeListLengthOf = R.standardGetter<number>(NodeList.prototype, 'length');
  const forms = Document.prototype.querySelectorAll.call(document, 'form');
  const formCount = nodeListLengthOf(forms);
  const formIndexOf = (element: Element): number => {
    const owner = Element.prototype.closest.call(element, 'form');
    if (owner === null) return -1;
    for (let index = 0; index < formCount; index += 1) {
      if (NodeList.prototype.item.call(forms, index) === owner) return index;
    }
    return -1;
  };
  return {
    value: (given ?? []).map((element) => {
      if (!(element instanceof Element) || !isConnected(element)) return { landmarks: [], form: -1 };
      // CC-128・SLK-1: 祖先のたどり方と判定は部品（`R.layoutLandmarksOf`。枠の部分の事実の読み取りと共有する）。
      return { landmarks: R.layoutLandmarksOf(element, input).landmarks, form: formIndexOf(element) };
    }),
    elements: [],
  };
});

/**
 * DEF-208-4（A）・SREV-1105-3 の再レビューの Minor-B: 押す対象ごとの、共通の枠のボタンの識別の digest（読めない・枠のボタンでなければ、その対象は持たない）と、
 * 同じ語の組の決まりの範囲の鍵（祖先の form の位置か、form の外。読めなければ、その対象は持たない）。
 */
async function targetContextsOf(
  page: Page,
  targets: readonly PressTarget[],
  backendNodeIds: readonly (number | undefined)[],
): Promise<{ readonly digests: ReadonlyMap<number, string>; readonly scopes: ReadonlyMap<number, string> }> {
  const digests = new Map<number, string>();
  const scopes = new Map<number, string>();
  const empty = { digests, scopes };
  if (targets.length === 0 || backendNodeIds.length !== targets.length || backendNodeIds.some((id) => id === undefined)) {
    return empty;
  }
  const outcome = await readElementsInIsolatedWorld(page, readLayoutLandmarksInPage, LAYOUT_LANDMARK_INPUT,
    openReadDeadline(), { argumentElements: backendNodeIds as readonly number[] });
  const lists: unknown = outcome.status === 'READ' ? outcome.value : null;
  if (!Array.isArray(lists) || lists.length !== targets.length) {
    return empty;
  }
  for (const [at, target] of targets.entries()) {
    const read: unknown = lists[at];
    if (!isRecord(read)) continue;
    const { landmarks, form } = read;
    if (Number.isSafeInteger(form)) scopes.set(target.index, form === -1 ? OUTSIDE_FORM_SCOPE : `form-${String(form)}`);
    if (!Array.isArray(landmarks) || landmarks.some((value) => typeof value !== 'string')) continue;
    const digest = sharedLayoutIdentityDigestOf({
      kind: target.kind, submitterWords: target.submitterWords, hasSubmitterText: target.hasSubmitterText, landmarks: landmarks as string[],
    });
    if (digest !== null) digests.set(target.index, digest);
  }
  return empty;
}

/** SREV-1105-3 の Minor-1: form の外のボタンの範囲の鍵。 */
const OUTSIDE_FORM_SCOPE = 'OUTSIDE_FORM';

/** T44c: 送信ボタンが見えるかの読み取りの入力（見え方の確かめの指定。LU-SFIX2-A fix round 1: 送信ボタンは、読み直しで確かめた要素そのものを受ける）。 */
interface SubmitterVisibilityInput {
  readonly visibilityOptions: CheckVisibilityOptions;
}

/**
 * T44c（Task 44 の設計書 P1-3）: 送信ボタンごとに、見えるか（`readProbeScopeInPage` と同じ確かめ。文書から外れていれば偽）を読む（ページの中で動く。
 * 標準のメソッドで読み、ページに何も書かない）。押す数を数える前に、見えない候補を除くために使う。LU-SFIX2-A fix round 1: 位置で引き直さず、読み直しの
 * 読み取りで確かめた要素そのもの（番号で渡す）を読む。
 */
const readSubmitterVisibilityInPage = composeInPage((R: StandardReaders, input: SubmitterVisibilityInput, given?: readonly Element[]): InPageElementsResult => {
  const isConnected = R.standardGetter<boolean>(Node.prototype, 'isConnected');
  return {
    value: (given ?? []).map((element) => element instanceof Element && isConnected(element)
      && Element.prototype.checkVisibility.call(element, input.visibilityOptions)),
    elements: [],
  };
});

/**
 * L6/L3-1 の続き（設計者の判断 A の案 A1）: 送信ボタンの矩形（viewport の座標）と、表示の範囲の大きさを読む（ページの中で動く。標準のメソッドで読み、ページに
 * 何も書かない。スクロールもしない）。読めなければ null。
 */
const readSubmitterRectInPage = composeInPage((R: StandardReaders, _input: null, given?: readonly Element[]): InPageElementsResult => {
  const isConnected = R.standardGetter<boolean>(Node.prototype, 'isConnected');
  const target = given?.[0];
  if (!(target instanceof Element) || !isConnected(target)) return { value: null, elements: [] };
  const rect = Element.prototype.getBoundingClientRect.call(target);
  return { value: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: window.innerWidth, height: window.innerHeight }, elements: [] };
});

/** L6/L3-1 の続き（A1）: 点ごとの最前面の要素の読み取りの入力（viewport の座標）。 */
interface SubmitterHitPointsInput {
  readonly points: readonly (readonly [number, number])[];
}

/**
 * L6/L3-1 の続き（A1）: 点ごとに、最前面の要素（`elementFromPoint`）と送信ボタンとの関係を読む（ページの中で動く。読むだけ）。値は関係の並び（点の順）。
 */
const readSubmitterHitPointsInPage = composeInPage((R: StandardReaders, input: SubmitterHitPointsInput, given?: readonly Element[]): InPageElementsResult => {
  const isConnected = R.standardGetter<boolean>(Node.prototype, 'isConnected');
  const target = given?.[0];
  if (!(target instanceof Element) || !isConnected(target)) return { value: null, elements: [] };
  return {
    value: input.points.map(([x, y]) => {
      const top: unknown = Document.prototype.elementFromPoint.call(document, x, y);
      return !(top instanceof Element) ? 'NONE' : top === target ? 'TARGET' : Node.prototype.contains.call(target, top) ? 'DESCENDANT' : 'OTHER';
    }),
    elements: [],
  };
});

/** L6/L3-1 の続き（A1）: 押す前の hit-test の結果。届く点が中心でなければ、押す位置（送信ボタンの矩形の左上からの px）。 */
type SubmitterHit =
  | { readonly kind: 'REACHABLE'; readonly position: { readonly x: number; readonly y: number } | undefined }
  | { readonly kind: 'COVERED' }
  | { readonly kind: 'UNKNOWN' };

const HIT_RELATIONS: readonly SubmitterHitTopRelation[] = Object.freeze(['TARGET', 'DESCENDANT', 'OTHER', 'NONE']);

/** SD-1: 押す要素の、操作の前の判定の事実（ページの中の部品 `destructiveActionFactsOf`。つながっていなければ null）。 */
const readDestructiveFactsInPage = composeInPage((R: StandardReaders, _input: null, given?: readonly Element[]): InPageElementsResult => {
  const isConnected = R.standardGetter<boolean>(Node.prototype, 'isConnected');
  const target = given?.[0];
  if (!(target instanceof Element) || !isConnected(target)) return { value: null, elements: [] };
  return { value: R.destructiveActionFactsOf(target), elements: [] };
});

/**
 * SD-1（設計書 `2026-11-16-beaksight-action-based-delete-guard-design.md` 2.3）: 押す要素が削除に関する操作か（操作の前の判定 `isDestructiveAction`）。事実を読めなければ
 * `UNREADABLE`（呼ぶ側は押さない）。
 */
async function destructivePressJudgementOf(page: Page, submitterId: number): Promise<'SAFE' | 'DESTRUCTIVE' | 'UNREADABLE'> {
  const read = await readElementsInIsolatedWorld(page, readDestructiveFactsInPage, null, openReadDeadline(), { argumentElements: [submitterId] });
  const facts = read.status === 'READ' ? destructiveActionFactsFrom(read.value) : null;
  if (facts === null) return 'UNREADABLE';
  return isDestructiveAction(facts) ? 'DESTRUCTIVE' : 'SAFE';
}

/**
 * L6/L3-1 の続き（A1）: 押す前の hit-test（2 回の読み取り:矩形と、点ごとの最前面。点と判定は契約の `submitterHitPointsOf`・`submitterHitJudgementOf`）。読めなければ
 * `UNKNOWN`（押す。押す 1 手が返らなければ 1 画面の見張りが終える）。
 */
async function submitterHitOf(page: Page, submitterId: number): Promise<SubmitterHit> {
  const rectRead = await readElementsInIsolatedWorld(page, readSubmitterRectInPage, null, openReadDeadline(), { argumentElements: [submitterId] });
  const rect: unknown = rectRead.status === 'READ' ? rectRead.value : null;
  const numberOf = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
  if (!isRecord(rect)) return { kind: 'UNKNOWN' };
  const [left, top, right, bottom, width, height] = ['left', 'top', 'right', 'bottom', 'width', 'height'].map((key) => numberOf(rect[key]));
  if (left == null || top == null || right == null || bottom == null || width == null || height == null) return { kind: 'UNKNOWN' };
  const points = submitterHitPointsOf({ left, top, right, bottom }, { width, height });
  if (points.length === 0) return { kind: 'UNKNOWN' };
  const pointsRead = await readElementsInIsolatedWorld(page, readSubmitterHitPointsInPage, { points: points.map(([x, y]) => [x, y] as const) } satisfies SubmitterHitPointsInput,
    openReadDeadline(), { argumentElements: [submitterId] });
  const relations: unknown = pointsRead.status === 'READ' ? pointsRead.value : null;
  if (!Array.isArray(relations) || relations.length !== points.length
    || !relations.every((relation): relation is SubmitterHitTopRelation => HIT_RELATIONS.includes(relation as SubmitterHitTopRelation))) {
    return { kind: 'UNKNOWN' };
  }
  const judged = submitterHitJudgementOf(points.map(([x, y], at) => [x, y, relations[at] as SubmitterHitTopRelation] as const));
  if (judged.kind !== 'REACHABLE') return judged;
  // 中心で届くなら、今までどおり位置を渡さない（Playwright の既定は中心）。四隅で届くなら、その点を押す（矩形の左上からの位置）。
  const [centre] = points;
  const [x, y] = judged.point;
  return { kind: 'REACHABLE', position: centre !== undefined && centre[0] === x && centre[1] === y ? undefined : { x: x - left, y: y - top } };
}

/**
 * T44c: 押す対象のうち、今の画面で送信ボタンが見えるものと見えないものに分ける（1 回の読み取り）。読めなければ、すべてを見えるものに入れる（押す部品が、
 * 押す前に 1 つずつ確かめる。今までの振る舞い）。
 */
async function splitByVisibility(
  page: Page,
  targets: readonly PressTarget[],
  backendNodeIds: readonly number[],
): Promise<{ readonly visible: readonly PressTarget[]; readonly invisible: readonly PressTarget[] }> {
  if (targets.length === 0 || backendNodeIds.length !== targets.length) {
    return { visible: targets, invisible: [] };
  }
  const outcome = await readElementsInIsolatedWorld(page, readSubmitterVisibilityInPage, {
    visibilityOptions: VISIBILITY_CHECK_OPTIONS,
  } satisfies SubmitterVisibilityInput, openReadDeadline(), { argumentElements: backendNodeIds });
  const flags: unknown = outcome.status === 'READ' ? outcome.value : null;
  if (!Array.isArray(flags) || flags.length !== targets.length || flags.some((flag) => typeof flag !== 'boolean')) {
    return { visible: targets, invisible: [] };
  }
  return {
    visible: targets.filter((_target, index) => flags[index] === true),
    invisible: targets.filter((_target, index) => flags[index] !== true),
  };
}

// L13 fix round 1: 押す前に読む、移りうる先の数の上限（前は `MAX_SUBMISSION_PROBE_NAVIGATION_TARGETS` の 16。ファイルの中だけの値）は撤廃した。

/** 欄の読み取りの入力の決まった部分。 */
const SCOPE_READ_BASE = Object.freeze({
  visibilityOptions: VISIBILITY_CHECK_OPTIONS,
  fieldSelector: FIELD_SELECTOR,
  fieldTypes: CANDIDATE_FIELD_TYPES,
  fillTypes: SUBMISSION_PROBE_FILL_FIELD_TYPES,
  selectTypes: SELECT_FIELD_TYPES,
});

/**
 * DEF-144: 移りうる先が外部スキームを指すか。DEF-210（通知の枠の設計書 3.2.1 の 5）: 通知の枠の閉じるボタンの見分けも使うので、Guard の外部スキームの判定の隣
 * （`src/safety/passive-request-guard.ts`）へ移した。ここでは公開し直す（今の呼び出しとテストの import のまま）。
 */
export { pointsToExternalScheme };

/**
 * 読んだ範囲（送信ボタンと欄の要素の参照、入れるか選ぶ欄、触らなかった欄の数）。読めなければ null。T38a: 欄ごとの、その画面で一意な CSS
 * （`selectors`。欄の順。作れなければ null）。
 */
interface ReadScope {
  readonly backendNodeIds: readonly number[];
  readonly paths: readonly (readonly number[])[];
  readonly fields: readonly ScopeField[];
  readonly selectors: readonly (string | null)[];
  readonly skipped: number;
  /** DEF-144: 押すと移りうる先（属性の書かれたままの値。`pointsToExternalScheme` で判定する）。 */
  readonly targets: readonly string[];
  /** REV-SD の I-4 (a): 選べる選択肢が削除の語のものだけの select か radio の組がある（押さない）。 */
  readonly destructiveChoiceOnly: boolean;
}

/** 文字の並び（形が違う値は除く）。 */
const stringsOf = (value: unknown): readonly string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []);

const isCandidateFieldType = (value: unknown): value is CandidateFieldType =>
  typeof value === 'string' && (CANDIDATE_FIELD_TYPES as readonly string[]).includes(value);

/** 属性の事実の形（文字列の 4 つ）。 */
const elementFactsOf = (value: unknown): EntryElementFacts | null =>
  isRecord(value) && typeof value['tag'] === 'string' && typeof value['id'] === 'string' && typeof value['name'] === 'string'
    && typeof value['type'] === 'string'
    ? { tag: value['tag'], id: value['id'], name: value['name'], type: value['type'] }
    : null;

/**
 * T38a: 欄ごとの、その画面でちょうど 1 つの欄に当たる CSS（T43c の組み立て `entrySelectorCandidatesOf` の候補を、isolated world で数えた結果
 * `uniqueEntrySelectorOf`。長すぎる CSS は使わない）。読めなければ、どの欄も null（欄の識別は `name` に任せる）。
 */
async function uniqueSelectorsOf(
  page: Page,
  fields: readonly ScopeField[],
  paths: readonly (readonly number[])[],
): Promise<readonly (string | null)[]> {
  const plans = fields.map((field, index) => ({
    path: paths[index + 1] ?? null,
    selectors: entrySelectorCandidatesOf(field.facts),
  }));
  if (plans.every(({ selectors }) => selectors.length === 0)) {
    return fields.map(() => null);
  }
  const outcome = await readInIsolatedWorld(page, countSelectorsInPage, { checks: plans }, openReadDeadline());
  const counts = outcome.status === 'READ' ? countReadingOf(outcome.value, plans.map(({ selectors }) => selectors.length)) : null;
  return plans.map(({ selectors }, index) => (counts === null
    ? null
    : uniqueEntrySelectorOf(selectors.map((selector, at) => ({
      selector,
      matches: counts[index]?.[at]?.matches ?? 0,
      matchesElement: counts[index]?.[at]?.matchesElement ?? false,
    })))));
}

/**
 * LU-SFIX2-A fix round 1（LU-SREV2 の Critical-1 と同じ形）: 押す直前に画面を 1 回読み直し（`probePageCandidatesWithSubmitters`。発見の probe と同じ読み方）、
 * 対象と同じ識別の digest の、同じ順番の候補の送信ボタンの番号を、同じ読み取りの要素そのものから受ける（位置で引き直さない）。なければ null。
 */
async function confirmedSubmitterIdOf(page: Page, location: CandidateLocation, target: PressTarget): Promise<number | null> {
  // COV-2b: 同じ要素（読み直しで受けた送信の要素の番号）があれば、それを使う。なければ、見分けの鍵（識別の digest と構造の手がかり）と、その中の順番で探す。
  const read = await readProbed(page, location);
  if (read === null) {
    return null;
  }
  if (target.nodeId !== undefined && [...read.nodeIds.values()].includes(target.nodeId)) {
    return target.nodeId;
  }
  // 要素がなくなった（画面が描き直した）ときは、同じ鍵と順番の要素を探す（鍵の違う要素は同じ候補にしない）。
  const at = read.keys.match.findIndex((key, index) => key === target.matchKey && read.keys.matchOrdinal[index] === target.ordinal);
  return at < 0 ? null : read.nodeIds.get(at) ?? null;
}

/** 候補の範囲の欄を読む（形が違う・位置のない要素があれば null）。LU-SFIX2-A fix round 1: 送信ボタンは、押す直前の読み直しで確かめた要素そのもの。 */
async function readScope(page: Page, location: CandidateLocation, target: PressTarget): Promise<ReadScope | null> {
  const submitterId = await confirmedSubmitterIdOf(page, location, target);
  if (submitterId === null) {
    return null;
  }
  const outcome = await readElementsInIsolatedWorld(page, readProbeScopeInPage, {
    ...SCOPE_READ_BASE,
    kind: target.kind,
  }, openReadDeadline(), { argumentElements: [submitterId] });
  if (outcome.status !== 'READ' || !isRecord(outcome.value) || !Array.isArray(outcome.value['fields'])) {
    return null;
  }
  const skipped = outcome.value['skipped'];
  const targets: unknown = outcome.value['targets'];
  if (!Array.isArray(targets) || targets.some((value) => typeof value !== 'string')) {
    return null;
  }
  const fields: ScopeField[] = [];
  const rawFields = outcome.value['fields'] as readonly unknown[];
  /** REV-SD の I-4 (a): 読んだ欄ごとに、入れる欄に残すか（選ばない radio と選択肢が削除の語だけの select は残さない）。 */
  const kept: boolean[] = [];
  /** REV-SD の I-4 (a): 選べる選択肢が削除の語のものだけの select か radio の組がある（その form は押さない）。 */
  let destructiveChoiceOnly = false;
  const chosenGroups = new Set<string>();
  const seenGroups = new Set<string>();
  for (const raw of rawFields) {
    const facts = isRecord(raw) ? elementFactsOf(raw['facts']) : null;
    if (!isRecord(raw) || !isCandidateFieldType(raw['type']) || !(raw['optionIndex'] === null || Number.isSafeInteger(raw['optionIndex']))
      || facts === null) {
      return null;
    }
    let optionIndex = raw['optionIndex'] as number | null;
    const group = raw['group'];
    if (raw['check'] === true && typeof group === 'string') {
      // 組ごとに、削除の語のない最初の選択肢を選ぶ（ほかは触らなかった欄に数える）。
      seenGroups.add(group);
      if (chosenGroups.has(group) || textsHaveDestructiveActionWord(stringsOf(raw['choiceTexts']))) {
        kept.push(false);
        continue;
      }
      chosenGroups.add(group);
    } else if (Array.isArray(raw['optionChoices'])) {
      // 削除の語のない最初の選択肢を選ぶ。なければ、その form を押さない。
      const choices = (raw['optionChoices'] as readonly unknown[]).flatMap((choice) => (isRecord(choice) && Number.isSafeInteger(choice['index'])
        ? [{ index: choice['index'] as number, texts: stringsOf(choice['texts']) }] : []));
      const safe = choices.find(({ texts }) => !textsHaveDestructiveActionWord(texts));
      if (safe === undefined) {
        destructiveChoiceOnly = true;
        kept.push(false);
        continue;
      }
      optionIndex = safe.index;
    }
    kept.push(true);
    fields.push({ type: raw['type'], optionIndex, ...(raw['check'] === true ? { check: true } : {}), facts });
  }
  if ([...seenGroups].some((group) => !chosenGroups.has(group))) destructiveChoiceOnly = true;
  const keptElements = outcome.elements.filter((_element, at) => at === 0 || kept[at - 1] === true);
  const paths = keptElements.map(({ path }) => path);
  if (typeof skipped !== 'number' || !Number.isSafeInteger(skipped) || skipped < 0 || outcome.elements.length !== rawFields.length + 1
    || paths.some((path) => path === null) || outcome.elements[0]?.backendNodeId !== submitterId) {
    return null;
  }
  const knownPaths = paths as readonly (readonly number[])[];
  return {
    backendNodeIds: keptElements.map(({ backendNodeId }) => backendNodeId),
    paths: knownPaths,
    fields,
    selectors: await uniqueSelectorsOf(page, fields, knownPaths),
    skipped: skipped + kept.filter((keep) => !keep).length,
    targets: targets as readonly string[],
    destructiveChoiceOnly,
  };
}

/**
 * Guard が凍結の段にあるか（Guard の段階を読む口 `passiveRequestGuardStageOf` で、段階が `FROZEN_ACTIVE` かを直接確かめる。T37R-fix-A の M-4）。
 * 凍結の段でない（閉じる途中・無効化を含む）、Guard がない、page が閉じた、読めないときは偽（押さない）。
 */
async function interactionFreezeHolds(page: Page): Promise<boolean> {
  // T37R-fix-A（M-4）: 例外に頼らず、Guard の段階を読む口（読み取りだけ）で `FROZEN_ACTIVE` を直接確かめる。口がない・読めないときは押さない（fail-closed）。
  try {
    return !page.isClosed() && passiveRequestGuardStageOf(page) === 'FROZEN_ACTIVE';
  } catch {
    return false;
  }
}

/**
 * 押す前の読み直しで、記録の対象の候補を探す（同じ識別の digest の、同じ順番の候補）。見つからない・送信ボタンがない・位置が shadow root の中の対象は
 * `missing` に入れる。
 */
function pressTargetsOf(
  record: DiscoveryReadPageRecord,
  indices: readonly number[],
  read: ProbedRead,
  bindings: RecordBindings,
): { readonly found: readonly PressTarget[]; readonly rereadIndexes: readonly number[]; readonly missing: readonly number[] } {
  // COV-2b: 記録の候補と読み直しの候補を、同じ文書の中では同じ要素（送信の要素の番号）で結ぶ。要素がなくなった候補は見つからない（別の要素を同じ候補にしない）。
  // 番号の分からない候補は、見分けの鍵（識別の digest と構造の手がかり）と、その中の順番で結ぶ（記録の側の順番は、同じ鍵の記録の候補の位置の順）。
  const { keys } = read;
  const found: PressTarget[] = [];
  const rereadIndexes: number[] = [];
  const missing: number[] = [];
  for (const index of indices) {
    const digest = record.candidates[index]?.identityDigest;
    const node = bindings.nodes.get(index);
    let rereadIndex = -1;
    if (node !== undefined) {
      rereadIndex = read.candidates.findIndex((_probed, at) => read.nodeIds.get(at) === node);
    } else {
      const key = bindings.keys.get(index);
      let ordinal = 0;
      for (let earlier = 0; earlier < index; earlier += 1) {
        if (key !== undefined && bindings.keys.get(earlier) === key) ordinal += 1;
      }
      rereadIndex = key === undefined ? -1 : keys.match.findIndex((other, at) => other === key && keys.matchOrdinal[at] === ordinal);
    }
    const probed = rereadIndex < 0 ? undefined : read.candidates[rereadIndex];
    const target = probed === undefined || digest === undefined ? null : pressTargetOf(index, probed, digest, keys, rereadIndex, read.nodeIds.get(rereadIndex));
    if (target === null) {
      missing.push(index);
      continue;
    }
    if (target.nodeId !== undefined) bindings.nodes.set(index, target.nodeId);
    found.push(target);
    rereadIndexes.push(rereadIndex);
  }
  return { found, rereadIndexes, missing };
}

/**
 * COV-2b: 結んだ要素がなくなった記録の候補（画面が区画を描き直した）を、同じ見分けの鍵（識別の digest と構造の手がかり）の、まだ結んでいない要素に結び直す
 * （記録の候補の位置の順と、文書の順で組にする）。鍵の違う要素（段をまたいで別の区画に出たボタン）には結ばない。
 */
function rebindVanished(read: ProbedRead, bindings: RecordBindings): void {
  const present = new Set(read.nodeIds.values());
  const stillBound = new Set([...bindings.nodes.values()].filter((node) => present.has(node)));
  const unbound = new Map<string, number[]>();
  read.candidates.forEach((_probed, at) => {
    const node = read.nodeIds.get(at);
    const key = read.keys.match[at];
    if (node === undefined || key === undefined || stillBound.has(node)) return;
    unbound.set(key, [...(unbound.get(key) ?? []), node]);
  });
  for (const [index, node] of [...bindings.nodes].sort(([left], [right]) => left - right)) {
    const key = bindings.keys.get(index);
    const free = key === undefined ? undefined : unbound.get(key);
    if (present.has(node) || free === undefined) continue;
    const next = free.shift();
    if (next !== undefined) bindings.nodes.set(index, next);
  }
}

/** COV-2・COV-2b: 記録の候補の見分けの鍵と、同じ文書の中の送信の要素の番号（記録の候補の位置ごと）。 */
interface RecordBindings {
  readonly keys: Map<number, string>;
  readonly nodes: Map<number, number>;
}

/**
 * COV-2・COV-2b: 記録の候補のうち、要素の番号のない候補を、読み直しの候補に結ぶ（鍵と番号を付ける）。前の読み込みの鍵がなければ（発見の入口で読んだ同じ文書の
 * 最初の読み直し）、識別の digest と、その中の順番で結ぶ（今までの結び方）。鍵があれば、鍵と、その中の順番で結ぶ。
 */
function bindRecordCandidates(record: DiscoveryReadPageRecord, read: ProbedRead, bindings: RecordBindings, byIdentity: boolean, location: CandidateLocation): void {
  const rereadDigests = read.candidates.map((probed) => probedCandidateIdentityDigestOf(location, probed));
  const digestOrdinals = ordinalsOf(rereadDigests);
  const recordDigestOrdinals = ordinalsOf(record.candidates.map(({ identityDigest }) => identityDigest));
  const recordKeyOrdinals = ordinalsOf(record.candidates.map((_candidate, index) => bindings.keys.get(index) ?? `missing:${String(index)}`));
  record.candidates.forEach((candidate, index) => {
    if (bindings.nodes.has(index)) return;
    const key = bindings.keys.get(index);
    const at = byIdentity && key === undefined
      ? rereadDigests.findIndex((digest, rereadIndex) => digest === candidate.identityDigest && digestOrdinals[rereadIndex] === recordDigestOrdinals[index])
      : read.keys.match.findIndex((other, rereadIndex) => other === key && read.keys.matchOrdinal[rereadIndex] === recordKeyOrdinals[index]);
    const matchKey = at < 0 ? undefined : read.keys.match[at];
    if (matchKey === undefined) return;
    if (key === undefined) bindings.keys.set(index, matchKey);
    const node = read.nodeIds.get(at);
    if (node !== undefined) bindings.nodes.set(index, node);
  });
}

/** 1 回の押下の結果（URL が変わったかは呼ぶ側が見る）。 */
export type PressOutcome =
  | { readonly kind: 'OBSERVED'; readonly record: SubmissionProbeRecord }
  /** DEF-144: 押す前に、外部スキームを指すと見分けた（押していない。押す回数を使わない）。 */
  | { readonly kind: 'EXTERNAL_SCHEME' }
  | {
    readonly kind: 'NOT_OBSERVED';
    readonly reason: SubmissionProbeNotObservedReason;
    readonly fields: SubmissionProbeFieldCounts;
    readonly inputFields: readonly SubmissionProbeInputField[];
    /** SREV-1105-3 の Important-1: 欄に入れた後に押せなかった（入れる前は押せた。1 画面の上限 `MAX_SUBMISSION_PROBE_DISABLED_FILLS_PER_PAGE` に数える）。 */
    readonly filledWhileDisabled?: true;
    /**
     * COV-2c（SREV-COV の I-2）: 押す時点の確かめ（`pressWithPressTimeGuard`）が止めた（押していない）。記録は今のとおり `PRESS_FAILED` だが、押した組には
     * 入れない（ほかの理由の `PRESS_FAILED` は、押したかが分からないので押した組に入れる）。
     */
    readonly pressStopped?: true;
  };

/**
 * COV-2c fix round 3（SREV-COV 再レビューの C-1。設計者の判断の 1）: 開き手の語だけの対象（`isOpenerOnlySubmitter`）を、ほかの対象より先に並べる（それぞれの中の
 * 順は保つ）。開き手を、同じ文書で目印を入れる押下より先に押す（目印を一度も入れていない文書で押す）ため。
 */
const openersFirst = (targets: readonly PressTarget[]): PressTarget[] => [
  ...targets.filter((target) => isOpenerOnlySubmitter(target.submitterWords)),
  ...targets.filter((target) => !isOpenerOnlySubmitter(target.submitterWords)),
];

/** COV-2c fix round 2: 目印を入れた欄の、入れる前の値（欄の要素の番号ごと。同じ文書の中だけで使い、記録しない）。 */
export type FilledFieldOriginals = Map<number, string>;

/** COV-2c fix round 2: 目印の残る欄の読み取りの入力（この画面で入れた目印と、欄の selector）。 */
interface MarkedFieldsInput {
  readonly markers: readonly string[];
  readonly selector: string;
}

/**
 * COV-2c fix round 2: 文書の欄（input・textarea）のうち、値にこの画面の目印を含む欄を読む（ページの中で動く。標準の getter で読み、ページに何も書かない）。
 * 値は返さず、欄の要素だけを返す。
 */
const readMarkedFieldsInPage = composeInPage((R: StandardReaders, input: MarkedFieldsInput): InPageElementsResult => {
  const inputValueOf = R.standardGetter<string>(HTMLInputElement.prototype, 'value');
  const textAreaValueOf = R.standardGetter<string>(HTMLTextAreaElement.prototype, 'value');
  const nodeListLengthOf = R.standardGetter<number>(NodeList.prototype, 'length');
  const list = Document.prototype.querySelectorAll.call(document, input.selector);
  const length = nodeListLengthOf(list);
  const marked: Element[] = [];
  for (let index = 0; index < length; index += 1) {
    const element = NodeList.prototype.item.call(list, index);
    const value = element instanceof HTMLInputElement ? inputValueOf(element) : element instanceof HTMLTextAreaElement ? textAreaValueOf(element) : '';
    if (input.markers.some((marker) => String.prototype.includes.call(value, marker))) marked.push(element as Element);
  }
  return { value: marked.length, elements: marked };
});

/** COV-2c fix round 2: 目印の残る欄の selector（目印を入れる欄の型の要素）。 */
const MARKED_FIELD_SELECTOR = 'input, textarea';

/**
 * COV-2c fix round 2（設計者の判断の案 1 の 2）: 開き手を押す前に、この画面の前の押下で入れた目印が残る欄を、入れる前の値（`filledOriginals`。覚えていない欄は空）
 * に戻す。戻した後にもう一度読み、目印の残る欄がなければ真。読めない・戻せない・戻した後も残るときは偽（呼ぶ側は押さない）。目印をまだ入れていなければ、読まずに真。
 */
async function restoreFilledMarkers(page: Page, markers: readonly string[], filledOriginals: FilledFieldOriginals): Promise<boolean> {
  if (markers.length === 0) {
    return true;
  }
  const readMarked = (): ReturnType<typeof readElementsInIsolatedWorld> => readElementsInIsolatedWorld(page, readMarkedFieldsInPage,
    { markers: [...markers], selector: MARKED_FIELD_SELECTOR }, openReadDeadline());
  const marked = await readMarked();
  if (marked.status !== 'READ') {
    return false;
  }
  if (marked.elements.length > 0) {
    const ids = marked.elements.map(({ backendNodeId }) => backendNodeId);
    const restored = await withSignaledElements(page, ids, openReadDeadline(), async (signals) => {
      for (const [at, { backendNodeId, path }] of marked.elements.entries()) {
        const signal = signals[at];
        if (path === null || signal === undefined) {
          throw new Error('the marked field is not tracked');
        }
        await trackOnScreen(page, page.locator(elementPathSelectorOf(path, signal)).fill(filledOriginals.get(backendNodeId) ?? '', { timeout: NO_STEP_TIMEOUT }));
      }
      return true;
    });
    if (restored.status !== 'DONE') {
      return false;
    }
  }
  const after = await readMarked();
  return after.status === 'READ' && after.elements.length === 0;
}

/** T38a: 欄の `name`（ないか空、長すぎれば null）。 */
// L13（N30）: 長い名前も null にしない（前は `MAX_FIELD_NAME_LENGTH` を超えたら null）。
const fieldNameOf = (name: string): string | null => (name.length === 0 ? null : name);

/**
 * 1 つの対象に入れて押し、静まるのを待って、観察の結果を返す（ファイルの先頭の 3・4）。T38a: 目印は押下ごとに新しく作り、番号は押下ごとに 0 から振る
 * （型の digest が前の押下に左右されない）。`earlierMarkers` は、その画面の前の押下で使った目印（同じ値を使わないために渡す。この押下の目印を足す）。
 * 入れた欄の識別（`name`・一意な CSS・種類・目印の番号）を `inputFields` に記録する（値は記録しない）。
 */
async function pressOne(
  page: Page,
  observation: SubmissionObservation,
  location: CandidateLocation,
  pagePath: string,
  target: PressTarget,
  earlierMarkers: string[],
  /** L6/L3-1 の続き（T18）: 押した後の待ち（最短の観察の長さと、落ち着きの待ちに渡す要求の今の数。`waitAfterPress`）。 */
  afterPress: AfterPressWait,
  onPress: (() => void) | undefined,
  opener: SubmissionProbeOpener | undefined,
  disabledFillAllowed: boolean,
  filledOriginals: FilledFieldOriginals,
  /** COV-3: たどり直しで選んだ select の `name`（その選択肢のままにする。選び直さない）。 */
  keptSelects: ReadonlySet<string> = new Set(),
): Promise<PressOutcome> {
  const scope = await readScope(page, location, target);
  if (scope === null) {
    return { kind: 'NOT_OBSERVED', reason: 'TARGET_NOT_FOUND', fields: { filledFieldCount: 0, skippedFieldCount: 0 }, inputFields: [] };
  }
  // DEF-144: 押すと外部スキームへ移りうる対象は、押さない（欄にも入れない）。
  if (pointsToExternalScheme(scope.targets, page.mainFrame().url())) {
    return { kind: 'EXTERNAL_SCHEME' };
  }
  // REV-SD の I-4 (a): 選べる選択肢が削除の語のものだけの欄があれば、押さない（欄にも入れない。押す回数を使わない）。
  if (scope.destructiveChoiceOnly) {
    return {
      kind: 'NOT_OBSERVED', reason: DESTRUCTIVE_ACTION_SKIPPED_PROBE_REASON,
      fields: { filledFieldCount: 0, skippedFieldCount: scope.skipped + scope.fields.length }, inputFields: [],
    };
  }
  // L6/L3-1 の続き（設計者の判断 A の案 A1）: 送信ボタンが、ほかの表示（モーダルの窓など）に覆われていれば、押さない（欄にも入れない。押す回数を使わない）。
  // 押す 1 手は期限なしで待つので、押せるようになるのを待ち続けない。覆われていなくても押す 1 手が返らないときは、1 画面の見張りが終える。
  // 中心だけが覆われていれば、届く四隅の点を押す（`pressPosition`）。
  const hitSubmitterId = scope.backendNodeIds[0];
  const hit: SubmitterHit = hitSubmitterId === undefined ?{ kind: 'UNKNOWN' } : await submitterHitOf(page, hitSubmitterId);
  const pressPosition = hit.kind === 'REACHABLE' ? hit.position : undefined;
  if (hit.kind === 'COVERED') {
    return {
      kind: 'NOT_OBSERVED', reason: COVERED_BY_OTHER_PROBE_REASON, fields: { filledFieldCount: 0, skippedFieldCount: scope.skipped + scope.fields.length },
      inputFields: [],
    };
  }
  // COV-2c fix round 2（設計者の判断の案 1）: 開き手の語だけの対象（`isOpenerOnlySubmitter`。判定はこの 1 か所）は、次の画面や form を出すために押すので、欄に
  // 目印を入れない（欄は触らない）。開き手の移り先は凍結の外で読むので、前の押下で入れた目印が同じ文書の欄に残っていれば、元の値に戻してから押す（戻せなければ
  // 押さない。押していないので、押した組に入れない）。
  const opensRow = isOpenerOnlySubmitter(target.submitterWords);
  if (opensRow && !(await restoreFilledMarkers(page, earlierMarkers, filledOriginals))) {
    return {
      kind: 'NOT_OBSERVED', reason: 'PRESS_FAILED', fields: { filledFieldCount: 0, skippedFieldCount: scope.skipped + scope.fields.length },
      inputFields: [], pressStopped: true,
    };
  }
  /** 入れる操作（位置と、目印か選択肢の位置。COV-2c fix round 2: 欄の要素の番号）。 */
  const operations: {
    readonly path: readonly number[]; readonly marker: string | null; readonly optionIndex: number | null; readonly check?: true; readonly nodeId: number | undefined;
  }[] = [];
  /** この押下の目印（番号は 0 から）。 */
  const markers: string[] = [];
  const inputFields: SubmissionProbeInputField[] = [];
  let skipped = scope.skipped;
  for (const [index, field] of scope.fields.entries()) {
    // COV-2c fix round 2: 開き手の語だけの対象では、欄に入れない（触らなかった欄に数える）。
    if (opensRow) {
      skipped += 1;
      continue;
    }
    const nodeId = scope.backendNodeIds[index + 1];
    const path = scope.paths[index + 1] ?? [];
    const identity = { name: fieldNameOf(field.facts.name), selector: scope.selectors[index] ?? null, type: field.type };
    if (field.check === true) {
      // COV-1: radio を選ぶ（目印は入れない）。
      operations.push({ path, marker: null, optionIndex: null, check: true, nodeId });
      inputFields.push({ ...identity, marker: null });
    } else if (field.optionIndex !== null && keptSelects.has(field.facts.name)) {
      // COV-3: たどり直しで選んだ選択肢の段では、その select を選び直さない（触らなかった欄に数える）。
      skipped += 1;
    } else if (field.optionIndex !== null) {
      operations.push({ path, marker: null, optionIndex: field.optionIndex, nodeId });
      inputFields.push({ ...identity, marker: null });
    } else {
      // L13（N25）: 目印は数で打ち切らない（前は `MAX_API_SHAPE_MARKERS` 個目の後の欄を触らなかった欄に数えた）。
      const marker = submissionProbeMarkerOf(field.type, markers, undefined, earlierMarkers);
      inputFields.push({ ...identity, marker: markers.length });
      markers.push(marker);
      operations.push({ path, marker, optionIndex: null, nodeId });
    }
  }
  const fields: SubmissionProbeFieldCounts = { filledFieldCount: operations.length, skippedFieldCount: skipped };
  const notFilled: SubmissionProbeFieldCounts = { filledFieldCount: 0, skippedFieldCount: skipped + operations.length };
  earlierMarkers.push(...markers);
  const submitterPath = scope.paths[0] ?? [];
  observation.begin({ pagePath, markers: [...markers] });
  /** COV-2c（I-2）: 押す前の main frame の URL（押す時点の確かめの「止めた」が、文書が替わって読めなかっただけかを見分ける）。 */
  const urlBeforePress = page.mainFrame().url();
  let pressed = false;
  /** COV-2c（I-2）: 押す時点の確かめが止めた（押していない）。 */
  let pressStopped = false;
  /** DEF-208-2（D）: 送信ボタンが押せなかった（押していない。押す回数を使わず、静まるのも待たない）。入れる前からか、入れた後か。 */
  let disabled: 'BEFORE_FILL' | 'AFTER_FILL' | null = null;
  /** SD-1: 押す前の判定で、削除に関する操作だった（押していない）。 */
  let destructive = false;
  let result: SubmissionObservationResult;
  /**
   * L10 の調べの直し: 入れる・押す 1 手は、この文書を使える間だけ待つ（文書が誤りの画面に替わった・Safety の記録が使うのをやめると言ったら、待つのをやめる。
   * 期限は付けない）。返らない 1 手を見放すときは、押せなかった扱い（`PRESS_FAILED`）になり、候補の結果は呼ぶ側が記録から決める。
   */
  const onUsableDocument = <T>(step: PromiseLike<T>): Promise<T> => trackOnScreen(page, stepOnUsableDocument(page, step, afterPress.recordUnusable));
  try {
    const outcome = await withSignaledElements(page, scope.backendNodeIds, openReadDeadline(), async (signals) => {
      const locate = (path: readonly number[]) => {
        const position = scope.paths.findIndex((candidate) => candidate.length === path.length && candidate.every((step, at) => step === path[at]));
        const signal = signals[position];
        if (position < 0 || signal === undefined) {
          throw new Error('the probed element is not tracked');
        }
        return page.locator(elementPathSelectorOf(path, signal));
      };
      // SREV-1105-3 の Important-1・DEF-214（設計書 3.4「入れる値を入れた後に押せるようになるボタンは、入れた後に読む」）: 欄に入れる前に、送信ボタンが押せるかを
      // 読む。入れる前から押せないボタンも、押せなかった回の上限（`disabledFillAllowed`）が残っている間は欄に入れ、入れた後に読む（必須の欄を入れると押せるように
      // なる作り）。上限の後は、入れる前から押せないボタンには欄に入れない。欄がなければ、入れても変わらないので入れない。
      if (await onUsableDocument(locate(submitterPath).isDisabled({ timeout: NO_STEP_TIMEOUT })) && (!disabledFillAllowed || operations.length === 0)) {
        return 'DISABLED_BEFORE_FILL' as const;
      }
      // DEF-144・SREV-1105-3 の Important-2: これから入れて押しにかかる対象を知らせる（欄に入れる間の違反も、この候補に結びつける）。
      onPress?.();
      for (const operation of operations) {
        if (operation.marker !== null) {
          // COV-2c fix round 2: 目印を入れる前の値を覚える（開き手の前に戻すため。同じ欄では最初の値。読めない欄は空。メモリの中だけで、記録しない）。
          if (operation.nodeId !== undefined && !filledOriginals.has(operation.nodeId)) {
            filledOriginals.set(operation.nodeId, await onUsableDocument(locate(operation.path).inputValue({ timeout: NO_STEP_TIMEOUT })).catch(() => ''));
          }
          await onUsableDocument(locate(operation.path).fill(operation.marker, { timeout: NO_STEP_TIMEOUT }));
        } else if (operation.optionIndex !== null) {
          await onUsableDocument(locate(operation.path).selectOption({ index: operation.optionIndex }, { timeout: NO_STEP_TIMEOUT }));
        } else if (operation.check === true) {
          // COV-1: radio は押して選ぶ（入力の操作の閉じた一覧 `click`・`fill`・`selectOption` の中で行う。選ばれていない radio を押すと選ばれる）。
          await onUsableDocument(locate(operation.path).click({ timeout: NO_STEP_TIMEOUT, noWaitAfter: true }));
        }
      }
      // DEF-208-2（設計書 `2026-11-05-beaksight-discovery-coverage-design.md` 3.4）: 欄に入れた後に、送信ボタンが押せるかを読む（Playwright の押せるかの判定。
      // disabled と `aria-disabled="true"`）。押せなければ押さない（押せるようになるのを待たない）。
      if (await onUsableDocument(locate(submitterPath).isDisabled({ timeout: NO_STEP_TIMEOUT }))) {
        return 'DISABLED_AFTER_FILL' as const;
      }
      // FIX-237 fix round 1（SREV-237 の Minor-2）: 押す時点の確かめ（共通の部品 `pressWithPressTimeGuard`）を通して押す。事象が届いた時点で、押す要素が
      // 的でない・つながりと form owner が受け手を付けた時点と違えば、受け手が止める（押せなかった扱い。押す瞬間に別の form へ移す画面の形を記録しない）。
      // fix round 2（SREV-237 の Minor-A）: 文言・属性は比べない（押す瞬間に「保存しています」にする画面を、判定できないにしない。届けないので安全は同じ）。
      const submitterId = scope.backendNodeIds[0];
      if (submitterId === undefined) {
        throw new Error('the probed submitter is not tracked');
      }
      // SD-1（設計書 `2026-11-16-beaksight-action-based-delete-guard-design.md` 2.3）: 欄に入れた後（選んだ選択肢も見る）、押す前に、削除に関する操作かを判定する。
      // 削除に関する操作なら押さない。事実を読めなければ押さない（押す時点の確かめが止めたのと同じ扱い）。
      const judged = await destructivePressJudgementOf(page, submitterId);
      if (judged !== 'SAFE') {
        return judged === 'DESTRUCTIVE' ? 'DESTRUCTIVE' as const : 'STOPPED' as const;
      }
      const pressed = await pressWithPressTimeGuard(page, submitterId, openReadDeadline(), () => Promise.resolve(true), async () => {
        // L6/L3-1 の続き（A1）: 中心が覆われ四隅で届くときは、その点を押す（`position`。中心で届くときは今までどおり渡さない）。
        await onUsableDocument(locate(submitterPath).click({
          timeout: NO_STEP_TIMEOUT, noWaitAfter: true, ...(pressPosition === undefined ? {} : { position: pressPosition }),
        }));
      }, { comparedFacts: 'IDENTITY' });
      return pressed === 'PRESSED' ? 'PRESSED' as const : 'STOPPED' as const;
    });
    if (outcome.status === 'DONE' && outcome.value === 'DISABLED_BEFORE_FILL') disabled = 'BEFORE_FILL';
    if (outcome.status === 'DONE' && outcome.value === 'DISABLED_AFTER_FILL') disabled = 'AFTER_FILL';
    destructive = outcome.status === 'DONE' && outcome.value === 'DESTRUCTIVE';
    pressed = outcome.status === 'DONE' && outcome.value === 'PRESSED';
    // COV-2c（I-2）: 押す時点の確かめの「止めた」は、読めないときも止めた側に倒す（押した後に文書が替わると、受け手の印を読めない）。押した組に入れないのは、
    // 文書が替わらず（URL が同じで Guard も閉じていない）、受け手が止めたと読めたときだけ（文書が替わったなら、押下は画面に届いた）。
    // 押したかが分からないときも、遅れて出る要求を口が受けるように、静まるまで待ってから閉じる（押せずに押さなかったときは待たない）。
    // L6/L3-1 の続き（T18。設計者の判断 2026-11-10 の C）: 最短の観察の長さの後に、選んだ後と同じ落ち着きの待ち（`settleAfterAction`。口ごとのデータの静まり・
    // 作りの印・高さ）で待つ（`waitAfterPress`）。
    if (disabled === null && !destructive) {
      await waitAfterPress(page, afterPress);
    }
    // 文書の移動は押した直後には URL に出ないことがあるので、静まるのを待った後に見る。
    pressStopped = outcome.status === 'DONE' && outcome.value === 'STOPPED' && !guardClosedContext(page) && page.mainFrame().url() === urlBeforePress;
  } finally {
    // 例外の経路でも口を閉じる（次の押下と次の画面で口を使えるようにする）。
    result = observation.end();
  }
  if (disabled === 'BEFORE_FILL') {
    return { kind: 'NOT_OBSERVED', reason: DISABLED_SUBMITTER_PROBE_REASON, fields: notFilled, inputFields: [] };
  }
  if (disabled === 'AFTER_FILL') {
    return { kind: 'NOT_OBSERVED', reason: DISABLED_SUBMITTER_PROBE_REASON, fields, inputFields, filledWhileDisabled: true };
  }
  if (destructive) {
    return { kind: 'NOT_OBSERVED', reason: DESTRUCTIVE_ACTION_SKIPPED_PROBE_REASON, fields, inputFields };
  }
  return pressed
    // DEF-186: 押した候補の送信ボタンの語を渡す（開き手の語だけの候補の登録の形は、開き手の側の要求にする。判定は契約の 1 か所）。
    // LU-4: 開き手の後に押した対象は、開き手の事実を写す（分類に `openedFromRow` を渡す）。
    ? { kind: 'OBSERVED', record: observedSubmissionProbeOf(result, fields, inputFields, target.submitterWords, opener) }
    : { kind: 'NOT_OBSERVED', reason: 'PRESS_FAILED', fields, inputFields, ...(pressStopped ? { pressStopped: true as const } : {}) };
}

/**
 * COV-2（網羅の設計書 3.2 の 2）: 読み込み直した画面で、押さないまま残った対象のあった状態を作り直すため、押下の 1 つ（見分けの鍵と順番）をたどって押し直す
 * （押す部品 `pressOne` で押す。送信は凍結の Guard が届けない。記録は書かない）。押せて、文書が替わらなかったら真。見つからない・押せない・外部スキーム・
 * 文書が替わったら偽。
 */
async function replayStep(
  page: Page,
  observation: SubmissionObservation,
  location: CandidateLocation,
  step: SubmissionProbeReplayStep,
  markers: string[],
  /** L6/L3-1 の続き（T18）: 押した後の待ち（最短の観察の長さと、落ち着きの待ちに渡す要求の今の数。`waitAfterPress`）。 */
  afterPress: AfterPressWait,
  onPress: (() => void) | undefined,
  startDocument: number | null,
  filledOriginals: FilledFieldOriginals,
  keptSelects: ReadonlySet<string> = new Set(),
): Promise<ReplayedPress | null> {
  if (!(await interactionFreezeHolds(page))) {
    return null;
  }
  const startUrl = page.mainFrame().url();
  const read = await readProbed(page, location);
  if (read === null) {
    return null;
  }
  const at = read.keys.match.findIndex((key, index) => key === step.matchKey && read.keys.matchOrdinal[index] === step.ordinal);
  const probed = at < 0 ? undefined : read.candidates[at];
  const target = probed === undefined
    ? null
    : pressTargetOf(step.index, probed, probedCandidateIdentityDigestOf(location, probed), read.keys, at, read.nodeIds.get(at));
  if (target === null) {
    return null;
  }
  const outcome = await pressOne(page, observation, location, location.path, target, markers, afterPress, onPress, undefined, true, filledOriginals, keptSelects);
  // COV-2c（I-2）: 押す時点の確かめが止めた押下も、押していない（たどり直せない）。
  if (outcome.kind === 'EXTERNAL_SCHEME'
    || (outcome.kind === 'NOT_OBSERVED' && (outcome.reason === 'TARGET_NOT_FOUND' || outcome.reason === DISABLED_SUBMITTER_PROBE_REASON
      || outcome.reason === COVERED_BY_OTHER_PROBE_REASON || outcome.reason === DESTRUCTIVE_ACTION_SKIPPED_PROBE_REASON || outcome.pressStopped === true))) {
    return null;
  }
  const after = pageStateOf(page, startUrl);
  if (after === 'SAME') {
    return { target, after: 'SAME' };
  }
  return { target, after: after === 'CHANGED' && await sameDocumentMovedUrlOf(page, startDocument) !== null ? 'SAME_DOCUMENT' : 'MOVED' };
}

/** COV-2c: たどり直しで押した押下（押した対象と、押した後の様子。`MOVED` は文書が替わったか Guard が閉じた）。 */
export interface ReplayedPress {
  readonly target: PressTarget;
  readonly after: 'SAME' | 'SAME_DOCUMENT' | 'MOVED';
}

/** COV-2c（SREV-COV の I-4）: 押下の並びを押し直して作り直した移り先（URL と、値に目印を含む query の名前。値は記録しない）。 */
export interface SubmissionProbeReplayedMove {
  readonly url: string;
  readonly markerQueryNames: readonly string[];
  /** COV-2c fix round 5: 押し直しで入れた目印の値（メモリの中だけ）。 */
  readonly markerValues: readonly string[];
}

/**
 * COV-2c（SREV-COV の I-4。網羅の設計書 3.2 の 2 の「たどり方」）: 再開の後、押下から生まれた移り先（伏せた値で URL の分からない状態）を作り直すため、読み直した
 * 元の画面で、押下の並び（`SubmissionProbeMoveFacts` の `trail`）を押し直す（押す部品 `pressOne` で押す。凍結の Guard が送信を届けない。記録は書かない）。
 * 最後の押下で、同じ文書のまま変わった URL か、Guard が止めた GET の文書の移動の行き先を返す。押せない・途中で文書が替わった・移り先が出なければ `null`。
 * 例外を投げない。
 */
export async function replaySubmissionProbeMove(
  page: Page,
  observation: SubmissionObservation,
  record: DiscoveryReadPageRecord,
  trail: readonly SubmissionProbeReplayStep[],
  options: {
    readonly quietWaitMs?: number | undefined;
    readonly onPress?: ((candidateIndex: number) => void) | undefined;
    /** COV-3: 選び直した後の落ち着きの待ちに渡す、要求の今の数（`SubmissionProbeOptions` の `dataActivity` と同じ）。 */
    readonly dataActivity?: ChoiceDataActivity | undefined;
  } = {},
): Promise<SubmissionProbeReplayedMove | null> {
  const { location } = record;
  const last = trail[trail.length - 1];
  if (location === null || last === undefined) {
    return null;
  }
  try {
    if (observation.active || !(await interactionFreezeHolds(page))) {
      return null;
    }
    const startDocument = await documentMarkerOf(page);
    const startUrl = page.mainFrame().url();
    const markers: string[] = [];
    /** COV-2c fix round 2: 目印を入れた欄の、入れる前の値。 */
    const filledOriginals: FilledFieldOriginals = new Map();
    // L6/L3-1 の続き（T18。設計者の判断 C）: 押した後は、最短の観察の長さ（`quietWaitMs`。既定 `SUBMISSION_PROBE_QUIET_WAIT_MS`）の後に、ページが落ち着くまで待つ。
    const afterPress: AfterPressWait = { minimumMs: options.quietWaitMs ?? SUBMISSION_PROBE_QUIET_WAIT_MS, dataActivity: options.dataActivity };
    const onPressOf = (step: SubmissionProbeReplayStep): (() => void) | undefined =>
      (options.onPress === undefined ? undefined : () => options.onPress?.(step.index));
    /** COV-3: たどり直しで選んだ select の `name`。 */
    const keptSelects = new Set<string>();
    for (const step of trail.slice(0, -1)) {
      // COV-3: 選ぶ選択肢は、選び直す（選べなければ作り直せない）。
      const choice = choiceOfReplayStep(step);
      if (choice !== null) {
        if (!(await chooseAndSettle(page, choice, options.dataActivity)) || pageStateOf(page, startUrl) !== 'SAME') return null;
        if (choice.kind === 'SELECT') keptSelects.add(choice.name);
        continue;
      }
      const replayed = await replayStep(page, observation, location, step, markers, afterPress, onPressOf(step), startDocument, filledOriginals, keptSelects);
      if (replayed === null || replayed.after === 'MOVED') {
        return null;
      }
    }
    if (choiceOfReplayStep(last) !== null) {
      return null;
    }
    const moveWatch = watchMainFrameNavigationRequests(page);
    let replayed: ReplayedPress | null;
    try {
      replayed = await replayStep(page, observation, location, last, markers, afterPress, onPressOf(last), startDocument, filledOriginals, keptSelects);
    } finally {
      moveWatch.stop();
    }
    if (replayed === null) {
      return null;
    }
    const url = replayed.after === 'SAME_DOCUMENT' ? page.mainFrame().url() : moveWatch.lastBlockedMoveUrl();
    return url !== null && /^https?:/iu.test(url)
      ?{ url, markerQueryNames: markerQueryNamesOf(url, markers), markerValues: [...markers] }
      : null;
  } catch {
    if (observation.active) {
      try {
        observation.end();
      } catch {
        // 閉じられなければ、口は次の画面の Context では使わない（Context ごとの口）。
      }
    }
    return null;
  }
}

/**
 * DEF-145・DEF-186: 押下の後に、開いた窓などの中の対象を読み直すか（何も送らなかった `NO_REQUEST` か、開き手の側の要求 `OPENER_SIDE_REQUEST`）。
 */
const opensDialogLikely = (record: SubmissionProbeRecord): boolean =>
  record.result === 'NO_REQUEST' || record.reason === OPENER_SIDE_REQUEST_PROBE_REASON;

/** DEF-190: 押下の間に main frame が始めた移動の要求の URL を覚える部品（覚えるのは最後の 1 つだけ。URL-LEN: 長さでは除かない）。 */
export interface MainFrameNavigationWatch {
  readonly lastUrl: () => string | null;
  /**
   * DEF-208-3（設計書 `2026-11-05-beaksight-discovery-coverage-design.md` 3.5 の G）: 押下の間に、押した page か、押下で開いた別の page（`window.open` など。凍結の
   * 間は Guard が閉じる）の main frame が始めた、GET の文書の移動の要求の URL（最後の 1 つ）。凍結の間の文書の移動は Guard が止めるので、Guard が止めた移動の行き先。
   */
  readonly lastBlockedMoveUrl: () => string | null;
  readonly stop: () => void;
}

/** DEF-190: 押下の間の main frame の移動の要求を見る（読むだけ。要求の扱いは Guard のまま）。 */
const watchMainFrameNavigationRequests = (page: Page): MainFrameNavigationWatch => {
  let last: string | null = null;
  let lastMove: string | null = null;
  const context = page.context();
  const listener = (request: Request): void => {
    try {
      if (!request.isNavigationRequest()) {
        return;
      }
      let frame: Frame;
      try {
        frame = request.frame();
      } catch {
        // DEF-208-3（G）: 押下で開いた別の page の最初の文書の要求は、frame がまだない（凍結の間は Guard が止める）。GET なら、止めた移動の行き先として覚える。
        if (request.method() === 'GET') lastMove = request.url();
        return;
      }
      if (frame === page.mainFrame()) {
        last = request.url();
      }
      // DEF-208-3（G）: 押した page か、押下で開いた別の page の main frame の、GET の文書の移動。
      if (frame.parentFrame() === null && request.method() === 'GET') {
        lastMove = request.url();
      }
    } catch {
      // 読めない要求は見ない。
    }
  };
  context.on('request', listener);
  return {
    lastUrl: () => last,
    lastBlockedMoveUrl: () => lastMove,
    stop: () => {
      context.off('request', listener);
    },
  };
};

/**
 * DEF-190: 移った先の URL（main frame の URL が http(s) ならそれ。移りを止めた画面などに替わったときは、押下の間に main frame が始めた最後の移動の URL。
 * どちらも分からなければ null）。
 */
const movedUrlOf = (page: Page, requested: string | null): string | null => {
  const current = page.mainFrame().url();
  if (/^https?:/iu.test(current)) {
    return current;
  }
  return requested !== null && /^https?:/iu.test(requested) ? requested : null;
};

/**
 * 画面の様子（押す前と押した後に見る）。DEF-144: Guard が Context を閉じ始めた（page が閉じたか、Guard の段階が閉じる途中・無効化・閉じた後）は
 * `CLOSED_BY_GUARD`（`PAGE_CHANGED` と分ける）。main frame の URL が押す前と違えば `CHANGED`。
 */
const pageStateOf = (page: Page, startUrl: string): 'CLOSED_BY_GUARD' | 'CHANGED' | 'SAME' => {
  if (guardClosedContext(page)) {
    return 'CLOSED_BY_GUARD';
  }
  return page.mainFrame().url() === startUrl ? 'SAME' : 'CHANGED';
};

/**
 * DEF-221: 文書の印を読む（ページの中で動く。`performance.timeOrigin` を `Performance.prototype` の標準の getter で読む。ページに何も書かない）。
 * 文書ごとに決まる値で、同じ文書の中の URL の変化（`pushState`・`replaceState`・ハッシュ）では変わらず、文書が替わる移動（`chrome-error://` を含む）では
 * 変わる（2 つの Chromium で確かめた）。isolated world で読むので、ページの JS は値を偽れない。
 */
const readDocumentMarkerInPage = composeInPage((R: StandardReaders, input: null): number => {
  void input;
  return R.standardGetter<number>(Performance.prototype, 'timeOrigin')(performance);
});

/** DEF-221: 今の文書の印（読めない・数でなければ `null`）。 */
const documentMarkerOf = async (page: Page): Promise<number | null> => {
  const outcome = await readInIsolatedWorld(page, readDocumentMarkerInPage, null, openReadDeadline());
  return outcome.status === 'READ' && typeof outcome.value === 'number' && Number.isFinite(outcome.value) ? outcome.value : null;
};

/**
 * DEF-221: 押した後に main frame の URL が変わった（`CHANGED`）とき、同じ文書のままなら、変わった後の URL（http(s) のもの。URL-LEN: 長さでは除かない）。押す前の印
 * （`startDocument`）がない、印を読めない、印が違う（文書が替わった）、URL が http(s) でなければ `null`。
 */
const sameDocumentMovedUrlOf = async (page: Page, startDocument: number | null): Promise<string | null> => {
  if (startDocument === null) {
    return null;
  }
  const current = page.mainFrame().url();
  if (!/^https?:/iu.test(current)) {
    return null;
  }
  return await documentMarkerOf(page) === startDocument ? current : null;
};

/** DEF-144: Guard が Context を閉じ始めたか（page が閉じた、か Guard の段階が閉じる途中・無効化・閉じた後）。読めなければ閉じた側に倒す。 */
const guardClosedContext = (page: Page): boolean => {
  try {
    if (page.isClosed()) {
      return true;
    }
    const stage = passiveRequestGuardStageOf(page);
    return stage !== null && isClosingOrInvalidatingPhase(stage);
  } catch {
    return true;
  }
};

/** LU-4（K6）: 開いた窓（`<dialog open>`・`role="dialog"`・`aria-modal="true"`）の祖先を探す CSS。 */
const OPEN_DIALOG_SELECTOR = 'dialog[open], [role="dialog"], [aria-modal="true"]';

/** LU-4（K6）: 送信ボタンが開いた窓の中にあるかの読み取りの入力。 */
interface InOpenDialogInput {
  readonly selector: string;
}

/**
 * LU-4（K6）: 送信ボタンごとに、開いた窓（`OPEN_DIALOG_SELECTOR` の祖先か自分）の中にあるかを読む（ページの中で動く。標準のメソッドで読み、ページに
 * 何も書かない）。文書から外れていれば偽。LU-SFIX2-A fix round 1: 位置で引き直さず、読み直しの読み取りで確かめた要素そのもの（番号で渡す）を読む。
 */
const readInOpenDialogInPage = composeInPage((R: StandardReaders, input: InOpenDialogInput, given?: readonly Element[]): InPageElementsResult => {
  const isConnected = R.standardGetter<boolean>(Node.prototype, 'isConnected');
  return {
    value: (given ?? []).map((element) => element instanceof Element && isConnected(element)
      && Element.prototype.closest.call(element, input.selector) !== null),
    elements: [],
  };
});

/**
 * 読み直した候補を、押す対象にする（記録の候補の位置 `index`、識別の digest と、読み直しの鍵と順番（COV-2。`rereadIndex` の位置））。位置が shadow root の中
 * なら null。
 */
const pressTargetOf = (
  index: number,
  probed: ProbedCandidate,
  identityDigest: string,
  keys: RereadKeys,
  rereadIndex: number,
  nodeId: number | undefined,
): PressTarget | null => {
  const path = probed.submitter?.path;
  const matchKey = keys.match[rereadIndex];
  const ordinal = keys.matchOrdinal[rereadIndex];
  const pressDigest = keys.press[rereadIndex];
  const pressOrdinal = keys.pressOrdinal[rereadIndex];
  if (path === undefined || path.some((step) => step < 0) || matchKey === undefined || ordinal === undefined || pressDigest === undefined
    || pressOrdinal === undefined) {
    return null;
  }
  return {
    index,
    scopeKey: probed.form === null ? OUTSIDE_FORM_SCOPE : JSON.stringify(probed.form.path),
    kind: probed.kind,
    path,
    identityDigest,
    matchKey,
    ordinal,
    pressDigest,
    pressOrdinal,
    nodeId,
    submitterWords: probed.submitterWords,
    hasSubmitterText: probed.hasSubmitterText,
    // T44c: 押す順だけの送信の語の印。
    hasSubmitWord: probed.hasSubmitWord,
  };
};

/**
 * LU-4（設計書 4.0.1 の K6、5.1 の 3）: 押下の後の読み直しで、記録になかった（同じ識別の digest の候補のない）ボタンのうち、開いた窓の中にあるものを、発見の
 * 入口と同じ組み立て（`classifyProbedCandidates`）で候補にする。対象の条件（`isSubmissionProbeTarget`）を満たし、登録・更新の語のあるものだけを返す
 * （記録の候補の位置は、記録の末尾から振る）。読めなければ空。
 * LU-SFIX1（LU-SREV1 の Minor-4）: 候補の読み切れなさの理由は、元の記録の理由に、押した後の読み直しで分かった理由（窓の中の
 * iframe など。発見の入口と同じ部品 `probedIncompleteReasonsOf`）を足したもの。
 * DEF-221（設計書 `2026-11-08-beaksight-same-origin-api-and-spa-routes-design.md` 3.2 の 3）: 開いた窓の外に新しく現れたボタンのうち、確定の語のあるものも
 * 同じく候補にする（押す回数の上限は呼ぶ側のまま）。
 */
async function openedDialogCandidatesOf(
  port: Pick<SubmissionProbeLoopPort, 'readInOpenDialog' | 'classifyProbed'>,
  location: CandidateLocation,
  record: DiscoveryReadPageRecord,
  read: ProbedRead,
  policy: SubmissionProbeTargetPolicy,
  freshIndexes: readonly number[],
): Promise<readonly { readonly candidate: DiscoveryCandidate; readonly target: PressTarget }[]> {
  const reread = read.outcome;
  const freshBackendNodeIds = freshIndexes.flatMap((index) => {
    const node = read.nodeIds.get(index);
    return node === undefined ? [] : [node];
  });
  const fresh = freshIndexes.map((index) => reread.candidates[index]).filter((probed): probed is ProbedCandidate => probed !== undefined);
  if (fresh.length === 0 || fresh.length !== freshIndexes.length || freshBackendNodeIds.length !== fresh.length) {
    return [];
  }
  const flags = await port.readInOpenDialog(freshBackendNodeIds);
  if (!Array.isArray(flags) || flags.length !== fresh.length) {
    return [];
  }
  // DEF-221（設計書 `2026-11-08-beaksight-same-origin-api-and-spa-routes-design.md` 3.2 の 3）: 開いた窓の外に新しく現れたボタンも、確定の語
  // （`hasSubmissionProbeConfirmWord`）のあるものは足す（同じ文書の中に、窓でない区画などで出た保存のボタン）。
  const chosen = fresh.flatMap((probed, at) => (flags[at] === true || hasSubmissionProbeConfirmWord(probed.submitterWords) ? [at] : []));
  const selectedIndexes = chosen.flatMap((at) => {
    const index = freshIndexes[at];
    return index === undefined ? [] : [index];
  });
  const selected = chosen.flatMap((at) => {
    const probed = fresh[at];
    return probed === undefined ? [] : [probed];
  });
  /** 選んだ対象ごとに、開いた窓の中か（窓の中は登録・更新の語、窓の外は確定の語で選ぶ）。 */
  const insideDialog = chosen.map((at) => flags[at] === true);
  if (selected.length === 0 || selected.length !== chosen.length || selectedIndexes.length !== chosen.length) {
    return [];
  }
  const candidates = await port.classifyProbed(location, record, reread, selected, policy);
  if (candidates === null || candidates.length !== selected.length) {
    return [];
  }
  const added: { readonly candidate: DiscoveryCandidate; readonly target: PressTarget }[] = [];
  const { keys } = read;
  for (const [index, candidate] of candidates.entries()) {
    const probed = selected[index];
    const hasWord = insideDialog[index] === true
      ? hasSubmissionProbePriorityWord(candidate.submitterWords)
      : hasSubmissionProbeConfirmWord(candidate.submitterWords);
    if (probed === undefined || !isSubmissionProbeTarget(candidate, policy) || !hasWord) {
      continue;
    }
    const rereadIndex = selectedIndexes[index];
    const digest = probedCandidateIdentityDigestOf(location, probed);
    const target = rereadIndex === undefined
      ? null
      : pressTargetOf(record.candidates.length + added.length, probed, digest, keys, rereadIndex, read.nodeIds.get(rereadIndex));
    if (target !== null) added.push({ candidate, target });
  }
  return added;
}

/**
 * LU-4（設計書 4.0 の D7。fix round 1）: 押す対象（記録の候補の順）のうち、名前（読み直しの `hasSubmitterText`）があり同じ識別の digest の対象を、最初の
 * 1 つ（`kept`）と残り（`sameIdentity`。押さない）に分ける。名前のない対象は、どれも `kept` に残す。DEF-189: D7（ユーザーの決定）は開き手だけに当てる。
 * 開き手の語だけの対象（SSOT の `isOpenerOnlySubmitter`）のほか（同じ識別の保存のボタンが 2 つある画面など）は、今までどおり 1 つずつ押す（T38R2-fix の
 * R2-I-1: 同じ識別の別のボタンの送り方を、押して確かめる）。
 */
const firstOfEachNamedIdentity = (
  record: DiscoveryReadPageRecord,
  targets: readonly PressTarget[],
): { readonly kept: readonly PressTarget[]; readonly sameIdentity: readonly number[] } => {
  const seen = new Set<string>();
  const kept: PressTarget[] = [];
  const sameIdentity: number[] = [];
  for (const target of targets) {
    const digest = target.hasSubmitterText && isOpenerOnlySubmitter(target.submitterWords) ? record.candidates[target.index]?.identityDigest : undefined;
    if (digest !== undefined && seen.has(digest)) {
      sameIdentity.push(target.index);
      continue;
    }
    if (digest !== undefined) seen.add(digest);
    kept.push(target);
  }
  return { kept, sameIdentity };
};

/** COV-1: URL の path（解析できなければ null）。 */
const pathOfUrl = (url: string): string | null => {
  try {
    return new URL(url).pathname;
  } catch {
    return null;
  }
};

/** COV-1: 押しにかかった組の鍵（状態の構造の鍵・候補の識別の digest・同じ digest の中の順番）。 */
const processedKeyOf = (structureKey: string, target: PressTarget): string =>
  JSON.stringify([structureKey, target.pressDigest, target.pressOrdinal]);

/** COV-2: 押す組の鍵（操作さがし全体の記録 `SubmissionProbePressRegistry` に渡す形）。 */
const pressKeyOf = (structureKey: string, target: PressTarget): CoveragePressKey =>
  ({ structureKey, candidateIdentityDigest: target.pressDigest, ordinal: target.pressOrdinal });

/** COV-1: 状態の構造の事実の読み取りの入力（ページの中の関数は外を参照できないので、値はすべてここで渡す）。 */
interface StateFactsInput {
  readonly visibilityOptions: CheckVisibilityOptions;
  readonly fieldSelector: string;
  readonly fieldTypes: readonly string[];
  readonly dialogSelector: string;
  readonly landmarkRoles: readonly string[];
  /** COV-2: 状態の語の閉じた一覧（`STATE_WORDS`。小文字）。 */
  readonly stateWords: readonly string[];
}

const STATE_FACTS_INPUT: StateFactsInput = Object.freeze({
  visibilityOptions: VISIBILITY_CHECK_OPTIONS,
  fieldSelector: FIELD_SELECTOR,
  fieldTypes: CANDIDATE_FIELD_TYPES,
  dialogSelector: OPEN_DIALOG_SELECTOR,
  landmarkRoles: STATE_LANDMARK_ROLES,
  stateWords: STATE_WORDS,
});

/**
 * COV-1（網羅の設計書 3.1 の 2）: 状態の構造の鍵の事実を読む（ページの中で動く。標準の getter とメソッドで読み、ページに何も書かない。文字の値は読まない）。
 * 見える欄（名前・型・必須・無効・選択肢の値）、見える開いた窓があるか、見える見出しの段、見える landmark の role（明示の role か、要素の名前から決まる role）。
 */
const readStateFactsInPage = composeInPage((R: StandardReaders, input: StateFactsInput) => {
  const getterOf = R.standardGetter;
  const localNameOf = getterOf<string>(Element.prototype, 'localName');
  const nodeListLengthOf = getterOf<number>(NodeList.prototype, 'length');
  const visible = (element: Element): boolean => Element.prototype.checkVisibility.call(element, input.visibilityOptions);
  const attributeOf = (element: Element, name: string): string | null => {
    const value: unknown = Element.prototype.getAttribute.call(element, name);
    return typeof value === 'string' ? value : null;
  };
  const each = (selector: string, visit: (element: Element) => void): void => {
    const list = Document.prototype.querySelectorAll.call(document, selector);
    const length = nodeListLengthOf(list);
    for (let index = 0; index < length; index += 1) {
      const element = NodeList.prototype.item.call(list, index);
      if (element instanceof Element) visit(element);
    }
  };
  // SLK-1: 欄と見出しの読み方は部品（共通の枠の部分の事実の読み取りと共有する）。
  const fields = R.visibleStateFieldsIn(document, input);
  let opened = false;
  each(input.dialogSelector, (element) => {
    if (visible(element)) opened = true;
  });
  const headings = R.visibleHeadingLevelsIn(document, input.visibilityOptions);
  const landmarks: string[] = [];
  const outsideSections = (element: Element): boolean => {
    const parent = getterOf<Element | null>(Node.prototype, 'parentElement')(element);
    return parent === null || Element.prototype.closest.call(parent, 'article, aside, main, nav, section') === null;
  };
  each('[role], nav, main, aside, header, footer, search, form, section', (element) => {
    if (!visible(element)) return;
    const role = (attributeOf(element, 'role') ?? '').trim().toLowerCase();
    const named = Element.prototype.hasAttribute.call(element, 'aria-label') || Element.prototype.hasAttribute.call(element, 'aria-labelledby');
    const tag = localNameOf(element);
    const implicit = tag === 'nav' ? 'navigation'
      : tag === 'main' ? 'main'
        : tag === 'aside' ? 'complementary'
          : tag === 'search' ? 'search'
            : tag === 'header' ? (outsideSections(element) ? 'banner' : '')
              : tag === 'footer' ? (outsideSections(element) ? 'contentinfo' : '')
                : (tag === 'form' && named) ? 'form'
                  : (tag === 'section' && named) ? 'region' : '';
    const value = role === '' ? implicit : role;
    if (input.landmarkRoles.includes(value)) landmarks.push(value);
  });
  // COV-2: 見える文字に、状態の語の閉じた一覧の語があるか（語だけを返す。文字の値は返さない）。
  const body = getterOf<HTMLElement | null>(Document.prototype, 'body')(document);
  // 小文字にして比べる（NFKC の正規化は `src/core/text.ts` だけが書く決まり。ページの中では行わない）。
  const text = body === null ? '' : String.prototype.toLowerCase.call(getterOf<string>(HTMLElement.prototype, 'innerText')(body));
  const stateWords = input.stateWords.filter((word) => String.prototype.includes.call(text, word));
  return { fields, opened, headings, landmarks, stateWords };
});

/** SLK-1: 共通の枠の部分の事実の読み取りの入力（枠の目印の基準と、見える欄の基準）。 */
interface LayoutFrameInput {
  readonly layout: LayoutLandmarkCriteria;
  readonly fields: StateFieldCriteria;
}

const LAYOUT_FRAME_INPUT: LayoutFrameInput = Object.freeze({ layout: LAYOUT_LANDMARK_INPUT, fields: STATE_FACTS_INPUT });

/**
 * DEF-208-4（A）・SLK-1（網羅の設計書 6 章の 2026-11-16）: 送信ボタンごとの、祖先の枠の目印（`readLayoutLandmarksInPage` と同じ部品）と、共通の枠の部分
 * （目印の最も外の要素）の番号（なければ -1）、枠の部分ごとの見える欄と見出しの段を読む（ページの中で動く。標準の getter とメソッドで読み、ページに何も
 * 書かない。文字の値は読まない）。
 */
const readLayoutFramesInPage = composeInPage((R: StandardReaders, input: LayoutFrameInput, given?: readonly Element[]): InPageElementsResult => {
  const isConnected = R.standardGetter<boolean>(Node.prototype, 'isConnected');
  const frames: Element[] = [];
  const items = (given ?? []).map((element) => {
    if (!(element instanceof Element) || !isConnected(element)) return { landmarks: [], frame: -1 };
    const { landmarks, frame } = R.layoutLandmarksOf(element, input.layout);
    if (frame === null) return { landmarks, frame: -1 };
    let at = frames.indexOf(frame);
    if (at === -1) at = frames.push(frame) - 1;
    return { landmarks, frame: at };
  });
  // REV-SD の M-4: 枠の中のリンクの移る先の path（文字の値は読まない。受け入れの判定はしない）と、開閉の印（`aria-expanded`）のある要素があるか。
  const baseUrl = R.documentProperty<string>('URL');
  const linkPathsOf = (frame: Element): string[] => {
    const paths: string[] = [];
    const anchors = Element.prototype.querySelectorAll.call(frame, 'a[href]');
    const length = R.standardGetter<number>(NodeList.prototype, 'length')(anchors);
    for (let index = 0; index < length; index += 1) {
      const anchor = NodeList.prototype.item.call(anchors, index) as Element | null;
      const href: unknown = anchor === null ? null : Element.prototype.getAttribute.call(anchor, 'href');
      if (typeof href !== 'string') continue;
      try {
        paths.push(new URL(href, baseUrl).pathname);
      } catch {
        // 解けない移る先は入れない。
      }
    }
    return paths;
  };
  return {
    value: {
      items,
      frames: frames.map((frame) => ({
        fields: R.visibleStateFieldsIn(frame, input.fields), headings: R.visibleHeadingLevelsIn(frame, input.fields.visibilityOptions),
        linkPaths: linkPathsOf(frame), expandToggle: Element.prototype.querySelector.call(frame, '[aria-expanded]') !== null,
      })),
    },
    elements: [],
  };
});

/** SLK-1: 見出しの段の並び（形が違えば `null`。欠けとして鍵に入れる）。 */
const headingLevelsOf = (value: unknown): readonly number[] | null =>
  (Array.isArray(value) && value.every((level) => Number.isInteger(level) && level >= 1 && level <= 6) ? value as readonly number[] : null);

/**
 * SLK-1: 共通の枠の部分の読み取り（`readLayoutFramesInPage`）から、送信の要素の番号ごとの、枠の部分の構造の鍵（`sharedLayoutStructureKeyOf`）を作る。枠の中の
 * 候補は、同じ枠の部分にある送信ボタンの、共通の枠のボタンの識別の digest。読めない送信ボタンは持たない（押す側）。
 */
const layoutStructureKeysOf = (
  chosen: ProbedRead['outcome']['chosen'],
  candidates: readonly ProbedCandidate[],
  value: unknown,
  opened: boolean | null,
): ReadonlyMap<number, string> => {
  const keys = new Map<number, string>();
  const items: unknown = isRecord(value) ? value['items'] : null;
  const frames: unknown = isRecord(value) ? value['frames'] : null;
  if (!Array.isArray(items) || items.length !== chosen.length || !Array.isArray(frames)) return keys;
  const members = new Map<number, { readonly node: number; readonly digest: string }[]>();
  chosen.forEach(({ candidateIndex, element }, at) => {
    const item: unknown = items[at];
    const probed = candidates[candidateIndex];
    if (!isRecord(item) || probed === undefined || !Number.isSafeInteger(item['frame']) || (item['frame'] as number) < 0) return;
    const landmarks = item['landmarks'];
    if (!Array.isArray(landmarks) || landmarks.some((landmark) => typeof landmark !== 'string')) return;
    const digest = sharedLayoutIdentityDigestOf({
      kind: probed.kind, submitterWords: probed.submitterWords, hasSubmitterText: probed.hasSubmitterText, landmarks: landmarks as string[],
    });
    if (digest === null) return;
    const frame = item['frame'] as number;
    members.set(frame, [...(members.get(frame) ?? []), { node: element.backendNodeId, digest }]);
  });
  for (const [frame, list] of members) {
    const facts: unknown = frames[frame];
    const key = sharedLayoutStructureKeyOf({
      candidateIdentityDigests: list.map(({ digest }) => digest),
      fields: isRecord(facts) ? stateFieldsOf(facts['fields']) : null,
      openedDialogOrRegion: opened,
      headingLevels: isRecord(facts) ? headingLevelsOf(facts['headings']) : null,
      // REV-SD の M-4: 形が違えば欠け（`null`）として鍵に入れる。
      linkPaths: isRecord(facts) && Array.isArray(facts['linkPaths']) && facts['linkPaths'].every((path) => typeof path === 'string')
        ? facts['linkPaths'] as readonly string[] : null,
      hasExpandToggle: isRecord(facts) && typeof facts['expandToggle'] === 'boolean' ? facts['expandToggle'] : null,
    });
    for (const { node } of list) keys.set(node, key);
  }
  return keys;
};

/** COV-1: 読んだ欄の事実を、構造の鍵の欄の形にする（形が違えば `null`。欠けとして鍵に入れる）。 */
const stateFieldsOf = (value: unknown): readonly StateStructureField[] | null => {
  if (!Array.isArray(value)) return null;
  const fields: StateStructureField[] = [];
  for (const item of value as readonly unknown[]) {
    if (!isRecord(item) || typeof item['name'] !== 'string' || typeof item['type'] !== 'string' || typeof item['required'] !== 'boolean'
      || typeof item['disabled'] !== 'boolean'
      || !(item['optionValues'] === null || (Array.isArray(item['optionValues']) && item['optionValues'].every((option) => typeof option === 'string')))) {
      return null;
    }
    fields.push({
      name: item['name'], type: item['type'], required: item['required'], disabled: item['disabled'], optionValues: item['optionValues'] as readonly string[] | null,
    });
  }
  return fields;
};

/**
 * COV-1・COV-2: 今の画面の状態の構造の鍵（`stateStructureKeyOf`。状態の鍵の唯一の部品）。読めない項目は欠け（`null`）として鍵に入れる。
 * - COV-2（網羅の設計書 3.1 の 2）: 候補の識別は、型にした識別（`probedCandidateStateTemplateDigestOf`。番号だけ違う同じ作りの画面で同じ）。共通の枠の候補
 *   （祖先に枠の目印がある送信ボタン。`readLayoutLandmarksInPage`）は除く。枠を読めなければ、除かずに入れる。
 * - COV-2: 状態の語は、閉じた一覧（`STATE_WORDS`）のうち、見える文字にある語。
 */
export async function pageStateStructureKeyOf(page: Page, location: CandidateLocation): Promise<string> {
  return (await pageStateStructureKeysOf(page, location)).full;
}

/**
 * COV-2c: `pageStateStructureKeyOf` の鍵と、同じ読み取りから作る、状態の語を入れない鍵。L6/L3-1（指示書の 4「無駄な繰り返し」）: 押した後に読み直した候補
 * （`given`。`readProbed` の読み取り。押せる位置の送信の要素の選び方は同じ `hasPressableSubmitter`）があれば、候補を読み直さずにそれを使う（その間に押す・入れる
 * 操作はしない）。
 */
async function pageStateStructureKeysOf(page: Page, location: CandidateLocation, given?: ProbedRead): Promise<StateStructureKeys> {
  const read = given?.outcome ?? await probePageCandidatesWithSubmitters(page, openReadDeadline(), (candidates) =>
    candidates.flatMap((probed, index) => (hasPressableSubmitter(probed) ? [index] : [])));
  let digests: readonly string[] | null = null;
  /** SLK-1: 共通の枠の部分の読み取り（読めなければ null）。 */
  let frames: unknown = null;
  if (read.status === 'READ') {
    const layout = new Set<number>();
    if (read.chosen.length > 0) {
      const outcome = await readElementsInIsolatedWorld(page, readLayoutFramesInPage, LAYOUT_FRAME_INPUT,
        openReadDeadline(), { argumentElements: read.chosen.map(({ element }) => element.backendNodeId) });
      frames = outcome.status === 'READ' ? outcome.value : null;
      const lists: unknown = isRecord(frames) ? frames['items'] : null;
      if (Array.isArray(lists) && lists.length === read.chosen.length) {
        read.chosen.forEach(({ candidateIndex }, at) => {
          const item: unknown = lists[at];
          if (isRecord(item) && Array.isArray(item['landmarks']) && item['landmarks'].length > 0) layout.add(candidateIndex);
        });
      }
    }
    digests = read.candidates.flatMap((probed, index) => (layout.has(index) ? [] : [probedCandidateStateTemplateDigestOf(location, probed)]));
  }
  const facts = await readInIsolatedWorld(page, readStateFactsInPage, STATE_FACTS_INPUT, openReadDeadline());
  const value = facts.status === 'READ' && isRecord(facts.value) ? facts.value : null;
  let url: URL | null = null;
  try {
    url = new URL(page.mainFrame().url());
  } catch {
    url = null;
  }
  const landmarks: unknown = value?.['landmarks'];
  const words: unknown = value?.['stateWords'];
  const knownRoles: readonly string[] = STATE_LANDMARK_ROLES;
  const knownWords: readonly string[] = STATE_WORDS;
  const structureFacts: StateStructureFacts = {
    path: url?.pathname ?? null,
    queryNames: url === null ? null : [...url.searchParams.keys()],
    candidateIdentityDigests: digests,
    fields: stateFieldsOf(value?.['fields']),
    openedDialogOrRegion: typeof value?.['opened'] === 'boolean' ? value['opened'] : null,
    headingLevels: headingLevelsOf(value?.['headings']),
    landmarkRoles: Array.isArray(landmarks) && landmarks.every((role) => typeof role === 'string' && knownRoles.includes(role))
      ? landmarks as readonly string[] : null,
    stateWords: Array.isArray(words) && words.every((word) => typeof word === 'string' && knownWords.includes(word)) ? words as readonly string[] : null,
  };
  // SLK-1: 共通の枠の部分の構造の鍵（送信の要素の番号ごと）。
  const layouts = read.status === 'READ' ? layoutStructureKeysOf(read.chosen, read.candidates, frames, structureFacts.openedDialogOrRegion) : new Map<number, string>();
  // COV-2c: 状態の語を入れない鍵（押下の後に、文字（状態の語）だけが変わったかを見分ける）。
  return { full: stateStructureKeyOf(structureFacts), withoutWords: stateStructureKeyOf({ ...structureFacts, stateWords: [] }), layouts };
}

/** COV-2c: 状態の構造の鍵と、状態の語を入れない鍵。SLK-1: 送信の要素の番号ごとの、共通の枠の部分の構造の鍵（枠のボタンでない・読めない要素は持たない）。 */
export interface StateStructureKeys {
  readonly full: string;
  readonly withoutWords: string;
  readonly layouts: ReadonlyMap<number, string>;
}

/** COV-1・COV-2c: 今の画面の状態の構造の鍵と、状態の語を入れない鍵（`pageStateStructureKeysOf`）。 */
const stateStructureKeyNow = (page: Page, location: CandidateLocation, given?: ProbedRead): Promise<StateStructureKeys> =>
  pageStateStructureKeysOf(page, location, given);

/**
 * COV-1（DEF-238 の設計書 3.1 の 4）: 段の読み直しで、記録になかった（同じ識別の digest の候補のない）ボタンを、発見の入口と同じ組み立て
 * （`classifyProbedCandidates`）で候補にし、押す対象の条件（`isSubmissionProbeTarget`）を満たすものを返す（窓の中か外か、語は問わない。窓でない区画に
 * 後から出た確定の語のボタンも足す）。読めなければ空。
 */
async function freshTargetCandidatesOf(
  port: Pick<SubmissionProbeLoopPort, 'classifyProbed'>,
  location: CandidateLocation,
  record: DiscoveryReadPageRecord,
  read: ProbedRead,
  policy: SubmissionProbeTargetPolicy,
  freshIndexes: readonly number[],
): Promise<readonly { readonly candidate: DiscoveryCandidate; readonly rereadIndex: number }[]> {
  const reread = read.outcome;
  const fresh = freshIndexes.map((index) => reread.candidates[index]).filter((probed): probed is ProbedCandidate => probed !== undefined);
  if (fresh.length === 0 || fresh.length !== freshIndexes.length) {
    return [];
  }
  const candidates = await port.classifyProbed(location, record, reread, fresh, policy);
  if (candidates === null || candidates.length !== fresh.length) {
    return [];
  }
  // COV-2: 足す候補ごとに、読み直しの中の位置を返す（呼ぶ側が見分けの鍵と要素の番号を結ぶ）。
  return candidates.flatMap((candidate, at) => {
    const rereadIndex = freshIndexes[at];
    return rereadIndex !== undefined && isSubmissionProbeTarget(candidate, policy) ? [{ candidate, rereadIndex }] : [];
  });
}

// ---------------------------------------------------------------------------------------------------------------
// COV-3（網羅の設計書 `2026-11-09-beaksight-coverage-by-state-design.md` 3.2 の 1・3.3）: select・radio の選択肢ごとの段
// ---------------------------------------------------------------------------------------------------------------

/**
 * COV-3: 選ぶ選択肢（欄の見分けと、選択肢の見分け）。欄は、種類・`name`（なければ空）・同じ種類と `name` の欄の中の文書の順の番号で見分ける。選択肢は、
 * 欄の中の順番と、値と表示の文字の digest（`optionDigestOf`）で見分ける（値と表示の文字そのものは持たない）。
 */
export interface SubmissionProbeChoice {
  readonly kind: DiscoveryOptionFieldKind;
  readonly name: string;
  readonly ordinal: number;
  readonly optionIndex: number;
  readonly optionDigest: string;
}

/** COV-3: 選ぶ押下の並びの 1 つの印（見分けの鍵の先頭。押下の見分けの鍵は digest で始まるので重ならない）。 */
const CHOICE_STEP_FORMAT = 'beaksight-probe-choice/1';
/** COV-3: 選択肢の digest の入力の形の印。 */
const OPTION_DIGEST_FORMAT = 'beaksight-probe-option/1';
/** COV-3: 選んだ後の状態を、操作さがし全体の押す組の記録に入れる印（構造の鍵ごとに 1 回だけ新しい段にする）。 */
const OPTION_STATE_DIGEST = createSha256Fingerprint('beaksight-probe-option-state/1');
/** COV-3: 欄の選択肢を選び終えた印（状態の構造の鍵と欄ごとに 1 回だけ選ぶ）の入力の形の印。 */
const OPTION_SURVEY_FORMAT = 'beaksight-probe-option-survey/2';
/** COV-3: 選択肢を選び終えた欄を、画面の場所ごとに記録する印の入力の形の印。 */
const OPTION_PAGE_FORMAT = 'beaksight-probe-option-page/1';

/** COV-3: 選択肢の値と表示の文字の digest。 */
const optionDigestOf = (value: string, label: string): string => createSha256Fingerprint(JSON.stringify([OPTION_DIGEST_FORMAT, value, label]));

/**
 * COV-3: 選ぶ選択肢を、押下の並びの 1 つ（`SubmissionProbeReplayStep`。待ち行列と状態の保存が形だけを確かめて持つ）にする。候補の位置はないので 0、順番は
 * 選択肢の順番。見分けの鍵に、選び方を入れる（値と表示の文字は digest だけ）。
 */
export const choiceReplayStepOf = (choice: SubmissionProbeChoice): SubmissionProbeReplayStep => Object.freeze({
  index: 0,
  matchKey: JSON.stringify([CHOICE_STEP_FORMAT, choice.kind, choice.name, choice.ordinal, choice.optionIndex, choice.optionDigest]),
  ordinal: choice.optionIndex,
});

/** COV-3: 押下の並びの 1 つが選ぶ選択肢なら、その選び方（押下なら `null`）。 */
export const choiceOfReplayStep = (step: SubmissionProbeReplayStep): SubmissionProbeChoice | null => {
  if (!step.matchKey.startsWith(`["${CHOICE_STEP_FORMAT}"`)) return null;
  try {
    const parsed: unknown = JSON.parse(step.matchKey);
    if (!Array.isArray(parsed) || parsed.length !== 6) return null;
    const [, kind, name, ordinal, optionIndex, optionDigest] = parsed as unknown[];
    if (!(DISCOVERY_OPTION_FIELD_KINDS as readonly unknown[]).includes(kind) || typeof name !== 'string' || !Number.isSafeInteger(ordinal)
      || !Number.isSafeInteger(optionIndex) || typeof optionDigest !== 'string') {
      return null;
    }
    return { kind: kind as DiscoveryOptionFieldKind, name, ordinal: ordinal as number, optionIndex: optionIndex as number, optionDigest };
  } catch {
    return null;
  }
};

/** COV-3: 選べる欄の読み取りの入力。 */
interface ChoosableFieldsInput {
  readonly visibilityOptions: CheckVisibilityOptions;
}

/**
 * COV-3: 画面の、選べる欄を読む（ページの中で動く。標準の getter とメソッドで読み、ページに何も書かない）。見えて選べる select と、名前のある radio の組
 * （同じ form の中の同じ `name`）。選択肢ごとに、値・表示の文字・選べないか（無効か見えない）を返す。要素は、select はその要素、radio の組は組の radio の順。
 */
const readChoosableFieldsInPage = composeInPage((R: StandardReaders, input: ChoosableFieldsInput): InPageElementsResult => {
  const localNameOf = R.standardGetter<string>(Element.prototype, 'localName');
  const nodeListLengthOf = R.standardGetter<number>(NodeList.prototype, 'length');
  const inputTypeOf = R.standardGetter<string>(HTMLInputElement.prototype, 'type');
  const inputValueOf = R.standardGetter<string>(HTMLInputElement.prototype, 'value');
  const inputCheckedOf = R.standardGetter<boolean>(HTMLInputElement.prototype, 'checked');
  const inputFormOf = R.standardGetter<HTMLFormElement | null>(HTMLInputElement.prototype, 'form');
  const inputLabelsOf = R.standardGetter<NodeList | null>(HTMLInputElement.prototype, 'labels');
  const selectOptionsOf = R.standardGetter<unknown>(HTMLSelectElement.prototype, 'options');
  const selectedIndexOf = R.standardGetter<number>(HTMLSelectElement.prototype, 'selectedIndex');
  const collectionLengthOf = R.standardGetter<number>(HTMLCollection.prototype, 'length');
  const optionValueOf = R.standardGetter<string>(HTMLOptionElement.prototype, 'value');
  const optionTextOf = R.standardGetter<string>(HTMLOptionElement.prototype, 'text');
  const optionDisabledOf = R.standardGetter<boolean>(HTMLOptionElement.prototype, 'disabled');
  const textOf = R.standardGetter<string | null>(Node.prototype, 'textContent');
  const forms = Document.prototype.querySelectorAll.call(document, 'form');
  const formCount = nodeListLengthOf(forms);
  const formIndexOf = (form: HTMLFormElement | null): number => {
    for (let index = 0; index < formCount; index += 1) {
      if (NodeList.prototype.item.call(forms, index) === form) return index;
    }
    return -1;
  };
  const usable = (element: Element): boolean =>
    Element.prototype.checkVisibility.call(element, input.visibilityOptions) && !Element.prototype.matches.call(element, ':disabled');
  const attributeOf = (element: Element, name: string): string => {
    const value: unknown = Element.prototype.getAttribute.call(element, name);
    return typeof value === 'string' ? value : '';
  };
  const fields: { kind: string; name: string; options: { value: string; label: string; disabled: boolean }[]; selected: number; elementCount: number }[] = [];
  const elements: Element[] = [];
  const radioGroups = new Map<string, { field: (typeof fields)[number]; radios: Element[] }>();
  const list = Document.prototype.querySelectorAll.call(document, 'select, input[type="radio" i]');
  const length = nodeListLengthOf(list);
  for (let index = 0; index < length; index += 1) {
    const element = NodeList.prototype.item.call(list, index) as Element | null;
    if (element === null) continue;
    if (localNameOf(element) === 'select') {
      if (!usable(element)) continue;
      const options = selectOptionsOf(element);
      const count = collectionLengthOf(options);
      const read: { value: string; label: string; disabled: boolean }[] = [];
      for (let at = 0; at < count; at += 1) {
        const option = HTMLCollection.prototype.item.call(options as HTMLCollection, at);
        if (option !== null) read.push({ value: optionValueOf(option), label: optionTextOf(option), disabled: optionDisabledOf(option) });
      }
      if (read.length === 0) continue;
      fields.push({ kind: 'SELECT', name: attributeOf(element, 'name'), options: read, selected: selectedIndexOf(element), elementCount: 1 });
      elements.push(element);
      continue;
    }
    if (localNameOf(element) !== 'input' || inputTypeOf(element) !== 'radio') continue;
    const name = attributeOf(element, 'name');
    if (name === '') continue;
    const groupKey = JSON.stringify([name, formIndexOf(inputFormOf(element))]);
    let group = radioGroups.get(groupKey);
    if (group === undefined) {
      group = { field: { kind: 'RADIO', name, options: [], selected: -1, elementCount: 0 }, radios: [] };
      radioGroups.set(groupKey, group);
      fields.push(group.field);
    }
    const labels = inputLabelsOf(element);
    const first = labels === null || nodeListLengthOf(labels) === 0 ? null : NodeList.prototype.item.call(labels, 0);
    if (inputCheckedOf(element)) group.field.selected = group.radios.length;
    group.field.options.push({ value: inputValueOf(element), label: first === null ? '' : (textOf(first) ?? ''), disabled: !usable(element) });
    group.radios.push(element);
  }
  // radio の組の要素は、組ごとにまとめて並べる（select の後に、組の出た順）。組の radio のどれも選べない組は外す。
  const kept = fields.filter((field) => field.kind === 'SELECT' || field.options.some((option) => !option.disabled));
  const ordered: Element[] = [];
  let selectAt = 0;
  for (const field of kept) {
    if (field.kind === 'SELECT') {
      const element = elements[selectAt];
      selectAt += 1;
      if (element !== undefined) ordered.push(element);
    } else {
      const group = [...radioGroups.values()].find((candidate) => candidate.field === field);
      field.elementCount = group?.radios.length ?? 0;
      ordered.push(...(group?.radios ?? []));
    }
  }
  return { value: kept, elements: ordered };
});

/** COV-3: 読んだ選べる欄（同じ種類と `name` の欄の中の順番、選択肢、選ばれている選択肢の順番（なければ -1）、要素）。 */
export interface ChoosableField {
  readonly kind: DiscoveryOptionFieldKind;
  readonly name: string;
  readonly ordinal: number;
  readonly options: readonly { readonly digest: string; readonly disabled: boolean }[];
  readonly selected: number;
  readonly elements: readonly { readonly backendNodeId: number; readonly path: readonly number[] | null }[];
}

/** COV-3: 選べる欄を読む（読めなければ `null`）。 */
async function readChoosableFields(page: Page): Promise<readonly ChoosableField[] | null> {
  const outcome = await readElementsInIsolatedWorld(page, readChoosableFieldsInPage, { visibilityOptions: VISIBILITY_CHECK_OPTIONS } satisfies ChoosableFieldsInput,
    openReadDeadline());
  if (outcome.status !== 'READ' || !Array.isArray(outcome.value)) return null;
  const fields: ChoosableField[] = [];
  const ordinals = new Map<string, number>();
  let at = 0;
  for (const raw of outcome.value as readonly unknown[]) {
    if (!isRecord(raw) || !(DISCOVERY_OPTION_FIELD_KINDS as readonly unknown[]).includes(raw['kind']) || typeof raw['name'] !== 'string'
      || !Array.isArray(raw['options']) || !Number.isSafeInteger(raw['selected']) || !Number.isSafeInteger(raw['elementCount'])) {
      return null;
    }
    const kind = raw['kind'] as DiscoveryOptionFieldKind;
    const options: { digest: string; disabled: boolean }[] = [];
    for (const option of raw['options'] as readonly unknown[]) {
      if (!isRecord(option) || typeof option['value'] !== 'string' || typeof option['label'] !== 'string' || typeof option['disabled'] !== 'boolean') return null;
      // SD-1（設計書 `2026-11-16-beaksight-action-based-delete-guard-design.md` 2.3）: 削除の語の選択肢（値か文字）は選ばない（選べない選択肢と同じに扱う）。
      options.push({
        digest: optionDigestOf(option['value'], option['label']),
        disabled: option['disabled'] || textsHaveDestructiveActionWord([option['value'], option['label']]),
      });
    }
    const count = raw['elementCount'] as number;
    const ordinalKey = JSON.stringify([kind, raw['name']]);
    const ordinal = ordinals.get(ordinalKey) ?? 0;
    ordinals.set(ordinalKey, ordinal + 1);
    fields.push({ kind, name: raw['name'], ordinal, options, selected: raw['selected'] as number, elements: outcome.elements.slice(at, at + count) });
    at += count;
  }
  return at === outcome.elements.length ? fields : null;
}

/** COV-3: 欄の中で、選び方に合う選択肢の順番（digest が同じもの。同じ順番を先に。なければ -1）。 */
const optionPositionOf = (field: ChoosableField, choice: SubmissionProbeChoice): number => {
  if (field.options[choice.optionIndex]?.digest === choice.optionDigest) return choice.optionIndex;
  return field.options.findIndex((option) => option.digest === choice.optionDigest);
};

/**
 * COV-3: 選択肢を選ぶ（画面を読み直して欄を見分け、select は `selectOption`、radio は押して選ぶ。入力の操作の閉じた一覧の中で行う）。選べたら真。欄や選択肢が
 * 見つからない・選べない・操作が失敗したら偽。凍結の段でなければ選ばない。例外を投げない。
 */
async function chooseOption(page: Page, choice: SubmissionProbeChoice): Promise<boolean> {
  try {
    if (!(await interactionFreezeHolds(page))) return false;
    const fields = await readChoosableFields(page);
    const field = fields?.find((candidate) => candidate.kind === choice.kind && candidate.name === choice.name && candidate.ordinal === choice.ordinal);
    if (field === undefined) return false;
    const position = optionPositionOf(field, choice);
    const option = field.options[position];
    if (option === undefined || option.disabled) return false;
    const element = field.kind === 'SELECT' ? field.elements[0] : field.elements[position];
    if (element === undefined || element.path === null) return false;
    const path = element.path;
    const done = await withSignaledElements(page, [element.backendNodeId], openReadDeadline(), async (signals) => {
      const signal = signals[0];
      if (signal === undefined) throw new Error('the option field is not tracked');
      const locator = page.locator(elementPathSelectorOf(path, signal));
      if (field.kind === 'SELECT') {
        await trackOnScreen(page, locator.selectOption({ index: position }, { timeout: NO_STEP_TIMEOUT }));
      } else {
        await trackOnScreen(page, locator.click({ timeout: NO_STEP_TIMEOUT, noWaitAfter: true }));
      }
      return true;
    });
    return done.status === 'DONE';
  } catch {
    return false;
  }
}

/** COV-3: 要求の今の数（落ち着きの待ちの部品 `waitForPageSettled` の `dataActivity` の形）。 */
export type ChoiceDataActivity = () => DataActivity;

/**
 * COV-3: 選んだ後に、ページが落ち着くまで待つ。決まった時間は待たず、落ち着きの待ちの唯一の部品（`waitForPageSettled`。作りの印・高さ・読み込みの段・要求の
 * 途中の数）に任せる。要求が始まらず、作りの印も変わらなければ、短い観察の窓（`PAGE_SETTLING_PACING`）で終わる。要求や変化がある間は待つ。期限を置かず、全く
 * 反応がないときは L0 の進みの見張り（`watchProgress`）が終える。例外を投げない。
 * L6/L3-1 の続き（T18）: 押した後の待ちも、この部品で待つ（選んだ後と押した後の、事実の待ちの唯一の入口）。要求の数（`dataActivity`）が口ごとの事実を持てば、
 * 一度応答を返し終えた口へのくり返しは静まりを止めない（`dataQuietnessOf`）。
 */
export async function settleAfterAction(page: Page, dataActivity: ChoiceDataActivity | undefined): Promise<void> {
  if (page.isClosed()) return;
  const settle = (signals: ProgressSignals): Promise<unknown> => waitForPageSettled(page, {
    // 期限の数を必ず受け取る部品なので、切らない値（L1 の共通の部品 `openEndedStageDeadline`）を渡す。
    deadlineAtMs: openReadDeadline(),
    pollIntervalMs: PAGE_SETTLING_PACING.pollIntervalMs,
    stableWindowMs: PAGE_SETTLING_PACING.stableWindowMs,
    progress: signals,
    ...(dataActivity === undefined ? {} : { dataActivity }),
  });
  try {
    // L6/L3-1: 1 画面の見張りの中では、自分では見張らず、その口を使う（ページの印も外側が付ける）。
    const outer = screenWatchOf(page);
    if (outer !== undefined) {
      await settle(outer);
      return;
    }
    await watchProgress(async (signals) => {
      const detach = attachPageProgressSignals(page, signals);
      try {
        await settle(signals);
      } finally {
        detach();
      }
    });
  } catch {
    // 待ちの失敗は外に投げない（選んだ後の構造の鍵の読み取りは、今どおり行う）。
  }
}

/** L6/L3-1 の続き（T18。設計者の判断 C）: 押した後の待ちの指定。 */
export interface AfterPressWait {
  /**
   * 最短の観察の長さ（ms。`SUBMISSION_PROBE_QUIET_WAIT_MS`。テストは短くする）。上限ではなく、遅れて送る作り（入力の後の自動の保存など）を見落とさないための
   * 最短の待ち。
   */
  readonly minimumMs: number;
  /** 落ち着きの待ちに渡す要求の今の数（省略すると、要求の数を見ない）。 */
  readonly dataActivity: ChoiceDataActivity | undefined;
  /**
   * L10 の調べの直し: Safety の記録から、この文書を使うのをやめるか（外部スキーム・frame の判定の失敗の記録が入った。`SubmissionProbeOptions.documentUnusable`）。
   * 省略すると記録は見ない（文書の替わりだけを見る）。
   */
  readonly recordUnusable?: (() => boolean) | undefined;
}

/** L10 の調べの直し: その文書を使うのをやめたので、1 手を待つのをやめた（`stepOnUsableDocument`）。 */
export class DocumentUnusableError extends Error {}

/**
 * L10 の調べの直し: 1 手（Playwright の呼び出し）を、文書を使える間だけ待つ（期限は付けない）。文書が消えた（誤りの画面に替わった・閉じた。`documentGoneOf`）か、
 * Safety の記録がこの文書を使うのをやめると言った（`recordUnusable`）ら、待つのをやめて `DocumentUnusableError` を投げる（1 手は見放す）。事実は、main frame の
 * 移動の事象と、確かめの間隔（`PAGE_SETTLING_PACING.pollIntervalMs`）ごとに見る。
 */
export async function stepOnUsableDocument<T>(page: Page, step: PromiseLike<T>, recordUnusable: () => boolean = () => false): Promise<T> {
  const running = Promise.resolve(step);
  const unusable = (): boolean => documentGoneOf(page) || recordUnusable();
  if (unusable()) {
    running.catch(() => undefined);
    throw new DocumentUnusableError();
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onNavigated: ((frame: Frame) => void) | undefined;
  const stopped = new Promise<never>((_resolve, reject) => {
    const check = (): void => {
      if (unusable()) reject(new DocumentUnusableError());
    };
    onNavigated = (frame: Frame): void => {
      if (frame === page.mainFrame()) check();
    };
    page.on('framenavigated', onNavigated);
    const poll = (): void => {
      check();
      timer = setTimeout(poll, PAGE_SETTLING_PACING.pollIntervalMs);
    };
    timer = setTimeout(poll, PAGE_SETTLING_PACING.pollIntervalMs);
  });
  try {
    return await Promise.race([running, stopped]);
  } finally {
    if (onNavigated !== undefined) page.off('framenavigated', onNavigated);
    if (timer !== undefined) clearTimeout(timer);
    running.catch(() => undefined);
    stopped.catch(() => undefined);
  }
}

/**
 * L6/L3-1 の続き（T18。設計者の判断 C）: 押した後に、最短の観察の長さだけ待ち、そのうえでページが落ち着くまで待つ（`settleAfterAction`）。例外を投げない。
 * 選んだ後の待ち（`chooseAndSettle`）には最短の長さを置かない（選択肢の多い画面で時間が大きく増えるため。限界）。
 */
export async function waitAfterPress(page: Page, afterPress: AfterPressWait): Promise<void> {
  await wait(afterPress.minimumMs);
  // DEF-279: 落ち着きの待ちも、この文書を使える間だけ待つ（文書が消えた・Safety の記録が使うのをやめると言ったら、待ちを終える。ページの中の読み取りが返らなく
  // なっても、1 画面の見張りまで待たない）。見放した待ちは、もう読むだけなので、この page に 1 手を重ねない。
  await stepOnUsableDocument(page, settleAfterAction(page, afterPress.dataActivity), afterPress.recordUnusable).catch((error: unknown) => {
    if (!(error instanceof DocumentUnusableError)) throw error;
  });
}

/** COV-3: 欄を選ぶ（選べたら、ページが落ち着くまで待つ）。 */
async function chooseAndSettle(page: Page, choice: SubmissionProbeChoice, dataActivity: ChoiceDataActivity | undefined): Promise<boolean> {
  const chosen = await chooseOption(page, choice);
  if (chosen) await settleAfterAction(page, dataActivity);
  return chosen;
}

/** COV-3: 選択肢を 1 つずつ選んだ結果（記録と、新しい段にする選び方）。`stopped` は、利用者の停止か Run の時間の上限で途中で終えたか。 */
export interface OptionSurvey {
  readonly records: readonly DiscoveryOptionChoiceRecord[];
  readonly stages: readonly SubmissionProbeChoice[];
  readonly stopped: boolean;
}

/** COV-3: 選択肢を選ぶときの、押す輪の事実（段の番号・画面の URL・新しい状態か・初めての欄か・止めるか）。 */
export interface OptionSurveyContext {
  readonly stage: number;
  readonly startUrl: string;
  readonly dataActivity: ChoiceDataActivity | undefined;
  readonly isNewState: (structureKey: string) => boolean;
  readonly isFirstSurvey: (field: ChoosableField) => boolean;
  readonly shouldStop: () => boolean;
}

/**
 * COV-3（網羅の設計書 3.3）: 今の状態の選べる欄の選択肢を、1 つずつ凍結の中で選び、選んだ後の状態の構造の鍵を読む（選択肢の数の上限はない。選ぶのはページの
 * 中の操作で、BeakSight からの読み込みは増やさない。選んだときにページが出す読み取りは通り、読み取りでない送信は凍結が止める）。
 * - 状態の語のほかの構造の鍵が変わらなかった選択肢は、数だけ数える（段を作らない）。
 * - 変わった選択肢は記録し、まだ見ていない構造の鍵（`isNewState`）なら、新しい段にする（呼ぶ側が読み込み直し、たどり直して選び、その段で押す）。
 * - 選んだ後の待ちは、決まった時間でなく、ページが落ち着いたかの事実で決める（`settleAfterAction`）。
 * - 欄ごとに、もとの選択肢を最後に選ぶ（選び終えた後に、もとの選択肢に戻る。選ぶ回数は選択肢の数を超えない）。radio の組でどれも選ばれていなかったときは、
 *   最初の選べる選択肢を最後に選ぶ（押す部品が押す前に選ぶ選択肢と同じ）。
 * - 同じ欄（種類・`name`・順番と、選択肢の digest の並び）は、この画面で 1 回だけ選ぶ（`isFirstSurvey`。選んで出た段でも、前の選びで分かった事実を使い、
 *   選び直さない）。
 * 画面が移ったら、そこで終える。
 */
async function surveyOptionChoices(page: Page, location: CandidateLocation, context: OptionSurveyContext): Promise<OptionSurvey> {
  const records: DiscoveryOptionChoiceRecord[] = [];
  const stages: SubmissionProbeChoice[] = [];
  const base = await stateStructureKeyNow(page, location);
  const fields = await readChoosableFields(page);
  for (const field of fields ?? []) {
    if (!context.isFirstSurvey(field)) continue;
    let chosenCount = 0;
    let unchangedCount = 0;
    const changed: { optionIndex: number; optionDigest: string; newStage: boolean }[] = [];
    const choiceOf = (optionIndex: number): SubmissionProbeChoice => ({
      kind: field.kind, name: field.name, ordinal: field.ordinal, optionIndex, optionDigest: field.options[optionIndex]?.digest ?? '',
    });
    let moved = false;
    // もとの選択肢（radio の組でどれも選ばれていなければ、最初の選べる選択肢）を最後に選ぶ順。
    const last = field.selected >= 0 ? field.selected : field.options.findIndex((option) => !option.disabled);
    const order = [...field.options.keys()].filter((index) => index !== last);
    if (last >= 0) order.push(last);
    for (const optionIndex of order) {
      const option = field.options[optionIndex];
      if (context.shouldStop()) {
        return { records, stages, stopped: true };
      }
      if (option === undefined || option.disabled || !(await chooseAndSettle(page, choiceOf(optionIndex), context.dataActivity))) continue;
      chosenCount += 1;
      if (pageStateOf(page, context.startUrl) !== 'SAME') {
        moved = true;
        break;
      }
      const keys = await stateStructureKeyNow(page, location);
      if (keys.withoutWords === base.withoutWords) {
        unchangedCount += 1;
        continue;
      }
      const newStage = context.isNewState(keys.full);
      changed.push({ optionIndex, optionDigest: option.digest, newStage });
      if (newStage) stages.push(choiceOf(optionIndex));
    }
    records.push(Object.freeze({
      stage: context.stage,
      field: Object.freeze({ kind: field.kind, name: fieldNameOf(field.name), ordinal: field.ordinal }),
      optionCount: field.options.length,
      chosenCount,
      unchangedCount,
      // 選んだ順で記録する（もとの選択肢は最後）。記録は選択肢の順にそろえる。
      changed: Object.freeze([...changed].sort((left, right) => left.optionIndex - right.optionIndex).map((entry) => Object.freeze(entry))),
    }));
    if (moved) break;
  }
  return { records, stages, stopped: false };
}

/** COV-3: 選択肢を選んだ欄の印（種類・`name`・順番と、選択肢の digest の並び。操作さがし全体の押す組の記録に入れる形）。 */
const optionSurveyDigestOf = (field: ChoosableField): string =>
  createSha256Fingerprint(JSON.stringify([OPTION_SURVEY_FORMAT, field.kind, field.name, field.ordinal, field.options.map(({ digest }) => digest)]));

/** 画面の様子（`pageStateOf` と同じ決め。押す輪は口から読む）。 */
const pageStateWith = (port: Pick<SubmissionProbeLoopPort, 'guardClosedContext' | 'mainFrameUrl'>, startUrl: string): ProbePageState =>
  (port.guardClosedContext() ? 'CLOSED_BY_GUARD' : port.mainFrameUrl() === startUrl ? 'SAME' : 'CHANGED');

/** 画面の様子（`CLOSED_BY_GUARD` は Guard が Context を閉じ始めた。`CHANGED` は main frame の URL が変わった）。 */
export type ProbePageState = 'CLOSED_BY_GUARD' | 'CHANGED' | 'SAME';

/**
 * RB-13（再構築の設計書 3 章。案 2 章の 8）: 押す輪が頼むページの操作。本物は `submissionProbeLoopPortOf(page, observation)`、テストは偽の口。判定は輪と純粋な
 * 1 歩（`probeStepOf`）にあり、口は読む・押すだけ。押す直前の確かめ（凍結の段か・押す時点の確かめ `pressWithPressTimeGuard`）は、本物の口の `pressTarget` と
 * `replayStep` の中に残す（読んでから押すまでの隙のため）。押す・入れる操作は、この口の本物（このファイル）だけが行う（`worker-login-hooks` の (q)）。
 */
export interface SubmissionProbeLoopPort {
  /** 観察の口が開いたままか（前の押下が閉じていない）。 */
  readonly observationActive: () => boolean;
  /** 観察の口を閉じる（予期しない誤りの後。投げうる）。 */
  readonly endObservation: () => void;
  /** Guard が凍結の段にあるか（読めなければ偽）。 */
  readonly freezeHolds: () => Promise<boolean>;
  /** Guard が Context を閉じ始めたか（読めなければ真）。 */
  readonly guardClosedContext: () => boolean;
  /** 読む文書が消えたか（`documentGoneOf`）。 */
  readonly documentGone: () => boolean;
  /** 1 画面の見張りが画面を終えたか。 */
  readonly screenWatchEnded: () => boolean;
  readonly mainFrameUrl: () => string;
  /** 文書の印（`documentMarkerOf`）。 */
  readonly documentMarker: () => Promise<number | null>;
  /** 同じ文書のまま変わった URL（`sameDocumentMovedUrlOf`）。 */
  readonly sameDocumentMovedUrl: (startDocument: number | null) => Promise<string | null>;
  /** 移った先の URL（`movedUrlOf`）。 */
  readonly movedUrl: (requested: string | null) => string | null;
  /** 押下の間の main frame の移動の要求を見始める。 */
  readonly watchNavigations: () => MainFrameNavigationWatch;
  /** 画面の候補を読み直す（読めなければ null）。 */
  readonly readProbed: (location: CandidateLocation) => Promise<ProbedRead | null>;
  /** 押す対象を、送信ボタンが見えるものと見えないものに分ける（読めなければ全部を見えるものに）。 */
  readonly splitByVisibility: (
    targets: readonly PressTarget[],
    backendNodeIds: readonly number[],
  ) => Promise<{ readonly visible: readonly PressTarget[]; readonly invisible: readonly PressTarget[] }>;
  /** 押す対象ごとの、共通の枠のボタンの識別と、同じ語の組の範囲の鍵。 */
  readonly targetContexts: (
    targets: readonly PressTarget[],
    backendNodeIds: readonly (number | undefined)[],
  ) => Promise<{ readonly digests: ReadonlyMap<number, string>; readonly scopes: ReadonlyMap<number, string> }>;
  /** 状態の構造の鍵（`given` があれば、その読み直しの候補を使う）。 */
  readonly stateStructureKeys: (location: CandidateLocation, given?: ProbedRead) => Promise<StateStructureKeys>;
  /** この画面の作りの印（読めなければ null）。 */
  readonly structureSignatures: () => Promise<unknown>;
  /** 送信の要素ごとに、開いた窓の中か（読めなければ null）。 */
  readonly readInOpenDialog: (backendNodeIds: readonly number[]) => Promise<unknown>;
  /** 読み直した候補を、発見の入口と同じ組み立てで候補にする（読めなければ null）。 */
  readonly classifyProbed: (
    location: CandidateLocation,
    record: DiscoveryReadPageRecord,
    reread: ProbedRead['outcome'],
    probed: readonly ProbedCandidate[],
    policy: SubmissionProbeTargetPolicy,
  ) => Promise<readonly DiscoveryCandidate[] | null>;
  /** 選択肢を選び、落ち着くまで待つ（選べたか）。 */
  readonly chooseAndSettle: (choice: SubmissionProbeChoice, dataActivity: ChoiceDataActivity | undefined) => Promise<boolean>;
  /** 今の状態の選べる欄の選択肢を 1 つずつ選ぶ（`surveyOptionChoices`）。 */
  readonly surveyOptions: (location: CandidateLocation, context: OptionSurveyContext) => Promise<OptionSurvey>;
  /** 押下の 1 つをたどって押し直す（`replayStep`）。 */
  readonly replayStep: (
    location: CandidateLocation,
    step: SubmissionProbeReplayStep,
    markers: string[],
    afterPress: AfterPressWait,
    onPress: (() => void) | undefined,
    startDocument: number | null,
    filledOriginals: FilledFieldOriginals,
    keptSelects: ReadonlySet<string>,
  ) => Promise<ReplayedPress | null>;
  /** 1 つの対象に入れて押し、観察の結果を返す（`pressOne`）。 */
  readonly pressTarget: (
    location: CandidateLocation,
    target: PressTarget,
    markers: string[],
    afterPress: AfterPressWait,
    onPress: (() => void) | undefined,
    opener: SubmissionProbeOpener | undefined,
    filledOriginals: FilledFieldOriginals,
  ) => Promise<PressOutcome>;
}

/** 本物の口（Playwright の page と、その Context の観察の口）。 */
export const submissionProbeLoopPortOf = (page: Page, observation: SubmissionObservation): SubmissionProbeLoopPort => Object.freeze<SubmissionProbeLoopPort>({
  observationActive: () => observation.active,
  endObservation: () => {
    observation.end();
  },
  freezeHolds: () => interactionFreezeHolds(page),
  guardClosedContext: () => guardClosedContext(page),
  documentGone: () => documentGoneOf(page),
  screenWatchEnded: () => screenWatchEnded(page),
  mainFrameUrl: () => page.mainFrame().url(),
  documentMarker: () => documentMarkerOf(page),
  sameDocumentMovedUrl: (startDocument: number | null) => sameDocumentMovedUrlOf(page, startDocument),
  movedUrl: (requested: string | null) => movedUrlOf(page, requested),
  watchNavigations: () => watchMainFrameNavigationRequests(page),
  readProbed: (location: CandidateLocation) => readProbed(page, location),
  splitByVisibility: (targets: readonly PressTarget[], backendNodeIds: readonly number[]) => splitByVisibility(page, targets, backendNodeIds),
  targetContexts: (targets: readonly PressTarget[], backendNodeIds: readonly (number | undefined)[]) => targetContextsOf(page, targets, backendNodeIds),
  stateStructureKeys: (location: CandidateLocation, given?: ProbedRead) => stateStructureKeyNow(page, location, given),
  structureSignatures: async () => {
    const read = await readInIsolatedWorld(page, structureSignaturesInPage, null, openReadDeadline());
    return read.status === 'READ' ? read.value : null;
  },
  readInOpenDialog: async (backendNodeIds: readonly number[]) => {
    const outcome = await readElementsInIsolatedWorld(page, readInOpenDialogInPage, {
      selector: OPEN_DIALOG_SELECTOR,
    } satisfies InOpenDialogInput, openReadDeadline(), { argumentElements: backendNodeIds });
    return outcome.status === 'READ' ? outcome.value : null;
  },
  classifyProbed: (location, record, reread, probed, policy) => classifyProbedCandidates(page, location, probed, { allowedOrigins: policy.allowedOrigins },
    (found) => probedIncompleteReasonsOf(page, record.incompleteReasons, reread, found)),
  chooseAndSettle: (choice: SubmissionProbeChoice, dataActivity: ChoiceDataActivity | undefined) => chooseAndSettle(page, choice, dataActivity),
  surveyOptions: (location: CandidateLocation, context: OptionSurveyContext) => surveyOptionChoices(page, location, context),
  replayStep: (location, step, markers, afterPress, onPress, startDocument, filledOriginals, keptSelects) =>
    replayStep(page, observation, location, step, markers, afterPress, onPress, startDocument, filledOriginals, keptSelects),
  pressTarget: (location, target, markers, afterPress, onPress, opener, filledOriginals) =>
    pressOne(page, observation, location, location.path, target, markers, afterPress, onPress, opener, true, filledOriginals),
});

/** RB-13: 1 つの対象を押すかの決めに使う、押す輪の状態（読むだけ）。 */
export interface ProbeLoopState {
  /** この画面で押しにかかった組（構造の鍵・押す組の digest・その中の順番。`processedKeyOf`）。 */
  readonly processed: ReadonlySet<string>;
  /** DEF-208-4（A）: 前の画面で押した共通の枠のボタン（構造の鍵つき）。 */
  readonly pressedEarlierLayouts: ReadonlySet<string>;
  /** DEF-208-2（C）: この画面で押して何も送らなかった語の組（構造の鍵つき）。 */
  readonly noRequestWords: ReadonlySet<string>;
}

/**
 * RB-13: 1 つの対象の事実（輪が口から読んだもの）。`freeze` は 2 段目の観察で、1 段目の決めが `READ_FREEZE` のときだけ読む（`HOLDS` は凍結の段、
 * `CLOSED_BY_GUARD` は凍結の段でなく Guard が Context を閉じ始めた、`NOT_HOLDING` はそのほか）。
 */
export interface ProbeTargetFacts {
  readonly stageKey: string;
  readonly layoutKey: string | undefined;
  readonly wordsKey: string | null;
  /** 押す前の画面の様子（Safety の記録がこの文書を使うのをやめると言ったら `CHANGED`）。 */
  readonly pageState: ProbePageState;
  /** COV-2: ほかの画面の同じ構造の鍵の状態で、同じ組を押したか。 */
  readonly pressedInSameState: boolean;
  /** この対象に、もう記録があるか（前の読み込みの記録か、この画面の記録）。 */
  readonly recorded: boolean;
  /** COV-2c fix round 3: 開き手の語だけの対象を、目印を入れた最初の読み込みの文書で押そうとしているか。 */
  readonly openerInMarkedDocument: boolean;
  readonly freeze?: 'HOLDS' | 'NOT_HOLDING' | 'CLOSED_BY_GUARD' | undefined;
}

/**
 * RB-13: 1 つの対象の決め。`SKIP` は押さない（`reason` が null なら記録を書かない。`leftBehind` は、作り直して押す並び: `QUEUE` は待ち行列を作った状態の並び、
 * `DOCUMENT` はこの文書で押した押下の並び）。
 */
export type ProbeStep =
  | { readonly kind: 'SKIP_PROCESSED' }
  | { readonly kind: 'SKIP'; readonly reason: SubmissionProbeNotObservedReason | null; readonly leftBehind: 'QUEUE' | 'DOCUMENT' | null }
  | { readonly kind: 'READ_FREEZE' }
  | { readonly kind: 'PRESS' };

const skipStepOf = (reason: SubmissionProbeNotObservedReason | null, leftBehind: 'QUEUE' | 'DOCUMENT' | null): ProbeStep =>
  ({ kind: 'SKIP', reason, leftBehind });

/**
 * RB-13（押す輪の 1 歩。純粋）: 1 つの対象を押すか。順は、押しにかかった組 → 共通の枠（DEF-208-4）→ 同じ語で何も送らなかった（DEF-208-2）→ 画面が移った・
 * Guard が閉じた（DEF-144）→ ほかの画面で押した組（COV-2）→ 凍結の段か（2 段目の観察。凍結の段でなければ押さない）→ 目印を入れた文書の開き手（COV-2c）。
 */
export const probeStepOf = (state: ProbeLoopState, facts: ProbeTargetFacts): ProbeStep => {
  if (state.processed.has(facts.stageKey)) return { kind: 'SKIP_PROCESSED' };
  if (facts.layoutKey !== undefined && state.pressedEarlierLayouts.has(facts.layoutKey)) return skipStepOf(SHARED_LAYOUT_PRESSED_PROBE_REASON, null);
  if (facts.wordsKey !== null && state.noRequestWords.has(facts.wordsKey)) return skipStepOf(SAME_WORDS_NO_REQUEST_PROBE_REASON, null);
  if (facts.pageState !== 'SAME') return skipStepOf(facts.pageState === 'CLOSED_BY_GUARD' ? 'CONTEXT_CLOSED_BY_GUARD' : 'PAGE_CHANGED', 'QUEUE');
  // COV-2c（I-2）: この画面で押しにかかった記録（押す時点の確かめが止めた押下など）は、飛ばした理由で書き直さない。
  if (facts.pressedInSameState) return skipStepOf(facts.recorded ? null : SAME_STATE_PRESSED_PROBE_REASON, null);
  if (facts.freeze === undefined) return { kind: 'READ_FREEZE' };
  if (facts.freeze === 'CLOSED_BY_GUARD') return skipStepOf('CONTEXT_CLOSED_BY_GUARD', 'QUEUE');
  if (facts.freeze === 'NOT_HOLDING') return skipStepOf('PRESS_FAILED', null);
  // COV-2c fix round 3（C-1）: 開き手は、目印を一度も入れていない文書で押す（呼ぶ側が読み込み直して押す）。
  if (facts.openerInMarkedDocument) return skipStepOf('PAGE_CHANGED', 'DOCUMENT');
  return { kind: 'PRESS' };
};

/**
 * 1 画面の候補に、送らずに観察する probe の結果を付ける（ファイルの先頭の説明）。対象がない・画面の場所がない記録は、そのまま返す。例外を投げない。
 */
export function probeDiscoveredSubmissions(
  page: Page,
  observation: SubmissionObservation,
  record: DiscoveryReadPageRecord,
  options: SubmissionProbeOptions,
): Promise<DiscoveryReadPageRecord> {
  return probeDiscoveredSubmissionsWith(submissionProbeLoopPortOf(page, observation), record, options);
}

/** 押す輪（RB-13。口を差し込める。押した後の待ちは口の `pressTarget` の中）。 */
export async function probeDiscoveredSubmissionsWith(
  port: SubmissionProbeLoopPort,
  record: DiscoveryReadPageRecord,
  options: SubmissionProbeOptions,
): Promise<DiscoveryReadPageRecord> {
  const { location } = record;
  if (location === null) {
    return record;
  }
  // DEF-144: 読み込み直した画面では、指定の対象（残りの候補）だけを押す。
  const { onlyCandidates } = options;
  /** 押す対象（記録の候補の位置）。LU-4（K6）: 押した後に開いた窓の中の候補を足す。 */
  const indices = record.candidates.flatMap((candidate, index) => (isSubmissionProbeTarget(candidate, options.targetPolicy)
    && (onlyCandidates === undefined || onlyCandidates.has(index)) ? [index] : []));
  // COV-3: 選択肢を選んで出た段（たどり直しの並びの最後が選ぶ選択肢）の読み込み直し。その段の対象は、前の記録の候補も含めて押しにかかる（押す組の記録で、同じ
  // 構造の鍵の組は押し直さない）。
  const replayTail = options.replay?.[options.replay.length - 1];
  const optionStageDoc = replayTail !== undefined && choiceOfReplayStep(replayTail) !== null;
  // COV-3: 選択肢を選んで段を探すとき（`onOptionStage` がある）は、押す対象のない画面でも選択肢を選ぶ。
  if (indices.length === 0 && !optionStageDoc && options.onOptionStage === undefined) {
    return record;
  }
  /** COV-3: 選択肢を選んだ欄の記録（記録の末尾に足す）。 */
  const optionRecords: DiscoveryOptionChoiceRecord[] = [];
  /** LU-4（K6）: 今の記録（押した後に開いた窓の中の候補を、末尾に足す。COV-1: 2 段目から後の段で新しく出た候補も末尾に足す）。 */
  let current = record;
  // COV-1（網羅の設計書 3.3）: 押す数の上限と、入れたのに押せなかった回の上限は使わない。終わりは状態の鍵で決める（`nextStage`）。
  /**
   * COV-2: 記録の候補の見分けの鍵（記録の候補の位置ごと。前の読み込みの鍵から始める）。COV-2b: あわせて、この文書の中の送信の要素の番号（同じ要素を同じ候補にする）。
   */
  const bindings: RecordBindings = { keys: new Map<number, string>(options.candidateKeys ?? []), nodes: new Map<number, number>() };
  const recordKeys = bindings.keys;
  const probes = new Map<number, SubmissionProbeRecord>();
  /** COV-1: 記録を書いた段（段をまたいで同じ候補を押したとき、強い記録を残す）。 */
  const probeStages = new Map<number, number>();
  /** COV-1: 今の段の番号（状態の構造の鍵が初めて出た順。1 から）と、この画面で押した押下の並び。 */
  let stageNumber = 1;
  /** COV-2c（M1）: 段の番号の始まり（読み込み直した画面では、たどり直しの押下の数）。 */
  let stageOffset = 0;
  const priorPresses: SubmissionProbePressStep[] = [];
  /**
   * COV-1: 記録を書く。同じ段の中では、今までどおり後の記録で書き直す。前の段の記録があれば、強さ（`submissionProbeStrengthOf`）が同じか弱い記録では書き直さない。
   * 2 段目から後の記録には、段の番号と、この押下の前の押下の並びを付ける。
   */
  const setProbe = (index: number, probe: SubmissionProbeRecord): void => {
    const earlier = probes.get(index);
    const earlierStage = probeStages.get(index);
    if (earlier !== undefined && earlierStage !== undefined && earlierStage !== stageNumber
      && submissionProbeStrengthOf(probe) <= submissionProbeStrengthOf(earlier)) {
      return;
    }
    // COV-3: 選択肢の段の読み込み直しでは、前の読み込みで付けた記録を、同じか弱い記録で書き直さない。
    const recorded = optionStageDoc && earlier === undefined ? current.candidates[index]?.submissionProbe : undefined;
    if (recorded !== undefined && submissionProbeStrengthOf(probe) <= submissionProbeStrengthOf(recorded)) {
      return;
    }
    probes.set(index, withSubmissionProbeStage(probe, { number: stageNumber, priorPresses }));
    probeStages.set(index, stageNumber);
  };
  /** COV-3: 返す記録（押下の結果と、選択肢を選んだ欄の記録）。 */
  const finish = (): DiscoveryReadPageRecord => withOptionChoices(withSubmissionProbes(current, probes), optionRecords);
  const markAll = (targets: readonly number[], reason: SubmissionProbeNotObservedReason): void => {
    for (const index of targets) {
      if (!probes.has(index)) setProbe(index, notObservedSubmissionProbeOf(reason));
    }
  };
  // L6/L3-1: 1 画面の見張りが画面を終えたときの記録（押しにかかった対象の記録は残し、まだ記録のない対象は、渡した理由で押せなかったとする）。
  options.onRecordSnapshot?.((reason) => {
    const ended = new Map(probes);
    for (const index of indices) {
      if (!ended.has(index)) ended.set(index, notObservedSubmissionProbeOf(reason));
    }
    return withOptionChoices(withSubmissionProbes(current, ended), optionRecords);
  });
  try {
    if (port.observationActive() || !(await port.freezeHolds())) {
      markAll(indices, 'PRESS_FAILED');
      return finish();
    }
    let startUrl = port.mainFrameUrl();
    // DEF-221: 押す前の文書の印（押した後に URL が変わったとき、同じ文書のままかを見分ける）。COV-1: 同じ文書の中の URL の変化は段の移りなので、口が
    // なくても読む。
    const startDocument = await port.documentMarker();
    const markers: string[] = [];
    /** COV-2c fix round 2: この文書で目印を入れた欄の、入れる前の値（開き手の前に戻す）。 */
    const filledOriginals: FilledFieldOriginals = new Map();
    // L6/L3-1 の続き（T18。設計者の判断 C）: 押した後は、最短の観察の長さ（`quietWaitMs`。既定 `SUBMISSION_PROBE_QUIET_WAIT_MS`）の後に、ページが落ち着くまで待つ。
    const afterPress: AfterPressWait = {
      minimumMs: options.quietWaitMs ?? SUBMISSION_PROBE_QUIET_WAIT_MS, dataActivity: options.dataActivity, recordUnusable: options.documentUnusable,
    };
    // COV-2c（SREV-COV の I-1 の 3）: 利用者の停止か Run の時間の上限に届いたら、押さずに終える（押していない対象には記録を付けない）。
    // L6/L3-1: 1 画面の見張りが画面を終えた後も、押さない（見放した処理が、後から押さないように）。
    const stopRequested = (): boolean => options.shouldStop?.() === true || port.screenWatchEnded();
    if (stopRequested()) {
      return finish();
    }
    // COV-2（設計書 3.2 の 2）: 読み込み直した画面で、残りの対象のあった状態を、押下の並びをたどって作り直す（記録は書き直さない。押せない・文書が替わったら、
    // 残りの対象は見つからなかったことにする）。
    const replaySteps = options.replay ?? [];
    /**
     * COV-2c fix round 4（SREV-COV 3 回目の Minor）: この文書で押した押下の並び（たどり直しの押下と、押した押下。押した順）。押せなかった開き手を、目印を入れた
     * 文書で押せるようになったときに、読み込み直してこの並びを押し直してから押すため（押せるようになった状態を作る）。
     */
    const docPressSteps: SubmissionProbeReplayStep[] = [];
    /** COV-3: たどり直しで選んだ select の `name`（押下の前に選び直さない）。 */
    const keptSelects = new Set<string>();
    for (const [at, step] of replaySteps.entries()) {
      if (stopRequested()) {
        return finish();
      }
      // COV-3: 選ぶ選択肢は、選び直す（選べない・画面が移ったら、その状態は作り直せない）。押下の並び（`priorPresses`）には入れない。
      const choice = choiceOfReplayStep(step);
      if (choice !== null) {
        if (!(await port.chooseAndSettle(choice, options.dataActivity)) || pageStateWith(port, startUrl) !== 'SAME') {
          markAll(indices, 'TARGET_NOT_FOUND');
          return finish();
        }
        if (choice.kind === 'SELECT') keptSelects.add(choice.name);
        docPressSteps.push(step);
        continue;
      }
      const replayed = await port.replayStep(location, step, markers, afterPress, options.onPress === undefined
        ? undefined
        : () => options.onPress?.(step.index, current.candidates[step.index]), startDocument, filledOriginals, keptSelects);
      if (replayed === null || replayed.after === 'MOVED') {
        markAll(indices, 'TARGET_NOT_FOUND');
        return finish();
      }
      // COV-2c（SREV-COV の M1）: たどり直しで押した押下も、この画面で押した押下の並びに入れる（残りの対象の記録に段の情報を残す）。段の番号は、たどり直しの
      // 押下の順（1 から）。
      priorPresses.push(Object.freeze({ stage: at + 1, identityDigest: replayed.target.identityDigest, ordinal: replayed.target.ordinal }));
      docPressSteps.push(step);
      startUrl = port.mainFrameUrl();
    }
    // COV-2c（M1）: たどり直した状態は、たどり直しの押下の数だけ後の段から数える（最初の読み込みは 1 段目から）。
    stageOffset = replaySteps.length;
    stageNumber = stageOffset + 1;
    // LU-SFIX2-A fix round 1: 押す対象の送信ボタンの番号を、対象を決めた読み直しと同じ読み取りから受ける（見えるかの確かめに使う。位置で引き直さない）。
    const reread = await port.readProbed(location);
    if (reread === null) {
      markAll(indices, 'TARGET_NOT_FOUND');
      return finish();
    }
    // COV-2: 最初の読み込みでは、発見の入口で読んだ同じ文書の候補に、識別の digest と順番で見分けの鍵を付ける。読み込み直した画面では、前の鍵で結ぶ。
    bindRecordCandidates(record, reread, bindings, options.candidateKeys === undefined, location);
    const { found: located, missing } = pressTargetsOf(record, indices, reread, bindings);
    const locatedIds = new Map(located.map((target) => [target.index, target.nodeId] as const));
    markAll(missing, 'TARGET_NOT_FOUND');
    // LU-4（D7。fix round 1）: 名前があり同じ識別の対象は、文書の順で最初の 1 つだけを押す対象に残す。残りは押さない（押す回数を使わない）。
    const { kept: found, sameIdentity } = firstOfEachNamedIdentity(record, located);
    markAll(sameIdentity, SAME_IDENTITY_PRESSED_PROBE_REASON);
    // T44c（Task 44 の設計書 P1-3）: 見えない対象は、押す数を数える前に除く（`TARGET_NOT_FOUND`。押す数の上限の後に並んでいても `PRESS_LIMIT_REACHED` に
    // しない）。押す順は、見える対象だけで決める。DEF-145 の読み直しは、ここで除いた対象も、押下で見えるようになったかを見る。
    const foundIds = found.map(({ index }) => locatedIds.get(index));
    const { visible, invisible } = await port.splitByVisibility(found, foundIds.every((id): id is number => id !== undefined) ? foundIds : []);
    markAll(invisible.map(({ index }) => index), 'TARGET_NOT_FOUND');
    // DEF-208-4（A）: 見える対象の、共通の枠のボタンの識別（この画面を始めた時点の、前の画面で押した識別と比べる）。
    const sharedLayout = options.sharedLayout;
    const pressedEarlier = new Set(sharedLayout?.pressed ?? []);
    // SREV-1105-3 の再レビューの Minor-B: 同じ読み取りで、祖先の form の範囲の鍵も読む（同じ語の組の決まりに使う）。
    const contexts = await port.targetContexts(visible, visible.map(({ index }) => locatedIds.get(index)));
    /** 共通の枠のボタンの識別と、同じ語の組の範囲の鍵（記録の候補の位置ごと。COV-1: 後の段の対象の分を足す）。 */
    const layoutDigests = new Map<number, string>(sharedLayout === undefined ? [] : contexts.digests);
    const scopes = new Map<number, string>(contexts.scopes);
    /** 押す順の待ち行列（DEF-145: 押下で開いたダイアログの中の送信ボタンを、先頭に足す。COV-1: 段が移ると、新しい段の対象で入れ替える）。 */
    const queue: PressTarget[] = openersFirst(submissionProbePressOrderOf(visible));
    /** DEF-145: 押下で新しく見えるようになったので、もう一度押しにかかった対象（1 対象 1 回まで）。 */
    const revisited = new Set<number>();
    /** LU-4: 読み直しで押しにかかった対象の、開き手の事実（記録の候補の位置ごと）。 */
    const openers = new Map<number, SubmissionProbeOpener>();
    /**
     * DEF-208-2（C）: この画面で、押して何も送らなかった（`NO_REQUEST`）送信ボタンの語の組の鍵（`submissionProbeWordsKeyOf`）。COV-1: 状態の構造の鍵つき
     * （構造の鍵が違う状態では押す）。
     */
    const noRequestWords = new Set<string>();
    /** COV-1: 今の段の状態の構造の鍵と、出た構造の鍵（出た順）。 */
    const initialKeys = await port.stateStructureKeys(location);
    let currentStructure = initialKeys.full;
    /** COV-2c: 今の段の、状態の語を入れない鍵（押下の後に文字だけが変わったかを見分ける）。 */
    let currentWithoutWords = initialKeys.withoutWords;
    /** SLK-1: 送信の要素の番号ごとの、共通の枠の部分の構造の鍵（段を読み直すたびに、読んだ要素の分を新しくする）。 */
    const layoutStructures = new Map<number, string>(initialKeys.layouts);
    const structures: string[] = [currentStructure];
    /**
     * COV-2: 状態の構造の鍵ごとの、その状態を作り直す押下の並び（最初に出たときの並び。読み込み直しの `replay` の続き）と、段を移した最後の押下と、今の待ち行列を
     * 作った状態の構造の鍵。
     */
    const trails = new Map<string, readonly SubmissionProbeReplayStep[]>([[currentStructure, options.replay ?? []]]);
    let lastMove: SubmissionProbeReplayStep | null = null;
    let queueStructure = currentStructure;
    /** COV-2: 押さないまま残った対象と、作り直す押下の並び（最初に残ったときの並び。終わりに、押さないままのものだけを知らせる）と、押した対象。 */
    const leftBehindTrails = new Map<number, readonly SubmissionProbeReplayStep[]>();
    const pressedIndices = new Set<number>();
    const reportLeftBehind = (index: number, structure: string): void => {
      if (!leftBehindTrails.has(index)) leftBehindTrails.set(index, trails.get(structure) ?? options.replay ?? []);
    };
    /** COV-1: この画面で押しにかかった（構造の鍵・候補の識別・同じ識別の中の順番）。同じ組は押し直さない。 */
    const processed = new Set<string>();
    /** COV-2c fix round 4（Minor）: 押せなかった（押せないボタン）組と、そのときのこの文書の押下の数。 */
    const disabledAt = new Map<string, number>();
    /** COV-1: 段が移ったので、押さないまま待ち行列から外した対象（最後に、記録のない対象を `PAGE_CHANGED` にする）。 */
    const leftBehind = new Set<number>();
    /**
     * COV-1: 段を読み直す（押した後に URL が同じ文書の中で変わった・状態の構造の鍵が変わった）。COV-3: 選択肢の段の読み込み直しでは、選んだ後の状態を新しい段として
     * 最初に読み直す（前の記録になかったボタンを候補に足す）。
     */
    let restage = optionStageDoc;
    /** COV-3: 選択肢を選んで出た状態の構造の鍵（この画面の中と、操作さがし全体の押す組の記録で、1 回だけ新しい段にする）。 */
    const seenOptionStates = new Set<string>();
    const isNewState = (structureKey: string): boolean => {
      const local = !seenOptionStates.has(structureKey);
      seenOptionStates.add(structureKey);
      const global = options.pressRegistry?.acceptPress({ structureKey, candidateIdentityDigest: OPTION_STATE_DIGEST, ordinal: 0 }) ?? true;
      return local && global;
    };
    isNewState(currentStructure);
    /**
     * COV-3: 選択肢を選び終えた欄（この画面の場所と欄の印。選んで出た段の読み込み直しでも、前の選びで分かった事実を使い、選び直さない）。操作さがし全体の押す組の
     * 記録には、画面の場所の印を構造の鍵の代わりに入れる。
     */
    const surveyedFields = new Set<string>();
    const pageKey = createSha256Fingerprint(JSON.stringify([OPTION_PAGE_FORMAT, location.origin, location.path]));
    const isFirstSurvey = (field: ChoosableField): boolean => {
      const digest = optionSurveyDigestOf(field);
      if (surveyedFields.has(digest)) return false;
      surveyedFields.add(digest);
      return options.pressRegistry?.acceptPress({ structureKey: pageKey, candidateIdentityDigest: digest, ordinal: 0 }) ?? true;
    };
    /** COV-3: 今の状態で選択肢を選ぶ段が残っているか（新しい段に初めて入ったときに選ぶ。値はその段の構造の鍵）。 */
    let surveyDue: string | null = null;
    /**
     * COV-3（網羅の設計書 3.3）: 今の状態の選べる欄の選択肢を 1 つずつ選び、まだ見ていない構造の鍵の状態になった選択肢を、新しい段として呼ぶ側に知らせる
     * （その状態を作る並びと、選ぶ選択肢）。選んだ欄の記録を足す。呼ぶ側が段を受けないときは選ばない。止めたら真。
     */
    const surveyOptions = async (structure: string): Promise<boolean> => {
      if (options.onOptionStage === undefined) return false;
      const survey = await port.surveyOptions(location, {
        stage: stageNumber, startUrl, dataActivity: options.dataActivity, isNewState, isFirstSurvey, shouldStop: stopRequested,
      });
      optionRecords.push(...survey.records);
      const base = trails.get(structure) ?? options.replay ?? [];
      for (const choice of survey.stages) options.onOptionStage([...base, choiceReplayStepOf(choice)]);
      return survey.stopped;
    };
    /**
     * COV-2c（SREV-COV の I-1）: この画面で今までに見た作りの印（L9 の `structureSignaturesInPage` を isolated world で読む。値を含まない）。押した後に新しい作りの
     * 印が出たか（`scrollStructureSignaturesOf`。伸び続ける画面の止め方と同じ判定）で、新しく出たボタンを候補にするかを決める。読めなければ、新しい作りは
     * 出なかったことにする（終わる側に倒す）。
     */
    const seenSignatures = new Set<string>();
    const signaturesGrew = async (): Promise<boolean> => {
      const value = await port.structureSignatures();
      return Array.isArray(value) && value.every((signature) => typeof signature === 'string')
        && scrollStructureSignaturesOf(seenSignatures, value as readonly string[]);
    };
    await signaturesGrew();
    /** COV-2c: 前の段の読み直しの後に、押下で新しい作りの印が出たか、と、その間に押した対象（記録の候補の位置。押した順）。 */
    let grewSinceStage = false;
    const pressedSinceStage: number[] = [];
    /** COV-2c: 押下の鎖を閉じた印（`NO_NEW_STRUCTURE`）を、その押下の記録に付ける。 */
    const closeChainAt = (index: number | undefined): void => {
      const probe = index === undefined ? undefined : probes.get(index);
      if (index !== undefined && probe !== undefined) probes.set(index, withSubmissionProbeChainEnd(probe, 'NO_NEW_STRUCTURE'));
    };
    /**
     * COV-1: 次の段の対象（ファイルの先頭の 12）。画面を読み直し、状態の構造の鍵を求め、新しく出た対象の候補を記録の末尾に足し、まだ押しにかかっていない
     * （構造の鍵・識別・順番の）見える対象を押す順に並べて返す。画面が移った・凍結の段でない・読めないときは空（終わる）。
     */
    const nextStage = async (urlMoved: boolean): Promise<readonly PressTarget[]> => {
      if (pageStateWith(port, startUrl) !== 'SAME' || !(await port.freezeHolds())) {
        return [];
      }
      // COV-2b: 記録の候補に結んだ要素（この文書の送信の要素の番号）のない、押せる位置の送信の要素の候補を、新しい候補にする（段をまたいで、同じ深さ・同じ識別の
      // 文字のないボタンが入れ替わっても、別の要素なので別の候補にする）。
      const all = await port.readProbed(location);
      if (all === null) {
        return [];
      }
      // 区画を描き直した画面では、同じ鍵の新しい要素を前の候補に結び直す（新しい候補にしない）。
      rebindVanished(all, bindings);
      const knownNodes = new Set(bindings.nodes.values());
      const unboundIndexes = all.candidates.flatMap((_probed, index) => {
        const node = all.nodeIds.get(index);
        return node !== undefined && !knownNodes.has(node) ? [index] : [];
      });
      const previousStructure = currentStructure;
      const keyNow = await port.stateStructureKeys(location);
      for (const [node, layoutStructure] of keyNow.layouts) layoutStructures.set(node, layoutStructure);
      // COV-2c（SREV-COV の I-1 の 1）: 前の段の後の押下が新しい作りの印を出さず、状態の語のほかの構造の鍵（見える欄・開いた窓・見出しや landmark の有無・
      // 候補の型の集合）も変えなかった（同じ作りの部品が増えただけ。「もっと見る」が同じボタンを足す画面、押すと「エラー」の文字が出るだけの画面など）なら、
      // 新しい状態とみなさない（今の段の構造の鍵のまま。新しく出たボタンを候補にしない）。その押下の鎖を閉じ、理由を記録する（`NO_NEW_STRUCTURE`）。同じ文書の
      // まま URL が変わったときは、場所が変わったので新しい状態にする。構造の鍵は数を入れない集合なので、作りの印の出ない変化で状態が増え続けることはない。
      const newState = urlMoved || grewSinceStage || keyNow.withoutWords !== currentWithoutWords;      if (newState) {
        currentStructure = keyNow.full;
        currentWithoutWords = keyNow.withoutWords;
      } else if (unboundIndexes.length > 0 || keyNow.full !== currentStructure) {
        closeChainAt(pressedSinceStage[pressedSinceStage.length - 1]);
      }
      const freshIndexes = newState ? unboundIndexes : [];
      grewSinceStage = false;
      pressedSinceStage.splice(0, pressedSinceStage.length);
      if (!structures.includes(currentStructure)) {
        structures.push(currentStructure);
        // COV-3: 初めて入った段では、押す前に選択肢を選ぶ（この状態も、選んで出た状態として見たことにする）。
        isNewState(currentStructure);
        surveyDue = currentStructure;
      }
      stageNumber = stageOffset + structures.indexOf(currentStructure) + 1;
      // COV-2: 初めて出た状態の、作り直す押下の並び（前の状態の並びと、段を移した押下）。
      if (!trails.has(currentStructure)) {
        const base = trails.get(previousStructure) ?? options.replay ?? [];
        trails.set(currentStructure, lastMove === null ? base : [...base, lastMove]);
      }
      const added = await freshTargetCandidatesOf(port, location, current, all, options.targetPolicy, freshIndexes);
      if (added.length > 0) {
        added.forEach(({ rereadIndex }, at) => {
          const matchKey = all.keys.match[rereadIndex];
          const node = all.nodeIds.get(rereadIndex);
          if (matchKey !== undefined) bindings.keys.set(current.candidates.length + at, matchKey);
          if (node !== undefined) bindings.nodes.set(current.candidates.length + at, node);
        });
        current = Object.freeze({ ...current, candidates: Object.freeze([...current.candidates, ...added.map(({ candidate }) => candidate)]) });
      }
      const stageIndices = current.candidates.flatMap((candidate, index) => (isSubmissionProbeTarget(candidate, options.targetPolicy)
        && (onlyCandidates === undefined || optionStageDoc || index >= record.candidates.length || onlyCandidates.has(index)) ? [index] : []));
      for (const index of stageIndices) {
        if (!indices.includes(index)) indices.push(index);
      }
      const stageSplit = pressTargetsOf(current, stageIndices, all, bindings);
      const stageIds = new Map(stageSplit.found.map((target) => [target.index, target.nodeId] as const));
      // LU-4（D7）: 同じ識別の開き手は、この状態の中で文書の順の最初の 1 つだけ（COV-1: 鍵は状態の構造の鍵・識別。押しにかかった組を除く前に決める）。
      const { kept: firsts, sameIdentity: repeated } = firstOfEachNamedIdentity(current, stageSplit.found);
      for (const index of repeated) {
        setProbe(index, notObservedSubmissionProbeOf(SAME_IDENTITY_PRESSED_PROBE_REASON));
      }
      // COV-2c fix round 4（Minor）: 押せなかった対象は、その後にほかの押下があったときだけ、押せるようになったかをもう一度確かめる（押せる候補の集まりが変わらなく
      // なったら、もう並べない。回数の上限は置かない）。
      const kept = firsts.filter((target) => {
        const key = processedKeyOf(currentStructure, target);
        return !processed.has(key) && disabledAt.get(key) !== docPressSteps.length;
      });
      const keptIds = kept.map(({ index }) => stageIds.get(index));
      const shown = (await port.splitByVisibility(kept, keptIds.every((id): id is number => id !== undefined) ? keptIds : [])).visible;
      const stageContexts = await port.targetContexts(shown, shown.map(({ index }) => stageIds.get(index)));
      if (sharedLayout !== undefined) {
        for (const [index, digest] of stageContexts.digests) layoutDigests.set(index, digest);
      }
      for (const [index, scope] of stageContexts.scopes) scopes.set(index, scope);
      // DEF-238 の設計書 3.1 の 4: まだ押せていない対象（押せなかった「作成」・後から出た候補）を、前の段で押した対象より先に押す（前の段で押した開く操作を
      // 先に押し直して、開いた欄を閉じないため）。それぞれの中は押す順（`submissionProbePressOrderOf`）。
      const ordered = submissionProbePressOrderOf(shown);
      const pressedBefore = (target: PressTarget): boolean =>
        priorPresses.some((step) => step.identityDigest === target.identityDigest && step.ordinal === target.ordinal);
      return openersFirst([...ordered.filter((target) => !pressedBefore(target)), ...ordered.filter(pressedBefore)]);
    };
    /** COV-1: 次に押しにかかる対象（段を読み直す印があるか、待ち行列が空なら、次の段の対象で入れ替える。次の段に対象がなければ、残りを続ける）。 */
    const nextTarget = async (): Promise<PressTarget | undefined> => {
      // L10 の調べの直し（安全）: この文書を使うのをやめたら、段の読み直しも選択肢の選びもしない（この page に 1 手を重ねない）。
      if (port.documentGone() || afterPress.recordUnusable?.() === true) {
        abandoned = true;
        return undefined;
      }
      if (restage || queue.length === 0) {
        const moved = restage;
        restage = false;
        const leftStructure = queueStructure;
        const next = await nextStage(moved);
        if (next.length > 0) {
          if (moved) {
            for (const left of queue) {
              leftBehind.add(left.index);
              // COV-2: 元の状態は、呼ぶ側が読み込み直し、押下の並びをたどって作り直して押す。
              reportLeftBehind(left.index, leftStructure);
            }
          }
          queue.splice(0, queue.length, ...next);
          queueStructure = currentStructure;
        }
        // COV-3: 初めて入った段では、押す前に選択肢を選ぶ。
        if (surveyDue !== null) {
          const due = surveyDue;
          surveyDue = null;
          if (await surveyOptions(due)) stopped = true;
        }
      }
      return queue.shift();
    };
    /** COV-2c（I-1 の 3）: 利用者の停止か Run の時間の上限で、押す輪を途中で終えたか。 */
    let stopped = false;
    /** L10 の調べの直し（安全）: この文書を使うのをやめたので、押す輪を途中で終えたか。 */
    let abandoned = false;
    // COV-3: 最初の状態の選択肢を、押す前に選ぶ（選んだ後は、もとの選択肢に戻す）。
    if (await surveyOptions(currentStructure)) stopped = true;
    // COV-3: 選択肢の段の読み込み直しは、待ち行列が空でも、選んだ後の状態の段を読み直して始める。
    const firstTarget = stopped ? undefined : (queue.length > 0 || !restage ? queue.shift() : await nextTarget());
    for (let target = firstTarget; target !== undefined; target = await nextTarget()) {
      if (stopRequested()) {
        stopped = true;
        break;
      }
      // L10 の調べの直し（安全）: この文書を使うのをやめた（文書が消えた・Safety の記録が言った）ら、この page では、もう何もしない（押さない・入れない・選ばない。
      // 段の読み直しもしない）。見放した 1 手が残っていても、この page に次の 1 手を重ねない。まだ記録のない対象は、作り直す押下の並びを付けて `PAGE_CHANGED` にし、
      // 呼ぶ側が新しい Context で読み込み直して押す（この Context は、呼ぶ側が印を付けて閉じる。凍結は戻せないので、見放した 1 手が動いても凍結の中）。
      if (port.documentGone() || afterPress.recordUnusable?.() === true) {
        abandoned = true;
        break;
      }
      const opener = openers.get(target.index);
      // RB-13: 押すかの決めは純粋な 1 歩（`probeStepOf`）。凍結の段かは、ほかの決めを通った対象だけ読む（2 段目の観察）。
      // DEF-208-2（設計書 3.3）・COV-1: 同じ語の組の鍵は、状態の構造の鍵つき（構造の鍵が違う状態では押す）。DEF-208-4（設計書 3.7 の A）・SLK-1: 共通の枠の
      // 鍵は、枠の部分の構造の鍵つき（枠の部分の作りが違えば押す。枠の部分を読めなければ印を作らず押す）。
      const layoutDigest = layoutDigests.get(target.index);
      const layoutStructure = target.nodeId === undefined ? undefined : layoutStructures.get(target.nodeId);
      const layoutKey = layoutDigest === undefined || layoutStructure === undefined ? undefined : sharedLayoutStateKeyOf(layoutStructure, layoutDigest);
      const scopedWords = submissionProbeWordsKeyOf(target.submitterWords, scopes.get(target.index) ?? target.scopeKey);
      const wordsKey = scopedWords === null ? null : JSON.stringify([currentStructure, scopedWords]);
      const opensRow = isOpenerOnlySubmitter(target.submitterWords);
      const markedDocument = markers.length > 0;
      const stageKey = processedKeyOf(currentStructure, target);
      const loopState: ProbeLoopState = { processed, pressedEarlierLayouts: pressedEarlier, noRequestWords };
      const facts: ProbeTargetFacts = {
        stageKey,
        layoutKey,
        wordsKey,
        // L10 の調べの直し: Safety の記録がこの文書を使うのをやめると言ったら、画面が移ったのと同じ（残りは読み込み直した文書で押す）。
        pageState: afterPress.recordUnusable?.() === true ? 'CHANGED' : pageStateWith(port, startUrl),
        pressedInSameState: options.pressRegistry?.hasPressed(pressKeyOf(currentStructure, target)) === true,
        recorded: current.candidates[target.index]?.submissionProbe !== undefined || probes.has(target.index),
        openerInMarkedDocument: opensRow && markedDocument && onlyCandidates === undefined,
      };
      let step = probeStepOf(loopState, facts);
      if (step.kind === 'READ_FREEZE') {
        const freeze = await port.freezeHolds() ? 'HOLDS' : port.guardClosedContext() ? 'CLOSED_BY_GUARD' : 'NOT_HOLDING';
        step = probeStepOf(loopState, { ...facts, freeze });
      }
      if (step.kind === 'SKIP_PROCESSED') {
        continue;
      }
      processed.add(stageKey);
      if (step.kind === 'SKIP') {
        if (step.reason !== null) setProbe(target.index, notObservedSubmissionProbeOf(step.reason, undefined, [], opener));
        // COV-2: 元の状態は、呼ぶ側が読み込み直して作り直して押す。
        if (step.leftBehind === 'QUEUE') reportLeftBehind(target.index, queueStructure);
        // COV-2c fix round 4（Minor）: 読み込み直した文書で、この文書で押した押下の並びを押し直す（前の押下で押せるようになった開き手も、押せる状態にしてから押す）。
        if (step.leftBehind === 'DOCUMENT' && !leftBehindTrails.has(target.index)) leftBehindTrails.set(target.index, [...docPressSteps]);
        continue;
      }
      const pressed = target;
      const onPress = options.onPress === undefined ? undefined : (): void => options.onPress?.(pressed.index, current.candidates[pressed.index]);
      // DEF-190: 開き手の語だけの対象の押下の間に main frame が始めた移動の URL（移りを止めた画面に替わったときに、移ろうとした先を知るため）。
      const navigationWatch = options.onOpenerPageChanged !== undefined && opensRow
        ? port.watchNavigations()
        : null;
      // COV-2b（網羅の設計書 3.2 の 1 の「押した後の画面」）: 開き手でない押下の間の、GET の文書の移動（押して文書が替わった移り先）も見る。
      const moveWatch = options.onPageMoved !== undefined && !opensRow ? port.watchNavigations() : null;
      let outcome: PressOutcome;
      try {
        // COV-1: 入れたのに押せなかった回の上限はない（入れる前から押せないボタンにも、欄があれば入れて読む）。
        outcome = await port.pressTarget(location, target, markers, afterPress, onPress, opener, filledOriginals);
      } finally {
        navigationWatch?.stop();
        moveWatch?.stop();
      }
      // COV-2b: 押下の間に GET の文書の移動があれば（Guard が止めた移動も含む）、その行き先を渡す。目印が query の値に入っていれば、その名前も渡す（呼ぶ側が
      // 場所の鍵と記録で伏せる）。読むかどうかは呼ぶ側が決める。
      // COV-2c（SREV-COV の I-4）: 移り先を出した押下までの押下の並び（この状態を作り直す並びと、この押下）も渡す（呼ぶ側が再開の後に押し直して作り直す）。
      const moveTrail: readonly SubmissionProbeReplayStep[] = [
        ...(trails.get(currentStructure) ?? options.replay ?? []),
        { index: target.index, matchKey: target.matchKey, ordinal: target.ordinal },
      ];
      const movedGetUrl = moveWatch?.lastBlockedMoveUrl() ?? null;
      if (movedGetUrl !== null && /^https?:/iu.test(movedGetUrl)) {
        options.onPageMoved?.({ url: movedGetUrl, markerQueryNames: markerQueryNamesOf(movedGetUrl, markers), trail: moveTrail, markerValues: [...markers] });
      }
      // DEF-144: 押す前に外部スキームを指すと見分けた対象は、押さずに `EXTERNAL_SCHEME`（押す回数を使わない）。
      if (outcome.kind === 'EXTERNAL_SCHEME') {
        setProbe(target.index, externalSchemeSubmissionProbeOf(opener));
        continue;
      }
      // COV-2: 待ち行列を作った状態から段が移った後に見つからなかった対象は、段が移って押さないまま残った対象にする（呼ぶ側が元の状態を作り直して押す）。
      if (outcome.kind === 'NOT_OBSERVED' && outcome.reason === 'TARGET_NOT_FOUND' && currentStructure !== queueStructure) {
        setProbe(target.index, notObservedSubmissionProbeOf('PAGE_CHANGED', undefined, [], opener));
        reportLeftBehind(target.index, queueStructure);
        continue;
      }
      /**
       * COV-1: 押した（押したかが分からない）押下か（押す前に見えない・読めない対象と、押せない送信ボタンは押していない）。COV-2c（SREV-COV の I-2）: 押す時点の
       * 確かめが止めた押下も押していない（押した組に入れない。番号だけ違う同じ作りの画面で、もう一度押しにかかる）。
       */
      const counted = outcome.kind === 'OBSERVED'
        || (outcome.reason !== 'TARGET_NOT_FOUND' && outcome.reason !== DISABLED_SUBMITTER_PROBE_REASON && outcome.reason !== COVERED_BY_OTHER_PROBE_REASON
          // SD-1: 削除に関する操作で押さなかった押下も、押していない。
          && outcome.reason !== DESTRUCTIVE_ACTION_SKIPPED_PROBE_REASON && outcome.pressStopped !== true);
      // COV-2c fix round 4（Minor）: 押せないボタンだった対象は、押しにかかった組から外し、そのときの押下の数を覚える（この後にほかの押下があれば、次の段の読み直しで
      // もう一度確かめる）。L6/L3-1 の続き（A1）: 覆われていた対象も同じ（窓を閉じる押下の後に、もう一度確かめる）。
      if (outcome.kind === 'NOT_OBSERVED' && (outcome.reason === DISABLED_SUBMITTER_PROBE_REASON || outcome.reason === COVERED_BY_OTHER_PROBE_REASON)) {
        processed.delete(stageKey);
        disabledAt.set(stageKey, docPressSteps.length);
      }
      if (counted) {
        options.onPressCounted?.(target.index);
        // COV-2: 押した組を、操作さがし全体の記録に入れる。段を移したかを見るため、最後の押下を覚える。
        options.pressRegistry?.acceptPress(pressKeyOf(currentStructure, target));
        lastMove = { index: target.index, matchKey: target.matchKey, ordinal: target.ordinal };
        docPressSteps.push(lastMove);
        pressedIndices.add(target.index);
        // DEF-208-4（A）: 押した共通の枠のボタンの識別を知らせる（COV-1: 状態の構造の鍵つき。同じ構造の鍵の状態では押し直さない）。
        if (layoutKey !== undefined) {
          sharedLayout?.onPressed(layoutKey);
        }
      }
      const fields = outcome.kind === 'OBSERVED'
        ? { filledFieldCount: outcome.record.filledFieldCount, skippedFieldCount: outcome.record.skippedFieldCount }
        : outcome.fields;
      const inputFields = outcome.kind === 'OBSERVED' ? outcome.record.inputFields ?? [] : outcome.inputFields;
      const after = pageStateWith(port, startUrl);
      // DEF-221（設計書 3.2 の 1）: 同じ文書のまま URL が変わった（`pushState`・`replaceState`・ハッシュ）ときは、変わった後の URL を渡す（読む画面にするかは
      // 呼ぶ側が決める）。DEF-190 の開き手の移った先（文書が替わった移動）は今のまま。
      const sameDocumentUrl = after === 'CHANGED' ? await port.sameDocumentMovedUrl(startDocument) : null;
      if (sameDocumentUrl !== null) {
        // COV-2c（SREV-COV の I-3・I-4）: 値に目印を含む query の名前（呼ぶ側が場所の鍵と記録で伏せる）と、押下の並びも渡す。
        options.onSameDocumentUrlChanged?.(sameDocumentUrl, {
          markerQueryNames: markerQueryNamesOf(sameDocumentUrl, markers), trail: moveTrail, markerValues: [...markers],
        });
      } else if (after === 'CHANGED' && navigationWatch !== null) {
        const movedUrl = port.movedUrl(navigationWatch.lastUrl());
        // COV-2c（C-1）: 開き手の移り先にも、目印の名前と押下の並びを渡す（呼ぶ側が凍結の中で読む）。
        if (movedUrl !== null) {
          options.onOpenerPageChanged?.(movedUrl, {
            markerQueryNames: markerQueryNamesOf(movedUrl, markers), trail: moveTrail, markedDocument, markerValues: [...markers],
          });
        }
      }
      // DEF-208-3（設計書 3.5 の G）: 画面が移らなかった（Guard が文書の移動を止め、URL が変わらなかった。押下で開いた別の page を含む）ときも、止めた移動の
      // 行き先を、移った先の候補として渡す（読むかどうかと、同じ Origin・読まないパスでない・1 つ下の番号の path の条件は、呼ぶ側の `openedEditPageOf` が決める）。
      const blockedMoveUrl = after === 'SAME' ? navigationWatch?.lastBlockedMoveUrl() ?? null : null;
      if (blockedMoveUrl !== null && /^https?:/iu.test(blockedMoveUrl)) {
        options.onOpenerPageChanged?.(blockedMoveUrl, {
          markerQueryNames: markerQueryNamesOf(blockedMoveUrl, markers), trail: moveTrail, markedDocument, markerValues: [...markers],
        });
      }
      const resultRecord = outcome.kind === 'OBSERVED' ? outcome.record : notObservedSubmissionProbeOf(outcome.reason, fields, inputFields, opener);
      if (after !== 'SAME' && sameDocumentUrl === null) {
        setProbe(target.index, notObservedSubmissionProbeOf(
          after === 'CLOSED_BY_GUARD' ? 'CONTEXT_CLOSED_BY_GUARD' : 'PAGE_CHANGED',
          fields,
          inputFields,
          opener,
        ));
        continue;
      }
      // COV-1（DEF-238 の設計書 3.1 の 3）: 同じ文書のまま URL が変わった押下も、観察した送信の形を捨てずに記録し、新しい段として読み直す（打ち切らない）。
      setProbe(target.index, resultRecord);
      /** COV-2c（I-1）: 押した後に新しい作りの印が出たか。 */
      let grewNow = false;
      if (counted) {
        priorPresses.push(Object.freeze({ stage: stageNumber, identityDigest: target.identityDigest, ordinal: target.ordinal }));
        grewNow = await signaturesGrew();
        if (grewNow) grewSinceStage = true;
        pressedSinceStage.push(target.index);
      }
      if (sameDocumentUrl !== null) {
        // COV-1: 画面の path が同じ（query・ハッシュだけの変化）なら、同じ画面の新しい段として続ける。path が変わったら、その画面は発見の流れが別の画面として
        // 読む（DEF-221。`onSameDocumentUrlChanged`）ので、この画面の残りは今のとおり `PAGE_CHANGED`（候補を別の画面の記録に入れない）。
        if (pathOfUrl(sameDocumentUrl) === location.path) {
          startUrl = port.mainFrameUrl();
          restage = true;
        }
        continue;
      }
      // DEF-208-2（C）: 何も送らなかった押下の語の組を覚える（同じ語の組の 2 つ目からは押さない）。
      if (outcome.kind === 'OBSERVED' && outcome.record.result === 'NO_REQUEST' && wordsKey !== null) {
        noRequestWords.add(wordsKey);
      }
      // DEF-145（設計書 `2026-10-21-beaksight-probe-navigation-and-dialog-design.md` 2.2）: 押下が何も送らず（`NO_REQUEST`）、回数が残っていれば、押す前は
      // 見えなかった（かなかった）登録・更新の語の送信ボタン（`TARGET_NOT_FOUND` の対象）が、押下で開いたダイアログなどで見えるようになったかを読み直し、
      // 見つかった対象を先に押す（結果は元の候補に記録する。押す前の見分けは、ほかの対象と同じく `pressOne` が行う）。
      // DEF-186（設計書 `2026-11-02-beaksight-list-row-update-design.md` 5.1 の 4）: 開き手の側の要求（`OPENER_SIDE_REQUEST`。開くとサイトが下書きを送る）の
      // 押下も、窓の中の保存を押すために読み直す（押す回数の上限は同じ）。
      /**
       * L6/L3-1（指示書の 4「無駄な繰り返し」）: 押した後の状態の構造の鍵（下の DEF-145 の読み直しがあれば、その読み取りの候補から作る。押した後に押す・入れる
       * 操作をしないうちに 2 回目の候補の読み取りをしない）。
       */
      let keysAfterPress: Promise<StateStructureKeys> | null = null;
      let rereadForKeys: ProbedRead | undefined;
      if (outcome.kind === 'OBSERVED' && opensDialogLikely(outcome.record)) {
        // LU-4（K6）・LU-SFIX2-A fix round 1: 記録になかった（同じ識別の digest の候補のない）送信ボタンの番号を、同じ読み取りから受ける（窓の中かの確かめに使う）。
        // COV-2: 見分けの鍵（識別の digest と位置の手がかり）で比べる。
        const known = new Set(recordKeys.values());
        const rereadAfter = await port.readProbed(location);
        if (rereadAfter !== null) {
          rereadForKeys = rereadAfter;
          const keysOfReread = (): Promise<StateStructureKeys> => (keysAfterPress ??= port.stateStructureKeys(location, rereadAfter));
          rebindVanished(rereadAfter, bindings);
          const unknownIndexes = rereadAfter.candidates.flatMap((_probed, index) => (!known.has(rereadAfter.keys.match[index] ?? '')
            && rereadAfter.nodeIds.has(index) ? [index] : []));
          // COV-2c（SREV-COV の I-1 の 1）: 新しい作りの印を出さず、状態の語のほかの構造の鍵（候補の型の集合を含む）も変えなかった押下で出たボタンは、同じ作りの
          // 部品が増えただけ。候補にせず、鎖を閉じる。
          const freshAllowed = unknownIndexes.length === 0 || grewNow
            || (await keysOfReread()).withoutWords !== currentWithoutWords;
          if (!freshAllowed) closeChainAt(target.index);
          const freshIndexes = freshAllowed ? unknownIndexes : [];
          const hidden = indices.filter((index) => !revisited.has(index)
            && probes.get(index)?.reason === 'TARGET_NOT_FOUND'
            && hasSubmissionProbePriorityWord(current.candidates[index]?.submitterWords ?? []));
          const reappeared = hidden.length === 0 ? [] : pressTargetsOf(current, hidden, rereadAfter, bindings).found;
          // LU-4（K6）: 押す前の記録になかった、開いた窓の中のボタンを候補にして、記録の末尾に足す。
          const added = await openedDialogCandidatesOf(port, location, current, rereadAfter, options.targetPolicy, freshIndexes);
          if (added.length > 0) {
            for (const { target: next } of added) {
              recordKeys.set(next.index, next.matchKey);
              if (next.nodeId !== undefined) bindings.nodes.set(next.index, next.nodeId);
            }
            current = Object.freeze({ ...current, candidates: Object.freeze([...current.candidates, ...added.map(({ candidate }) => candidate)]) });
            indices.push(...added.map(({ target: next }) => next.index));
          }
          const { kept: revealed, sameIdentity: repeated } = firstOfEachNamedIdentity(current, submissionProbePressOrderOf([
            ...reappeared,
            ...added.map(({ target: next }) => next),
          ]));
          markAll(repeated, SAME_IDENTITY_PRESSED_PROBE_REASON);
          // LU-4（設計書 5.1 の 2）: 読み直しで押しにかかる対象に、押した開き手の事実を結ぶ（値は持たない）。LU-SFIX1（LU-SREV1 の Minor-3）: 開き手の語
          // （`DISCOVERY_OPENER_WORDS`。`submissionProbeOpenerOf` の `openerWords`）のある押下に限る（窓の中の保存を押した後の読み直しで押す対象には付けない）。
          const openerDigest = current.candidates[target.index]?.identityDigest;
          const openerFacts = openerDigest === undefined ? undefined : submissionProbeOpenerOf(openerDigest, target.hasSubmitterText, target.submitterWords);
          // LU-11 fix round 2（設計者の判断。選択肢 1）: 開き手の押下で見えるようになった、同じ行のフォーム（`rowOpener` で結んだもの）の欄の見え方を、同じ読み直し
          // （`rereadAfter`）で記録し直す（欄の形と識別の digest が同じときだけ。判定は `withRevealedRowFormFields`）。
          if (openerDigest !== undefined && openerFacts !== undefined && openerFacts.openerWords.length > 0) {
            const relinked = withRevealedRowFormFields(current.candidates, location, openerDigest, rereadAfter.candidates);
            if (relinked !== current.candidates) {
              current = Object.freeze({ ...current, candidates: Object.freeze([...relinked]) });
            }
          }
          for (const next of revealed) {
            revisited.add(next.index);
            if (openerFacts !== undefined && openerFacts.openerWords.length > 0) openers.set(next.index, openerFacts);
          }
          queue.unshift(...submissionProbePressOrderOf(revealed));
        }
      }
      // COV-1（設計書 3.2 の 2）: 押した後の状態の構造の鍵が、今の段と違えば、新しい段として読み直す（同じ構造の鍵に戻ったときは、まだ押していない組だけを押す）。
      // COV-2c（SREV-COV の I-1 の 1）: 新しい作りの印を出したか、状態の語のほかの鍵が変わった押下だけ。状態の語だけが変わった押下は新しい状態とみなさず、
      // その押下の鎖を閉じたことを記録する（`NO_NEW_STRUCTURE`）。
      const keysAfter = counted ? await (keysAfterPress ?? port.stateStructureKeys(location, rereadForKeys)) : null;
      if (keysAfter !== null && keysAfter.full !== currentStructure) {
        if (grewNow || keysAfter.withoutWords !== currentWithoutWords) {
          restage = true;
        } else {
          closeChainAt(target.index);
        }
      }
    }
    // L10 の調べの直し（安全）: この文書を使うのをやめたときは、まだ記録のない対象を、作り直す押下の並びを付けて `PAGE_CHANGED` にする（新しい Context で押す）。
    if (abandoned) {
      for (const index of indices) {
        if (probes.has(index)) continue;
        setProbe(index, notObservedSubmissionProbeOf('PAGE_CHANGED', undefined, [], openers.get(index)));
        reportLeftBehind(index, queueStructure);
      }
    }
    // COV-1: 段が移ったので押さないまま外した対象と、どの段でも押しにかからなかった対象。
    markAll([...leftBehind], 'PAGE_CHANGED');
    if (stopped) {
      // COV-2c（I-1 の 3）: 止めたので押さなかった対象には記録を付けず、読み込み直しても押さない（残りを知らせない）。
      options.onCandidateKeys?.(new Map(recordKeys));
      return finish();
    }
    markAll(indices, 'TARGET_NOT_FOUND');
    // COV-2: 押さないまま残った（段が移った・画面が移った・Guard が閉じた）対象だけを、作り直す押下の並びと一緒に知らせる。
    for (const [index, trail] of leftBehindTrails) {
      const reason = probes.get(index)?.reason;
      if (!pressedIndices.has(index) && (reason === 'PAGE_CHANGED' || reason === 'CONTEXT_CLOSED_BY_GUARD')) options.onLeftBehind?.(index, trail);
    }
    options.onCandidateKeys?.(new Map(recordKeys));
  } catch {
    // 予期しない誤り（文は値を含みうるので捨てる）。まだ結果のない対象は、押したかが分からない。
    if (port.observationActive()) {
      try {
        port.endObservation();
      } catch {
        // 閉じられなければ、口は次の画面の Context では使わない（Context ごとの口）。
      }
    }
    // DEF-144: Guard が Context を閉じ始めた後の誤りは、その理由で記録する。
    markAll(indices, port.guardClosedContext() ? 'CONTEXT_CLOSED_BY_GUARD' : 'PRESS_FAILED');
  }
  return finish();
}
