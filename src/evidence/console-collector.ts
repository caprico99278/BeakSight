import type { ConsoleMessage, Page } from 'playwright';
import { safeErrorMessage } from '../core/errors.js';
import {
  CONSOLE_MESSAGE_TYPES,
  type ConsoleEvidence,
  type ConsoleMessageEvidence,
  type PageErrorEvidence,
} from '../core/evidence-types.js';
import {
  MAX_CONSOLE_MESSAGES,
  MAX_CONSOLE_TEXT_LENGTH,
  MAX_ERROR_MESSAGE_LENGTH,
  MAX_ERROR_NAME_LENGTH,
  MAX_PAGE_ERRORS,
  MAX_STACK_LENGTH,
  MAX_URL_LENGTH,
} from '../core/limits.js';
import { truncateText } from '../core/text.js';
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
 * pageerror の値を、例外を投げずに上限付きの Evidence にする。
 * 名前を読めない場合は空文字列、stack を読めない場合は `null` にする。メッセージは `safeErrorMessage` で読む。
 */
function pageErrorEvidence(error: unknown): PageErrorEvidence {
  const source = typeof error === 'object' && error !== null ? error : null;
  const name = truncateText(
    (source === null ? null : readStringProperty(source, 'name')) ?? '',
    MAX_ERROR_NAME_LENGTH,
  );
  // 切り詰めたかどうかを知るため、全文を読んでから上限で切り詰める。
  const message = truncateText(safeErrorMessage(error, Number.MAX_SAFE_INTEGER), MAX_ERROR_MESSAGE_LENGTH);
  const rawStack = source === null ? null : readStringProperty(source, 'stack');
  const stack = rawStack === null ? null : truncateText(rawStack, MAX_STACK_LENGTH);
  return Object.freeze({
    name: name.text,
    message: message.text,
    stack: stack?.text ?? null,
    truncated: name.truncated || message.truncated || (stack?.truncated ?? false),
  });
}

export class ConsoleCollector {
  static attach(page: Page): CollectorHandle<ConsoleEvidence> {
    const consoleMessages: ConsoleMessageEvidence[] = [];
    const pageErrors: PageErrorEvidence[] = [];
    let omittedConsoleMessageCount = 0;
    let omittedPageErrorCount = 0;

    const onConsole = (message: ConsoleMessage): void => {
      const messageType = message.type();
      const type = CONSOLE_MESSAGE_TYPES.find((candidate) => candidate === messageType);
      if (type === undefined) {
        return;
      }
      if (consoleMessages.length >= MAX_CONSOLE_MESSAGES) {
        omittedConsoleMessageCount += 1;
        return;
      }
      const location = message.location();
      const text = truncateText(message.text(), MAX_CONSOLE_TEXT_LENGTH);
      const url = truncateText(location.url, MAX_URL_LENGTH);
      consoleMessages.push(Object.freeze({
        type,
        text: text.text,
        location: Object.freeze({
          url: url.text,
          lineNumber: location.lineNumber,
          columnNumber: location.columnNumber,
        }),
        truncated: text.truncated || url.truncated,
      }));
    };
    const onPageError = (error: Error): void => {
      if (pageErrors.length >= MAX_PAGE_ERRORS) {
        omittedPageErrorCount += 1;
        return;
      }
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
