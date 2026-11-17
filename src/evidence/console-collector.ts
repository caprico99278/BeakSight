import type { ConsoleMessage, Page } from 'playwright';
import { safeErrorMessage } from '../core/errors.js';
import {
  CONSOLE_MESSAGE_TYPES,
  type ConsoleEvidence,
  type ConsoleMessageEvidence,
  type PageErrorEvidence,
} from '../core/evidence-types.js';
import { createCollectorHandle, type CollectorHandle } from './collector-handle.js';

function copyConsoleMessage(message: ConsoleMessageEvidence): ConsoleMessageEvidence {
  return Object.freeze({ ...message, location: Object.freeze({ ...message.location }) });
}

function copyPageError(error: PageErrorEvidence): PageErrorEvidence {
  return Object.freeze({ ...error });
}

/** `Reflect.get` で読んだ値が文字列なら返す。読み取りが例外を投げた場合と文字列でない場合は `null`。 */
function readStringProperty(target: object, key: string): string | null {
  try {
    const value = Reflect.get(target, key) as unknown;
    return typeof value === 'string' ? value : null;
  } catch {
    return null;
  }
}

/**
 * pageerror の値を、例外を投げずに Evidence にする。
 * 名前を読めない場合は空文字列、stack を読めない場合は `null` にする。メッセージは `safeErrorMessage` で読む。
 * LZ-2: 名前・メッセージ・stack の長さの上限（前は 256・2,048・8,192）は置かない。切り詰めない（`truncated` は前の記録の形のために残し、いつも偽）。
 */
function pageErrorEvidence(error: unknown): PageErrorEvidence {
  const source = typeof error === 'object' && error !== null ? error : null;
  return Object.freeze({
    name: (source === null ? null : readStringProperty(source, 'name')) ?? '',
    message: safeErrorMessage(error),
    stack: source === null ? null : readStringProperty(source, 'stack'),
    truncated: false,
  });
}

export class ConsoleCollector {
  static attach(page: Page): CollectorHandle<ConsoleEvidence> {
    const consoleMessages: ConsoleMessageEvidence[] = [];
    const pageErrors: PageErrorEvidence[] = [];
    // L2（設計書 `2026-11-09-beaksight-remove-limits-design.md` 4、INV-LIMITS の表 A の N8）: 件数の上限（`MAX_CONSOLE_MESSAGES`・`MAX_PAGE_ERRORS`）を
    // 置かず、全部を記録する。省いた数の欄は、形を保つために残し、常に 0。
    const omittedConsoleMessageCount = 0;
    const omittedPageErrorCount = 0;

    const onConsole = (message: ConsoleMessage): void => {
      const messageType = message.type();
      const type = CONSOLE_MESSAGE_TYPES.find((candidate) => candidate === messageType);
      if (type === undefined) {
        return;
      }
      const location = message.location();
      consoleMessages.push(Object.freeze({
        type,
        // LZ-2: 文は切り詰めない（前は 2,048 まで。`truncated` は前の記録の形のために残し、いつも偽）。
        text: message.text(),
        location: Object.freeze({
          // URL-LEN: 場所の URL は切り詰めない（前は 2,048 までに切り詰めた）。
          url: location.url,
          lineNumber: location.lineNumber,
          columnNumber: location.columnNumber,
        }),
        truncated: false,
      }));
    };
    const onPageError = (error: Error): void => {
      pageErrors.push(pageErrorEvidence(error));
    };

    page.on('console', onConsole);
    page.on('pageerror', onPageError);

    return createCollectorHandle(
      async () => {
        const messageBoundary = consoleMessages.map(copyConsoleMessage);
        const errorBoundary = pageErrors.map(copyPageError);
        return Object.freeze({
          consoleMessages: Object.freeze(messageBoundary),
          pageErrors: Object.freeze(errorBoundary),
          omittedConsoleMessageCount,
          omittedPageErrorCount,
        });
      },
      () => {
        page.off('console', onConsole);
        page.off('pageerror', onPageError);
      },
    );
  }
}
