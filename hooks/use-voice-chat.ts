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
  const [volume, setVolume] = useState(100);
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
  const generation = useRef(0);
  const volumeRef = useRef(volume);
  const sensitivityRef = useRef(sensitivity);

  const bindOutputElement = useCallback((element: HTMLMediaElement | null) => {
    videoOutput.current = element;
  }, []);

  const resumePlayback = useCallback(async () => {
    const audio = context.current;
    if (!audio) {
      setPlaybackBlocked(false);
      return;
    }

    try {
      await audio.resume();
      const sink = (videoOutput.current as (HTMLMediaElement & { sinkId?: string }) | null)?.sinkId || '';
      const sinkable = audio as SinkableAudioContext;
      // AudioContext.setSinkId is not supported everywhere. If copying the
      // video's output device fails, keep the system default instead of
      // preventing the call audio from playing at all.
      if (sink && typeof sinkable.setSinkId === 'function') {
        await sinkable.setSinkId(sink).catch(() => undefined);
      }
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
    receivers.current.set(id, incoming);
    sources.current.get(id)?.disconnect();
    sources.current.delete(id);
    if (!context.current || !output.current || incoming.kind !== 'audio' || incoming.readyState === 'ended') {
      return;
    }

    // Play remote voice directly through the active AudioContext. The old
    // MediaStreamDestination -> detached <audio> path could be blocked or
    // remain silent even while the speaking data-channel state worked.
    const source = context.current.createMediaStreamSource(new MediaStream([incoming]));
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
    if (analysisTimer.current) window.clearInterval(analysisTimer.current);
    analysisTimer.current = null;
    raw.current?.getTracks().forEach((current) => current.stop());
    raw.current = null;
    track.current?.stop();
    track.current = null;
    void Promise.resolve(onTrack.current?.(null)).catch(() => undefined);
    sources.current.forEach((source) => source.disconnect());
    sources.current.clear();
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
      output.current.gain.value = volumeRef.current / 100;
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
          autoGainControl: false,
          channelCount: 1,
        },
        video: false,
      });
      if (token !== generation.current) {
        stream.getTracks().forEach((current) => current.stop());
        return;
      }

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
      await onTrack.current?.(microphoneTrack);
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
    if (output.current) output.current.gain.value = volume / 100;
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
