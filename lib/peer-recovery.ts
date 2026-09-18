export function cancelPeerRecovery(timers: Map<string, number>, peerId: string) {
  const timer = timers.get(peerId);
  if (timer !== undefined) window.clearTimeout(timer);
  timers.delete(peerId);
}

/** Re-arm stalled peers even when the browser emits no further ICE state event. */
export function schedulePeerRecovery(
  timers: Map<string, number>, peerId: string, delay: number,
  shouldRecover: () => boolean, recover: () => Promise<void>,
) {
  cancelPeerRecovery(timers, peerId);
  const timer = window.setTimeout(() => {
    if (timers.get(peerId) !== timer) return;
    timers.delete(peerId);
    if (!shouldRecover()) return;
    void recover().catch(() => undefined).finally(() => {
      if (shouldRecover() && !timers.has(peerId)) {
        schedulePeerRecovery(timers, peerId, 12000, shouldRecover, recover);
      }
    });
  }, delay);
  timers.set(peerId, timer);
}
