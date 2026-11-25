// RB-9（再構築の設計書 3 章。案 2 章の 7）: 通知の枠を閉じる輪（設計書 `2026-11-06-beaksight-notification-overlay-design.md` 3.2・3.2.1・3.4）。
// 判定は純粋な 1 歩（`notificationDismissalStepOf`）にあり、輪は口に頼んで時計で待つだけ。偽の口（メモリの中の枠）と偽の時計で確かめる（ブラウザも本物の時間も
// 使わない）。前は notification-dismissal の結合（本物の Page Auditor と Chromium）で確かめていた、閉じる輪の場面。
import { describe, expect, it } from 'vitest';
import type { NotificationFrameStatus } from '../../src/core/evidence-types.js';
import { PRODUCTION_OBSERVATION_WINDOWS } from '../../src/core/observation-windows.js';
import {
  dismissNotificationFramesWith,
  type NotificationDismissalOptions,
  type NotificationDismissalPort,
  type NotificationFrameWithElements,
} from '../../src/interaction/notification-overlay.js';
import { createFakeClock } from '../helpers/fake-browser-port/fake-clock.js';

/** 偽の枠。`onPress`: 押したときの動き（消える・残る・押せない・画面を移そうとして Guard に止められる）。 */
interface FakeFrame {
  readonly digest: string;
  readonly status: NotificationFrameStatus;
  readonly surfaceAreaRatio?: number | null;
  readonly onPress?: 'remove' | 'stay' | 'fail' | 'move';
  readonly modal?: boolean;
}

/** 偽の口が、隠したときに返す画面の幅とスクロールの位置。 */
const HIDDEN_AT = Object.freeze({ viewportWidth: 800, scrollX: 0, scrollY: 120 });

const BUTTON_ID_OFFSET = 1_000;

/** 偽の口（押す・隠す・押す期間の始まりを、起きた順に記録する）。 */
const fakePortOf = (frames: readonly FakeFrame[], options: { readonly canBeginPressPeriod?: boolean; readonly readable?: boolean } = {}) => {
  const present = new Set(frames.map((_frame, index) => index));
  let navigations = 0;
  const log: string[] = [];
  const readAtMs: number[] = [];
  const clock = createFakeClock(10_000);
  /** 偽の画面の幅とスクロールの位置（隠す前の画像を撮ると先頭へ移る）。 */
  const position: { viewportWidth: number; scrollX: number; scrollY: number } = { ...HIDDEN_AT };
  const frameOf = (index: number): NotificationFrameWithElements => {
    const frame = frames[index] as FakeFrame;
    const pressable = frame.status === 'DISMISSIBLE' || frame.status === 'TOO_LARGE';
    return {
      candidate: index,
      status: frame.status,
      closeButton: pressable ? index : null,
      surfaceAreaRatio: frame.surfaceAreaRatio ?? 0.1,
      modal: frame.modal ?? false,
      digest: frame.digest,
      frameElement: { backendNodeId: index, path: [0, index] },
      closeButtonElement: pressable ? { backendNodeId: BUTTON_ID_OFFSET + index, path: [0, index, 0] } : null,
    };
  };
  const port: NotificationDismissalPort = {
    readFrames: async () => {
      readAtMs.push(clock.now());
      return options.readable === false
        ? { status: 'FAILED' }
        : { status: 'READ', frames: [...present].map(frameOf), excluded: [], truncated: false };
    },
    beginPressPeriod: () => {
      log.push('begin');
      return options.canBeginPressPeriod ?? true;
    },
    blockedNavigations: () => navigations,
    pressCloseButton: async (reference) => {
      const index = reference.backendNodeId - BUTTON_ID_OFFSET;
      const frame = frames[index] as FakeFrame;
      log.push(`press ${frame.digest}`);
      switch (frame.onPress ?? 'remove') {
        case 'remove':
          present.delete(index);
          return true;
        case 'stay':
          return true;
        case 'fail':
          return false;
        case 'move':
          navigations += 1;
          return true;
      }
    },
    isGone: async (backendNodeId) => !present.has(backendNodeId - BUTTON_ID_OFFSET),
    hideFrame: async (backendNodeId) => {
      log.push(`hide ${(frames[backendNodeId] as FakeFrame).digest}`);
      return { ...position };
    },
    readViewportPosition: async () => ({ ...position }),
  };
  const dismiss = async (overrides: Partial<NotificationDismissalOptions> = {}) => {
    const result = dismissNotificationFramesWith(port, { deadlineAtMs: clock.now() + 60_000, pressMode: 'AUDIT', ...overrides }, clock);
    await clock.advance(120_000);
    return result;
  };
  return { dismiss, log, readAtMs, position };
};

const factsOf = (overlay: Awaited<ReturnType<ReturnType<typeof fakePortOf>['dismiss']>>) =>
  overlay.frames.map(({ digest, status, pressed, dismissed, hidden, hiddenReason }) => ({ digest, status, pressed, dismissed, hidden, hiddenReason }));

