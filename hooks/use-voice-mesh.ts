'use client';

import { useCallback, useEffect, useRef } from 'react';
import type { CallParticipant } from './use-call-presence';
import { matchesRemoteIce, rtcConfiguration, updateConnection } from '../lib/rtc-connection';
import { replaceSenderTrack } from '../lib/rtc-sender';

type Entry = {
  pc: RTCPeerConnection;
  sender: RTCRtpSender;
  candidates: RTCIceCandidateInit[];
  sessionId: string;
  offerId: string | null;
  started: boolean;
  listed: boolean;
  timer?: number;
  retries: number;
  negotiate: (restart?: boolean) => void;
};
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
type Message = {
  kind?: string;
  sessionId?: string;
  offerId?: string;
  description?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit;
};

function scheduleMeshRecovery(entry: Entry, id: string, selfId: string, current: () => boolean, send: Options['send'], delay: number) {
  window.clearTimeout(entry.timer);
  if (!current() || entry.pc.connectionState === 'connected' || entry.retries >= 3) return;
  entry.timer = window.setTimeout(() => {
    if (!current() || entry.pc.connectionState === 'connected') return;
    entry.retries++;
    if (selfId < id) entry.negotiate(true);
    else {
      send(id, { kind: 'restart', sessionId: entry.sessionId });
      scheduleMeshRecovery(entry, id, selfId, current, send, 12000);
    }
  }, delay);
}

