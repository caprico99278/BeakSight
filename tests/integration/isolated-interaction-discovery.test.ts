// isolated-interaction の候補の探り（DOM の作業量、計測の対照、Task 2 の境界と解決の持ち主）と、候補の探索と、Interaction の session の区分・期限・
// 読み込みの観測・出口の中継の記録のテスト（TS-c。本文と共通の補助は `isolated-interaction-cases.ts`。session の場面は SLIM BD-5 で
// `isolated-interaction-audit.test.ts` から移した）。
import { registerCandidateDiscoveryCases, registerInteractionProbeCases, registerInteractionSessionCases } from './isolated-interaction-cases.js';

registerInteractionProbeCases();
registerCandidateDiscoveryCases();
registerInteractionSessionCases();
