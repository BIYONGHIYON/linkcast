'use client';
import { useCallback, useEffect, useRef, useState } from 'react';

export type CallParticipant = { id: string; label: string; enabled: boolean; muted: boolean; speaking: boolean };
type State = Pick<CallParticipant, 'enabled' | 'muted' | 'speaking'>;
function send(channel: RTCDataChannel, message: unknown) {
  if (channel.readyState === 'open') { try { channel.send(JSON.stringify(message)); } catch { /* Connection closed. */ } }
}
export function useCallPresence(local: State) {
  const { enabled, muted, speaking } = local;
  const [participants, setParticipants] = useState<CallParticipant[]>([]);
  const channels = useRef(new Map<string, RTCDataChannel>());
  const peers = useRef(new Map<string, CallParticipant>());
  const state = useRef(local);
  const identity = useRef({ host: false, id: '' });
  const index = useRef(0);
  const publish = useCallback(() => {
    if (identity.current.host) {
      const roster = [{ ...state.current, id: identity.current.id, label: '송출자' }, ...peers.current.values()];
      setParticipants([...peers.current.values()]);
      channels.current.forEach(channel => send(channel, { type: 'roster', roster }));
    } else channels.current.forEach(channel => send(channel, { type: 'state', ...state.current }));
  }, []);
  useEffect(() => { state.current = { enabled, muted, speaking }; publish(); }, [enabled, muted, speaking, publish]);
  const remove = useCallback((id: string) => {
    const channel = channels.current.get(id);
    channels.current.delete(id); peers.current.delete(id);
    if (channel) { channel.onclose = null; channel.close(); }
    if (!identity.current.host) setParticipants([]);
    publish();
  }, [publish]);
  const register = useCallback((id: string, connection: RTCPeerConnection, host: boolean, selfId: string) => {
    identity.current = { host, id: selfId };
    const channel = connection.createDataChannel('call-presence', { negotiated: true, id: 1, ordered: true });
    channels.current.set(id, channel);
    if (host) peers.current.set(id, { id, label: `참가자 ${++index.current}`, enabled: false, muted: false, speaking: false });
    channel.onopen = publish;
    channel.onclose = () => { if (channels.current.get(id) === channel) remove(id); };
    channel.onmessage = event => {
      if (channels.current.get(id) !== channel || typeof event.data !== 'string' || event.data.length > 8192) return;
      try {
        const message = JSON.parse(event.data);
        if (host && message.type === 'state' && ['enabled', 'muted', 'speaking'].every(key => typeof message[key] === 'boolean')) {
          const previous = peers.current.get(id)!;
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
    channels.current.forEach(c => { c.onclose = null; c.close(); }); channels.current.clear(); peers.current.clear(); index.current = 0; setParticipants([]);
  }, []);
  useEffect(() => clear, [clear]);
  return { participants, register, remove, clear };
}
