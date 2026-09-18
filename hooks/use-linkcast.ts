'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { SignalingSocket } from './signaling-socket';
import { useVoiceChat } from './use-voice-chat';
import { useCallPresence } from './use-call-presence';
import { useLaserStrokes } from './use-laser-strokes';
import { useVoiceMesh } from './use-voice-mesh';
import { configureVideoQuality } from '../lib/video-quality';
import { queueDataChannel, type DataChannelTransport } from '../lib/data-channel';
import { replaceSenderTrack } from '../lib/rtc-sender';
import { matchesRemoteIce, rtcConfiguration, updateConnection } from '../lib/rtc-connection';
import { cancelPeerRecovery, schedulePeerRecovery } from '../lib/peer-recovery';

type Role = 'host' | 'viewer';
export type LaserPoint = { x: number; y: number };
export type LaserStroke = { id: string; points: LaserPoint[] };
type ConnectionStatus =
  | 'idle'
  | 'creating'
  | 'waiting'
  | 'connecting'
  | 'connected'
  | 'full'
  | 'not-found'
  | 'failed';

type Signal = {
  id: number;
  senderId: string;
  kind: 'join' | 'leave' | 'offer' | 'answer' | 'candidate' | 'host_lost' | 'host_restart' | 'room_closed';
  payload: string;
};

type RoomResponse = {
  roomId: string;
  hostId: string;
};
type SignalPayload = RTCIceCandidateInit & Partial<RTCSessionDescriptionInit> & {
  connectionId?: string;
  offerId?: string;
  voiceMid?: string;
  reset?: boolean;
  reconnecting?: boolean;
};

const SIGNALING_RETRY_ERROR = '연결 서버에 닿지 못했어요. 다시 연결하고 있습니다.';
const MAX_VIEWERS = 5;

function randomId() {
  return crypto.randomUUID().replaceAll('-', '');
}

function findVoiceTransceiver(connection: RTCPeerConnection, expectedMid?: string) {
  if (expectedMid) {
    // During ontrack the capture track can arrive before the voice m-line.
    // Never substitute capture audio for a known, not-yet-created voice m-line.
    return connection.getTransceivers().find((transceiver) => transceiver.mid === expectedMid) || null;
  }

  // The host creates the capture-audio transceiver before the dedicated
  // voice transceiver. If a browser drops the auxiliary voiceMid metadata,
  // the last audio m-line is still the dedicated voice m-line.
  const audioTransceivers = connection.getTransceivers().filter((transceiver) =>
    transceiver.receiver.track.kind === 'audio' || transceiver.sender.track?.kind === 'audio',
  );
  return audioTransceivers[audioTransceivers.length - 1] || null;
}


