// isolated-interaction の fail-closed の監査（凍結中のポップアップの DEF-036・DEF-039 を含む）と、Interaction の session の区分・期限・読み込みの
// 観測・出口の中継の記録・凍結の直後の close の競合（DEF-045）のテスト（TS-c。本文と共通の補助は `isolated-interaction-cases.ts`）。
import { registerFailClosedAuditCases, registerInteractionSessionCases } from './isolated-interaction-cases.js';

registerFailClosedAuditCases();
registerInteractionSessionCases();
