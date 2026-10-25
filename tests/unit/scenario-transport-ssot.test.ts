// T40R-fix-B（Task 40 の設計書 7 章の「T40R」の行の M-2）: 送り方の値と「API は CREATE だけ」の判定の SSOT。
// - 送り方の値の名前つきの定数は `FORM_SCENARIO_TRANSPORT`・`API_SCENARIO_TRANSPORT` だけ（`SCENARIO_TRANSPORTS` の要素から作る）。定義は core の
//   `scenario-transport.ts`（IPC の契約がシナリオの契約を読むと循環するため）で、`scenario-contracts.ts` が公開し直す。IPC の
//   `WORKER_API_WRITE_TRANSPORT` は、公開の名前を保つ別名。
// - 次のファイルは、送り方の値の定数を自分で定義しない（`'FORM'`・`'API'` を定数に書かない）: 記録の要約、台帳の読み出し、承認の要約の項目、IPC、
//   書き込みの流れ、画面の型の要約（画面はカタログのラベルで出す。CC-103）。
// - LG-3b: 「API は CREATE だけ」の判定 `apiWriteRejectionOf` は捨てた（契約のない API の更新の版は、スキーマが拒む）。開始の口（`writeStartSpecOf`）は、
//   種類の判定を自分で持たない。
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { API_SCENARIO_TRANSPORT, FORM_SCENARIO_TRANSPORT, SCENARIO_TRANSPORTS } from '../../src/control/approval/scenario-contracts.js';
import { WORKER_API_WRITE_TRANSPORT } from '../../src/control/worker-protocol.js';

const sourceOf = (path: string): string => readFileSync(resolve(process.cwd(), path), 'utf8');

/** 送り方の値を定数に書く形（`= 'API'`、`'FORM' satisfies ScenarioTransport` など）。 */
const TRANSPORT_LITERAL_CONSTANT = /=\s*'(?:FORM|API)'(?:\s+satisfies\s+ScenarioTransport)?\s*;/u;

describe('T40R-fix-B: the transport values', () => {
  it('names the transport values from the closed list, and keeps the IPC name as an alias', () => {
    expect([FORM_SCENARIO_TRANSPORT, API_SCENARIO_TRANSPORT]).toEqual([...SCENARIO_TRANSPORTS]);
    expect(SCENARIO_TRANSPORTS).toContain(FORM_SCENARIO_TRANSPORT);
    expect(SCENARIO_TRANSPORTS).toContain(API_SCENARIO_TRANSPORT);
    expect(WORKER_API_WRITE_TRANSPORT).toBe(API_SCENARIO_TRANSPORT);
  });

  it.each([
    'src/control/actions/action-api-summary.ts',
    'src/control/actions/write-result-facts.ts',
    'src/control/approval/scenario-store.ts',
    'src/control/worker-protocol.ts',
    'src/worker/write-create-run.ts',
    'apps/local-ui/src/components/ScenarioApiShape.tsx',
  ])('defines no transport value constant of its own in %s', (path) => {
    expect(sourceOf(path)).not.toMatch(TRANSPORT_LITERAL_CONSTANT);
  });

  // T40R2-fix（Task 40 の設計書 7 章の「T40R2」の行の M-3）: 送り方の生の文字列の比べと値（`=== 'API'`、`transport: 'FORM'` など）を残さない。Guard の
  // 書き込みの段の送り方も、シナリオの送り方と同じ意味の値なので、同じ定数を使う。
  it.each([
    'src/control/approval/scenario-policy.ts',
    'src/control/approval/scenario-store.ts',
    'src/control/data-rules/field-evaluation.ts',
    'src/safety/passive-request-guard.ts',
    'apps/local-ui/src/components/ScenarioForm.tsx',
  ])('compares no raw transport string in %s', (path) => {
    const code = sourceOf(path).split('\n').filter((line) => !/^\s*(?:\/\/|\*|\/\*\*)/u.test(line)).join('\n');
    expect(code).not.toMatch(/[!=]==\s*'(?:API|FORM)'/u);
    expect(code).not.toMatch(/transport\??:\s*'(?:API|FORM)'/u);
  });

  it('defines the transport values once in core, and the scenario contracts re-export them (the IPC reads core to avoid a cycle)', () => {
    const core = sourceOf('src/core/scenario-transport.ts');
    expect(core).toMatch(/export const FORM_SCENARIO_TRANSPORT\b/u);
    expect(core).toMatch(/export const API_SCENARIO_TRANSPORT\b/u);
    const contracts = sourceOf('src/control/approval/scenario-contracts.ts');
    expect(contracts).not.toMatch(/export const (?:FORM_SCENARIO_TRANSPORT|API_SCENARIO_TRANSPORT|SCENARIO_TRANSPORTS)\b/u);
    expect(contracts).toMatch(/export \{ API_SCENARIO_TRANSPORT, FORM_SCENARIO_TRANSPORT, SCENARIO_TRANSPORTS \} from '\.\.\/\.\.\/core\/scenario-transport\.js';/u);
  });
});

describe('T40R-fix-B: one owner of "an API scenario writes CREATE only"', () => {
  it('keeps the start of the write without a kind of its own (LG-3b: no API write judgement)', () => {
    const start = sourceOf('src/control/job/write-job-start.ts');
    expect(start).not.toMatch(/apiWriteRejectionOf\(/u);
    expect(start).not.toMatch(/API_WRITE_SCENARIO_KIND/u);
    expect(start).not.toMatch(/'CREATE'\s+satisfies\s+ScenarioKind/u);
  });
});
