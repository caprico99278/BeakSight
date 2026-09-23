import type { ConsoleMessage, Page } from 'playwright';
import { createCollectorHandle, type CollectorHandle } from './collector-handle.js';

export interface ConsoleLocationEvidence {
  readonly url: string;
  readonly lineNumber: number;
  readonly columnNumber: number;
}

export interface ConsoleMessageEvidence {
  readonly type: 'error' | 'warning';
  readonly text: string;
  readonly location: ConsoleLocationEvidence;
}

export interface PageErrorEvidence {
  readonly name: string;
  readonly message: string;
  readonly stack: string | null;
}

export interface ConsoleEvidence {
  readonly consoleMessages: readonly ConsoleMessageEvidence[];
  readonly pageErrors: readonly PageErrorEvidence[];
}

function copyConsoleMessage(message: ConsoleMessageEvidence): ConsoleMessageEvidence {
  return Object.freeze({ ...message, location: Object.freeze({ ...message.location }) });
}

function copyPageError(error: PageErrorEvidence): PageErrorEvidence {
  return Object.freeze({ ...error });
}

export class ConsoleCollector {
  static attach(page: Page): CollectorHandle<ConsoleEvidence> {
    const consoleMessages: ConsoleMessageEvidence[] = [];
    const pageErrors: PageErrorEvidence[] = [];

    const onConsole = (message: ConsoleMessage): void => {
      const type = message.type();
      if (type !== 'error' && type !== 'warning') {
        return;
      }
      const location = message.location();
      consoleMessages.push(Object.freeze({
        type,
        text: message.text(),
        location: Object.freeze({
          url: location.url,
          lineNumber: location.lineNumber,
          columnNumber: location.columnNumber,
        }),
      }));
    };
    const onPageError = (error: Error): void => {
      pageErrors.push(Object.freeze({
        name: error.name,
        message: error.message,
        stack: error.stack ?? null,
      }));
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
        });
      },
      () => {
        page.off('console', onConsole);
        page.off('pageerror', onPageError);
      },
    );
  }
}