/** One deterministic offerer per viewer pair, with independent recovery per pair. */
export function useVoiceMesh({ selfId, hostId, participants, track, attach, remove, send, subscribe }: Options) {
  const peers = useRef(new Map<string, Entry>());
  const retired = useRef(new Set<string>());
  const earlyCandidates = useRef(new Map<string, RTCIceCandidateInit[]>());
  const close = useCallback((id: string) => {
    const entry = peers.current.get(id);
    peers.current.delete(id);
    if (entry) {
      retired.current.add(entry.sessionId);
      if (retired.current.size > 64) retired.current.delete(retired.current.values().next().value!);
      window.clearTimeout(entry.timer);
      entry.pc.ontrack = null;
      entry.pc.onicecandidate = null;
      entry.pc.onconnectionstatechange = null;
      entry.pc.oniceconnectionstatechange = null;
      entry.pc.close();
    }
    remove(`mesh:${id}`);
  }, [remove]);

  const create = useCallback((id: string, sessionId: string = crypto.randomUUID()) => {
    const existing = peers.current.get(id);
    if (existing) return existing;
    const pc = new RTCPeerConnection(rtcConfiguration);
    const transceiver = pc.addTransceiver(track.current || 'audio', { direction: 'sendrecv' });
    const key = `${id}:${sessionId}`;
    const entry: Entry = {
      pc, sender: transceiver.sender, candidates: earlyCandidates.current.get(key) || [],
      sessionId, offerId: null, started: false, listed: false, retries: 0, negotiate: () => undefined,
    };
    earlyCandidates.current.delete(key);
    peers.current.set(id, entry);
    const current = () => peers.current.get(id) === entry;
    entry.negotiate = (restart = false) => {
      if (!current() || selfId > id || (!restart && entry.started)) return;
      entry.started = true;
      void updateConnection(pc, async () => {
        if (!current()) return;
        if (pc.signalingState === 'have-local-offer') {
          if (!restart) return;
          await pc.setLocalDescription({ type: 'rollback' });
        }
        if (!current() || pc.signalingState !== 'stable') return;
        const offer = await pc.createOffer({ iceRestart: restart });
        if (!current()) return;
        entry.offerId = crypto.randomUUID();
        await pc.setLocalDescription(offer);
        if (!current()) return;
        send(id, { kind: 'offer', sessionId, offerId: entry.offerId, description: pc.localDescription });
      }).catch(() => undefined).finally(() => scheduleMeshRecovery(entry, id, selfId, current, send, 12000));
    };
    pc.onicecandidate = event => {
      if (current() && event.candidate) send(id, { kind: 'candidate', sessionId, candidate: event.candidate.toJSON() });
    };
    pc.ontrack = event => {
      if (current() && event.track.kind === 'audio') attach(`mesh:${id}`, event.track);
    };
    const connectionChanged = () => {
      if (!current()) return;
      if (pc.connectionState === 'connected') {
        window.clearTimeout(entry.timer);
        entry.retries = 0;
        return;
      }
      scheduleMeshRecovery(entry, id, selfId, current, send, pc.connectionState === 'failed' || pc.iceConnectionState === 'failed' ? 500 :
        pc.connectionState === 'disconnected' || pc.iceConnectionState === 'disconnected' ? 3000 : 12000);
    };
    pc.onconnectionstatechange = connectionChanged;
    pc.oniceconnectionstatechange = connectionChanged;
    scheduleMeshRecovery(entry, id, selfId, current, send, 12000);
    return entry;
  }, [attach, selfId, send, track]);

  useEffect(() => subscribe((id, payload) => {
    // Signals may arrive before React commits the host's latest participant list.
    if (!selfId || !hostId || selfId === hostId || id === selfId || id === hostId ||
      !/^[a-zA-Z0-9_-]{16,80}$/.test(id) || !payload || typeof payload !== 'object') return;
    const message = payload as Message;
    if (!['offer', 'answer', 'candidate', 'restart'].includes(message.kind || '')) return;
    if (message.sessionId !== undefined && (typeof message.sessionId !== 'string' || message.sessionId.length > 64)) return;
    if (message.offerId !== undefined && (typeof message.offerId !== 'string' || message.offerId.length > 64)) return;
    if (message.kind !== 'restart' && message.sessionId && retired.current.has(message.sessionId)) return;
    if (message.kind === 'offer' && id > selfId) return;
    if (message.kind === 'restart' && selfId > id) return;

    let entry = peers.current.get(id);
    const wasListed = entry?.listed || false;
    if (message.kind === 'candidate' && message.candidate && message.sessionId && (!entry || entry.sessionId !== message.sessionId)) {
      const key = `${id}:${message.sessionId}`;
      if (!earlyCandidates.current.has(key) && earlyCandidates.current.size >= 16) return;
      const candidates = earlyCandidates.current.get(key) || [];
      if (candidates.length < 128) candidates.push(message.candidate);
      earlyCandidates.current.set(key, candidates);
      return;
    }
    if (entry && message.sessionId && entry.sessionId !== message.sessionId) {
      if (message.kind !== 'offer' && message.kind !== 'restart') return;
      close(id);
      entry = undefined;
    }
    if (!entry && message.kind === 'answer') return;
    if (!entry && peers.current.size >= 4) return;
    const peer = entry || create(id, message.kind === 'restart' ? undefined : message.sessionId);
    peer.listed ||= wasListed;
    if (message.kind === 'restart') { if (selfId < id) peer.negotiate(true); return; }
    void updateConnection(peer.pc, async () => {
      const current = () => peers.current.get(id) === peer;
      if (!current()) return;
      const { pc } = peer;
      if (message.kind === 'candidate' && message.candidate) {
        if (matchesRemoteIce(pc, message.candidate)) await pc.addIceCandidate(message.candidate).catch(() => undefined);
        else if (peer.candidates.length < 128) peer.candidates.push(message.candidate);
        return;
      }
      if (!message.description || message.description.type !== message.kind || typeof message.description.sdp !== 'string') return;
      if (message.kind === 'answer' && (pc.signalingState !== 'have-local-offer' ||
        (message.offerId && message.offerId !== peer.offerId))) return;
      await pc.setRemoteDescription(message.description);
      if (!current()) return;
      await replaceSenderTrack(peer.sender, track.current).catch(() => undefined);
      for (const candidate of peer.candidates.splice(0)) {
        if (!current()) return;
        if (!matchesRemoteIce(pc, candidate)) {
          if (peer.candidates.length < 128) peer.candidates.push(candidate);
          continue;
        }
        await pc.addIceCandidate(candidate).catch(() => undefined);
      }
      if (message.kind === 'offer') {
        if (!current()) return;
        const answer = await pc.createAnswer();
        if (!current()) return;
        await pc.setLocalDescription(answer);
        if (current()) send(id, { kind: 'answer', sessionId: message.sessionId, offerId: message.offerId, description: pc.localDescription });
      }
    }).catch(() => undefined);
  }), [close, create, hostId, selfId, send, subscribe, track]);

  useEffect(() => {
    const ids = new Set(selfId && hostId && selfId !== hostId
      ? participants.filter(p => p.id !== hostId && p.id !== selfId).map(p => p.id) : []);
    for (const [id, entry] of peers.current) {
      // An older roster must not delete a connection introduced by a newer offer.
      if (entry.listed && !ids.has(id)) close(id);
    }
    for (const id of ids) {
      const entry = peers.current.get(id) || create(id);
      entry.listed = true;
      if (selfId < id && !entry.started) entry.negotiate();
    }
  }, [participants, selfId, hostId, close, create]);

  useEffect(() => () => {
    for (const id of peers.current.keys()) close(id);
    earlyCandidates.current.clear();
    retired.current.clear();
  }, [selfId, hostId, close]);

  return useCallback(async (next: MediaStreamTrack | null) => {
    await Promise.allSettled([...peers.current.values()].map(entry => replaceSenderTrack(entry.sender, next)));
  }, []);
}
