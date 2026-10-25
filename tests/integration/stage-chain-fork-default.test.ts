// FM2d: まとめて実行の端から端（Run の Browser はテストの既定の Chromium）（TS-c。本文と共通の補助は `stage-chain-fork-cases.ts`）。
import { registerChainedRunCases } from './stage-chain-fork-cases.js';

registerChainedRunCases('the default test Chromium');
