/**
 * T44d（Task 44 の設計書 P2-1。設計の変更の履歴の T44d の行の案 (a)）: プロファイルの画面の「監査の負荷」（ページの上限・時間の上限・読み込みの間隔）。
 * - 値は、プロファイルが指す設定のファイルの値（`crawl-limits-functions.ts`）。画面から書くのは `local/targets/` の中のファイルだけ（ほかは案内だけ）。
 * - 「変更を確かめる」で、サーバが書くときと同じ確かめを行い（範囲は `validateConfig` と同じ。間隔は今の下限より短くできない）、誤りは欄ごとに出す。
 *   通れば確認のダイアログに、変える前と後の値（変えた項目だけ）、承認が外れるシナリオの数、途中の Run があれば再開されない旨を出す。
 * - 確定すると保存し（画面が見た中身のときだけ置き換える）、画面を読み直す。文言はカタログ。
 * - 欄が空のとき（数でない値。スキーマが数を求めるので送れない）だけは、送らずに欄に出す（値の範囲の確かめは、サーバだけが行う）。
 */
import { useRouter } from '@tanstack/react-router';
import { useServerFn } from '@tanstack/react-start';
import { Fragment, useState } from 'react';
import {
  TARGET_CRAWL_LIMIT_FIELDS,
  type TargetCrawlLimitField,
  type TargetCrawlLimitProblemCode,
  type TargetCrawlLimits,
  type TargetCrawlLimitsChangeFailure,
} from '../../../../src/config/target-config-draft.js';
import { formatCount, formatDuration, formatElapsedTime } from '../../../../src/presentation/format.js';
import {
  LOCAL_UI_AUDIT_TEXT,
  LOCAL_UI_CRAWL_LIMITS_TEXT,
  TARGET_CRAWL_LIMIT_PROBLEM_DESCRIPTIONS,
  TARGET_CRAWL_LIMITS_CHANGE_FAILURE_DESCRIPTIONS,
} from '../../../../src/presentation/messages.js';
import { closedListReason, settleServerFunction } from '../display/server-function-outcome';
import {
  previewCrawlLimitsFn,
  saveCrawlLimitsFn,
  type CrawlLimitsPanelView,
  type CrawlLimitsPreviewView,
} from '../server/crawl-limits-functions';
import { ConfirmDialog } from './ConfirmDialog';
import { FieldFrame } from './FieldFrame';
import { Notice } from './Notice';

const text = LOCAL_UI_CRAWL_LIMITS_TEXT;

/** 値の書式（ページの数、時間、間隔。開始の画面と同じ書式）。 */
const VALUE_TEXT: Readonly<Record<TargetCrawlLimitField, (value: number) => string>> = Object.freeze({
  maxPages: formatCount,
  maxRuntimeMs: formatElapsedTime,
  minNavigationIntervalMs: formatDuration,
});

/** 項目の名前（開始の画面の要点と同じ）。 */
const ITEM_LABEL: Readonly<Record<TargetCrawlLimitField, string>> = Object.freeze({
  maxPages: LOCAL_UI_AUDIT_TEXT.start.maxPages,
  maxRuntimeMs: LOCAL_UI_AUDIT_TEXT.start.maxRuntime,
  minNavigationIntervalMs: LOCAL_UI_AUDIT_TEXT.start.minNavigationInterval,
});

/** 欄が空のとき（送れない）に出す誤り（範囲の確かめはサーバ）。 */
const EMPTY_FIELD_PROBLEM: Readonly<Record<TargetCrawlLimitField, TargetCrawlLimitProblemCode>> = Object.freeze({
  maxPages: 'NOT_POSITIVE_INTEGER',
  maxRuntimeMs: 'NOT_POSITIVE_INTEGER',
  minNavigationIntervalMs: 'NOT_NON_NEGATIVE_INTEGER',
});

const isFailureReason = closedListReason(TARGET_CRAWL_LIMITS_CHANGE_FAILURE_DESCRIPTIONS);

type FieldValues = Readonly<Record<TargetCrawlLimitField, string>>;
type FieldProblems = Partial<Record<TargetCrawlLimitField, TargetCrawlLimitProblemCode>>;
type Failure = { readonly kind: 'REJECTED'; readonly reason: TargetCrawlLimitsChangeFailure } | { readonly kind: 'REQUEST_FAILED' };
type Preview = Extract<CrawlLimitsPreviewView, { ok: true }>;

