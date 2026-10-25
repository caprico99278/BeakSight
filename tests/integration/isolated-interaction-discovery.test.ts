// isolated-interaction の候補の探り（DOM の作業量、計測の対照、Task 2 の境界と解決の持ち主）と、候補の探索のテスト（TS-c。本文と共通の補助は
// `isolated-interaction-cases.ts`）。
import { registerCandidateDiscoveryCases, registerInteractionProbeCases } from './isolated-interaction-cases.js';

registerInteractionProbeCases();
registerCandidateDiscoveryCases();
