export interface BlockedRequestEvent {
  readonly method: string;
  readonly url: string;
  readonly reason: 'NON_READ_METHOD';
}

export interface BlockedNavigationEvent {
  readonly method: string;
  readonly url: string;
  readonly reason: 'EXTERNAL_MAIN_FRAME_NAVIGATION';
}

export interface BlockedWebSocketEvent {
  readonly url: string;
  readonly reason: 'PASSIVE_WEBSOCKET';
}

export interface InvariantViolationEvent {
  readonly code: string;
  readonly message: string;
}

export interface BlockedExternalActionEvent {
  readonly candidateId: string;
  readonly url: string | null;
  readonly reason: string;
}

export interface BlockedInteractionRequestEvent {
  readonly method: string;
  readonly url: string;
  readonly reason: 'INTERACTION_FROZEN';
}

export interface BlockedInteractionNavigationEvent extends BlockedInteractionRequestEvent {}

export interface BlockedPopupEvent {
  readonly url: string;
  readonly reason: 'INTERACTION_FROZEN';
}

export interface BlockedDownloadEvent {
  readonly url: string;
  readonly suggestedFilename: string;
  readonly reason: 'INTERACTION_FROZEN';
}

export interface BlockedInteractionWebSocketEvent {
  readonly url: string;
  readonly reason: 'INTERACTION_FROZEN';
}

export interface SafetyLedgerSnapshot {
  readonly blockedRequestsByMethod: Readonly<Record<string, number>>;
  readonly blockedRequests: readonly BlockedRequestEvent[];
  readonly blockedNavigations: readonly BlockedNavigationEvent[];
  readonly blockedWebSockets: readonly BlockedWebSocketEvent[];
  readonly blockedExternalActions: readonly BlockedExternalActionEvent[];
  readonly blockedInteractionRequests: readonly BlockedInteractionRequestEvent[];
  readonly blockedInteractionNavigations: readonly BlockedInteractionNavigationEvent[];
  readonly blockedPopups: readonly BlockedPopupEvent[];
  readonly blockedDownloads: readonly BlockedDownloadEvent[];
  readonly blockedInteractionWebSockets: readonly BlockedInteractionWebSocketEvent[];
  readonly invariantViolations: readonly InvariantViolationEvent[];
}

const MAX_LEDGER_EVENTS = 256;
const MAX_LEDGER_TEXT_LENGTH = 2_048;
const MAX_LEDGER_METHOD_LENGTH = 32;
const MAX_LEDGER_METHOD_KEYS = 64;
const MAX_LEDGER_COUNTER = 65_535;

export class SafetyLedger {
  readonly #blockedRequestsByMethod: Record<string, number> = Object.create(null) as Record<string, number>;
  readonly #blockedRequests: BlockedRequestEvent[] = [];
  readonly #blockedNavigations: BlockedNavigationEvent[] = [];
  readonly #blockedWebSockets: BlockedWebSocketEvent[] = [];
  readonly #blockedExternalActions: BlockedExternalActionEvent[] = [];
  readonly #blockedInteractionRequests: BlockedInteractionRequestEvent[] = [];
  readonly #blockedInteractionNavigations: BlockedInteractionNavigationEvent[] = [];
  readonly #blockedPopups: BlockedPopupEvent[] = [];
  readonly #blockedDownloads: BlockedDownloadEvent[] = [];
  readonly #blockedInteractionWebSockets: BlockedInteractionWebSocketEvent[] = [];
  readonly #invariantViolations: InvariantViolationEvent[] = [];
  readonly #reportedLimits = new Set<string>();