const fieldValuesOf = (limits: TargetCrawlLimits): FieldValues => ({
  maxPages: String(limits.maxPages),
  maxRuntimeMs: String(limits.maxRuntimeMs),
  minNavigationIntervalMs: String(limits.minNavigationIntervalMs),
});

/** 応答の欄ごとの誤り（形の違う値は捨てる）。 */
const problemsOf = (value: unknown): FieldProblems => {
  if (typeof value !== 'object' || value === null || !Array.isArray((value as { problems?: unknown }).problems)) {
    return {};
  }
  const problems: FieldProblems = {};
  for (const problem of (value as { problems: readonly unknown[] }).problems) {
    const { field, code } = (problem ?? {}) as { field?: unknown; code?: unknown };
    if (TARGET_CRAWL_LIMIT_FIELDS.some((each) => each === field) && typeof code === 'string' && Object.hasOwn(TARGET_CRAWL_LIMIT_PROBLEM_DESCRIPTIONS, code)) {
      problems[field as TargetCrawlLimitField] = code as TargetCrawlLimitProblemCode;
    }
  }
  return problems;
};

export function CrawlLimitsPanel({ view }: Readonly<{ view: CrawlLimitsPanelView }>) {
  const preview = useServerFn(previewCrawlLimitsFn);
  const save = useServerFn(saveCrawlLimitsFn);
  const router = useRouter();
  const [values, setValues] = useState<FieldValues>(view.limits === null ? { maxPages: '', maxRuntimeMs: '', minNavigationIntervalMs: '' } : fieldValuesOf(view.limits));
  const [problems, setProblems] = useState<FieldProblems>({});
  const [failure, setFailure] = useState<Failure | null>(null);
  const [pending, setPending] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const { limits, minNavigationIntervalFloorMs: floorMs, targetConfigDigest } = view;

  if (view.state !== 'EDITABLE' || limits === null || floorMs === null || targetConfigDigest === null) {
    return (
      <section className="panel" data-testid="profile-crawl-limits">
        <h2 className="panel-heading">{text.heading}</h2>
        <dl className="facts">
          <dt>{text.targetConfigPath}</dt>
          <dd><code>{view.targetConfigPath}</code></dd>
          {limits === null ? null : TARGET_CRAWL_LIMIT_FIELDS.map((field) => (
            <Fragment key={field}>
              <dt>{ITEM_LABEL[field]}</dt>
              <dd>{VALUE_TEXT[field](limits[field])}</dd>
            </Fragment>
          ))}
        </dl>
        {view.state === 'UNREADABLE'
          ? <p className="muted" data-testid="crawl-limits-unreadable">{text.unreadable}</p>
          : <p className="muted" data-testid="crawl-limits-not-editable">{text.notEditable}</p>}
      </section>
    );
  }

  const request = (entered: TargetCrawlLimits) => ({ data: { profileId: view.profileId, expectedTargetConfigDigest: targetConfigDigest, limits: entered } });

  /** 欄の値を確かめ、通ればダイアログを開く。 */
  const review = (): void => {
    setSaved(false);
    setFailure(null);
    const empty: FieldProblems = {};
    for (const field of TARGET_CRAWL_LIMIT_FIELDS) {
      const number = Number(values[field].trim());
      if (values[field].trim() === '' || !Number.isFinite(number)) {
        empty[field] = EMPTY_FIELD_PROBLEM[field];
      }
    }
    if (Object.keys(empty).length > 0) {
      setProblems(empty);
      return;
    }
    const entered = {
      maxPages: Number(values.maxPages.trim()),
      maxRuntimeMs: Number(values.maxRuntimeMs.trim()),
      minNavigationIntervalMs: Number(values.minNavigationIntervalMs.trim()),
    };
    setBusy(true);
    void preview(request(entered))
      .then((result) => {
        if (result.ok) {
          setProblems({});
          setPending(result);
        } else {
          setProblems(problemsOf(result));
          setFailure(isFailureReason(result.reason) ? { kind: 'REJECTED', reason: result.reason } : { kind: 'REQUEST_FAILED' });
        }
      }, () => setFailure({ kind: 'REQUEST_FAILED' }))
      .finally(() => setBusy(false));
  };

  const hintOf = (field: TargetCrawlLimitField): string => {
    const current = text.currentValue(VALUE_TEXT[field](limits[field]));
    return field === 'minNavigationIntervalMs' && floorMs > 0 ? `${current} ${text.intervalFloor(formatDuration(floorMs))}` : current;
  };

  return (
    <section className="panel" data-testid="profile-crawl-limits">
      <h2 className="panel-heading">{text.heading}</h2>
      <p className="muted">{text.body}</p>
      <dl className="facts">
        <dt>{text.targetConfigPath}</dt>
        <dd><code>{view.targetConfigPath}</code></dd>
      </dl>
      {failure === null ? null : (
        <Notice kind="critical" heading={text.rejectedHeading}>
          {failure.kind === 'REJECTED' ? (
            <div data-testid="crawl-limits-rejection" data-reason={failure.reason}>
              <p>{TARGET_CRAWL_LIMITS_CHANGE_FAILURE_DESCRIPTIONS[failure.reason].description}</p>
              <p>{TARGET_CRAWL_LIMITS_CHANGE_FAILURE_DESCRIPTIONS[failure.reason].action}</p>
            </div>
          ) : <p data-testid="crawl-limits-request-failed">{text.requestFailed}</p>}
        </Notice>
      )}
      {saved ? <Notice kind="positive"><p data-testid="crawl-limits-saved">{text.saved}</p></Notice> : null}
      <form
        className="form-grid"
        onSubmit={(event) => {
          event.preventDefault();
          review();
        }}
      >
        {TARGET_CRAWL_LIMIT_FIELDS.map((field) => {
          const problem = problems[field];
          return (
            <FieldFrame key={field} label={text.fields[field]} hint={hintOf(field)} errors={problem === undefined ? [] : [TARGET_CRAWL_LIMIT_PROBLEM_DESCRIPTIONS[problem]]}>
              {({ id, describedBy, invalid }) => (
                <input
                  id={id}
                  className="input"
                  name={field}
                  type="number"
                  inputMode="numeric"
                  value={values[field]}
                  aria-describedby={describedBy}
                  aria-invalid={invalid}
                  onChange={(event) => setValues({ ...values, [field]: event.target.value })}
                />
              )}
            </FieldFrame>
          );
        })}
        <div className="button-row">
          <button type="submit" className="button" disabled={busy}>{busy && pending === null ? text.reviewing : text.review}</button>
        </div>
      </form>
      <ConfirmDialog
        open={pending !== null}
        title={text.dialog.title}
        body={text.dialog.body}
        confirmLabel={text.dialog.confirm}
        cancelLabel={text.dialog.cancel}
        busy={busy}
        onCancel={() => setPending(null)}
        onConfirm={() => {
          if (pending === null) {
            return;
          }
          setBusy(true);
          void settleServerFunction(save(request(pending.after)), isFailureReason)
            .then((outcome) => {
              setPending(null);
              if (outcome.kind === 'ACCEPTED') {
                setSaved(true);
                return router.invalidate();
              }
              setFailure(outcome);
              return undefined;
            })
            .finally(() => setBusy(false));
        }}
      >
        {pending === null ? null : (
          <>
            <table data-testid="crawl-limits-changes">
              <thead>
                <tr>
                  <th scope="col">{text.dialog.item}</th>
                  <th scope="col">{text.dialog.before}</th>
                  <th scope="col">{text.dialog.after}</th>
                </tr>
              </thead>
              <tbody>
                {TARGET_CRAWL_LIMIT_FIELDS.filter((field) => pending.before[field] !== pending.after[field]).map((field) => (
                  <tr key={field} data-testid="crawl-limits-change-row" data-field={field}>
                    <th scope="row">{ITEM_LABEL[field]}</th>
                    <td>{VALUE_TEXT[field](pending.before[field])}</td>
                    <td>{VALUE_TEXT[field](pending.after[field])}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {pending.approvedScenarioCount === 0 ? null : (
              <Notice kind="caution">
                <p data-testid="crawl-limits-approval">{text.approvalNotice(formatCount(pending.approvedScenarioCount))}</p>
              </Notice>
            )}
            <Notice kind="caution">
              <p data-testid="crawl-limits-resume">{text.resumeNotice}</p>
            </Notice>
          </>
        )}
      </ConfirmDialog>
    </section>
  );
}
