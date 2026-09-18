const updates = new WeakMap<RTCRtpSender, Promise<void>>();

/** Serialize track and encoding updates; one failed update must not block the next. */
export function updateSender(sender: RTCRtpSender, update: () => Promise<void>) {
  const operation = (updates.get(sender) || Promise.resolve()).catch(() => undefined).then(update);
  updates.set(sender, operation);
  void operation.finally(() => {
    if (updates.get(sender) === operation) updates.delete(sender);
  }).catch(() => undefined);
  return operation;
}

export function replaceSenderTrack(sender: RTCRtpSender, track: MediaStreamTrack | null) {
  return updateSender(sender, async () => {
    if (sender.transport?.state === 'closed') return;
    await sender.replaceTrack(track);
  });
}