export function useLinkcast() {
  const voice = useVoiceChat();
  const { participants, register: registerPresence, remove: removePresence, clear: clearPresence, signalVoice, subscribeVoice, isOpen: isPresenceOpen } = useCallPresence({ enabled: voice.enabled, muted: voice.muted, speaking: voice.speaking });
  const { attach: attachVoice, remove: removeVoice, stop: stopVoice, track: voiceTrack, subscribeTrack } = voice;
  const voiceTransceivers = useRef(new Map<string, RTCRtpTransceiver>());
  const voiceMids = useRef(new Map<string, string>());
  const [meshIdentity, setMeshIdentity] = useState({ selfId: '', hostId: '' });
  const replaceMeshTrack = useVoiceMesh({ ...meshIdentity, participants, track: voiceTrack, attach: attachVoice, remove: removeVoice, send: signalVoice, subscribe: subscribeVoice });
  useEffect(() => subscribeTrack(async next => {
    const replacements: Promise<void>[] = [];
    peerConnectionsRef.current.forEach((connection, peerId) => {
      if (connection.signalingState === 'closed') return;
      let transceiver = voiceTransceivers.current.get(peerId);
      if (!transceiver) {
        transceiver = findVoiceTransceiver(connection, voiceMids.current.get(peerId)) || undefined;
        if (transceiver) {
          transceiver.direction = 'sendrecv';
          voiceTransceivers.current.set(peerId, transceiver);
          if (transceiver.mid) voiceMids.current.set(peerId, transceiver.mid);
        }
      }
      if (transceiver) replacements.push(replaceSenderTrack(transceiver.sender, next));
    });
    // A departing peer must not prevent installing the microphone in the mesh.
    await Promise.allSettled([...replacements, replaceMeshTrack(next)]);
  }), [subscribeTrack, replaceMeshTrack]);
  const transportRef = useRef<SignalingSocket | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>('idle');
  const [roomId, setRoomId] = useState('');
  const [viewerCount, setViewerCount] = useState(0);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [error, setError] = useState('');
  const api = useCallback(<T,>(path: string, init?: RequestInit) => {
    const transport = transportRef.current ??= new SignalingSocket();
    transport.onStatus = (connected, reason) => {
      if (reason === 'room_full') { setStatus('full'); setError('참가 인원이 가득 찼어요.'); return; }
      if (reason === 'room_offline' || reason === 'room_not_found') { setStatus('not-found'); setError('종료되었거나 존재하지 않는 송출이에요.'); return; }
      if (reason === 'room_forbidden') { setStatus('failed'); setError('이 송출에 연결할 수 없어요. 링크를 다시 확인해 주세요.'); return; }
      setError(current => connected ? (current === SIGNALING_RETRY_ERROR ? '' : current) : SIGNALING_RETRY_ERROR);
    };
    return transport.request<T>(path, init);
  }, []);
  const { strokes: laserStrokes, add: addLaserStroke, clear: clearLaserStrokes } = useLaserStrokes();
  const laserChannels = useRef(new Map<string, DataChannelTransport>());
  const broadcastLaserStroke = useCallback((stroke: LaserStroke, excludedPeerId?: string) => {
    const message = JSON.stringify(stroke);
    laserChannels.current.forEach((channel, peerId) => {
      if (peerId === excludedPeerId) return;
      channel.send(message);
    });
  }, []);
  const sendLaserStroke = useCallback((points: LaserPoint[]) => {
    const stroke = { id: crypto.randomUUID(), points: points.slice(0, 512).map(p => ({ x: Math.round(p.x * 10000) / 10000, y: Math.round(p.y * 10000) / 10000 })) };
    addLaserStroke(stroke);
    broadcastLaserStroke(stroke);
  }, [addLaserStroke, broadcastLaserStroke]);

  const roleRef = useRef<Role | null>(null);
  const roomIdRef = useRef('');
  const peerIdRef = useRef('');
  const hostIdRef = useRef('');
  const localStreamRef = useRef<MediaStream | null>(null);
  const loopGenerationRef = useRef(0);
  const peerConnectionsRef = useRef(new Map<string, RTCPeerConnection>());
  const connectionIdsRef = useRef(new Map<string, string>());
  const offerIdsRef = useRef(new Map<string, string>());
  const retiredConnectionIdsRef = useRef(new Set<string>());
  const candidateQueuesRef = useRef(new Map<string, RTCIceCandidateInit[]>());
  const iceRecoveryRef = useRef(new Set<string>());
  const connectionRecoveryTimersRef = useRef(new Map<string, number>());
  const signalingRecoveryTimersRef = useRef(new Map<string, number>());
  const remoteStreamRef = useRef<MediaStream | null>(null);
  const viewerRecoveryRef = useRef(false);
  const viewerRecoveryTimerRef = useRef<number | null>(null);
  const viewerOfferTimerRef = useRef<number | null>(null);
  const retryViewerReconnectRef = useRef<(peerId: string) => void>(() => undefined);
  const viewerReconnectAttemptsRef = useRef(0);
  const roomOperationRef = useRef(0);

  const sendSignal = useCallback(
    async (recipientId: string, kind: 'join' | 'offer' | 'answer' | 'candidate', payload: unknown) => {
      const roomId = roomIdRef.current;
      const senderId = peerIdRef.current;
      if (!roomId || !senderId) return;
      await api('/api/signals', {
        method: 'POST',
        body: JSON.stringify({
          roomId,
          senderId,
          recipientId,
          kind,
          payload,
        }),
      });
    },
    [api],
  );

  const flushCandidates = useCallback(async (peerId: string, connection: RTCPeerConnection) => {
    const key = `${peerId}:${connectionIdsRef.current.get(peerId) || ''}`;
    const queued = [...(candidateQueuesRef.current.get(key) || []), ...(candidateQueuesRef.current.get(`${peerId}:`) || [])];
    candidateQueuesRef.current.delete(key);
    candidateQueuesRef.current.delete(`${peerId}:`);
    for (const candidate of queued) {
      if (peerConnectionsRef.current.get(peerId) !== connection) return;
      if (!matchesRemoteIce(connection, candidate)) {
        const pending = candidateQueuesRef.current.get(key) || [];
        if (pending.length < 128) pending.push(candidate);
        candidateQueuesRef.current.set(key, pending);
        continue;
      }
      await connection.addIceCandidate(candidate).catch(() => undefined);
    }
  }, []);

  const closePeer = useCallback((peerId: string) => {
    const laserChannel = laserChannels.current.get(peerId);
    laserChannels.current.delete(peerId);
    laserChannel?.close();
    removePresence(peerId);
    removeVoice(peerId);
    voiceTransceivers.current.delete(peerId);
    voiceMids.current.delete(peerId);
    const connection = peerConnectionsRef.current.get(peerId);
    if (connection) {
      connection.onicecandidate = null;
      connection.oniceconnectionstatechange = null;
      connection.onconnectionstatechange = null;
      connection.ontrack = null;
      connection.close();
    }
    const recoveryTimer = connectionRecoveryTimersRef.current.get(peerId);
    if (recoveryTimer) window.clearTimeout(recoveryTimer);
    connectionRecoveryTimersRef.current.delete(peerId);
    const signalingTimer = signalingRecoveryTimersRef.current.get(peerId);
    if (signalingTimer) window.clearTimeout(signalingTimer);
    signalingRecoveryTimersRef.current.delete(peerId);
    peerConnectionsRef.current.delete(peerId);
    const connectionId = connectionIdsRef.current.get(peerId);
    if (connectionId) {
      retiredConnectionIdsRef.current.add(connectionId);
      if (retiredConnectionIdsRef.current.size > 64) retiredConnectionIdsRef.current.delete(retiredConnectionIdsRef.current.values().next().value!);
    }
    connectionIdsRef.current.delete(peerId);
    offerIdsRef.current.delete(peerId);
    for (const key of candidateQueuesRef.current.keys()) if (key.startsWith(`${peerId}:`)) candidateQueuesRef.current.delete(key);
    iceRecoveryRef.current.delete(peerId);
    if (roleRef.current === 'viewer') {
      remoteStreamRef.current = null;
      setRemoteStream(null);
    }
    setViewerCount(peerConnectionsRef.current.size);
  }, [removeVoice, removePresence]);

  const scheduleViewerReconnect = useCallback(
    (remotePeerId: string): void => {
      if (roleRef.current !== 'viewer' || viewerRecoveryRef.current) return;
      if (viewerOfferTimerRef.current !== null) window.clearTimeout(viewerOfferTimerRef.current);
      viewerOfferTimerRef.current = null;

      const attempt = viewerReconnectAttemptsRef.current + 1;
      if (attempt > 3) {
        setStatus('failed');
        setError('직접 연결이 불안정해요. 링크를 다시 열어 시도해 주세요.');
        return;
      }

      viewerReconnectAttemptsRef.current = attempt;
      viewerRecoveryRef.current = true;
      const generation = loopGenerationRef.current;
      setStatus('connecting');
      if (viewerRecoveryTimerRef.current) window.clearTimeout(viewerRecoveryTimerRef.current);

      const delay = Math.min(500 * 2 ** (attempt - 1), 3000);
      viewerRecoveryTimerRef.current = window.setTimeout(() => {
        viewerRecoveryTimerRef.current = null;
        if (generation !== loopGenerationRef.current || roleRef.current !== 'viewer' || !roomIdRef.current || !peerIdRef.current) {
          viewerRecoveryRef.current = false;
          return;
        }

        closePeer(remotePeerId);
        void api('/api/rooms', {
          method: 'POST',
          body: JSON.stringify({
            roomId: roomIdRef.current,
            peerId: peerIdRef.current,
            role: 'viewer',
          }),
        })
          .then(() => {
            if (generation !== loopGenerationRef.current) return;
            setError((current) => (current === SIGNALING_RETRY_ERROR ? '' : current));
            if (!peerConnectionsRef.current.has(remotePeerId)) {
              viewerOfferTimerRef.current = window.setTimeout(() => {
                viewerOfferTimerRef.current = null;
                if (generation === loopGenerationRef.current && !peerConnectionsRef.current.has(remotePeerId)) retryViewerReconnectRef.current(remotePeerId);
              }, 15000);
            }
          })
          .catch((reason) => {
            if (generation !== loopGenerationRef.current) return;
            const name = reason instanceof Error ? reason.name : '';
            if (name === 'room_full') {
              setStatus('full');
              setError('참가 인원이 가득 찼어요. 잠시 후 다시 시도해 주세요.');
            } else if (name === 'room_not_found' || name === 'room_offline') {
              setStatus('not-found');
              setError(name === 'room_offline' ? '송출자가 연결되어 있지 않아요.' : '종료되었거나 존재하지 않는 송출이에요.');
            } else {
              setStatus('failed');
              setError('연결 서버에 닿지 못했어요. 링크를 다시 열어 시도해 주세요.');
            }
          })
          .finally(() => {
            if (generation === loopGenerationRef.current) viewerRecoveryRef.current = false;
          });
      }, delay);
    },
    [api, closePeer],
  );

  useEffect(() => {
    retryViewerReconnectRef.current = scheduleViewerReconnect;
  }, [scheduleViewerReconnect]);

  const createPeerConnection = useCallback(
    (remotePeerId: string, connectionId = randomId()) => {
      const existing = peerConnectionsRef.current.get(remotePeerId);
      if (existing) return existing;

      const connection = new RTCPeerConnection(rtcConfiguration);
      peerConnectionsRef.current.set(remotePeerId, connection);
      connectionIdsRef.current.set(remotePeerId, connectionId);
      if (roleRef.current === 'viewer' && viewerOfferTimerRef.current !== null) {
        window.clearTimeout(viewerOfferTimerRef.current);
        viewerOfferTimerRef.current = null;
      }
      const isCurrent = () => peerConnectionsRef.current.get(remotePeerId) === connection;
      // A completed stroke is sent once, so let SCTP retransmit lost packets without
      // a short deadline. Independent strokes do not need ordered delivery.
      const channel = connection.createDataChannel('laser', { negotiated: true, id: 0, ordered: false });
      const laserChannel = queueDataChannel(channel);
      laserChannels.current.set(remotePeerId, laserChannel);
      channel.onmessage = event => {
        if (peerConnectionsRef.current.get(remotePeerId) !== connection || typeof event.data !== 'string' || event.data.length > 65536) return;
        try {
          const stroke = JSON.parse(event.data) as LaserStroke;
          if (typeof stroke.id !== 'string' || stroke.id.length > 64 || !Array.isArray(stroke.points) || !stroke.points.length || stroke.points.length > 512 || !stroke.points.every(p => p && Number.isFinite(p.x) && Number.isFinite(p.y) && p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1)) return;
          addLaserStroke(stroke);
          if (roleRef.current === 'host') broadcastLaserStroke(stroke, remotePeerId);
        } catch { /* Ignore invalid pointer messages. */ }
      };

      let recoveryAttempts = 0;
      const healthy = () => connection.connectionState === 'connected' && channel.readyState === 'open' && isPresenceOpen(remotePeerId);
      const recover = async () => {
        if (roleRef.current === 'viewer') {
          scheduleViewerReconnect(remotePeerId);
          return;
        }
        if (recoveryAttempts++ >= 3) {
          closePeer(remotePeerId);
          setStatus(peerConnectionsRef.current.size ? 'connected' : 'waiting');
          return;
        }
        iceRecoveryRef.current.add(remotePeerId);
        await updateConnection(connection, async () => {
            if (!isCurrent()) return;
            if (connection.signalingState === 'stable') {
              const offer = await connection.createOffer({ iceRestart: true });
              if (!isCurrent()) return;
              offerIdsRef.current.set(remotePeerId, randomId());
              await connection.setLocalDescription(offer);
            }
            if (!isCurrent() || connection.localDescription?.type !== 'offer') return;
            await sendSignal(remotePeerId, 'offer', {
              ...connection.localDescription.toJSON(), connectionId, offerId: offerIdsRef.current.get(remotePeerId),
              voiceMid: voiceTransceivers.current.get(remotePeerId)?.mid,
            });
        }).catch(() => {
          if (isCurrent()) setError(SIGNALING_RETRY_ERROR);
        });
      };
      const scheduleRecovery = (delay: number) => {
        schedulePeerRecovery(connectionRecoveryTimersRef.current, remotePeerId, delay, () => isCurrent() && !healthy(), recover);
      };
      channel.onclose = () => {
        if (laserChannels.current.get(remotePeerId) === laserChannel) laserChannels.current.delete(remotePeerId);
        laserChannel.close();
        if (isCurrent()) scheduleRecovery(1000);
      };
      connection.onicecandidate = (event) => {
        if (isCurrent() && event.candidate) {
          void sendSignal(remotePeerId, 'candidate', { ...event.candidate.toJSON(), connectionId }).catch(() => {
            if (isCurrent()) scheduleRecovery(1000);
          });
        }
      };
      const updateConnectionState = () => {
        if (!isCurrent()) return;
        if (healthy()) {
          cancelPeerRecovery(connectionRecoveryTimersRef.current, remotePeerId);
          recoveryAttempts = 0;
          iceRecoveryRef.current.delete(remotePeerId);
          viewerReconnectAttemptsRef.current = 0;
          viewerRecoveryRef.current = false;
          if (viewerRecoveryTimerRef.current) window.clearTimeout(viewerRecoveryTimerRef.current);
          viewerRecoveryTimerRef.current = null;
          setStatus('connected');
          setError(current => current === SIGNALING_RETRY_ERROR ? current : '');
          for (const sender of connection.getSenders()) {
            if (sender.track?.kind === 'video') void configureVideoQuality(sender).catch(() => undefined);
          }
          const voiceSender = voiceTransceivers.current.get(remotePeerId)?.sender;
          if (voiceSender) void replaceSenderTrack(voiceSender, voiceTrack.current).catch(() => undefined);
          return;
        }
        if (roleRef.current === 'viewer' || ![...peerConnectionsRef.current.values()].some(peer => peer !== connection && peer.connectionState === 'connected')) setStatus('connecting');
        if (connection.connectionState === 'failed' || connection.iceConnectionState === 'failed') scheduleRecovery(500);
        else if (connection.connectionState === 'disconnected' || connection.iceConnectionState === 'disconnected') scheduleRecovery(4000);
        else if (!connectionRecoveryTimersRef.current.has(remotePeerId)) scheduleRecovery(15000);
      };
      registerPresence(remotePeerId, connection, roleRef.current === 'host', peerIdRef.current, updateConnectionState);
      channel.onopen = updateConnectionState;
      channel.onerror = () => scheduleRecovery(1000);
      connection.oniceconnectionstatechange = updateConnectionState;
      connection.onconnectionstatechange = updateConnectionState;
      scheduleRecovery(15000);

      if (roleRef.current === 'host') {
        for (const track of localStreamRef.current?.getTracks() || []) {
          if (track.kind === 'video') track.contentHint = 'detail';
          const sender = connection.addTransceiver(track, { direction: 'sendonly', streams: [localStreamRef.current!] }).sender;
          if (track.kind === 'video') void configureVideoQuality(sender).catch(() => undefined);
        }
        const transceiver = connection.addTransceiver(voiceTrack.current || 'audio', { direction: 'sendrecv' });
        voiceTransceivers.current.set(remotePeerId, transceiver);
        // Keep the receiver track attached even if a browser fires ontrack
        // before or during the answer exchange. The same receiver track is
        // unmuted when the viewer starts sending voice.
        attachVoice(remotePeerId, transceiver.receiver.track);
        connection.ontrack = event => {
          if (isCurrent() && event.track.kind === 'audio') attachVoice(remotePeerId, event.track);
        };
        setViewerCount(peerConnectionsRef.current.size);
      } else {
        connection.ontrack = (event) => {
          if (!isCurrent()) return;
          const voiceTransceiver = voiceTransceivers.current.get(remotePeerId);
          if (
            event.track.kind === 'audio' &&
            (event.transceiver === voiceTransceiver ||
              event.transceiver.mid === voiceMids.current.get(remotePeerId) ||
              (!voiceMids.current.has(remotePeerId) && !event.streams.length &&
                event.transceiver === findVoiceTransceiver(connection)))
          ) {
            attachVoice(remotePeerId, event.track);
            return;
          }
          const stream = remoteStreamRef.current || new MediaStream();
          if (!stream.getTracks().some((track) => track.id === event.track.id)) {
            stream.addTrack(event.track);
          }
          remoteStreamRef.current = stream;
          setRemoteStream(stream);
        };
      }

      return connection;
    },
    [addLaserStroke, registerPresence, isPresenceOpen, attachVoice, voiceTrack, broadcastLaserStroke, closePeer, scheduleViewerReconnect, sendSignal],
  );

  const handleSignal = useCallback(
    async (signal: Signal, generation: number) => {
      if (generation !== loopGenerationRef.current) return;

      let parsed: unknown;
      try {
        parsed = JSON.parse(signal.payload || '{}');
      } catch {
        return;
      }
      if (!parsed || typeof parsed !== 'object') return;
      const payload = parsed as SignalPayload;
      if (payload.connectionId !== undefined && (typeof payload.connectionId !== 'string' || payload.connectionId.length > 64)) return;
      if (payload.offerId !== undefined && (typeof payload.offerId !== 'string' || payload.offerId.length > 64)) return;
      if (payload.connectionId && retiredConnectionIdsRef.current.has(payload.connectionId)) return;

      if (signal.kind === 'leave') {
        if (roleRef.current === 'host' && payload.reconnecting && peerConnectionsRef.current.has(signal.senderId)) {
          const previous = signalingRecoveryTimersRef.current.get(signal.senderId);
          if (previous !== undefined) window.clearTimeout(previous);
          signalingRecoveryTimersRef.current.set(signal.senderId, window.setTimeout(() => {
            if (generation !== loopGenerationRef.current) return;
            closePeer(signal.senderId);
            setStatus(peerConnectionsRef.current.size ? 'connected' : 'waiting');
          }, 15000));
          return;
        }
        closePeer(signal.senderId);
        if (roleRef.current === 'host') {
          setStatus(peerConnectionsRef.current.size ? 'connected' : 'waiting');
        } else if (roleRef.current === 'viewer') {
          setStatus('not-found');
          setError('송출자가 연결을 종료했어요.');
        }
        return;
      }

      if (signal.kind === 'host_lost' && roleRef.current === 'viewer') {
        const connection = peerConnectionsRef.current.get(signal.senderId);
        if (connection && ['connected', 'completed'].includes(connection.iceConnectionState)) return;
        setStatus('connecting');
        setError('송출자 연결을 확인하고 있어요.');
        return;
      }

      if (signal.kind === 'host_restart' && roleRef.current === 'viewer') {
        const connection = peerConnectionsRef.current.get(signal.senderId);
        if (connection && ['connected', 'completed'].includes(connection.iceConnectionState)) {
          setError('');
          return;
        }
        closePeer(signal.senderId);
        setStatus('connecting');
        setError('');
        await sendSignal(signal.senderId, 'join', { reset: true });
        return;
      }

      if (signal.kind === 'room_closed' && roleRef.current === 'viewer') {
        stopVoice();
        closePeer(signal.senderId);
        transportRef.current?.close();
        setStatus('not-found');
        setError('송출자가 연결을 종료했어요.');
        return;
      }

      if (signal.kind === 'join' && roleRef.current === 'host') {
        const reconnectTimer = signalingRecoveryTimersRef.current.get(signal.senderId);
        if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
        signalingRecoveryTimersRef.current.delete(signal.senderId);
        if (peerConnectionsRef.current.size >= MAX_VIEWERS && !peerConnectionsRef.current.has(signal.senderId)) return;
        let connection = peerConnectionsRef.current.get(signal.senderId);
        if (connection?.connectionState === 'connected' && !payload.reset) return;
        if (connection && (payload.reset || connection.signalingState !== 'stable')) {
          closePeer(signal.senderId);
          connection = undefined;
        }
        if (connection?.signalingState === 'closed' || connection?.iceConnectionState === 'failed') {
          closePeer(signal.senderId);
          connection = undefined;
        }
        if (connection && iceRecoveryRef.current.has(signal.senderId)) {
          closePeer(signal.senderId);
          connection = undefined;
        }
        if (connection && connection.signalingState !== 'stable') return;
        const peer = connection || createPeerConnection(signal.senderId);
        const current = () => generation === loopGenerationRef.current && peerConnectionsRef.current.get(signal.senderId) === peer;
        await updateConnection(peer, async () => {
          if (!current()) return;
          const offer = await peer.createOffer();
          if (!current()) return;
          offerIdsRef.current.set(signal.senderId, randomId());
          await peer.setLocalDescription(offer);
          if (!current()) return;
          await sendSignal(signal.senderId, 'offer', { ...offer, connectionId: connectionIdsRef.current.get(signal.senderId), offerId: offerIdsRef.current.get(signal.senderId), voiceMid: voiceTransceivers.current.get(signal.senderId)?.mid });
          if (current() && ![...peerConnectionsRef.current.values()].some(item => item.connectionState === 'connected')) setStatus('connecting');
        });
        return;
      }

      if (signal.kind === 'offer' && roleRef.current === 'viewer') {
        if (payload.type !== 'offer' || typeof payload.sdp !== 'string') return;
        let connection = peerConnectionsRef.current.get(signal.senderId);
        if (connection && payload.connectionId && connectionIdsRef.current.get(signal.senderId) !== payload.connectionId) {
          const key = `${signal.senderId}:${payload.connectionId}`;
          const pending = candidateQueuesRef.current.get(key);
          closePeer(signal.senderId);
          if (pending) candidateQueuesRef.current.set(key, pending);
          connection = undefined;
        }
        const peer = connection || createPeerConnection(signal.senderId, payload.connectionId);
        const current = () => generation === loopGenerationRef.current && peerConnectionsRef.current.get(signal.senderId) === peer;
        await updateConnection(peer, async () => {
          if (!current()) return;
          const voiceMid = typeof payload.voiceMid === 'string' ? payload.voiceMid : undefined;
          if (voiceMid) voiceMids.current.set(signal.senderId, voiceMid);
          await peer.setRemoteDescription({ type: 'offer', sdp: payload.sdp });
          if (!current()) return;
          const voiceTransceiver = findVoiceTransceiver(peer, voiceMid);
          if (voiceTransceiver) {
            voiceTransceiver.direction = 'sendrecv';
            voiceTransceivers.current.set(signal.senderId, voiceTransceiver);
            if (voiceTransceiver.mid) voiceMids.current.set(signal.senderId, voiceTransceiver.mid);
            attachVoice(signal.senderId, voiceTransceiver.receiver.track);
            // Microphone installation must not block the video answer.
            await replaceSenderTrack(voiceTransceiver.sender, voiceTrack.current).catch(() => undefined);
          }
          await flushCandidates(signal.senderId, peer);
          if (!current()) return;
          const answer = await peer.createAnswer();
          if (!current()) return;
          await peer.setLocalDescription(answer);
          if (!current()) return;
          await sendSignal(signal.senderId, 'answer', { ...answer, connectionId: payload.connectionId, offerId: payload.offerId });
        });
        return;
      }

      const connection = peerConnectionsRef.current.get(signal.senderId);
      const matchesConnection = !payload.connectionId || payload.connectionId === connectionIdsRef.current.get(signal.senderId);

      if (signal.kind === 'answer' && roleRef.current === 'host' && connection && matchesConnection) {
        if (payload.type !== 'answer' || typeof payload.sdp !== 'string') return;
        if (payload.offerId && payload.offerId !== offerIdsRef.current.get(signal.senderId)) return;
        const current = () => generation === loopGenerationRef.current && peerConnectionsRef.current.get(signal.senderId) === connection;
        await updateConnection(connection, async () => {
          if (!current() || connection.signalingState !== 'have-local-offer') return;
          if (payload.offerId && payload.offerId !== offerIdsRef.current.get(signal.senderId)) return;
          await connection.setRemoteDescription({ type: 'answer', sdp: payload.sdp });
          if (!current()) return;
          await flushCandidates(signal.senderId, connection);
          if (!current()) return;
          const voiceTransceiver = voiceTransceivers.current.get(signal.senderId);
          if (voiceTransceiver) await replaceSenderTrack(voiceTransceiver.sender, voiceTrack.current).catch(() => undefined);
          await Promise.allSettled(connection.getSenders().filter(sender => sender.track?.kind === 'video').map(configureVideoQuality));
        });
      } else if (signal.kind === 'candidate') {
        if (typeof payload.candidate !== 'string') return;
        const candidate: RTCIceCandidateInit = { candidate: payload.candidate, sdpMid: payload.sdpMid, sdpMLineIndex: payload.sdpMLineIndex, usernameFragment: payload.usernameFragment };
        if (connection && matchesConnection && matchesRemoteIce(connection, candidate)) await connection.addIceCandidate(candidate).catch(() => undefined);
        else {
          if (roleRef.current === 'host' && !matchesConnection) return;
          const key = `${signal.senderId}:${payload.connectionId || ''}`;
          if (!candidateQueuesRef.current.has(key) && candidateQueuesRef.current.size >= 32) return;
          const queue = candidateQueuesRef.current.get(key) || [];
          if (queue.length < 128) queue.push(candidate);
          candidateQueuesRef.current.set(key, queue);
        }
      }
    },
    [stopVoice, voiceTrack, attachVoice, closePeer, createPeerConnection, flushCandidates, sendSignal],
  );

  const refreshLease = useCallback(async () => { transportRef.current?.resume(); }, []);

  const stopLoops = useCallback(() => {
    loopGenerationRef.current += 1;
    if (viewerRecoveryTimerRef.current) window.clearTimeout(viewerRecoveryTimerRef.current);
    viewerRecoveryTimerRef.current = null;
    if (viewerOfferTimerRef.current !== null) window.clearTimeout(viewerOfferTimerRef.current);
    viewerOfferTimerRef.current = null;
    viewerRecoveryRef.current = false;
    connectionRecoveryTimersRef.current.forEach(timer => window.clearTimeout(timer));
    connectionRecoveryTimersRef.current.clear();
    signalingRecoveryTimersRef.current.forEach(timer => window.clearTimeout(timer));
    signalingRecoveryTimersRef.current.clear();
  }, []);

  const startLoops = useCallback(() => {
    stopLoops();
    const generation = loopGenerationRef.current;
    const queues = new Map<string, Promise<void>>();
    transportRef.current?.subscribe(signal => {
      const queue = (queues.get(signal.senderId) || Promise.resolve()).then(async () => {
        if (generation === loopGenerationRef.current) await handleSignal(signal, generation);
      }).catch(() => { if (generation === loopGenerationRef.current) setError(SIGNALING_RETRY_ERROR); });
      queues.set(signal.senderId, queue);
      void queue.then(() => {
        if (queues.get(signal.senderId) === queue) queues.delete(signal.senderId);
      });
    });
  }, [handleSignal, stopLoops]);

  const leave = useCallback(async () => {
    setMeshIdentity({ selfId: '', hostId: '' });
    roomOperationRef.current++;
    clearPresence();
    stopVoice();
    voiceTransceivers.current.clear();
    voiceMids.current.clear();
    peerConnectionsRef.current.forEach((_, id) => removeVoice(id));
    clearLaserStrokes();
    laserChannels.current.forEach(channel => channel.close());
    laserChannels.current.clear();
    stopLoops();
    const currentRoom = roomIdRef.current;
    const currentPeer = peerIdRef.current;
    peerConnectionsRef.current.forEach((connection) => {
      connection.onicecandidate = null;
      connection.oniceconnectionstatechange = null;
      connection.onconnectionstatechange = null;
      connection.ontrack = null;
      connection.close();
    });
    peerConnectionsRef.current.clear();
    connectionIdsRef.current.clear();
    offerIdsRef.current.clear();
    retiredConnectionIdsRef.current.clear();
    candidateQueuesRef.current.clear();
    iceRecoveryRef.current.clear();
    connectionRecoveryTimersRef.current.forEach((timer) => window.clearTimeout(timer));
    connectionRecoveryTimersRef.current.clear();
    remoteStreamRef.current = null;
    localStreamRef.current = null;
    viewerReconnectAttemptsRef.current = 0;
    setRemoteStream(null);
    setViewerCount(0);
    setStatus('idle');
    setRoomId('');
    setError('');

    roleRef.current = null;
    roomIdRef.current = '';
    peerIdRef.current = '';
    hostIdRef.current = '';

    if (currentRoom && currentPeer) {
      await api('/api/rooms', {
        method: 'DELETE',
        body: JSON.stringify({ roomId: currentRoom, peerId: currentPeer }),
        keepalive: true,
      }).catch(() => undefined);
    }
  }, [api, stopLoops, stopVoice, removeVoice, clearPresence, clearLaserStrokes]);

  const createRoom = useCallback(
    async (stream: MediaStream, requestedRoomId?: string) => {
      const leaving = leave();
      const operation = roomOperationRef.current;
      await leaving;
      if (operation !== roomOperationRef.current) return null;
      setStatus('creating');
      setError('');
      const nextRoomId = requestedRoomId || randomId().slice(0, 12);
      const peerId = randomId();
      try {
        localStreamRef.current = stream;
        roleRef.current = 'host';
        roomIdRef.current = nextRoomId;
        peerIdRef.current = peerId;
        hostIdRef.current = peerId;
        setMeshIdentity({ selfId: peerId, hostId: peerId });
        await api<RoomResponse>('/api/rooms', {
          method: 'POST',
          body: JSON.stringify({ roomId: nextRoomId, peerId, role: 'host' }),
        });
        if (operation !== roomOperationRef.current) return null;
        setRoomId(nextRoomId);
        setStatus('waiting');
        startLoops();
        return nextRoomId;
      } catch {
        if (operation !== roomOperationRef.current) return null;
        setStatus('failed');
        setError('방을 만들지 못했어요. 잠시 후 다시 시도해 주세요.');
        return null;
      }
    },
    [api, leave, startLoops],
  );

  const joinRoom = useCallback(
    async (targetRoomId: string) => {
      const leaving = leave();
      const operation = roomOperationRef.current;
      await leaving;
      if (operation !== roomOperationRef.current) return false;
      const normalized = targetRoomId.trim();
      const peerId = randomId();
      setStatus('connecting');
      setError('');
      try {
        roleRef.current = 'viewer';
        roomIdRef.current = normalized;
        peerIdRef.current = peerId;
        const room = await api<RoomResponse>('/api/rooms', {
          method: 'POST',
          body: JSON.stringify({ roomId: normalized, peerId, role: 'viewer' }),
        });
        if (operation !== roomOperationRef.current) return false;
        hostIdRef.current = room.hostId;
        setMeshIdentity({ selfId: peerId, hostId: room.hostId });
        setRoomId(normalized);
        startLoops();
        viewerOfferTimerRef.current = window.setTimeout(() => {
          viewerOfferTimerRef.current = null;
          if (operation === roomOperationRef.current && !peerConnectionsRef.current.has(room.hostId)) scheduleViewerReconnect(room.hostId);
        }, 15000);
        return true;
      } catch (reason) {
        if (operation !== roomOperationRef.current) return false;
        const name = reason instanceof Error ? reason.name : '';
        if (name === 'room_full') {
          setStatus('full');
          setError('참가 인원이 가득 찼어요.');
        } else if (name === 'room_not_found' || name === 'room_offline') {
          setStatus('not-found');
          setError(name === 'room_offline' ? '송출자가 연결되어 있지 않아요.' : '종료되었거나 존재하지 않는 송출이에요.');
        } else {
          setStatus('failed');
          setError('송출에 연결하지 못했어요.');
        }
        return false;
      }
    },
    [api, leave, startLoops, scheduleViewerReconnect],
  );

  useEffect(() => {
    const connections = peerConnectionsRef.current;
    const pointerChannels = laserChannels.current;
    const handlePageHide = (event: PageTransitionEvent) => {
      if (!event.persisted) { stopVoice(); transportRef.current?.close(); }
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') void refreshLease();
    };
    window.addEventListener('pagehide', handlePageHide);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      window.removeEventListener('pagehide', handlePageHide);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      stopLoops();
      transportRef.current?.close();
      pointerChannels.forEach(channel => channel.close());
      pointerChannels.clear();
      connections.forEach((connection) => {
        connection.onicecandidate = null;
        connection.oniceconnectionstatechange = null;
        connection.onconnectionstatechange = null;
        connection.ontrack = null;
        connection.close();
      });
      connections.clear();
    };
  }, [refreshLease, stopLoops, stopVoice]);

  return {
    voice: { ...voice, participants },
    laserStrokes,
    sendLaserStroke,
    status,
    roomId,
    viewerCount,
    remoteStream,
    error,
    createRoom,
    joinRoom,
    leave,
  };
}
