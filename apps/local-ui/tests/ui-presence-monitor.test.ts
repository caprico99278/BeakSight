/**
 * UI-close（設計書 `doc/design/2026-10-19-beaksight-ui-close-stops-server-design.md` の 2 章）: 管理画面のページの生きている知らせと閉じたときの知らせ
 * から、画面のサーバを止めるかを決める部品（`apps/local-ui/launcher/presence.ts` の `createPresenceMonitor`）。時刻は注入する。
 * - 起動の後に、ページが一度は知らせを送った。
 * - どのページも開いていない（閉じた知らせの後は猶予、知らせが途絶えたときは途絶えの上限の後）。
 * - 動いているジョブがない（あれば、終わった後に確かめ直す）。
 */
import { describe, expect, it } from 'vitest';
import { createPresenceMonitor } from '../launcher/presence.ts';

const CLOSED_GRACE_MS = 15_000;
const SILENCE_LIMIT_MS = 120_000;

const monitorOf = (jobs = { count: 0 }) => {
  let now = 0;
  let idle = 0;
  const monitor = createPresenceMonitor({
    closedGraceMs: CLOSED_GRACE_MS,
    silenceLimitMs: SILENCE_LIMIT_MS,
    runningJobCount: () => jobs.count,
    onIdle: () => {
      idle += 1;
    },
    now: () => now,
  });
  return {
    monitor,
    at: (ms: number): void => {
      now = ms;
      monitor.check();
    },
    idle: (): number => idle,
  };
};

describe('UI-close: when the local UI server stops after the page is closed', () => {
  it('does not stop before a page has ever sent a notice', () => {
    const { at, idle } = monitorOf();
    at(SILENCE_LIMIT_MS * 10);
    expect(idle()).toBe(0);
  });

  it('stops once, after the grace from the closed notice of the last page', () => {
    const { monitor, at, idle } = monitorOf();
    monitor.alive('page-a');
    at(1_000);
    monitor.closed('page-a');
    at(1_000 + CLOSED_GRACE_MS - 1);
    expect(idle()).toBe(0);
    at(1_000 + CLOSED_GRACE_MS);
    expect(idle()).toBe(1);
    at(1_000 + CLOSED_GRACE_MS * 2);
    expect(idle()).toBe(1);
  });

  it('does not stop on a reload (the new page sends a notice within the grace) or while another page is open', () => {
    const reload = monitorOf();
    reload.monitor.alive('page-a');
    reload.monitor.closed('page-a');
    reload.at(CLOSED_GRACE_MS - 1);
    reload.monitor.alive('page-b');
    reload.at(CLOSED_GRACE_MS * 3);
    expect(reload.idle()).toBe(0);

    const tabs = monitorOf();
    tabs.monitor.alive('page-a');
    tabs.monitor.alive('page-b');
    tabs.monitor.closed('page-a');
    tabs.at(CLOSED_GRACE_MS * 3);
    expect(tabs.idle()).toBe(0);
    tabs.monitor.closed('page-b');
    tabs.at(CLOSED_GRACE_MS * 4);
    expect(tabs.idle()).toBe(1);
  });

  it('stops when the notices stop for the silence limit (a page closed without the closed notice)', () => {
    const { monitor, at, idle } = monitorOf();
    monitor.alive('page-a');
    at(SILENCE_LIMIT_MS - 1);
    expect(idle()).toBe(0);
    at(SILENCE_LIMIT_MS);
    expect(idle()).toBe(1);
  });

  it('does not stop while a job runs, and stops after the job ends unless a page came back', () => {
    const jobs = { count: 1 };
    const { monitor, at, idle } = monitorOf(jobs);
    monitor.alive('page-a');
    monitor.closed('page-a');
    at(CLOSED_GRACE_MS * 2);
    expect(idle()).toBe(0);
    jobs.count = 0;
    at(CLOSED_GRACE_MS * 2 + 1);
    expect(idle()).toBe(1);

    const back = monitorOf({ count: 1 });
    back.monitor.alive('page-a');
    back.monitor.closed('page-a');
    back.at(CLOSED_GRACE_MS * 2);
    back.monitor.alive('page-b');
    back.at(CLOSED_GRACE_MS * 3);
    expect(back.idle()).toBe(0);
  });

  it('does not count a closed notice of a page that never sent the alive notice', () => {
    const { monitor, at, idle } = monitorOf();
    monitor.closed('page-a');
    at(SILENCE_LIMIT_MS * 10);
    expect(idle()).toBe(0);
  });
});
