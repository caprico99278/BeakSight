/**
 * シナリオの画面のための、承認の判定に渡す管理データの外の事実（認証の設定の digest と、ターゲットの設定の digest）（Task 28 の設計書 3 章の
 * 「承認を縛るもの」、4.6。T28e）。サーバだけで使う（ブラウザ側のコードは import しない。`scenario-functions.ts` だけが使う）。
 * - T28R-fix-1（独立レビュー T28R の I-1、台帳の CC-080 (a)）: 求め方は `src/control/approval-external-facts.ts` の `approvalExternalFactsOf` に移した
 *   （書き込みのジョブ（Task 30）と同じ求め方。資格情報を削除して登録し直しても、資格情報の変更の最後の出来事の id で再承認になる）。ここは、画面の
 *   サーバの依存（管理データ、リポジトリの根、資格情報の部品）を渡すだけ。
 * - 求められないとき（設定のファイルを読めない、パスを受けない、資格情報のメタデータを読めない、保存した設定の形が違う）は `null`（fail-closed。
 *   画面は承認の状態を「確かめられない」と示し、承認・撤回の要求は `SCENARIO_FACTS_UNAVAILABLE` で拒む）。
 */
import type { ApprovalExternalFacts } from '../../../../src/control/approval-view.js';
import { approvalExternalFactsOf as externalFactsOf } from '../../../../src/control/approval-external-facts.js';
import type { StoredProfile } from '../../../../src/control/store/profile-store.js';
import { localUiRepositoryRoot, localUiStore } from './control-store';
import { localUiCredentialStore } from './credential-runtime';

/** 画面のサーバが、シナリオの要求を拒む理由（保存の部品の理由のほか。閉じた一覧）。 */
export const SCENARIO_REQUEST_LOCAL_REJECTION_REASONS = Object.freeze(['SCENARIO_FACTS_UNAVAILABLE'] as const);
export type ScenarioRequestLocalRejectionReason = (typeof SCENARIO_REQUEST_LOCAL_REJECTION_REASONS)[number];

/** 承認の判定に渡す管理データの外の事実（求められなければ null）。 */
export const approvalExternalFactsOf = (stored: StoredProfile): Promise<ApprovalExternalFacts | null> =>
  externalFactsOf(stored, { database: localUiStore(), repositoryRoot: localUiRepositoryRoot(), credentialStore: localUiCredentialStore() });
