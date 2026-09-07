'use client';
import { useCallback, useEffect, useRef, useState } from 'react';

export function useVoiceChat() {
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(100);
  const [sensitivity, setSensitivity] = useState(65);
  const [level, setLevel] = useState(0);
  const [speaking, setSpeaking] = useState(false);
  const [error, setError] = useState('');
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [device, setDevice] = useState('');
  const track = useRef<MediaStreamTrack | null>(null);
  const onTrack = useRef<((track: MediaStreamTrack | null) => void | Promise<void>) | null>(
    null,
  );
  const context = useRef<AudioContext | null>(null);
  const raw = useRef<MediaStream | null>(null);
  const gate = useRef<AudioWorkletNode | null>(null);
  const output = useRef<GainNode | null>(null);
  const receivers = useRef(new Map<string, MediaStreamTrack>());
  const sources = useRef(new Map<string, MediaStreamAudioSourceNode>());
  const generation = useRef(0);
  const volumeRef = useRef(volume);
  const sensitivityRef = useRef(sensitivity);
  const subscribeTrack = useCallback(
    (listener: (track: MediaStreamTrack | null) => void | Promise<void>) => {
      onTrack.current = listener;
      return () => {
        if (onTrack.current === listener) onTrack.current = null;
      };
    },
    [],
  );
  const attach = useCallback((id: string, incoming: MediaStreamTrack) => {
    receivers.current.set(id, incoming);
    sources.current.get(id)?.disconnect();
    sources.current.delete(id);
    if (!context.current || !output.current || incoming.readyState === 'ended')
      return;
    const source = context.current.createMediaStreamSource(
      new MediaStream([incoming]),
    );
    source.connect(output.current);
    sources.current.set(id, source);
  }, []);
  const remove = useCallback((id: string) => {
    sources.current.get(id)?.disconnect();
    sources.current.delete(id);
    receivers.current.delete(id);
  }, []);
  const stop = useCallback(() => {
    generation.current++;
    raw.current?.getTracks().forEach((t) => t.stop());
    raw.current = null;
    track.current?.stop();
    track.current = null;
    void Promise.resolve(onTrack.current?.(null)).catch(() => undefined);
    gate.current?.disconnect();
    gate.current = null;
    sources.current.forEach((s) => s.disconnect());
    sources.current.clear();
    void context.current?.close().catch(() => undefined);
    context.current = null;
    output.current = null;
    setEnabled(false);
    setMuted(false);
    setBusy(false);
    setLevel(0);
    setSpeaking(false);
  }, []);
  const start = useCallback(async () => {
    if (context.current) return;
    const token = ++generation.current;
    setBusy(true);
    setError('');
    try {
      const audio = new AudioContext({ latencyHint: 'interactive' });
      context.current = audio;
      await audio.resume();
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: device ? { exact: device } : undefined,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: false,
          channelCount: 1,
        },
        video: false,
      });
      if (token !== generation.current) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      raw.current = stream;
      await audio.audioWorklet.addModule('/voice-gate.js');
      if (token !== generation.current) return;
      const processor = new AudioWorkletNode(audio, 'voice-gate', {
        outputChannelCount: [1],
      });
      gate.current = processor;
      processor.parameters.get('threshold')!.value =
        10 ** ((-20 - sensitivityRef.current * 0.6) / 20);
      processor.port.onmessage = (event) => {
        if (token !== generation.current) return;
        setLevel(Math.min(100, event.data.level * 500));
        setSpeaking(event.data.speaking);
      };
      const destination = audio.createMediaStreamDestination();
      // WebAudio destinations default to stereo; the negotiated microphone is mono.
      destination.channelCount = 1;
      audio
        .createMediaStreamSource(stream)
        .connect(processor)
        .connect(destination);
      output.current = audio.createGain();
      output.current.gain.value = volumeRef.current / 100;
      output.current.connect(audio.destination);
      receivers.current.forEach((t, id) => attach(id, t));
      track.current = destination.stream.getAudioTracks()[0];
      stream.getAudioTracks()[0].onended = () => {
        if (token === generation.current) stop();
      };
      try { await onTrack.current?.(track.current); }
      catch { throw new Error('voice_sender_failed'); }
      if (token !== generation.current) return;
      setEnabled(true);
      const available = await navigator.mediaDevices
        .enumerateDevices()
        .catch(() => []);
      if (token === generation.current)
        setDevices(available.filter((d) => d.kind === 'audioinput'));
    } catch (reason) {
      if (token === generation.current) {
        stop();
        setError(reason instanceof Error && reason.message === 'voice_sender_failed'
          ? '마이크 전송을 연결하지 못했어요. 양쪽 페이지를 새로고침하고 새 방에서 다시 시도해 주세요.'
          : '마이크를 연결하지 못했어요. 권한과 장치를 확인해 주세요.');
      }
    } finally {
      if (token === generation.current) setBusy(false);
    }
  }, [attach, device, stop]);
  const toggleMute = useCallback(() => {
    setMuted((current) => {
      raw.current?.getAudioTracks().forEach((t) => {
        t.enabled = current;
      });
      return !current;
    });
  }, []);
  useEffect(() => {
    volumeRef.current = volume;
    if (output.current) output.current.gain.value = volume / 100;
  }, [volume]);
  useEffect(() => {
    sensitivityRef.current = sensitivity;
    gate.current?.parameters
      .get('threshold')
      ?.setValueAtTime(
        10 ** ((-20 - sensitivity * 0.6) / 20),
        context.current?.currentTime || 0,
      );
  }, [sensitivity]);
  useEffect(() => {
    let live = true;
    void navigator.mediaDevices
      ?.enumerateDevices()
      .then((ds) => {
        if (live) setDevices(ds.filter((d) => d.kind === 'audioinput'));
      })
      .catch(() => undefined);
    return () => {
      live = false;
      stop();
    };
  }, [stop]);
  return {
    enabled,
    busy,
    muted,
    volume,
    setVolume,
    sensitivity,
    setSensitivity,
    level,
    speaking: speaking && !muted,
    error,
    devices,
    device,
    setDevice,
    start,
    stop,
    toggleMute,
    track,
    subscribeTrack,
    attach,
    remove,
  };
}
