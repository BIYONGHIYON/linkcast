'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { SignalingSocket } from './signaling-socket';

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
  kind: 'join' | 'offer' | 'answer' | 'candidate' | 'leave';
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
const VIDEO_MAX_BITRATE = 12_000_000;
const MAX_VIEWERS = 5;

function randomId() {
  return crypto.randomUUID().replaceAll('-', '');
}


export function useLinkcast() {
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
  const [laserStroke, setLaserStroke] = useState<LaserStroke | null>(null);
  const laserChannels = useRef(new Map<string, RTCDataChannel>());
  const sendLaserStroke = useCallback((points: LaserPoint[]) => {
    const stroke = { id: crypto.randomUUID(), points: points.slice(0, 512) };
    setLaserStroke(stroke);
    const message = JSON.stringify(stroke);
    laserChannels.current.forEach(channel => {
      if (channel.readyState === 'open' && channel.bufferedAmount < 65536) {
        try { channel.send(message); } catch { /* Connection may close during release. */ }
      }
    });
  }, []);

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

  const sendSignal = useCallback(
    async (recipientId: string, kind: 'offer' | 'answer' | 'candidate', payload: unknown) => {
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
  }, []);

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
      const channel = connection.createDataChannel('laser', { negotiated: true, id: 0, ordered: false, maxPacketLifeTime: 1500 });
      laserChannels.current.set(remotePeerId, channel);
      channel.onclose = () => {
        if (laserChannels.current.get(remotePeerId) === channel) laserChannels.current.delete(remotePeerId);
      };
      channel.onmessage = event => {
        if (peerConnectionsRef.current.get(remotePeerId) !== connection || typeof event.data !== 'string' || event.data.length > 65536) return;
        try {
          const stroke = JSON.parse(event.data) as LaserStroke;
          if (typeof stroke.id !== 'string' || stroke.id.length > 64 || !Array.isArray(stroke.points) || !stroke.points.length || stroke.points.length > 512 || !stroke.points.every(p => p && Number.isFinite(p.x) && Number.isFinite(p.y) && p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1)) return;
          setLaserStroke(stroke);
          if (roleRef.current === 'host') laserChannels.current.forEach((other, id) => {
            if (id !== remotePeerId && other.readyState === 'open' && other.bufferedAmount < 65536) {
              try { other.send(JSON.stringify(stroke)); } catch { /* A viewer disconnected. */ }
            }
          });
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
                await sendSignal(remotePeerId, 'offer', offer);
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
          const sender = connection.addTrack(track, localStreamRef.current!);
          if (track.kind === 'video') {
            const parameters = sender.getParameters();
            parameters.encodings = parameters.encodings.length ? parameters.encodings : [{}];
            parameters.degradationPreference = 'maintain-resolution';
            parameters.encodings[0].maxBitrate = VIDEO_MAX_BITRATE;
            parameters.encodings[0].maxFramerate = 60;
            parameters.encodings[0].scaleResolutionDownBy = 1;
            void sender.setParameters(parameters).catch(async () => {
              const fallback = sender.getParameters();
              fallback.encodings = fallback.encodings.length ? fallback.encodings : [{}];
              fallback.encodings[0].maxBitrate = VIDEO_MAX_BITRATE;
              fallback.encodings[0].maxFramerate = 60;
              await sender.setParameters(fallback).catch(() => undefined);
            });
          }
        }
        setViewerCount(peerConnectionsRef.current.size);
      } else {
        connection.ontrack = (event) => {
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
    [closePeer, scheduleViewerReconnect, sendSignal],
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
          setStatus('waiting');
        } else if (roleRef.current === 'viewer') {
          setStatus('not-found');
          setError('송출자가 연결을 종료했어요.');
        }
        return;
      }

      if (signal.kind === 'join' && roleRef.current === 'host') {
        if (peerConnectionsRef.current.size >= MAX_VIEWERS && !peerConnectionsRef.current.has(signal.senderId)) return;
        let connection = peerConnectionsRef.current.get(signal.senderId);
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
        await sendSignal(signal.senderId, 'offer', offer);
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
        await connection.setRemoteDescription(payload as RTCSessionDescriptionInit);
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
        // Reapply once encodings have been negotiated; some browsers reject pre-offer parameters.
        for (const sender of connection.getSenders()) {
          if (sender.track?.kind !== 'video') continue;
          const parameters = sender.getParameters();
          if (!parameters.encodings.length) continue;
          parameters.degradationPreference = 'maintain-resolution';
          parameters.encodings[0].maxBitrate = VIDEO_MAX_BITRATE;
          parameters.encodings[0].maxFramerate = 60;
          await sender.setParameters(parameters).catch(() => undefined);
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
    [closePeer, createPeerConnection, flushCandidates, sendSignal],
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
    let queue = Promise.resolve();
    transportRef.current?.subscribe(signal => {
      queue = queue.then(async () => {
        if (generation === loopGenerationRef.current) await handleSignal(signal, generation);
      }).catch(() => setError(SIGNALING_RETRY_ERROR));
    });
  }, [handleSignal, stopLoops]);

  const leave = useCallback(async () => {
    setLaserStroke(null);
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
  }, [api, stopLoops]);

  const createRoom = useCallback(
    async (stream: MediaStream) => {
      await leave();
      setStatus('creating');
      setError('');
      const nextRoomId = randomId().slice(0, 12);
      const peerId = randomId();
      try {
        localStreamRef.current = stream;
        roleRef.current = 'host';
        roomIdRef.current = nextRoomId;
        peerIdRef.current = peerId;
        hostIdRef.current = peerId;
        await api<RoomResponse>('/api/rooms', {
          method: 'POST',
          body: JSON.stringify({ roomId: nextRoomId, peerId, role: 'host' }),
        });
        setRoomId(nextRoomId);
        setStatus('waiting');
        startLoops();
        return nextRoomId;
      } catch {
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
        hostIdRef.current = room.hostId;
        setRoomId(normalized);
        startLoops();
        return true;
      } catch (reason) {
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
      if (!event.persisted) transportRef.current?.close();
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
  }, [refreshLease, stopLoops]);

  return {
    laserStroke,
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
