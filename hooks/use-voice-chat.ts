'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

type SinkableAudioContext = AudioContext & {
  setSinkId?: (sinkId: string) => Promise<void>;
};

function thresholdForSensitivity(value: number) {
  return 10 ** ((-20 - value * 0.6) / 20);
}

export function useVoiceChat() {
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(150);
  const [sensitivity, setSensitivity] = useState(65);
  const [level, setLevel] = useState(0);
  const [speaking, setSpeaking] = useState(false);
  const [error, setError] = useState('');
  const [playbackBlocked, setPlaybackBlocked] = useState(false);
  const videoOutput = useRef<HTMLMediaElement | null>(null);
  const inputGraph = useRef<AudioNode[]>([]);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [device, setDevice] = useState('');
  const track = useRef<MediaStreamTrack | null>(null);
  const onTrack = useRef<((track: MediaStreamTrack | null) => void | Promise<void>) | null>(
    null,
  );
  const context = useRef<AudioContext | null>(null);
  const raw = useRef<MediaStream | null>(null);
  const analyser = useRef<AnalyserNode | null>(null);
  const analysisBuffer = useRef<Float32Array<ArrayBuffer> | null>(null);
  const analysisTimer = useRef<number | null>(null);
  const output = useRef<GainNode | null>(null);
  const receivers = useRef(new Map<string, MediaStreamTrack>());
  const sources = useRef(new Map<string, MediaStreamAudioSourceNode>());
  const players = useRef(new Map<string, HTMLAudioElement>());
  const generation = useRef(0);
  const volumeRef = useRef(volume);
  const sensitivityRef = useRef(sensitivity);

  const bindOutputElement = useCallback((element: HTMLMediaElement | null) => {
    videoOutput.current = element;
    const audio = context.current as SinkableAudioContext | null;
    const sink = (element as (HTMLMediaElement & { sinkId?: string }) | null)?.sinkId || '';
    if (audio?.setSinkId) void audio.setSinkId(sink).catch(() => undefined);
    players.current.forEach(player => {
      if (typeof player.setSinkId === 'function') void player.setSinkId(sink).catch(() => undefined);
    });
  }, []);

  const resumePlayback = useCallback(async () => {
    const audio = context.current;
    if (!audio) {
      setPlaybackBlocked(false);
      return;
    }

    try {
      // Start media playback before the first await to retain user activation.
      const playing = Promise.all([...players.current.values()].map(player => player.play()));
      await Promise.all([audio.resume(), playing]);
      const sink = (videoOutput.current as (HTMLMediaElement & { sinkId?: string }) | null)?.sinkId || '';
      const sinkable = audio as SinkableAudioContext;
      // AudioContext.setSinkId is not supported everywhere. If copying the
      // video's output device fails, keep the system default instead of
      // preventing the call audio from playing at all.
      if (typeof sinkable.setSinkId === 'function') {
        await sinkable.setSinkId(sink).catch(() => undefined);
      }
      await Promise.all([...players.current.values()].map(player =>
        typeof player.setSinkId === 'function' ? player.setSinkId(sink).catch(() => undefined) : Promise.resolve()));
      if (audio.state !== 'running') throw new Error('audio_context_suspended');
      setPlaybackBlocked(false);
    } catch {
      setPlaybackBlocked(true);
    }
  }, []);

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
    if (receivers.current.get(id) === incoming && players.current.has(id)) return;
    receivers.current.set(id, incoming);
    const previous = players.current.get(id);
    if (previous) { previous.pause(); previous.srcObject = null; previous.remove(); }
    players.current.delete(id);
    sources.current.get(id)?.disconnect();
    sources.current.delete(id);
    if (!context.current || !output.current || incoming.kind !== 'audio' || incoming.readyState === 'ended') {
      return;
    }
    incoming.enabled = true;

    // Render the original remote stream, not a re-synthesized destination
    // stream. Native media playback is the primary path; Web Audio only
    // supplies gain above 100%, so normal playback does not depend on it.
    const stream = new MediaStream([incoming]);
    const player = new Audio();
    player.autoplay = true;
    player.setAttribute('playsinline', '');
    player.hidden = true;
    player.volume = Math.min(1, volumeRef.current / 100);
    player.muted = volumeRef.current === 0;
    player.srcObject = stream;
    document.body.appendChild(player);
    players.current.set(id, player);
    const source = context.current.createMediaStreamSource(stream);
    source.connect(output.current);
    sources.current.set(id, source);
    void resumePlayback();
  }, [resumePlayback]);

  const remove = useCallback((id: string) => {
    const player = players.current.get(id);
    if (player) { player.pause(); player.srcObject = null; player.remove(); }
    players.current.delete(id);
    sources.current.get(id)?.disconnect();
    sources.current.delete(id);
    receivers.current.delete(id);
  }, []);

  const stop = useCallback(() => {
    generation.current++;
    if (analysisTimer.current) window.clearInterval(analysisTimer.current);
    analysisTimer.current = null;
    raw.current?.getTracks().forEach((current) => current.stop());
    raw.current = null;
    track.current?.stop();
    track.current = null;
    void Promise.resolve(onTrack.current?.(null)).catch(() => undefined);
    sources.current.forEach((source) => source.disconnect());
    sources.current.clear();
    players.current.forEach(player => { player.pause(); player.srcObject = null; player.remove(); });
    players.current.clear();
    inputGraph.current.forEach((node) => node.disconnect());
    inputGraph.current = [];
    analyser.current = null;
    analysisBuffer.current = null;
    void context.current?.close().catch(() => undefined);
    context.current = null;
    output.current = null;
    setEnabled(false);
    setMuted(false);
    setBusy(false);
    setLevel(0);
    setSpeaking(false);
    setPlaybackBlocked(false);
  }, []);

  const start = useCallback(async () => {
    if (context.current && context.current.state !== 'closed') return;

    const token = ++generation.current;
    setBusy(true);
    setError('');

    try {
      const audio = new AudioContext({ latencyHint: 'interactive' });
      context.current = audio;
      output.current = audio.createGain();
      output.current.gain.value = Math.max(0, volumeRef.current / 100 - 1);
      output.current.connect(audio.destination);
      inputGraph.current = [output.current];

      // This runs during the call-button gesture, so the AudioContext is
      // unlocked before a permission prompt or signaling round trip occurs.
      await resumePlayback();
      if (token !== generation.current) return;

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: device ? { exact: device } : undefined,
          echoCancellation: true,
          noiseSuppression: true,
          // Normalize quiet microphones without replacing the working raw
          // WebRTC track with a synthesized Web Audio destination track.
          autoGainControl: true,
          channelCount: 1,
        },
        video: false,
      });
      if (token !== generation.current) {
        stream.getTracks().forEach((current) => current.stop());
        return;
      }
      await resumePlayback();

      const microphoneTrack = stream.getAudioTracks()[0];
      if (!microphoneTrack) throw new Error('microphone_track_missing');
      raw.current = stream;

      // Send the browser's live microphone track directly over WebRTC. The
      // analyser is only for the local level/speaking indicator and never
      // sits in the media path, so it cannot accidentally mute the call.
      const microphoneSource = audio.createMediaStreamSource(stream);
      const meter = audio.createAnalyser();
      meter.fftSize = 1024;
      meter.smoothingTimeConstant = 0.2;
      const silentMonitor = audio.createGain();
      silentMonitor.gain.value = 0;
      microphoneSource.connect(meter).connect(silentMonitor).connect(audio.destination);
      analyser.current = meter;
      analysisBuffer.current = new Float32Array(
        new ArrayBuffer(meter.fftSize * Float32Array.BYTES_PER_ELEMENT),
      );
      inputGraph.current.push(microphoneSource, meter, silentMonitor);

      const updateMeter = () => {
        if (token !== generation.current || context.current !== audio || audio.state === 'closed') return;
        const currentAnalyser = analyser.current;
        const buffer = analysisBuffer.current;
        if (!currentAnalyser || !buffer) return;
        currentAnalyser.getFloatTimeDomainData(buffer);
        let energy = 0;
        for (const value of buffer) energy += value * value;
        const rms = Math.sqrt(energy / buffer.length);
        const live = microphoneTrack.enabled && microphoneTrack.readyState === 'live';
        setLevel(live ? Math.min(100, rms * 500) : 0);
        setSpeaking(live && rms >= thresholdForSensitivity(sensitivityRef.current));
      };
      updateMeter();
      analysisTimer.current = window.setInterval(updateMeter, 50);

      track.current = microphoneTrack;
      microphoneTrack.onended = () => {
        if (token === generation.current) stop();
      };

      // Install the track into every already-negotiated voice sender. If the
      // room has no peer yet, the current track is picked up when a new peer
      // connection is created.
      try {
        if (!onTrack.current) throw new Error('voice_listener_missing');
        await onTrack.current(microphoneTrack);
      } catch {
        throw new Error('voice_sender_failed');
      }
      if (token !== generation.current) return;
      receivers.current.forEach((incoming, id) => attach(id, incoming));
      setEnabled(true);

      const available = await navigator.mediaDevices.enumerateDevices().catch(() => []);
      if (token === generation.current) {
        setDevices(available.filter((current) => current.kind === 'audioinput'));
      }
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
  }, [attach, device, resumePlayback, stop]);

  const toggleMute = useCallback(() => {
    setMuted((current) => {
      raw.current?.getAudioTracks().forEach((currentTrack) => {
        currentTrack.enabled = current;
      });
      if (!current) setSpeaking(false);
      return !current;
    });
  }, []);

  useEffect(() => {
    volumeRef.current = volume;
    if (output.current) output.current.gain.value = Math.max(0, volume / 100 - 1);
    players.current.forEach(player => {
      player.volume = Math.min(1, volume / 100);
      player.muted = volume === 0;
    });
  }, [volume]);

  useEffect(() => {
    sensitivityRef.current = sensitivity;
  }, [sensitivity]);

  useEffect(() => {
    let live = true;
    void navigator.mediaDevices
      ?.enumerateDevices()
      .then((available) => {
        if (live) setDevices(available.filter((current) => current.kind === 'audioinput'));
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
    playbackBlocked,
    resumePlayback,
    bindOutputElement,
  };
}
