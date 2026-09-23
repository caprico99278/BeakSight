export interface CollectorHandle<TEvidence> {
  snapshot(): Promise<TEvidence>;
  detach(): void;
}

export function createCollectorHandle<TEvidence>(
  createSnapshot: () => Promise<TEvidence>,
  detachListeners: () => void,
): CollectorHandle<TEvidence> {
  let detached = false;

  return Object.freeze({
    snapshot: createSnapshot,
    detach(): void {
      if (detached) {
        return;
      }
      detached = true;
      detachListeners();
    },
  });
}