  recordBlockedRequest(event: BlockedRequestEvent): void {
    const method = this.#boundedMethod(event.method, 'blockedRequests.method');
    const currentCount = this.#blockedRequestsByMethod[method];
    if (currentCount === undefined) {
      if (Object.keys(this.#blockedRequestsByMethod).length >= MAX_LEDGER_METHOD_KEYS) {
        this.#recordLimit('blockedRequestsByMethod');
      } else {
        this.#blockedRequestsByMethod[method] = 1;
      }
    } else if (currentCount >= MAX_LEDGER_COUNTER) {
      this.#recordLimit(`blockedRequestsByMethod.${method}.counter`);
    } else {
      this.#blockedRequestsByMethod[method] = currentCount + 1;
    }
    this.#pushEvent(this.#blockedRequests, {
      ...event,
      method,
      url: this.#boundedText(event.url, 'blockedRequests.url'),
    }, 'blockedRequests');
  }

  recordBlockedNavigation(event: BlockedNavigationEvent): void {
    this.#pushEvent(this.#blockedNavigations, {
      ...event,
      method: this.#boundedMethod(event.method, 'blockedNavigations.method'),
      url: this.#boundedText(event.url, 'blockedNavigations.url'),
    }, 'blockedNavigations');
  }

  recordBlockedWebSocket(event: BlockedWebSocketEvent): void {
    this.#pushEvent(this.#blockedWebSockets, {
      ...event,
      url: this.#boundedText(event.url, 'blockedWebSockets.url'),
    }, 'blockedWebSockets');
  }

  recordBlockedExternalAction(event: BlockedExternalActionEvent): void {
    this.#pushEvent(this.#blockedExternalActions, {
      candidateId: this.#boundedText(event.candidateId, 'blockedExternalActions.candidateId'),
      url: event.url === null ? null : this.#boundedText(event.url, 'blockedExternalActions.url'),
      reason: this.#boundedText(event.reason, 'blockedExternalActions.reason'),
    }, 'blockedExternalActions');
  }

  recordBlockedInteractionRequest(event: BlockedInteractionRequestEvent): void {
    this.#pushEvent(this.#blockedInteractionRequests, {
      ...event,
      method: this.#boundedMethod(event.method, 'blockedInteractionRequests.method'),
      url: this.#boundedText(event.url, 'blockedInteractionRequests.url'),
    }, 'blockedInteractionRequests');
  }

  recordBlockedInteractionNavigation(event: BlockedInteractionNavigationEvent): void {
    this.#pushEvent(this.#blockedInteractionNavigations, {
      ...event,
      method: this.#boundedMethod(event.method, 'blockedInteractionNavigations.method'),
      url: this.#boundedText(event.url, 'blockedInteractionNavigations.url'),
    }, 'blockedInteractionNavigations');
  }

  recordBlockedPopup(event: BlockedPopupEvent): void {
    this.#pushEvent(this.#blockedPopups, {
      ...event,
      url: this.#boundedText(event.url, 'blockedPopups.url'),
    }, 'blockedPopups');
  }

  recordBlockedDownload(event: BlockedDownloadEvent): void {
    this.#pushEvent(this.#blockedDownloads, {
      ...event,
      url: this.#boundedText(event.url, 'blockedDownloads.url'),
      suggestedFilename: this.#boundedText(event.suggestedFilename, 'blockedDownloads.suggestedFilename'),
    }, 'blockedDownloads');
  }

  recordBlockedInteractionWebSocket(event: BlockedInteractionWebSocketEvent): void {
    this.#pushEvent(this.#blockedInteractionWebSockets, {
      ...event,
      url: this.#boundedText(event.url, 'blockedInteractionWebSockets.url'),
    }, 'blockedInteractionWebSockets');
  }

  recordInvariantViolation(event: InvariantViolationEvent): void {
    const boundedEvent = {
      code: event.code.slice(0, MAX_LEDGER_TEXT_LENGTH),
      message: event.message.slice(0, MAX_LEDGER_TEXT_LENGTH),
    };
    this.#pushInvariant(boundedEvent);
    if (boundedEvent.code !== event.code || boundedEvent.message !== event.message) {
      this.#recordLimit('invariantViolations.text');
    }
  }

  snapshot(): SafetyLedgerSnapshot {
    const immutableEvents = <Event extends object>(events: readonly Event[]): readonly Readonly<Event>[] => (
      Object.freeze(events.map((event) => Object.freeze({ ...event })))
    );
    return Object.freeze({
      blockedRequestsByMethod: Object.freeze(Object.assign(
        Object.create(null) as Record<string, number>,
        this.#blockedRequestsByMethod,
      )),
      blockedRequests: immutableEvents(this.#blockedRequests),
      blockedNavigations: immutableEvents(this.#blockedNavigations),
      blockedWebSockets: immutableEvents(this.#blockedWebSockets),
      blockedExternalActions: immutableEvents(this.#blockedExternalActions),
      blockedInteractionRequests: immutableEvents(this.#blockedInteractionRequests),
      blockedInteractionNavigations: immutableEvents(this.#blockedInteractionNavigations),
      blockedPopups: immutableEvents(this.#blockedPopups),
      blockedDownloads: immutableEvents(this.#blockedDownloads),
      blockedInteractionWebSockets: immutableEvents(this.#blockedInteractionWebSockets),
      invariantViolations: immutableEvents(this.#invariantViolations),
    });
  }

  #boundedMethod(value: string, category: string): string {
    const normalized = value.toUpperCase();
    if (normalized.length > MAX_LEDGER_METHOD_LENGTH) {
      this.#recordLimit(category);
    }
    return normalized.slice(0, MAX_LEDGER_METHOD_LENGTH);
  }

  #boundedText(value: string, category: string): string {
    if (value.length > MAX_LEDGER_TEXT_LENGTH) {
      this.#recordLimit(category);
    }
    return value.slice(0, MAX_LEDGER_TEXT_LENGTH);
  }

  #pushEvent<Event extends object>(events: Event[], event: Event, category: string): void {
    if (events.length >= MAX_LEDGER_EVENTS) {
      this.#recordLimit(category);
      return;
    }
    events.push(event);
  }

  #pushInvariant(event: InvariantViolationEvent): void {
    if (this.#invariantViolations.length >= MAX_LEDGER_EVENTS) {
      this.#recordLimit('invariantViolations');
      return;
    }
    this.#invariantViolations.push(event);
  }

  #recordLimit(category: string): void {
    const boundedCategory = category.slice(0, MAX_LEDGER_TEXT_LENGTH);
    if (this.#reportedLimits.has(boundedCategory)) {
      return;
    }
    this.#reportedLimits.add(boundedCategory);
    const event = { code: 'SAFETY_LEDGER_LIMIT_REACHED', message: boundedCategory };
    if (this.#invariantViolations.length >= MAX_LEDGER_EVENTS) {
      let replacementIndex = MAX_LEDGER_EVENTS - 1;
      while (
        replacementIndex > 0
        && this.#invariantViolations[replacementIndex]?.code === 'SAFETY_LEDGER_LIMIT_REACHED'
      ) {
        replacementIndex -= 1;
      }
      this.#invariantViolations[replacementIndex] = event;
      return;
    }
    this.#invariantViolations.push(event);
  }
}
