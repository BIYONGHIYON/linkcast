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
  const peerConnectionsRef = useRef(new Map<string, RTCPeerConnection>());
  const candidateQueuesRef = useRef(new Map<string, RTCIceCandidateInit[]>());
  const iceRecoveryRef = useRef(new Set<string>());

  const sendSignal = useCallback(
    async (recipientId: string, kind: 'offer' | 'answer' | 'candidate', payload: unknown) => {
      await api('/api/signals', {
        method: 'POST',
        body: JSON.stringify({
          roomId: roomIdRef.current,
          senderId: peerIdRef.current,
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
    for (const candidate of queued) await connection.addIceCandidate(candidate);
  }, []);

  const closePeer = useCallback((peerId: string) => {
    peerConnectionsRef.current.get(peerId)?.close();
    peerConnectionsRef.current.delete(peerId);
    candidateQueuesRef.current.delete(peerId);
    iceRecoveryRef.current.delete(peerId);
    setViewerCount(peerConnectionsRef.current.size);
  }, []);

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
          setStatus('connected');
        } else if (connection.iceConnectionState === 'checking') {
          setStatus('connecting');
        } else if (connection.iceConnectionState === 'disconnected') {
          setStatus('connecting');
        } else if (connection.iceConnectionState === 'failed') {
          if (roleRef.current === 'host' && !iceRecoveryRef.current.has(remotePeerId)) {
            iceRecoveryRef.current.add(remotePeerId);
            setStatus('connecting');
            void (async () => {
              try {
                if (connection.signalingState === 'closed') throw new Error('connection_closed');
                connection.restartIce();
                const offer = await connection.createOffer({ iceRestart: true });
                await connection.setLocalDescription(offer);
                await sendSignal(remotePeerId, 'offer', offer);
              } catch {
                iceRecoveryRef.current.delete(remotePeerId);
                setStatus('failed');
                setError('직접 연결에 실패했어요. 다른 네트워크에서 다시 시도해 주세요.');
                closePeer(remotePeerId);
              }
            })();
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
          const stream = event.streams[0] || new MediaStream([event.track]);
          setRemoteStream(stream);
        };
      }

      return connection;
    },
    [closePeer, sendSignal],
  );

  const handleSignal = useCallback(
    async (signal: Signal) => {
      const payload = JSON.parse(signal.payload || '{}') as
        | RTCSessionDescriptionInit
        | RTCIceCandidateInit;

      if (signal.kind === 'leave') {
        closePeer(signal.senderId);
        if (roleRef.current === 'host') setStatus('waiting');
        return;
      }

      if (signal.kind === 'join' && roleRef.current === 'host') {
        if (peerConnectionsRef.current.size >= 2 && !peerConnectionsRef.current.has(signal.senderId)) return;
        const connection = createPeerConnection(signal.senderId);
        const offer = await connection.createOffer();
        await connection.setLocalDescription(offer);
        await sendSignal(signal.senderId, 'offer', offer);
        setStatus('connecting');
        return;
      }

      if (signal.kind === 'offer' && roleRef.current === 'viewer') {
        const connection = createPeerConnection(signal.senderId);
        await connection.setRemoteDescription(payload as RTCSessionDescriptionInit);
        await flushCandidates(signal.senderId, connection);
        const answer = await connection.createAnswer();
        await connection.setLocalDescription(answer);
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
        await connection.setRemoteDescription(payload as RTCSessionDescriptionInit);
        await flushCandidates(signal.senderId, connection);
      } else if (signal.kind === 'candidate') {
        const candidate = payload as RTCIceCandidateInit;
        if (connection.remoteDescription) await connection.addIceCandidate(candidate);
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
    if (pollingRef.current) window.clearInterval(pollingRef.current);
    if (heartbeatRef.current) window.clearInterval(heartbeatRef.current);
    pollingRef.current = null;
    heartbeatRef.current = null;
  }, []);

  const startLoops = useCallback(() => {
    stopLoops();
    pollingFailuresRef.current = 0;
    const poll = async () => {
      if (!roomIdRef.current || !peerIdRef.current) return;
      try {
        const query = new URLSearchParams({
          roomId: roomIdRef.current,
          peerId: peerIdRef.current,
          after: String(lastSignalIdRef.current),
        });
        const result = await api<{ signals: Signal[] }>(`/api/signals?${query}`);
        for (const signal of result.signals) {
          lastSignalIdRef.current = Math.max(lastSignalIdRef.current, signal.id);
          await handleSignal(signal);
        }
        pollingFailuresRef.current = 0;
        setError((current) => (current === SIGNALING_RETRY_ERROR ? '' : current));
      } catch {
        pollingFailuresRef.current += 1;
        if (pollingFailuresRef.current >= 8) setError(SIGNALING_RETRY_ERROR);
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
    peerConnectionsRef.current.forEach((connection) => connection.close());
    peerConnectionsRef.current.clear();
    candidateQueuesRef.current.clear();
    iceRecoveryRef.current.clear();
    setRemoteStream(null);
    setViewerCount(0);
    setStatus('idle');
    setRoomId('');
    setError('');
    if (currentRoom && currentPeer) {
      await api('/api/rooms', {
        method: 'DELETE',
        body: JSON.stringify({ roomId: currentRoom, peerId: currentPeer }),
        keepalive: true,
      }).catch(() => undefined);
    }
    roleRef.current = null;
    roomIdRef.current = '';
    peerIdRef.current = '';
    hostIdRef.current = '';
    lastSignalIdRef.current = 0;
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
        } else if (name === 'room_not_found') {
          setStatus('not-found');
          setError('종료되었거나 존재하지 않는 송출이에요.');
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
