/**
 * 段の口の共通の形（RB-8・RB-11。再構築の設計書 2 章 1・3）: ワーカーの段（発見・READ の確かめ・書き込み）は、Run の前の確認（`runPreflight`）と、開いた Browser の
 * 片付け（`endPreflightBrowser`）と、段の持ち越しに渡す認証の状態の持ち主を、この口に頼む。段ごとの読み込みの操作は、段の口（`StageSession` を広げた型）が持つ。
 * - 本物は `playwrightStagePortsOf`（factory から段の操作を作る）。テストだけが偽の口を差し込む（本番の入口は渡さない。段ごとの Gate）。
 * - 口は判定しない。段の輪（止まり方・順・成果物）は段の関数に残り、偽の口でブラウザなしに確かめる。
 */
import type { NavigationPacer } from '../crawl/navigation-pacer.js';
import type { recordRunStageCarry } from '../orchestration/audit-stage-run.js';
import type { BrowserContextFactory } from '../browser/context-factory.js';
import { endPreflightBrowser, runPreflight, type PreflightOptions } from '../orchestration/preflight.js';

/** 開いた段の口の共通の部分。 */
export interface StageSession {
  /** FM2d: 段の持ち越しに渡す、最新の認証の状態の持ち主（本物は factory）。 */
  readonly carry: NonNullable<Parameters<typeof recordRunStageCarry>[1]>;
  /** Browser を片付ける（RB-5: lease から借りたものは返す）。 */
  readonly close: () => Promise<void>;
}

/** 段の口: Run の前の確認をして、段の口を開く。確認に失敗したら `null`（呼ぶ側は `PREFLIGHT_FAILED`）。 */
export interface StagePorts<Session extends StageSession> {
  readonly open: (preflight: PreflightOptions, pacer: NavigationPacer) => Promise<Session | null>;
}

/** 本物の段の口（`runPreflight` → 段の操作 → `endPreflightBrowser`）。`operationsOf` は factory と pacer から段の操作を作る。 */
export const playwrightStagePortsOf = <Session extends StageSession>(
  operationsOf: (factory: BrowserContextFactory, pacer: NavigationPacer) => Omit<Session, keyof StageSession>,
): StagePorts<Session> => Object.freeze({
  open: async (preflightOptions: PreflightOptions, pacer: NavigationPacer): Promise<Session | null> => {
    const preflight = await runPreflight(preflightOptions);
    if (!preflight.ok) {
      return null;
    }
    const { factory } = preflight;
    const session: StageSession = {
      carry: factory,
      close: async (): Promise<void> => {
        await endPreflightBrowser(preflight);
      },
    };
    return Object.freeze({ ...operationsOf(factory, pacer), ...session }) as Session;
  },
});
