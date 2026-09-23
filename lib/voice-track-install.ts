import { replaceSenderTrack } from './rtc-sender';

type VoiceSender = {
  sender: RTCRtpSender;
  isCurrent: () => boolean;
};

/** Install on every peer, but report failures that still belong to the call. */
export async function installVoiceTrack(peers: VoiceSender[], track: MediaStreamTrack | null) {
  const results = await Promise.allSettled(peers.map(peer => replaceSenderTrack(peer.sender, track)));
  if (results.some((result, index) => result.status === 'rejected' && peers[index].isCurrent())) {
    throw new Error('voice_sender_failed');
  }
}
