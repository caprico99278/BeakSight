// CC-106（PRE42-CC の組 2）: シナリオの種類の閉じた一覧と、値の名前つきの定数は `src/core/scenario-kind.ts` の 1 か所にある。シナリオの契約
// （`scenario-contracts.ts`）と画面の公開し直し（`approval-view.ts`）は同じ値を公開し直し、IPC の契約（`worker-protocol.ts`）と画面のブラウザ側
// （`ScenarioApiFields.tsx`）は core から読む（`'UPDATE' satisfies ScenarioKind` を書き写さない。`tests/architecture/owner-constant-reuse.test.ts` の (d)）。
// IPC の種類の照合（承認の要約の種類と書き込みの指定の UPDATE の指定の有無）の振る舞いは `worker-protocol-write.test.ts` の
// 「accepts the approval facts of a CREATE and of an UPDATE」と、種類の食い違いを拒むテストで確かめる。
import { describe, expect, expectTypeOf, it } from 'vitest';
import * as approvalView from '../../src/control/approval-view.js';
import * as scenarioContracts from '../../src/control/approval/scenario-contracts.js';
import type { CandidateClassification } from '../../src/discovery/candidate-contracts.js';
import { CREATE_SCENARIO_KIND, SCENARIO_KINDS, UPDATE_SCENARIO_KIND, type ScenarioKind } from '../../src/core/scenario-kind.js';

describe('CC-106: the one owner of the scenario kinds', () => {
  it('keeps the frozen closed list and its named values in the core', () => {
    expect(SCENARIO_KINDS).toEqual(['CREATE', 'UPDATE']);
    expect(Object.isFrozen(SCENARIO_KINDS)).toBe(true);
    expect(CREATE_SCENARIO_KIND).toBe(SCENARIO_KINDS[0]);
    expect(UPDATE_SCENARIO_KIND).toBe(SCENARIO_KINDS[1]);
  });

  it('makes the scenario contract and the screen re-export the same values of the core', () => {
    for (const module of [scenarioContracts, approvalView]) {
      expect(module.SCENARIO_KINDS).toBe(SCENARIO_KINDS);
      expect(module.CREATE_SCENARIO_KIND).toBe(CREATE_SCENARIO_KIND);
      expect(module.UPDATE_SCENARIO_KIND).toBe(UPDATE_SCENARIO_KIND);
    }
  });

  it('makes the scenario kind of the contracts the core type, a part of the candidate classifications', () => {
    expectTypeOf<scenarioContracts.ScenarioKind>().toEqualTypeOf<ScenarioKind>();
    expectTypeOf<approvalView.ScenarioKind>().toEqualTypeOf<ScenarioKind>();
    expectTypeOf<ScenarioKind>().toMatchTypeOf<CandidateClassification>();
  });
});
