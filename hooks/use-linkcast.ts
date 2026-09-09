'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { SignalingSocket } from './signaling-socket';
import { useVoiceChat } from './use-voice-chat';
import { useCallPresence } from './use-call-presence';
import { useLaserStrokes } from './use-laser-strokes';
import { useVoiceMesh } from './use-voice-mesh';
import { configureVideoQuality } from '../lib/video-quality';

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

const rtcConfiguration: RTCConfiguration = {
  iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }],
  iceCandidatePoolSize: 4,
  bundlePolicy: 'max-bundle',
};

const SIGNALING_RETRY_ERROR = '연결 서버에 닿지 못했어요. 다시 연결하고 있습니다.';
const MAX_VIEWERS = 5;

function randomId() {
  return crypto.randomUUID().replaceAll('-', '');
}

function findVoiceTransceiver(connection: RTCPeerConnection, expectedMid?: string) {
  if (expectedMid) {
    const exact = connection.getTransceivers().find((transceiver) => transceiver.mid === expectedMid);
    if (exact) return exact;
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
  const { participants, register: registerPresence, remove: removePresence, clear: clearPresence, signalVoice, subscribeVoice } = useCallPresence({ enabled: voice.enabled, muted: voice.muted, speaking: voice.speaking });
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
      if (transceiver) replacements.push(transceiver.sender.replaceTrack(next));
    });
    await Promise.all(replacements);
    await replaceMeshTrack(next);
  }), [subscribeTrack, replaceMeshTrack]);
  const transportRef = useRef<SignalingSocket | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>('idle');
  const [roomId, setRoomId] = useState('');
  const [viewerCount, setViewerCount] = useState(0);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [error, setError] = useState('');
  const api = useCallback(<T,>(path: string, init?: RequestInit) => {
    const transport = transportRef.current ??= new SignalingSocket();
    transport.onStatus = connected => setError(current => connected ? (current === SIGNALING_RETRY_ERROR ? '' : current) : SIGNALING_RETRY_ERROR);
    return transport.request<T>(path, init);
  }, []);
  const { strokes: laserStrokes, add: addLaserStroke, clear: clearLaserStrokes } = useLaserStrokes();
  const laserChannels = useRef(new Map<string, RTCDataChannel>());
  const broadcastLaserStroke = useCallback((stroke: LaserStroke, excludedPeerId?: string) => {
    const message = JSON.stringify(stroke);
    laserChannels.current.forEach((channel, peerId) => {
      if (peerId === excludedPeerId) return;
      if (channel.readyState === 'open' && channel.bufferedAmount < 65536) {
        try { channel.send(message); } catch { /* Connection may close during release. */ }
      }
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
  const lastSignalIdRef = useRef(0);
  const loopGenerationRef = useRef(0);
  const peerConnectionsRef = useRef(new Map<string, RTCPeerConnection>());
  const candidateQueuesRef = useRef(new Map<string, RTCIceCandidateInit[]>());
  const iceRecoveryRef = useRef(new Set<string>());
  const connectionRecoveryTimersRef = useRef(new Map<string, number>());
  const remoteStreamRef = useRef<MediaStream | null>(null);
  const viewerRecoveryRef = useRef(false);
  const viewerRecoveryTimerRef = useRef<number | null>(null);
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
    const queued = candidateQueuesRef.current.get(peerId) || [];
    candidateQueuesRef.current.delete(peerId);
    for (const candidate of queued) {
      await connection.addIceCandidate(candidate).catch(() => undefined);
    }
  }, []);

  const closePeer = useCallback((peerId: string) => {
    removePresence(peerId);
    removeVoice(peerId);
    voiceTransceivers.current.delete(peerId);
    voiceMids.current.delete(peerId);
    const connection = peerConnectionsRef.current.get(peerId);
    if (connection) {
      connection.onicecandidate = null;
      connection.oniceconnectionstatechange = null;
      connection.ontrack = null;
      connection.close();
    }
    const recoveryTimer = connectionRecoveryTimersRef.current.get(peerId);
    if (recoveryTimer) window.clearTimeout(recoveryTimer);
    connectionRecoveryTimersRef.current.delete(peerId);
    peerConnectionsRef.current.delete(peerId);
    candidateQueuesRef.current.delete(peerId);
    iceRecoveryRef.current.delete(peerId);
    if (roleRef.current === 'viewer') {
      remoteStreamRef.current = null;
      setRemoteStream(null);
    }
    setViewerCount(peerConnectionsRef.current.size);
  }, [removeVoice, removePresence]);

  const scheduleViewerReconnect = useCallback(
    (remotePeerId: string) => {
      if (roleRef.current !== 'viewer' || viewerRecoveryRef.current) return;

      const attempt = viewerReconnectAttemptsRef.current + 1;
      if (attempt > 3) {
        setStatus('failed');
        setError('직접 연결이 불안정해요. 링크를 다시 열어 시도해 주세요.');
        return;
      }

      viewerReconnectAttemptsRef.current = attempt;
      viewerRecoveryRef.current = true;
      setStatus('connecting');
      if (viewerRecoveryTimerRef.current) window.clearTimeout(viewerRecoveryTimerRef.current);

      const delay = Math.min(500 * 2 ** (attempt - 1), 3000);
      viewerRecoveryTimerRef.current = window.setTimeout(() => {
        viewerRecoveryTimerRef.current = null;
        if (roleRef.current !== 'viewer' || !roomIdRef.current || !peerIdRef.current) {
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
          .then(() => setError((current) => (current === SIGNALING_RETRY_ERROR ? '' : current)))
          .catch((reason) => {
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
            viewerRecoveryRef.current = false;
          });
      }, delay);
    },
    [api, closePeer],
  );

  const createPeerConnection = useCallback(
    (remotePeerId: string) => {
      const existing = peerConnectionsRef.current.get(remotePeerId);
      if (existing) return existing;

      const connection = new RTCPeerConnection(rtcConfiguration);
      peerConnectionsRef.current.set(remotePeerId, connection);
      registerPresence(remotePeerId, connection, roleRef.current === 'host', peerIdRef.current);
      // Completed strokes need brief loss recovery; this is a retry deadline, not a send delay.
      const channel = connection.createDataChannel('laser', { negotiated: true, id: 0, ordered: false, maxPacketLifeTime: 500 });
      laserChannels.current.set(remotePeerId, channel);
      channel.onclose = () => {
        if (laserChannels.current.get(remotePeerId) === channel) laserChannels.current.delete(remotePeerId);
      };
      channel.onmessage = event => {
        if (peerConnectionsRef.current.get(remotePeerId) !== connection || typeof event.data !== 'string' || event.data.length > 65536) return;
        try {
          const stroke = JSON.parse(event.data) as LaserStroke;
          if (typeof stroke.id !== 'string' || stroke.id.length > 64 || !Array.isArray(stroke.points) || !stroke.points.length || stroke.points.length > 512 || !stroke.points.every(p => p && Number.isFinite(p.x) && Number.isFinite(p.y) && p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1)) return;
          addLaserStroke(stroke);
          if (roleRef.current === 'host') broadcastLaserStroke(stroke, remotePeerId);
        } catch { /* Ignore invalid pointer messages. */ }
      };

      connection.onicecandidate = (event) => {
        if (event.candidate) {
          void sendSignal(remotePeerId, 'candidate', event.candidate.toJSON()).catch(() => {
            setError('연결 정보를 전송하지 못했어요.');
          });
        }
      };

      connection.oniceconnectionstatechange = () => {
        if (connection.iceConnectionState === 'connected' || connection.iceConnectionState === 'completed') {
          iceRecoveryRef.current.delete(remotePeerId);
          viewerReconnectAttemptsRef.current = 0;
          viewerRecoveryRef.current = false;
          setStatus('connected');
          setError('');
        } else if (connection.iceConnectionState === 'checking') {
          setStatus('connecting');
        } else if (connection.iceConnectionState === 'disconnected') {
          setStatus('connecting');
          if (!connectionRecoveryTimersRef.current.has(remotePeerId)) {
            const timer = window.setTimeout(() => {
              connectionRecoveryTimersRef.current.delete(remotePeerId);
              if (connection.iceConnectionState === 'disconnected' && roleRef.current === 'viewer') {
                scheduleViewerReconnect(remotePeerId);
              }
            }, 4000);
            connectionRecoveryTimersRef.current.set(remotePeerId, timer);
          }
        } else if (connection.iceConnectionState === 'failed') {
          if (roleRef.current === 'host' && !iceRecoveryRef.current.has(remotePeerId)) {
            iceRecoveryRef.current.add(remotePeerId);
            setStatus('connecting');
            void (async () => {
              const isCurrentConnection = () => peerConnectionsRef.current.get(remotePeerId) === connection;
              try {
                if (!isCurrentConnection() || connection.signalingState === 'closed') throw new Error('connection_closed');
                connection.restartIce();
                const offer = await connection.createOffer({ iceRestart: true });
                if (!isCurrentConnection()) return;
                await connection.setLocalDescription(offer);
                if (!isCurrentConnection()) return;
                await sendSignal(remotePeerId, 'offer', { ...offer, voiceMid: voiceTransceivers.current.get(remotePeerId)?.mid });
              } catch {
                if (!isCurrentConnection()) return;
                iceRecoveryRef.current.delete(remotePeerId);
                setStatus('failed');
                setError('직접 연결에 실패했어요. 다른 네트워크에서 다시 시도해 주세요.');
                closePeer(remotePeerId);
              }
            })();
          } else if (roleRef.current === 'viewer') {
            scheduleViewerReconnect(remotePeerId);
          } else if (!iceRecoveryRef.current.has(remotePeerId)) {
            setStatus('failed');
            setError('직접 연결에 실패했어요. 다른 네트워크에서 다시 시도해 주세요.');
            closePeer(remotePeerId);
          }
        }
      };

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
          if (event.track.kind === 'audio') attachVoice(remotePeerId, event.track);
        };
        setViewerCount(peerConnectionsRef.current.size);
      } else {
        connection.ontrack = (event) => {
          const voiceTransceiver = voiceTransceivers.current.get(remotePeerId);
          if (
            event.track.kind === 'audio' &&
            (event.transceiver === voiceTransceiver ||
              event.transceiver.mid === voiceMids.current.get(remotePeerId) ||
              event.transceiver === findVoiceTransceiver(connection, voiceMids.current.get(remotePeerId)))
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
    [addLaserStroke, registerPresence, attachVoice, voiceTrack, broadcastLaserStroke, closePeer, scheduleViewerReconnect, sendSignal],
  );

  const handleSignal = useCallback(
    async (signal: Signal, generation: number) => {
      if (generation !== loopGenerationRef.current) return;

      let payload: RTCSessionDescriptionInit | RTCIceCandidateInit;
      try {
        payload = JSON.parse(signal.payload || '{}') as
          | RTCSessionDescriptionInit
          | RTCIceCandidateInit;
      } catch {
        return;
      }

      if (signal.kind === 'leave') {
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
        if (peerConnectionsRef.current.size >= MAX_VIEWERS && !peerConnectionsRef.current.has(signal.senderId)) return;
        let connection = peerConnectionsRef.current.get(signal.senderId);
        if (connection && ((payload as { reset?: boolean }).reset || connection.signalingState !== 'stable')) {
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
        connection = connection || createPeerConnection(signal.senderId);
        const offer = await connection.createOffer();
        if (generation !== loopGenerationRef.current) return;
        await connection.setLocalDescription(offer);
        if (generation !== loopGenerationRef.current) return;
        await sendSignal(signal.senderId, 'offer', { ...offer, voiceMid: voiceTransceivers.current.get(signal.senderId)?.mid });
        setStatus('connecting');
        return;
      }

      if (signal.kind === 'offer' && roleRef.current === 'viewer') {
        let connection = peerConnectionsRef.current.get(signal.senderId);
        if (connection?.signalingState === 'closed' || connection?.iceConnectionState === 'failed') {
          closePeer(signal.senderId);
          connection = undefined;
        }
        connection = connection || createPeerConnection(signal.senderId);
        if (generation !== loopGenerationRef.current) return;
        const voiceMid = (payload as RTCSessionDescriptionInit & { voiceMid?: string }).voiceMid;
        if (typeof voiceMid === 'string') voiceMids.current.set(signal.senderId, voiceMid);
        await connection.setRemoteDescription(payload as RTCSessionDescriptionInit);
        const voiceTransceiver = findVoiceTransceiver(connection, voiceMid);
        if (voiceTransceiver) {
          voiceTransceiver.direction = 'sendrecv';
          voiceTransceivers.current.set(signal.senderId, voiceTransceiver);
          if (voiceTransceiver.mid) voiceMids.current.set(signal.senderId, voiceTransceiver.mid);
          attachVoice(signal.senderId, voiceTransceiver.receiver.track);
          await voiceTransceiver.sender.replaceTrack(voiceTrack.current);
        }
        await flushCandidates(signal.senderId, connection);
        if (generation !== loopGenerationRef.current) return;
        const answer = await connection.createAnswer();
        await connection.setLocalDescription(answer);
        if (generation !== loopGenerationRef.current) return;
        await sendSignal(signal.senderId, 'answer', answer);
        setStatus('connecting');
        return;
      }

      const connection = peerConnectionsRef.current.get(signal.senderId);
      if (!connection) {
        if (signal.kind === 'candidate') {
          const queue = candidateQueuesRef.current.get(signal.senderId) || [];
          queue.push(payload as RTCIceCandidateInit);
          candidateQueuesRef.current.set(signal.senderId, queue);
        }
        return;
      }

      if (signal.kind === 'answer' && roleRef.current === 'host') {
        if (generation !== loopGenerationRef.current) return;
        await connection.setRemoteDescription(payload as RTCSessionDescriptionInit);
        await flushCandidates(signal.senderId, connection);
        const voiceTransceiver = voiceTransceivers.current.get(signal.senderId);
        if (voiceTransceiver) {
          await voiceTransceiver.sender.replaceTrack(voiceTrack.current);
        }
        // Reapply once encodings have been negotiated; some browsers reject pre-offer parameters.
        for (const sender of connection.getSenders()) {
          if (sender.track?.kind !== 'video') continue;
          await configureVideoQuality(sender).catch(() => undefined);
        }
      } else if (signal.kind === 'candidate') {
        const candidate = payload as RTCIceCandidateInit;
        if (connection.remoteDescription) await connection.addIceCandidate(candidate).catch(() => undefined);
        else {
          const queue = candidateQueuesRef.current.get(signal.senderId) || [];
          queue.push(candidate);
          candidateQueuesRef.current.set(signal.senderId, queue);
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
    viewerRecoveryRef.current = false;
  }, []);

  const startLoops = useCallback(() => {
    stopLoops();
    const generation = loopGenerationRef.current;
    const queues = new Map<string, Promise<void>>();
    transportRef.current?.subscribe(signal => {
      const queue = (queues.get(signal.senderId) || Promise.resolve()).then(async () => {
        if (generation === loopGenerationRef.current) await handleSignal(signal, generation);
      }).catch(() => setError(SIGNALING_RETRY_ERROR));
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
      connection.ontrack = null;
      connection.close();
    });
    peerConnectionsRef.current.clear();
    candidateQueuesRef.current.clear();
    iceRecoveryRef.current.clear();
    connectionRecoveryTimersRef.current.forEach((timer) => window.clearTimeout(timer));
    connectionRecoveryTimersRef.current.clear();
    remoteStreamRef.current = null;
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
    lastSignalIdRef.current = 0;

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
      await leave();
      const operation = roomOperationRef.current;
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
      await leave();
      const operation = roomOperationRef.current;
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
    [api, leave, startLoops],
  );

  useEffect(() => {
    const connections = peerConnectionsRef.current;
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
      connections.forEach((connection) => connection.close());
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
