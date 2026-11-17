// COV-3（網羅の設計書 3.3）: 選ぶ選択肢を押下の並びの 1 つにする形の単体テスト。選択肢の段を作る並びは、待ち行列と状態の保存を通っても、選び方を失わない
// （たどり直しで選んだ選択肢を再現できる）。値と表示の文字は持たない（digest だけ）。ブラウザを使わない。
import { describe, expect, it } from 'vitest';
import { createSha256Fingerprint } from '../../src/core/ids.js';
import { CoverageQueue } from '../../src/discovery/coverage-queue.js';
import { choiceOfReplayStep, choiceReplayStepOf, type SubmissionProbeChoice } from '../../src/interaction/submission-probe.js';

const BASE = 'https://app.example.test';
const S1 = createSha256Fingerprint('structure-1');
const CHOICE: SubmissionProbeChoice = { kind: 'SELECT', name: 'kind', ordinal: 0, optionIndex: 2, optionDigest: createSha256Fingerprint('corp-option') };
const PRESS = { index: 1, matchKey: JSON.stringify([createSha256Fingerprint('go-button'), '[2,null]']), ordinal: 0 };

describe('COV-3: the choice of an option as a step of the replay', () => {
  it('turns a choice into a step and back', () => {
    const step = choiceReplayStepOf(CHOICE);
    expect(step.ordinal).toBe(2);
    expect(choiceOfReplayStep(step)).toEqual(CHOICE);
    expect(choiceOfReplayStep({ ...step, matchKey: step.matchKey.replace('SELECT', 'CHECKBOX') })).toBeNull();
    // 押下の見分けの鍵は、選ぶ選択肢ではない。
    expect(choiceOfReplayStep(PRESS)).toBeNull();
    const radio: SubmissionProbeChoice = { ...CHOICE, kind: 'RADIO', name: '', ordinal: 1 };
    expect(choiceOfReplayStep(choiceReplayStepOf(radio))).toEqual(radio);
  });

  it('keeps the choice of a step in the trail of a state through the snapshot of the queue', () => {
    const queue = new CoverageQueue();
    queue.enqueue({ kind: 'LINK', url: `${BASE}/find`, frame: null, openedRegion: null });
    const find = queue.next()!;
    const trail = [choiceReplayStepOf(CHOICE), PRESS];
    queue.completeRead(find.stateId, {
      structureKey: S1,
      edges: [{ kind: 'LINK', url: `${BASE}/r1?q=bsprobe0123456789ab`, frame: null, openedRegion: null, redactedQueryNames: ['q'], pressTrail: trail }],
    });
    const text = JSON.stringify(queue.snapshot());
    // 値と表示の文字は持たない（digest だけ）。
    expect(text).not.toContain('bsprobe0123456789ab');
    const restored = CoverageQueue.restore(JSON.parse(text) as unknown);
    restored.next();
    const [awaiting] = restored.pressTrailsAwaitingFrom(find.stateId);
    expect(awaiting?.pressTrail.map(choiceOfReplayStep)).toEqual([CHOICE, null]);
  });
});
