/** Keep each received track update observable to React and media elements. */
export function mergeRemoteStream(current: MediaStream | null, track: MediaStreamTrack) {
  const tracks = current?.getTracks() || [];
  if (tracks.some((existing) => existing.id === track.id)) return current;
  return new MediaStream([...tracks, track]);
}
