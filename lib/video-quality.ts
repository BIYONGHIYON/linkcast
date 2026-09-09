/** One quality-first policy for initial connection and renegotiation. */
export async function configureVideoQuality(sender: RTCRtpSender) {
  if (sender.track?.kind !== 'video') return;
  const parameters = sender.getParameters();
  // Retry after negotiation when a browser has not supplied encodings yet.
  if (!parameters.encodings.length) return;
  parameters.degradationPreference = 'maintain-resolution';
  for (const encoding of parameters.encodings) {
    delete encoding.maxBitrate;
    encoding.maxFramerate = 60;
    encoding.scaleResolutionDownBy = 1;
  }
  await sender.setParameters(parameters);
}
