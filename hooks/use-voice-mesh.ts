'use client';

import { useCallback, useEffect, useRef } from 'react';
import type { CallParticipant } from './use-call-presence';

type Entry = { pc: RTCPeerConnection; sender: RTCRtpSender; candidates: RTCIceCandidateInit[]; queue: Promise<void>; timer?: number; retries: number };
type Options = {
  selfId: string;
  hostId: string;
  participants: CallParticipant[];
  track: { current: MediaStreamTrack | null };
  attach: (id: string, track: MediaStreamTrack) => void;
  remove: (id: string) => void;
  send: (id: string, payload: unknown) => void;
  subscribe: (listener: (id: string, payload: unknown) => void) => () => void;
};

/** Audio-only viewer mesh. Existing host connections still carry host voice/video. */
export function useVoiceMesh({ selfId, hostId, participants, track, attach, remove, send, subscribe }: Options) {
  const peers = useRef(new Map<string, Entry>());
  const allowed = useRef(new Set<string>());
  const close = useCallback((id: string) => {
    const entry = peers.current.get(id);
    peers.current.delete(id);
    if (entry) {
      window.clearTimeout(entry.timer);
      entry.pc.ontrack = null;
      entry.pc.onicecandidate = null;
      entry.pc.onconnectionstatechange = null;
      entry.pc.close();
    }
    remove(`mesh:${id}`);
  }, [remove]);

  const create = useCallback((id: string) => {
    const existing = peers.current.get(id);
    if (existing) return existing;
    const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }], bundlePolicy: 'max-bundle' });
    const transceiver = pc.addTransceiver(track.current || 'audio', { direction: 'sendrecv' });
    const entry: Entry = { pc, sender: transceiver.sender, candidates: [], queue: Promise.resolve(), retries: 0 };
    peers.current.set(id, entry);
    const current = () => peers.current.get(id) === entry;
    pc.onicecandidate = event => {
      if (current() && event.candidate) send(id, { kind: 'candidate', candidate: event.candidate.toJSON() });
    };
    pc.ontrack = event => { if (current() && event.track.kind === 'audio') attach(`mesh:${id}`, event.track); };
    pc.onconnectionstatechange = () => {
      if (!current()) return;
      window.clearTimeout(entry.timer);
      if (pc.connectionState === 'connected') { entry.retries = 0; return; }
      if (selfId < id && ['failed', 'disconnected'].includes(pc.connectionState) && entry.retries < 3) {
        entry.timer = window.setTimeout(() => {
          entry.queue = entry.queue.then(async () => {
            if (!current() || pc.connectionState === 'connected' || pc.signalingState !== 'stable') return;
            entry.retries++;
            await pc.setLocalDescription(await pc.createOffer({ iceRestart: true }));
            if (current()) send(id, { kind: 'offer', description: pc.localDescription });
          }).catch(() => undefined);
        }, 3000);
      }
    };
    return entry;
  }, [attach, selfId, send, track]);

  useEffect(() => subscribe((id, payload) => {
    if (!allowed.current.has(id) || !payload || typeof payload !== 'object') return;
    const message = payload as { kind?: string; description?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit };
    if (!['offer', 'answer', 'candidate'].includes(message.kind || '')) return;
    const entry = create(id);
    entry.queue = entry.queue.then(async () => {
      if (peers.current.get(id) !== entry) return;
      const { pc } = entry;
      if (message.kind === 'candidate' && message.candidate) {
        if (pc.remoteDescription) await pc.addIceCandidate(message.candidate);
        else if (entry.candidates.length < 128) entry.candidates.push(message.candidate);
        return;
      }
      if (!message.description || message.description.type !== message.kind) return;
      if (message.kind === 'offer' && id > selfId) return;
      if (message.kind === 'answer' && pc.signalingState !== 'have-local-offer') return;
      await pc.setRemoteDescription(message.description);
      await entry.sender.replaceTrack(track.current);
      for (const candidate of entry.candidates.splice(0)) await pc.addIceCandidate(candidate).catch(() => undefined);
      if (message.kind === 'offer') {
        await pc.setLocalDescription(await pc.createAnswer());
        if (peers.current.get(id) === entry) send(id, { kind: 'answer', description: pc.localDescription });
      }
    }).catch(() => undefined);
  }), [create, selfId, send, subscribe, track]);

  useEffect(() => {
    const ids = new Set(selfId && hostId && selfId !== hostId
      ? participants.filter(p => p.id !== hostId && p.id !== selfId).map(p => p.id) : []);
    allowed.current = ids;
    for (const id of peers.current.keys()) if (!ids.has(id)) close(id);
    for (const id of ids) {
      if (selfId > id || peers.current.has(id)) continue;
      const entry = create(id);
      entry.queue = entry.queue.then(async () => {
        if (peers.current.get(id) !== entry) return;
        await entry.pc.setLocalDescription(await entry.pc.createOffer());
        if (peers.current.get(id) === entry) send(id, { kind: 'offer', description: entry.pc.localDescription });
      }).catch(() => undefined);
    }
  }, [participants, selfId, hostId, close, create, send]);

  useEffect(() => () => {
    for (const id of peers.current.keys()) close(id);
    allowed.current.clear();
  }, [selfId, hostId, close]);

  return useCallback(async (next: MediaStreamTrack | null) => {
    await Promise.all([...peers.current.values()].map(entry => entry.sender.replaceTrack(next)));
  }, []);
}
