import { updateSender } from './rtc-sender';

/** Reapply the same source-resolution policy after negotiation and ICE recovery. */
export function configureVideoQuality(sender: RTCRtpSender) {
  return updateSender(sender, async () => {
    if (sender.track?.kind !== 'video' || sender.transport?.state === 'closed') return;
    const configure = (preferResolution: boolean) => {
      const parameters = sender.getParameters();
      if (!parameters.encodings?.length) return null;
      if (preferResolution) parameters.degradationPreference = 'maintain-resolution';
      else delete parameters.degradationPreference;
      for (const encoding of parameters.encodings) {
        encoding.active = true;
        delete encoding.maxBitrate;
        encoding.maxFramerate = 60;
        encoding.scaleResolutionDownBy = 1;
      }
      return parameters;
    };
    const parameters = configure(true);
    // Initial senders may not have encodings until the answer is applied.
    if (!parameters) return;
    try {
      await sender.setParameters(parameters);
    } catch (error) {
      if (!(error instanceof DOMException) || !['NotSupportedError', 'InvalidModificationError'].includes(error.name)) throw error;
      // A browser rejecting degradationPreference should still receive the
      // resolution/frame-rate settings. Fetch a fresh transaction before retrying.
      const fallback = configure(false);
      if (fallback) await sender.setParameters(fallback);
    }
  });
}
