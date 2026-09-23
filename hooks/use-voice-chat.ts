'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useSavedPreference, validDevice, validVolume, validSensitivity } from './use-saved-preference';

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
  // Internal volume is actual gain percent; the UI displays half this value.
  const [volume, setVolume] = useState(200);
  const [sensitivity, setSensitivity] = useState(65);
  const level = useRef(0);
  const levelListeners = useRef(new Set<() => void>());
  const getLevel = useCallback(() => level.current, []);
  const subscribeLevel = useCallback((listener: () => void) => {
    levelListeners.current.add(listener);
    return () => { levelListeners.current.delete(listener); };
  }, []);
  const setLevel = useCallback((next: number) => {
    if (level.current === next) return;
    level.current = next;
    levelListeners.current.forEach(listener => listener());
  }, []);
  const [speaking, setSpeaking] = useState(false);
  const [error, setError] = useState('');
  const [playbackBlocked, setPlaybackBlocked] = useState(false);
  const videoOutput = useRef<HTMLMediaElement | null>(null);
  const inputGraph = useRef<AudioNode[]>([]);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [device, setDevice] = useState('');
  useSavedPreference('linkcast.call.volume.v1', volume, setVolume, validVolume);
  useSavedPreference('linkcast.call.sensitivity.v1', sensitivity, setSensitivity, validSensitivity);
  useSavedPreference('linkcast.call.device.v1', device, setDevice, validDevice);
  const track = useRef<MediaStreamTrack | null>(null);
  const onTrack = useRef<((track: MediaStreamTrack | null) => void | Promise<void>) | null>(
    null,
  );
  const trackUpdates = useRef<Promise<void>>(Promise.resolve());
  const context = useRef<AudioContext | null>(null);
  const raw = useRef<MediaStream | null>(null);
  const analyser = useRef<AnalyserNode | null>(null);
  const analysisBuffer = useRef<Float32Array<ArrayBuffer> | null>(null);
  const analysisTimer = useRef<number | null>(null);
  const output = useRef<GainNode | null>(null);
  const receivers = useRef(new Map<string, MediaStreamTrack>());
  const clearReceivers = useCallback(() => receivers.current.clear(), []);
  const sources = useRef(new Map<string, MediaElementAudioSourceNode>());
  const players = useRef(new Map<string, HTMLAudioElement>());
  const blockedPlayers = useRef(new Set<string>());
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
      players.current.forEach((player, id) => {
        void player.play().then(() => {
          if (context.current !== audio || players.current.get(id) !== player) return;
          blockedPlayers.current.delete(id);
          setPlaybackBlocked(audio.state !== 'running' || blockedPlayers.current.size > 0);
        }).catch((reason: unknown) => {
          if (context.current !== audio || players.current.get(id) !== player) return;
          if (reason instanceof DOMException && reason.name === 'NotAllowedError') {
            blockedPlayers.current.add(id);
            setPlaybackBlocked(true);
          }
        });
      });
      // A remote track without packets can keep play() pending. It must not
      // hold up every other participant or microphone acquisition.
      await audio.resume();
      if (context.current !== audio) return;
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
      if (context.current !== audio) return;
      if (audio.state !== 'running') throw new Error('audio_context_suspended');
      setPlaybackBlocked(blockedPlayers.current.size > 0);
    } catch {
      if (context.current === audio) setPlaybackBlocked(true);
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

  // Keep leave/rejoin track replacements ordered. A slow replaceTrack(null)
  // from the previous call must never finish after the new microphone track.
  const publishTrack = useCallback((next: MediaStreamTrack | null) => {
    const token = generation.current;
    const update = trackUpdates.current.catch(() => undefined).then(async () => {
      if (token !== generation.current || (next && next.readyState === 'ended')) return;
      const listener = onTrack.current;
      if (!listener && next) throw new Error('voice_listener_missing');
      await listener?.(next);
    });
    trackUpdates.current = update.catch(() => undefined);
    return update;
  }, []);

  const attach = useCallback((id: string, incoming: MediaStreamTrack) => {
    if (receivers.current.get(id) === incoming && players.current.has(id)) return;
    receivers.current.set(id, incoming);
    const previous = players.current.get(id);
    if (previous) { previous.pause(); previous.srcObject = null; previous.remove(); }
    players.current.delete(id);
    blockedPlayers.current.delete(id);
    sources.current.get(id)?.disconnect();
    sources.current.delete(id);
    if (!context.current || !output.current || incoming.kind !== 'audio' || incoming.readyState === 'ended') {
      return;
    }
    incoming.enabled = true;

    // Route media playback into Web Audio, replacing its direct speaker
    // output. There is exactly one audible path at every volume:
    // remote stream -> media element -> gain -> destination.
    const stream = new MediaStream([incoming]);
    const player = new Audio();
    player.autoplay = true;
    player.setAttribute('playsinline', '');
    player.hidden = true;
    player.volume = 1;
    player.muted = false;
    // Connect before assigning srcObject/autoplay can start direct playback.
    const source = context.current.createMediaElementSource(player);
    source.connect(output.current);
    sources.current.set(id, source);
    player.srcObject = stream;
    document.body.appendChild(player);
    players.current.set(id, player);
    void resumePlayback();
  }, [resumePlayback]);

  const remove = useCallback((id: string) => {
    const player = players.current.get(id);
    if (player) { player.pause(); player.srcObject = null; player.remove(); }
    players.current.delete(id);
    blockedPlayers.current.delete(id);
    if (context.current?.state === 'running') setPlaybackBlocked(blockedPlayers.current.size > 0);
    sources.current.get(id)?.disconnect();
    sources.current.delete(id);
    receivers.current.delete(id);
  }, []);

  const stop = useCallback(() => {
    generation.current++;
    if (analysisTimer.current) window.clearInterval(analysisTimer.current);
    analysisTimer.current = null;
    raw.current?.getTracks().forEach((current) => { current.onended = null; current.stop(); });
    raw.current = null;
    track.current?.stop();
    track.current = null;
    void publishTrack(null).catch(() => undefined);
    sources.current.forEach((source) => source.disconnect());
    sources.current.clear();
    players.current.forEach(player => { player.pause(); player.srcObject = null; player.remove(); });
    players.current.clear();
    blockedPlayers.current.clear();
    inputGraph.current.forEach((node) => node.disconnect());
    inputGraph.current = [];
    analyser.current = null;
    analysisBuffer.current = null;
    if (context.current) {
      context.current.onstatechange = null;
      void context.current.close().catch(() => undefined);
    }
    context.current = null;
    output.current = null;
    setEnabled(false);
    setMuted(false);
    setBusy(false);
    setLevel(0);
    setSpeaking(false);
    setPlaybackBlocked(false);
  }, [publishTrack, setLevel]);

  const start = useCallback(async () => {
    if (context.current && context.current.state !== 'closed') return;

    const token = ++generation.current;
    setBusy(true);
    setError('');

    try {
      const audio = new AudioContext({ latencyHint: 'interactive' });
      context.current = audio;
      setPlaybackBlocked(audio.state !== 'running');
      audio.onstatechange = () => {
        if (context.current === audio) setPlaybackBlocked(audio.state !== 'running' || blockedPlayers.current.size > 0);
      };
      output.current = audio.createGain();
      output.current.gain.value = volumeRef.current / 100;
      output.current.connect(audio.destination);
      inputGraph.current = [output.current];

      // This runs during the call-button gesture, so the AudioContext is
      // unlocked before a permission prompt or signaling round trip occurs.
      void resumePlayback();

      const constraints: MediaStreamConstraints = {
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
      };
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia(constraints);
      } catch (reason) {
        if (token !== generation.current) return;
        if (!device || !(reason instanceof DOMException) || !['NotFoundError', 'OverconstrainedError'].includes(reason.name)) throw reason;
        // Saved device IDs can disappear after unplugging a USB microphone.
        stream = await navigator.mediaDevices.getUserMedia({ ...constraints, audio: { ...(constraints.audio as MediaTrackConstraints), deviceId: undefined } });
        if (token === generation.current) setDevice('');
      }
      if (token !== generation.current) {
        stream.getTracks().forEach((current) => current.stop());
        return;
      }
      raw.current = stream;
      void resumePlayback();
      const microphoneTrack = stream.getAudioTracks()[0];
      if (!microphoneTrack) throw new Error('microphone_track_missing');

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

      let speakingUntil = 0;
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
        if (live && rms >= thresholdForSensitivity(sensitivityRef.current)) speakingUntil = performance.now() + 180;
        setSpeaking(live && performance.now() < speakingUntil);
      };
      updateMeter();
      analysisTimer.current = window.setInterval(updateMeter, 50);

      track.current = microphoneTrack;
      microphoneTrack.onended = () => {
        if (token === generation.current) {
          stop();
          setError('마이크 연결이 끊겼어요. 장치를 확인하고 통화를 다시 시작해 주세요.');
        }
      };

      // Install the track into every already-negotiated voice sender. If the
      // room has no peer yet, the current track is picked up when a new peer
      // connection is created.
      try {
        await publishTrack(microphoneTrack);
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
          ? '마이크 전송을 연결하지 못했어요. 통화 시작을 다시 눌러 주세요.'
          : '마이크를 연결하지 못했어요. 권한과 장치를 확인해 주세요.');
      }
    } finally {
      if (token === generation.current) setBusy(false);
    }
  }, [attach, device, publishTrack, resumePlayback, stop, setLevel]);

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
    const refreshDevices = () => { void navigator.mediaDevices?.enumerateDevices()
      .then((available) => {
        if (live) setDevices(available.filter((current) => current.kind === 'audioinput'));
      })
      .catch(() => undefined); };
    const resume = () => {
      if (document.visibilityState === 'visible' && context.current &&
        (context.current.state !== 'running' || blockedPlayers.current.size > 0)) void resumePlayback();
    };
    refreshDevices();
    navigator.mediaDevices?.addEventListener('devicechange', refreshDevices);
    document.addEventListener('visibilitychange', resume);
    window.addEventListener('pointerdown', resume);
    window.addEventListener('keydown', resume);
    return () => {
      live = false;
      navigator.mediaDevices?.removeEventListener('devicechange', refreshDevices);
      document.removeEventListener('visibilitychange', resume);
      window.removeEventListener('pointerdown', resume);
      window.removeEventListener('keydown', resume);
      stop();
      clearReceivers();
    };
  }, [clearReceivers, resumePlayback, stop]);

  return {
    enabled,
    busy,
    muted,
    volume,
    setVolume,
    sensitivity,
    setSensitivity,
    getLevel,
    subscribeLevel,
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
