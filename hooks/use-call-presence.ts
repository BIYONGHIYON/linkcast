'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { queueDataChannel, type DataChannelTransport } from '../lib/data-channel';

export type CallParticipant = { id: string; label: string; enabled: boolean; muted: boolean; speaking: boolean };
type State = Pick<CallParticipant, 'enabled' | 'muted' | 'speaking'>;
function send(channel: DataChannelTransport, message: unknown, key?: string) {
  return channel.send(JSON.stringify(message), key);
}
export function useCallPresence(local: State) {
  const { enabled, muted, speaking } = local;
  const [participants, setParticipants] = useState<CallParticipant[]>([]);
  const channels = useRef(new Map<string, DataChannelTransport>());
  const peers = useRef(new Map<string, CallParticipant>());
  const state = useRef(local);
  const identity = useRef({ host: false, id: '' });
  const index = useRef(0);
  const voiceListener = useRef<((sender: string, payload: unknown) => void) | null>(null);
  const subscribeVoice = useCallback((listener: (sender: string, payload: unknown) => void) => {
    voiceListener.current = listener;
    return () => { if (voiceListener.current === listener) voiceListener.current = null; };
  }, []);
  const signalVoice = useCallback((recipient: string, payload: unknown) => {
    if (identity.current.host) return;
    channels.current.forEach(channel => send(channel, { type: 'voice-signal', recipient, payload }));
  }, []);
  const publish = useCallback(() => {
    if (identity.current.host) {
      const roster = [{ ...state.current, id: identity.current.id, label: '송출자' }, ...peers.current.values()];
      setParticipants([...peers.current.values()]);
      channels.current.forEach(channel => send(channel, { type: 'roster', roster }, 'roster'));
    } else channels.current.forEach(channel => send(channel, { type: 'state', ...state.current }, 'state'));
  }, []);
  useEffect(() => { state.current = { enabled, muted, speaking }; publish(); }, [enabled, muted, speaking, publish]);
  const remove = useCallback((id: string) => {
    const channel = channels.current.get(id);
    channels.current.delete(id); peers.current.delete(id);
    channel?.close();
    if (!identity.current.host) setParticipants([]);
    publish();
  }, [publish]);
  const isOpen = useCallback((id: string) => channels.current.get(id)?.channel.readyState === 'open', []);
  const register = useCallback((id: string, connection: RTCPeerConnection, host: boolean, selfId: string, onStateChange?: () => void) => {
    identity.current = { host, id: selfId };
    channels.current.get(id)?.close();
    const channel = connection.createDataChannel('call-presence', { negotiated: true, id: 1, ordered: true });
    const transport = queueDataChannel(channel);
    channels.current.set(id, transport);
    if (host) peers.current.set(id, { id, label: `참가자 ${++index.current}`, enabled: false, muted: false, speaking: false });
    channel.onopen = () => { publish(); onStateChange?.(); };
    channel.onclose = () => { if (channels.current.get(id) === transport) { remove(id); onStateChange?.(); } };
    channel.onmessage = event => {
      if (channels.current.get(id) !== transport || typeof event.data !== 'string' || event.data.length > 65536) return;
      try {
        const message = JSON.parse(event.data);
        if (message.type === 'voice-signal') {
          if (host && typeof message.recipient === 'string' && message.recipient !== id) {
            const target = channels.current.get(message.recipient);
            if (target) send(target, { type: 'voice-signal', sender: id, payload: message.payload });
          } else if (!host && typeof message.sender === 'string' && message.sender !== selfId) {
            voiceListener.current?.(message.sender, message.payload);
          }
          return;
        }
        if (host && message.type === 'state' && ['enabled', 'muted', 'speaking'].every(key => typeof message[key] === 'boolean')) {
          const previous = peers.current.get(id);
          if (!previous) return;
          peers.current.set(id, { ...previous, enabled: message.enabled, muted: message.muted, speaking: message.speaking });
          publish();
        } else if (!host && message.type === 'roster' && Array.isArray(message.roster) && message.roster.length <= 6) {
          const valid = message.roster.every((p: CallParticipant) => p && typeof p.id === 'string' && p.id.length <= 80 && typeof p.label === 'string' && p.label.length <= 40 && typeof p.enabled === 'boolean' && typeof p.muted === 'boolean' && typeof p.speaking === 'boolean');
          if (valid) setParticipants(message.roster.filter((p: CallParticipant) => p.id !== selfId));
        }
      } catch { /* Ignore invalid peer data. */ }
    };
    publish();
  }, [publish, remove]);
  const clear = useCallback(() => {
    channels.current.forEach(c => c.close()); channels.current.clear(); peers.current.clear(); index.current = 0;
    identity.current = { host: false, id: '' };
    setParticipants([]);
  }, []);
  useEffect(() => clear, [clear]);
  return { participants, register, remove, clear, signalVoice, subscribeVoice, isOpen };
}
