export const rtcConfiguration: RTCConfiguration = {
  iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }],
  iceCandidatePoolSize: 4,
  bundlePolicy: 'max-bundle',
};

const operations = new WeakMap<RTCPeerConnection, Promise<void>>();

/** ICE restart candidates can arrive while remoteDescription still holds the old SDP. */
export function matchesRemoteIce(connection: RTCPeerConnection, candidate: RTCIceCandidateInit) {
  const description = connection.remoteDescription;
  return Boolean(description && (!candidate.usernameFragment ||
    description.sdp?.split(/\r?\n/).includes(`a=ice-ufrag:${candidate.usernameFragment}`)));
}

/** Recovery offers and incoming SDP must never modify one connection concurrently. */
export function updateConnection(connection: RTCPeerConnection, update: () => Promise<void>) {
  const operation = (operations.get(connection) || Promise.resolve()).catch(() => undefined).then(async () => {
    if (connection.signalingState !== 'closed') await update();
  });
  operations.set(connection, operation);
  void operation.finally(() => {
    if (operations.get(connection) === operation) operations.delete(connection);
  }).catch(() => undefined);
  return operation;
}
