/**
 * DEF-146: 止める確認のダイアログ（ふつうの止め方と強制の止め方）の文言を、どのジョブの種類でも読み違えない形にした（カタログ）。
 * - 題と確定のボタンは、ジョブの種類の呼び名（`AUDIT_JOB_STOP_TARGET_NAMES`。網羅は `catalog-coverage.ts` で型で確かめる）を含む。
 * - 取り消しは「止めずに戻る」の趣旨で、「やめる」ではない（「止める」と読み違えた）。強制の止め方の確定は、ふつうの止め方と区別できる。
 * - T44d（Task 44 の設計書 P2-3）: 本文（ふつうの止め方と強制の止め方）は、ジョブの種類ごと（`AUDIT_JOB_STOP_DIALOG_BODIES`）。ジョブの画面の大きい
 *   止めるボタンも、種類の呼び名を入れる（`LOCAL_UI_AUDIT_TEXT.job.stop`）。
 */
import { describe, expect, it } from 'vitest';
import { WORKER_JOB_KINDS } from '../../../src/control/worker-protocol.js';
import {
  AUDIT_JOB_STOP_DIALOG_BODIES,
  AUDIT_JOB_STOP_REQUESTED_TEXTS,
  AUDIT_JOB_STOP_TARGET_NAMES,
  LOCAL_UI_AUDIT_TEXT,
} from '../../../src/presentation/messages.js';

/** 前の取り消しのボタンの文言。 */
const AMBIGUOUS_CANCEL_LABEL = 'やめる';

describe('DEF-146: the text of the stop dialogs', () => {
  it('names the kind of the job in the title and the confirm button, and the cancel does not read "やめる"', () => {
    expect(Object.keys(AUDIT_JOB_STOP_TARGET_NAMES).sort()).toEqual([...WORKER_JOB_KINDS].sort());
    expect(AUDIT_JOB_STOP_TARGET_NAMES.DISCOVERY).toBe('発見');
    expect(AUDIT_JOB_STOP_TARGET_NAMES.AUDIT).toBe('監査');
    expect(AUDIT_JOB_STOP_TARGET_NAMES.READ_CHECK).toBe('READ の確かめ');
    for (const dialog of [LOCAL_UI_AUDIT_TEXT.stopDialog, LOCAL_UI_AUDIT_TEXT.forceStopDialog]) {
      expect(dialog.cancel).toBe('止めずに戻る');
      expect(dialog.cancel).not.toBe(AMBIGUOUS_CANCEL_LABEL);
      for (const target of Object.values(AUDIT_JOB_STOP_TARGET_NAMES)) {
        expect(dialog.title(target)).toContain(target);
        expect(dialog.confirm(target)).toContain(target);
        expect(dialog.confirm(target)).not.toBe(dialog.cancel);
      }
    }
    expect(LOCAL_UI_AUDIT_TEXT.stopDialog.title('発見')).toBe('発見を止めますか');
    expect(LOCAL_UI_AUDIT_TEXT.stopDialog.confirm('発見')).toBe('発見を止める');
    expect(LOCAL_UI_AUDIT_TEXT.forceStopDialog.title('発見')).toBe('発見を強制的に止めますか');
    expect(LOCAL_UI_AUDIT_TEXT.forceStopDialog.confirm('発見')).toBe('発見を強制的に止める');
  });

  // T44d（Task 44 の設計書 P2-3）: 本文と、ジョブの画面の大きい止めるボタンも、ジョブの種類に合わせる（監査だけが続きから再開できる）。
  it('writes the body of both dialogs for each kind of the job, and names the kind on the big stop button', () => {
    expect(Object.keys(AUDIT_JOB_STOP_DIALOG_BODIES).sort()).toEqual([...WORKER_JOB_KINDS].sort());
    for (const kind of WORKER_JOB_KINDS) {
      const bodies = AUDIT_JOB_STOP_DIALOG_BODIES[kind];
      expect(bodies.stop.length, kind).toBeGreaterThan(0);
      expect(bodies.force.length, kind).toBeGreaterThan(0);
      expect(bodies.force, kind).not.toBe(bodies.stop);
      const target = AUDIT_JOB_STOP_TARGET_NAMES[kind];
      expect(LOCAL_UI_AUDIT_TEXT.job.stop(target), kind).toBe(LOCAL_UI_AUDIT_TEXT.stopDialog.confirm(target));
    }
    expect(LOCAL_UI_AUDIT_TEXT.job.stop(AUDIT_JOB_STOP_TARGET_NAMES.AUDIT)).toBe('監査を止める');
    expect(LOCAL_UI_AUDIT_TEXT.job.stop(AUDIT_JOB_STOP_TARGET_NAMES.DISCOVERY)).toBe('発見を止める');
    // 監査は、今のページを終えてから止まり、前回の続きから再開できる。
    expect(AUDIT_JOB_STOP_DIALOG_BODIES.AUDIT.stop).toContain('今のページの監査を終えてから止めます');
    expect(AUDIT_JOB_STOP_DIALOG_BODIES.AUDIT.stop).toContain('続きから再開');
    // 監査のほかの種類は、再開しない（監査の続きからの再開の案内を書かない）。
    for (const kind of WORKER_JOB_KINDS.filter((each) => each !== 'AUDIT')) {
      for (const body of [AUDIT_JOB_STOP_DIALOG_BODIES[kind].stop, AUDIT_JOB_STOP_DIALOG_BODIES[kind].force]) {
        expect(body, kind).toContain('再開しません');
        expect(body, kind).not.toContain('続きから再開');
        expect(body, kind).not.toContain('ページの監査');
      }
    }
    // 止める要求の後の文（`AUDIT_JOB_STOP_REQUESTED_TEXTS`）も、種類ごと（監査のほかは、ページの監査の文を出さない）。
    expect(Object.keys(AUDIT_JOB_STOP_REQUESTED_TEXTS).sort()).toEqual([...WORKER_JOB_KINDS].sort());
    expect(AUDIT_JOB_STOP_REQUESTED_TEXTS.AUDIT).toBe('止める要求を送りました。今のページの監査を終えてから止まります。');
    for (const kind of WORKER_JOB_KINDS.filter((each) => each !== 'AUDIT')) {
      expect(AUDIT_JOB_STOP_REQUESTED_TEXTS[kind], kind).toContain('止める要求を送りました。');
      expect(AUDIT_JOB_STOP_REQUESTED_TEXTS[kind], kind).not.toContain('ページの監査');
    }
    // 書き込みは、送る前なら送らない。押した後は送った結果を記録する（強制の止め方では、送ったか分からないことがある）。
    for (const kind of ['WRITE_CREATE', 'WRITE_UPDATE'] as const) {
      expect(AUDIT_JOB_STOP_DIALOG_BODIES[kind].stop, kind).toContain('送る前なら、送らずに止めます');
      expect(AUDIT_JOB_STOP_DIALOG_BODIES[kind].force, kind).toContain('送ったか分からない');
    }
  });
});