describe('RB-9: the loop that closes the notification frames', () => {
  it('starts the press period before the press, closes the frame, and reads again only after the end of the dismiss window', async () => {
    const { dismiss, log, readAtMs } = fakePortOf([{ digest: 'corner', status: 'DISMISSIBLE' }]);
    const measured: string[] = [];

    const overlay = await dismiss({ beforeFirstDismissal: async () => { measured.push('layout'); } });

    expect(overlay).toMatchObject({ readStatus: 'READ', pressCount: 1, navigated: false });
    expect(factsOf(overlay)).toEqual([{ digest: 'corner', status: 'DISMISSIBLE', pressed: true, dismissed: true, hidden: false, hiddenReason: null }]);
    expect(log).toEqual(['begin', 'press corner']);
    expect(measured).toEqual(['layout']);
    // 消えた後も、待つ時間の終わりまで待ってから読み直す（遅れて動く移動を見分けるため）。
    expect((readAtMs[1] ?? 0) - (readAtMs[0] ?? 0)).toBeGreaterThanOrEqual(PRODUCTION_OBSERVATION_WINDOWS.notification.dismissWaitMs);
  });

  it('marks a frame seen before as not first, and measures before the dismissal only for a first frame', async () => {
    const seenDigests = new Set<string>();
    const measured: string[] = [];
    const beforeFirstDismissal = async (): Promise<void> => { measured.push('layout'); };

    const first = await fakePortOf([{ digest: 'corner', status: 'DISMISSIBLE' }]).dismiss({ seenDigests, beforeFirstDismissal });
    const again = await fakePortOf([{ digest: 'corner', status: 'DISMISSIBLE' }]).dismiss({ seenDigests, beforeFirstDismissal });

    expect([first.frames[0]?.firstSeen, again.frames[0]?.firstSeen]).toEqual([true, false]);
    expect(measured).toEqual(['layout']);
    expect([...seenDigests]).toEqual(['corner']);
  });

  it('presses a full modal too, and hides a frame that stays, a large frame without a close button and a disabled close button', async () => {
    const { dismiss, log } = fakePortOf([
      { digest: 'modal', status: 'TOO_LARGE', surfaceAreaRatio: 0.8 },
      { digest: 'stuck', status: 'DISMISSIBLE', onPress: 'stay' },
      { digest: 'panel', status: 'NO_CLOSE_BUTTON', surfaceAreaRatio: 0.7 },
      { digest: 'small', status: 'NO_CLOSE_BUTTON', surfaceAreaRatio: 0.1 },
      { digest: 'disabled', status: 'CLOSE_BUTTON_DISABLED' },
    ]);

    const overlay = await dismiss();

    expect(factsOf(overlay)).toEqual([
      { digest: 'modal', status: 'TOO_LARGE', pressed: true, dismissed: true, hidden: false, hiddenReason: null },
      { digest: 'stuck', status: 'DISMISSIBLE', pressed: true, dismissed: false, hidden: true, hiddenReason: 'NOT_DISMISSED' },
      { digest: 'panel', status: 'NO_CLOSE_BUTTON', pressed: false, dismissed: false, hidden: true, hiddenReason: 'NO_CLOSE_BUTTON' },
      { digest: 'small', status: 'NO_CLOSE_BUTTON', pressed: false, dismissed: false, hidden: false, hiddenReason: null },
      { digest: 'disabled', status: 'CLOSE_BUTTON_DISABLED', pressed: false, dismissed: false, hidden: true, hiddenReason: 'CLOSE_BUTTON_DISABLED' },
    ]);
    // 押す期間は 1 回だけ始め、押すのも隠すのも、その後。
    expect(log).toEqual(['begin', 'press modal', 'press stuck', 'hide stuck', 'hide panel', 'hide disabled']);
  });

  it('AUD-2: keeps a modal dialog open instead of hiding it, and records the hidden frame with the width and the scroll after one capture before the hide', async () => {
    const { dismiss, log, position } = fakePortOf([
      { digest: 'modal', status: 'NO_CLOSE_BUTTON', surfaceAreaRatio: 0.9, modal: true },
      { digest: 'stuck-modal', status: 'TOO_LARGE', surfaceAreaRatio: 0.8, onPress: 'stay', modal: true },
      { digest: 'panel', status: 'NO_CLOSE_BUTTON', surfaceAreaRatio: 0.7 },
    ]);

    // REV-AUD2 の M-2: 撮影の部品が先頭へ移しても、記録するのは移す前の位置。
    const overlay = await dismiss({ beforeFirstHide: async () => { log.push('capture'); position.scrollY = 0; } });

    expect(overlay.frames.map(({ digest, hidden, hiddenReason, keptOpen, hiddenAt }) => ({ digest, hidden, hiddenReason, keptOpen, hiddenAt }))).toEqual([
      { digest: 'modal', hidden: false, hiddenReason: null, keptOpen: true, hiddenAt: undefined },
      { digest: 'stuck-modal', hidden: false, hiddenReason: 'NOT_DISMISSED', keptOpen: true, hiddenAt: undefined },
      { digest: 'panel', hidden: true, hiddenReason: 'NO_CLOSE_BUTTON', keptOpen: undefined, hiddenAt: HIDDEN_AT },
    ]);
    expect(log).toEqual(['begin', 'press stuck-modal', 'capture', 'hide panel']);
  });

  it('AUD-2: does not capture before the hide when nothing is hidden', async () => {
    const { dismiss, log } = fakePortOf([{ digest: 'modal', status: 'NO_CLOSE_BUTTON', surfaceAreaRatio: 0.9, modal: true }]);

    await dismiss({ beforeFirstHide: async () => { log.push('capture'); } });

    expect(log).toEqual([]);
  });

  it('fix round 6: does not press a frame again after its press failed, and hides it as a frame that cannot be closed', async () => {
    const { dismiss, log } = fakePortOf([{ digest: 'stuck', status: 'DISMISSIBLE', onPress: 'fail' }]);

    const overlay = await dismiss();

    expect(overlay.pressCount).toBe(0);
    expect(factsOf(overlay)).toEqual([{ digest: 'stuck', status: 'DISMISSIBLE', pressed: false, dismissed: false, hidden: true, hiddenReason: 'NOT_DISMISSED' }]);
    expect(log).toEqual(['begin', 'press stuck', 'hide stuck']);
  });

  it('fix round 2 (I-7): reads the frames again after each press, and presses up to the limit of a page', async () => {
    const { dismiss, readAtMs } = fakePortOf(Array.from({ length: 5 }, (_value, index) => ({ digest: `n${String(index)}`, status: 'DISMISSIBLE' as const })));

    const overlay = await dismiss();

    expect(overlay.pressCount).toBe(3);
    expect(overlay.frames.filter((frame) => frame.pressed).map((frame) => frame.digest)).toEqual(['n0', 'n1', 'n2']);
    expect(readAtMs).toHaveLength(4);
  });

  it('fix round 2 (I-6): stops after a press that tried to move the page, and neither presses the rest nor hides', async () => {
    const { dismiss, log } = fakePortOf([
      { digest: 'moving', status: 'DISMISSIBLE', onPress: 'move' },
      { digest: 'next', status: 'DISMISSIBLE' },
      { digest: 'panel', status: 'NO_CLOSE_BUTTON', surfaceAreaRatio: 0.7 },
    ]);

    const overlay = await dismiss();

    expect(overlay).toMatchObject({ navigated: true, pressCount: 1 });
    expect(log).toEqual(['begin', 'press moving']);
    expect(overlay.frames.map((frame) => frame.hidden)).toEqual([false, false, false]);
  });

  it('presses and hides nothing when the press period cannot start (no Guard on the page)', async () => {
    const { dismiss, log } = fakePortOf([
      { digest: 'corner', status: 'DISMISSIBLE' },
      { digest: 'panel', status: 'NO_CLOSE_BUTTON', surfaceAreaRatio: 0.7 },
    ], { canBeginPressPeriod: false });

    const overlay = await dismiss();

    expect(overlay.pressCount).toBe(0);
    expect(log.filter((entry) => entry !== 'begin')).toEqual([]);
    expect(overlay.frames.map((frame) => frame.hidden)).toEqual([false, false]);
  });

  it('REV-SD I-1: presses and hides nothing once the page has moved out of the audit scope', async () => {
    const { dismiss, log } = fakePortOf([
      { digest: 'corner', status: 'DISMISSIBLE' },
      { digest: 'panel', status: 'NO_CLOSE_BUTTON', surfaceAreaRatio: 0.7 },
    ]);

    const overlay = await dismiss({ inAuditScope: () => false });

    expect(overlay.pressCount).toBe(0);
    expect(log).toEqual([]);
  });

  it('returns the unreadable facts when the frames cannot be read, and does nothing after the deadline', async () => {
    expect(await fakePortOf([{ digest: 'corner', status: 'DISMISSIBLE' }], { readable: false }).dismiss())
      .toMatchObject({ readStatus: 'FAILED', frames: [], pressCount: 0 });
    const late = fakePortOf([{ digest: 'corner', status: 'DISMISSIBLE' }, { digest: 'panel', status: 'NO_CLOSE_BUTTON', surfaceAreaRatio: 0.7 }]);
    const overlay = await late.dismiss({ deadlineAtMs: 0 });
    expect(overlay).toMatchObject({ readStatus: 'READ', pressCount: 0 });
    expect(late.log).toEqual([]);
  });
});
