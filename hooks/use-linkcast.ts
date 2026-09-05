'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

type Role = 'host' | 'viewer';
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

function randomId() {
  return crypto.randomUUID().replaceAll('-', '');
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set('content-type', 'application/json');
  const response = await fetch(path, {
    ...init,
    headers,
  });
  const body = (await response.json()) as T & { error?: string };
  if (!response.ok) {
    const error = new Error(body.error || 'request_failed');
    error.name = body.error || 'request_failed';
    throw error;
  }
  return body;
}

export function useLinkcast() {
  const [status, setStatus] = useState<ConnectionStatus>('idle');
  const [roomId, setRoomId] = useState('');
  const [viewerCount, setViewerCount] = useState(0);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [error, setError] = useState('');

  const roleRef = useRef<Role | null>(null);
  const roomIdRef = useRef('');
  const peerIdRef = useRef('');
  const hostIdRef = useRef('');
  const localStreamRef = useRef<MediaStream | null>(null);
  const lastSignalIdRef = useRef(0);
  const pollingRef = useRef<number | null>(null);
  const heartbeatRef = useRef<number | null>(null);
  const pollingFailuresRef = useRef(0);
  const pollingInFlightRef = useRef(false);
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
    [],
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
    [closePeer],
  );

  const createPeerConnection = useCallback(
    (remotePeerId: string) => {
      const existing = peerConnectionsRef.current.get(remotePeerId);
      if (existing) return existing;

      const connection = new RTCPeerConnection(rtcConfiguration);
      peerConnectionsRef.current.set(remotePeerId, connection);

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
          if (track.kind === 'video') track.contentHint = 'motion';
          const sender = connection.addTrack(track, localStreamRef.current!);
          if (track.kind === 'video') {
            const parameters = sender.getParameters();
            parameters.encodings = parameters.encodings.length ? parameters.encodings : [{}];
            parameters.degradationPreference = 'balanced';
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
        if (peerConnectionsRef.current.size >= 2 && !peerConnectionsRef.current.has(signal.senderId)) return;
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

  const stopLoops = useCallback(() => {
    loopGenerationRef.current += 1;
    if (pollingRef.current) window.clearInterval(pollingRef.current);
    if (heartbeatRef.current) window.clearInterval(heartbeatRef.current);
    if (viewerRecoveryTimerRef.current) window.clearTimeout(viewerRecoveryTimerRef.current);
    pollingRef.current = null;
    heartbeatRef.current = null;
    viewerRecoveryTimerRef.current = null;
    viewerRecoveryRef.current = false;
    pollingInFlightRef.current = false;
  }, []);

  const startLoops = useCallback(() => {
    stopLoops();
    pollingFailuresRef.current = 0;
    const generation = loopGenerationRef.current;
    const poll = async () => {
      if (
        generation !== loopGenerationRef.current ||
        pollingInFlightRef.current ||
        !roomIdRef.current ||
        !peerIdRef.current
      ) return;
      pollingInFlightRef.current = true;
      try {
        const query = new URLSearchParams({
          roomId: roomIdRef.current,
          peerId: peerIdRef.current,
          after: String(lastSignalIdRef.current),
        });
        const result = await api<{ signals: Signal[] }>(`/api/signals?${query}`);
        for (const signal of result.signals) {
          if (generation !== loopGenerationRef.current) break;
          await handleSignal(signal, generation);
          if (generation === loopGenerationRef.current) {
            lastSignalIdRef.current = Math.max(lastSignalIdRef.current, signal.id);
          }
        }
        if (generation === loopGenerationRef.current) {
          pollingFailuresRef.current = 0;
          setError((current) => (current === SIGNALING_RETRY_ERROR ? '' : current));
        }
      } catch {
        if (generation === loopGenerationRef.current) {
          pollingFailuresRef.current += 1;
          if (pollingFailuresRef.current >= 8) setError(SIGNALING_RETRY_ERROR);
        }
      } finally {
        if (generation === loopGenerationRef.current) pollingInFlightRef.current = false;
      }
    };
    void poll();
    pollingRef.current = window.setInterval(() => void poll(), 250);
    heartbeatRef.current = window.setInterval(() => {
      void api('/api/rooms', {
        method: 'PATCH',
        body: JSON.stringify({ roomId: roomIdRef.current, peerId: peerIdRef.current }),
      }).catch(() => undefined);
    }, 15_000);
  }, [handleSignal, stopLoops]);

  const leave = useCallback(async () => {
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
  }, [stopLoops]);

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
    [leave, startLoops],
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
    [leave, startLoops],
  );

  useEffect(() => {
    const connections = peerConnectionsRef.current;
    const handlePageHide = () => {
      const currentRoom = roomIdRef.current;
      const currentPeer = peerIdRef.current;
      if (currentRoom && currentPeer) {
        void fetch('/api/rooms', {
          method: 'DELETE',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ roomId: currentRoom, peerId: currentPeer }),
          keepalive: true,
        });
      }
    };
    window.addEventListener('pagehide', handlePageHide);
    return () => {
      window.removeEventListener('pagehide', handlePageHide);
      stopLoops();
      connections.forEach((connection) => connection.close());
    };
  }, [stopLoops]);

  return {
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
