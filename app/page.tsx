'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Check,
  Copy,
  Link2,
  LogOut,
  Maximize2,
  Minimize2,
  MonitorUp,
  PictureInPicture,
  Radio,
  RefreshCw,
  Users,
  Video,
  Volume2,
  VolumeX,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useLinkcast } from '@/hooks/use-linkcast';
import { LaserOverlay } from '@/components/laser-overlay';
import { createRoomLink, normalizeRoomValue } from '@/lib/room-input';
import { VoiceControls } from '@/components/voice-controls';

type DeviceOption = { deviceId: string; label: string };
type CaptureInfo = { width?: number; height?: number; frameRate?: number };
type ModelContextLike = {
  registerTool: (
    tool: {
      name: string;
      title: string;
      description: string;
      inputSchema: object;
      annotations: { readOnlyHint: boolean; untrustedContentHint: boolean };
      execute: (input: unknown) => unknown;
    },
    options?: { signal?: AbortSignal },
  ) => void | Promise<void>;
};

type WebkitFullscreenVideo = HTMLVideoElement & {
  webkitEnterFullscreen?: () => void;
  webkitExitFullscreen?: () => void;
};

type PictureInPictureVideo = HTMLVideoElement & {
  autoPictureInPicture?: boolean;
  webkitPresentationMode?: string;
  webkitSetPresentationMode?: (mode: 'inline' | 'picture-in-picture') => void;
  webkitSupportsPresentationMode?: (mode: string) => boolean;
};

type PictureInPictureDocument = Document & {
  pictureInPictureElement?: Element | null;
  pictureInPictureEnabled?: boolean;
  exitPictureInPicture?: () => Promise<void>;
};

function supportsPictureInPicture(video: HTMLVideoElement | null) {
  if (!video) return false;

  const pictureInPictureVideo = video as PictureInPictureVideo;
  const pictureInPictureDocument = document as PictureInPictureDocument;
  const standardSupported =
    typeof video.requestPictureInPicture === 'function' &&
    pictureInPictureDocument.pictureInPictureEnabled !== false &&
    !video.disablePictureInPicture;
  const webkitSupported =
    typeof pictureInPictureVideo.webkitSetPresentationMode === 'function' &&
    pictureInPictureVideo.webkitSupportsPresentationMode?.('picture-in-picture') === true;

  return standardSupported || webkitSupported;
}

async function writeClipboardText(value: string) {
  if (!value) throw new Error('empty_clipboard_value');

  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return;
    }
  } catch {
    // Safari can expose the API before allowing it after an asynchronous step.
    // Try the synchronous fallback while the original click is still active.
  }

  const textarea = document.createElement('textarea');
  textarea.value = value;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  const copyCommand = Reflect.get(document, 'exec' + 'Command') as ((command: string) => boolean) | undefined;
  const copied = copyCommand ? copyCommand.call(document, 'copy') : false;
  textarea.remove();
  if (!copied) throw new Error('clipboard_unavailable');
}

async function requestFullscreenWithFallback(stage: HTMLElement, video: HTMLVideoElement | null) {
  const nativeVideo = video as WebkitFullscreenVideo | null;

  // iPhone Safari does not support element fullscreen for arbitrary containers.
  // Its native video fullscreen is the only reliable way to hide the address bar.
  if (typeof nativeVideo?.webkitEnterFullscreen === 'function') {
    try {
      nativeVideo.webkitEnterFullscreen();
      return 'native-video';
    } catch {
      // Continue with the standard fullscreen API or the viewport fallback.
    }
  }

  if (typeof stage.requestFullscreen === 'function') {
    try {
      await stage.requestFullscreen();
      return 'document';
    } catch {
      // Keep overlays available through a viewport-filling fallback.
    }
  }

  // Some mobile browsers reject fullscreen on a nested element but allow the
  // document root. This also gives the browser a chance to collapse its URL bar.
  if (typeof document.documentElement.requestFullscreen === 'function') {
    try {
      await document.documentElement.requestFullscreen();
      return 'document';
    } catch {
      // The browser may not allow root fullscreen from this browsing context.
    }
  }

  // Video-only fullscreen cannot display interactive overlays. Use the stage instead.
  return 'viewport';
}

function statusLabel(status: ReturnType<typeof useLinkcast>['status']) {
  switch (status) {
    case 'creating':
      return '방 만드는 중';
    case 'waiting':
      return '참가자 대기 중';
    case 'connecting':
      return '직접 연결 중';
    case 'connected':
      return '직접 연결됨';
    case 'full':
      return '정원 초과';
    case 'not-found':
      return '송출 없음';
    case 'failed':
      return '연결 실패';
    default:
      return '연결 준비';
  }
}

export default function Home() {
  const previewVideoRef = useRef<HTMLVideoElement>(null);
  const viewerVideoRef = useRef<HTMLVideoElement>(null);
  const hostStageRef = useRef<HTMLElement>(null);
  const viewerStageRef = useRef<HTMLElement>(null);
  const nativeHostFullscreenRef = useRef(false);
  const nativeViewerFullscreenRef = useRef(false);
  const viewerAutoPipAttemptRef = useRef(false);
  const hostControlsTimerRef = useRef<number | null>(null);
  const viewerControlsTimerRef = useRef<number | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const autoJoinRef = useRef('');
  const joiningRef = useRef<Promise<boolean> | null>(null);
  const joiningRoomRef = useRef('');
  const creatingRef = useRef<Promise<string | null> | null>(null);
  const [mode, setMode] = useState<'host' | 'viewer'>('host');
  const [videoDevices, setVideoDevices] = useState<DeviceOption[]>([]);
  const [audioDevices, setAudioDevices] = useState<DeviceOption[]>([]);
  const [selectedDevice, setSelectedDevice] = useState('');
  const [selectedAudio, setSelectedAudio] = useState('');
  const [captureInfo, setCaptureInfo] = useState<CaptureInfo>({});
  const [isPreviewing, setIsPreviewing] = useState(false);
  const [joinValue, setJoinValue] = useState('');
  const [copied, setCopied] = useState(false);
  const [codeCopied, setCodeCopied] = useState(false);
  const [captureError, setCaptureError] = useState('');
  const [hostAudioEnabled, setHostAudioEnabled] = useState(true);
  const [playbackBlocked, setPlaybackBlocked] = useState(false);
  const [viewerVideoReady, setViewerVideoReady] = useState(false);
  const [hostAspectRatio, setHostAspectRatio] = useState<number | null>(null);
  const [viewerAspectRatio, setViewerAspectRatio] = useState<number | null>(null);
  const [isHostFullscreen, setIsHostFullscreen] = useState(false);
  const [showHostControls, setShowHostControls] = useState(true);
  const [isViewerFullscreen, setIsViewerFullscreen] = useState(false);
  const [showViewerControls, setShowViewerControls] = useState(true);
  const [viewerPipSupported, setViewerPipSupported] = useState(false);
  const [isViewerPip, setIsViewerPip] = useState(false);
  const [viewerPipError, setViewerPipError] = useState('');

  const {
    voice,
    laserStrokes,
    sendLaserStroke,
    status,
    roomId,
    viewerCount,
    remoteStream,
    error: connectionError,
    createRoom,
    joinRoom,
    leave,
  } = useLinkcast();

  const shareUrl = useMemo(() => {
    if (!roomId || typeof window === 'undefined') return '';
    return createRoomLink(window.location.href, roomId);
  }, [roomId]);

  const { bindOutputElement } = voice;
  useEffect(() => {
    bindOutputElement(mode === 'host' ? previewVideoRef.current : viewerVideoRef.current);
  }, [mode, roomId, remoteStream, bindOutputElement]);

  const exitViewerPictureInPicture = useCallback(async () => {
    const video = viewerVideoRef.current as PictureInPictureVideo | null;
    const pictureInPictureDocument = document as PictureInPictureDocument;

    try {
      if (
        pictureInPictureDocument.pictureInPictureElement === video &&
        typeof pictureInPictureDocument.exitPictureInPicture === 'function'
      ) {
        await pictureInPictureDocument.exitPictureInPicture();
      } else if (
        video?.webkitPresentationMode === 'picture-in-picture' &&
        typeof video.webkitSetPresentationMode === 'function'
      ) {
        video.webkitSetPresentationMode('inline');
      }
    } catch {
      // The browser may have already closed the PiP window.
    } finally {
      setIsViewerPip(false);
    }
  }, []);

  const enterViewerPictureInPicture = useCallback(async () => {
    const video = viewerVideoRef.current as PictureInPictureVideo | null;
    const pictureInPictureDocument = document as PictureInPictureDocument;
    if (!video || !remoteStream || !viewerVideoReady) return false;

    if (
      pictureInPictureDocument.pictureInPictureElement === video ||
      video.webkitPresentationMode === 'picture-in-picture'
    ) {
      setIsViewerPip(true);
      return true;
    }

    // iOS Safari's WebKit presentation API can handle a MediaStream video even
    // where the standard requestPictureInPicture API is unavailable.
    if (
      video.webkitSupportsPresentationMode?.('picture-in-picture') === true &&
      typeof video.webkitSetPresentationMode === 'function'
    ) {
      video.webkitSetPresentationMode('picture-in-picture');
      setIsViewerPip(true);
      return true;
    }

    if (
      typeof video.requestPictureInPicture === 'function' &&
      pictureInPictureDocument.pictureInPictureEnabled !== false
    ) {
      await video.requestPictureInPicture();
      setIsViewerPip(true);
      return true;
    }

    return false;
  }, [remoteStream, viewerVideoReady]);

  const toggleViewerPictureInPicture = useCallback(async () => {
    const video = viewerVideoRef.current as PictureInPictureVideo | null;
    const pictureInPictureDocument = document as PictureInPictureDocument;
    if (!video || !remoteStream || !viewerVideoReady) return;

    setViewerPipError('');
    try {
      if (pictureInPictureDocument.pictureInPictureElement === video) {
        await exitViewerPictureInPicture();
        return;
      }
      if (video.webkitPresentationMode === 'picture-in-picture') {
        await exitViewerPictureInPicture();
        return;
      }

      if (!(await enterViewerPictureInPicture())) throw new Error('picture_in_picture_unsupported');
    } catch {
      setViewerPipError('이 브라우저에서는 PiP를 시작할 수 없어요. Safari 또는 Chrome 최신 버전을 사용해 주세요.');
    }
  }, [enterViewerPictureInPicture, exitViewerPictureInPicture, remoteStream, viewerVideoReady]);

  const stopPreview = useCallback(() => {
    void leave();
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (previewVideoRef.current) previewVideoRef.current.srcObject = null;
    setIsPreviewing(false);
    setHostAudioEnabled(false);
    setHostAspectRatio(null);
    setShowHostControls(true);
    setCaptureInfo({});
  }, [leave]);

  const refreshDevices = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    const devices = await navigator.mediaDevices.enumerateDevices();
    const cameras = devices
      .filter((device) => device.kind === 'videoinput')
      .map((device, index) => ({
        deviceId: device.deviceId,
        label: device.label || `영상 입력 ${index + 1}`,
      }));
    const microphones = devices
      .filter((device) => device.kind === 'audioinput')
      .map((device, index) => ({
        deviceId: device.deviceId,
        label: device.label || `오디오 입력 ${index + 1}`,
      }));
    setVideoDevices(cameras);
    setAudioDevices(microphones);
    setSelectedDevice((current) => current || cameras[0]?.deviceId || '');
    setSelectedAudio((current) => current || microphones[0]?.deviceId || '');
  }, []);

  const startPreview = useCallback(
    async (videoDeviceId?: string, audioDeviceId?: string) => {
      setCaptureError('');
      setHostAspectRatio(null);
      await leave();
      streamRef.current?.getTracks().forEach((track) => track.stop());

      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            width: { ideal: 1920 },
            height: { ideal: 1080 },
            frameRate: { ideal: 60, max: 60 },
            ...(videoDeviceId ? { deviceId: { exact: videoDeviceId } } : {}),
          },
          audio: {
            ...(audioDeviceId ? { deviceId: { exact: audioDeviceId } } : {}),
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
          },
        });
        streamRef.current = stream;
        if (previewVideoRef.current) {
          previewVideoRef.current.srcObject = stream;
          previewVideoRef.current.muted = false;
          try {
            await previewVideoRef.current.play();
            setHostAudioEnabled(true);
          } catch {
            previewVideoRef.current.muted = true;
            setHostAudioEnabled(false);
            await previewVideoRef.current.play();
          }
        }
        const videoSettings = stream.getVideoTracks()[0]?.getSettings();
        const audioSettings = stream.getAudioTracks()[0]?.getSettings();
        if (videoSettings?.width && videoSettings.height) {
          setHostAspectRatio(videoSettings.width / videoSettings.height);
        }
        setCaptureInfo({
          width: videoSettings?.width,
          height: videoSettings?.height,
          frameRate: videoSettings?.frameRate,
        });
        setSelectedDevice(videoSettings?.deviceId || videoDeviceId || '');
        setSelectedAudio(audioSettings?.deviceId || audioDeviceId || '');
        setIsPreviewing(true);
        await refreshDevices();
      } catch (reason) {
        const message =
          reason instanceof DOMException && reason.name === 'NotAllowedError'
            ? '카메라와 오디오 권한을 허용해 주세요.'
            : '캡처보드를 찾지 못했어요. 연결 상태를 확인해 주세요.';
        setCaptureError(message);
      }
    },
    [leave, refreshDevices],
  );

  const connectViewer = useCallback(
    async (value: string) => {
      const normalized = normalizeRoomValue(value);
      if (!normalized) return false;
      if (joiningRef.current && joiningRoomRef.current === normalized) return joiningRef.current;
      joiningRoomRef.current = normalized;
      setJoinValue(normalized);
      setMode('viewer');
      autoJoinRef.current = normalized;
      // Joining must not also trigger router navigation and effect cleanup.
      const pending = joinRoom(normalized).then(connected => {
        if (connected && joiningRoomRef.current === normalized) {
          // A code join after an old link must also replace that old address.
          window.history.replaceState(window.history.state, '', createRoomLink(window.location.href, normalized));
        }
        return connected;
      });
      joiningRef.current = pending;
      void pending.finally(() => {
        if (joiningRef.current === pending) joiningRef.current = null;
      }).catch(() => undefined);
      return pending;
    },
    [joinRoom],
  );

  useEffect(() => {
    const requestedRoom = normalizeRoomValue(window.location.href);
    const timer = window.setTimeout(() => {
      if (requestedRoom && autoJoinRef.current !== requestedRoom) void connectViewer(requestedRoom);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [connectViewer]);

  useEffect(() => {
    const timer = window.setTimeout(() => void refreshDevices(), 0);
    return () => {
      window.clearTimeout(timer);
      streamRef.current?.getTracks().forEach((track) => track.stop());
    };
  }, [refreshDevices]);

  useEffect(() => {
    const video = viewerVideoRef.current;
    if (!video) return;

    setViewerVideoReady(false);
    setPlaybackBlocked(false);
    setViewerAspectRatio(null);
    video.onplaying = () => {
      setViewerVideoReady(true);
      setPlaybackBlocked(video.muted);
    };

    if (!remoteStream) {
      void exitViewerPictureInPicture();
      video.srcObject = null;
      return;
    }

    const tryPlay = () => {
      void video.play().catch((reason: unknown) => {
        if (reason instanceof DOMException && reason.name === 'NotAllowedError') {
          setPlaybackBlocked(true);
          // A shared link has no user gesture: show video immediately, then unlock audio on tap.
          video.muted = true;
          void video.play().catch(() => undefined);
        }
      });
    };

    video.muted = false;
    video.srcObject = remoteStream;
    video.onloadedmetadata = () => {
      if (video.videoWidth && video.videoHeight) {
        setViewerAspectRatio(video.videoWidth / video.videoHeight);
      }
      tryPlay();
    };
    tryPlay();

    return () => {
      video.onplaying = null;
      video.onloadedmetadata = null;
    };
  }, [exitViewerPictureInPicture, remoteStream]);

  useEffect(() => {
    const video = viewerVideoRef.current;
    if (!video) return;

    const refreshPictureInPictureSupport = () => {
      setViewerPipSupported(Boolean(remoteStream && viewerVideoReady && supportsPictureInPicture(video)));
    };
    refreshPictureInPictureSupport();
    video.addEventListener('loadedmetadata', refreshPictureInPictureSupport);
    video.addEventListener('canplay', refreshPictureInPictureSupport);
    return () => {
      video.removeEventListener('loadedmetadata', refreshPictureInPictureSupport);
      video.removeEventListener('canplay', refreshPictureInPictureSupport);
    };
  }, [remoteStream, viewerVideoReady]);

  useEffect(() => {
    const video = viewerVideoRef.current as PictureInPictureVideo | null;
    if (!video) return;

    viewerAutoPipAttemptRef.current = false;

    // Chromium can enter PiP automatically when the page is backgrounded.
    // Keep this as a hint; unsupported browsers simply ignore the property.
    if ('autoPictureInPicture' in video) {
      video.autoPictureInPicture = Boolean(remoteStream && viewerVideoReady);
    }

    const requestAutomaticPictureInPicture = (event?: Event) => {
      if (
        (document.visibilityState !== 'hidden' && event?.type !== 'pagehide') ||
        !remoteStream ||
        !viewerVideoReady ||
        isViewerFullscreen ||
        nativeViewerFullscreenRef.current ||
        viewerAutoPipAttemptRef.current
      ) {
        return;
      }

      // requestPictureInPicture normally needs a user gesture. This best-effort
      // attempt is intentionally silent when the browser rejects background PiP.
      viewerAutoPipAttemptRef.current = true;
      void enterViewerPictureInPicture().catch(() => undefined);
    };
    const resetAutomaticPictureInPictureAttempt = () => {
      if (document.visibilityState === 'visible') viewerAutoPipAttemptRef.current = false;
    };

    document.addEventListener('visibilitychange', requestAutomaticPictureInPicture);
    document.addEventListener('visibilitychange', resetAutomaticPictureInPictureAttempt);
    window.addEventListener('pagehide', requestAutomaticPictureInPicture);
    return () => {
      document.removeEventListener('visibilitychange', requestAutomaticPictureInPicture);
      document.removeEventListener('visibilitychange', resetAutomaticPictureInPictureAttempt);
      window.removeEventListener('pagehide', requestAutomaticPictureInPicture);
      if ('autoPictureInPicture' in video) video.autoPictureInPicture = false;
    };
  }, [enterViewerPictureInPicture, isViewerFullscreen, remoteStream, viewerVideoReady]);

  useEffect(() => {
    const video = viewerVideoRef.current as PictureInPictureVideo | null;
    if (!video) return;

    const updatePictureInPictureState = () => {
      const pictureInPictureDocument = document as PictureInPictureDocument;
      setIsViewerPip(
        pictureInPictureDocument.pictureInPictureElement === video ||
        video.webkitPresentationMode === 'picture-in-picture',
      );
    };
    video.addEventListener('enterpictureinpicture', updatePictureInPictureState);
    video.addEventListener('leavepictureinpicture', updatePictureInPictureState);
    video.addEventListener('webkitpresentationmodechanged', updatePictureInPictureState);
    return () => {
      video.removeEventListener('enterpictureinpicture', updatePictureInPictureState);
      video.removeEventListener('leavepictureinpicture', updatePictureInPictureState);
      video.removeEventListener('webkitpresentationmodechanged', updatePictureInPictureState);
    };
  }, []);

  const updateHostAspectRatio = useCallback(() => {
    const video = previewVideoRef.current;
    if (video?.videoWidth && video.videoHeight) {
      setHostAspectRatio(video.videoWidth / video.videoHeight);
    }
  }, []);

  const copyText = useCallback(
    async (value: string, onSuccess: () => void, failureMessage: string) => {
      try {
        await writeClipboardText(value);
        setCaptureError('');
        onSuccess();
        return true;
      } catch {
        setCaptureError(failureMessage);
        return false;
      }
    },
    [],
  );

  const createShareLink = useCallback(async () => {
    if (creatingRef.current) return creatingRef.current;
    if (!streamRef.current) return null;
    const requestedRoomId = crypto.randomUUID().replaceAll('-', '').slice(0, 12);
    const nextShareUrl = createRoomLink(window.location.href, requestedRoomId);
    setCopied(false);
    setCodeCopied(false);
    // Start the clipboard write in the original button gesture. Waiting for
    // room creation first loses Safari's transient clipboard permission.
    const copyPromise = copyText(
      nextShareUrl,
      () => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1800);
      },
      '송출 링크를 만들었지만 자동 복사하지 못했어요. 아래 링크 복사 버튼을 눌러 주세요.',
    );
    const pending = createRoom(streamRef.current, requestedRoomId).then(async createdRoomId => {
      await copyPromise;
      if (!createdRoomId) {
        setCopied(false);
        return null;
      }

      autoJoinRef.current = createdRoomId;
      window.history.replaceState(window.history.state, '', nextShareUrl);
      return createdRoomId;
    });
    creatingRef.current = pending;
    try { return await pending; }
    finally { if (creatingRef.current === pending) creatingRef.current = null; }
  }, [copyText, createRoom]);

  const copyLink = async () => {
    if (!shareUrl) return;
    await copyText(
      shareUrl,
      () => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1800);
      },
      '링크를 복사하지 못했어요. 표시된 링크를 선택해 복사해 주세요.',
    );
  };

  const copyCode = async () => {
    if (!roomId) return;
    await copyText(
      roomId,
      () => {
        setCodeCopied(true);
        window.setTimeout(() => setCodeCopied(false), 1800);
      },
      '코드를 복사하지 못했어요. 표시된 코드를 선택해 복사해 주세요.',
    );
  };

  const changeMode = (nextMode: 'host' | 'viewer') => {
    if (nextMode === mode) return;
    void exitViewerPictureInPicture();
    if (document.fullscreenElement) void document.exitFullscreen();
    if (nativeHostFullscreenRef.current) {
      (previewVideoRef.current as WebkitFullscreenVideo | null)?.webkitExitFullscreen?.();
    }
    if (nativeViewerFullscreenRef.current) {
      (viewerVideoRef.current as WebkitFullscreenVideo | null)?.webkitExitFullscreen?.();
    }
    nativeHostFullscreenRef.current = false;
    nativeViewerFullscreenRef.current = false;
    void leave();
    setMode(nextMode);
    setJoinValue('');
    setShowHostControls(true);
    setShowViewerControls(true);
    setPlaybackBlocked(false);
    window.history.replaceState(null, '', '/');
  };

  const toggleHostAudio = useCallback(async () => {
    const video = previewVideoRef.current;
    if (!video) return;
    if (hostAudioEnabled) {
      video.muted = true;
      setHostAudioEnabled(false);
      return;
    }
    video.muted = false;
    try {
      await video.play();
      setHostAudioEnabled(true);
    } catch {
      video.muted = true;
      setHostAudioEnabled(false);
    }
  }, [hostAudioEnabled]);

  const toggleHostFullscreen = useCallback(async () => {
    const stage = hostStageRef.current;
    const video = previewVideoRef.current;
    if (!stage) return;
    try {
      const nativeVideo = video as WebkitFullscreenVideo | null;
      if (nativeHostFullscreenRef.current) {
        nativeVideo?.webkitExitFullscreen?.();
        nativeHostFullscreenRef.current = false;
        setIsHostFullscreen(false);
        setShowHostControls(true);
        return;
      }
      if (document.fullscreenElement) {
        await document.exitFullscreen();
        return;
      }
      setShowHostControls(false);
      const fullscreenMode = await requestFullscreenWithFallback(stage, video);
      if (fullscreenMode === 'native-video' || fullscreenMode === 'viewport') {
        nativeHostFullscreenRef.current = true;
        setIsHostFullscreen(true);
      } else if (!fullscreenMode) {
        throw new Error('fullscreen_unsupported');
      }
    } catch {
      nativeHostFullscreenRef.current = false;
      setIsHostFullscreen(false);
      setShowHostControls(true);
    }
  }, []);

  const revealHostControls = useCallback(() => {
    setShowHostControls(true);
    if (hostControlsTimerRef.current) window.clearTimeout(hostControlsTimerRef.current);
    if (isHostFullscreen) {
      hostControlsTimerRef.current = window.setTimeout(() => setShowHostControls(false), 3200);
    }
  }, [isHostFullscreen]);

  const toggleViewerFullscreen = useCallback(async () => {
    const stage = viewerStageRef.current;
    const video = viewerVideoRef.current;
    if (!stage) return;
    try {
      const nativeVideo = video as WebkitFullscreenVideo | null;
      if (nativeViewerFullscreenRef.current) {
        nativeVideo?.webkitExitFullscreen?.();
        nativeViewerFullscreenRef.current = false;
        setIsViewerFullscreen(false);
        setShowViewerControls(true);
        return;
      }
      if (document.fullscreenElement) {
        await document.exitFullscreen();
        return;
      }
      setShowViewerControls(false);
      const fullscreenMode = await requestFullscreenWithFallback(stage, video);
      if (fullscreenMode === 'native-video' || fullscreenMode === 'viewport') {
        nativeViewerFullscreenRef.current = true;
        setIsViewerFullscreen(true);
      } else if (!fullscreenMode) {
        throw new Error('fullscreen_unsupported');
      }
    } catch {
      nativeViewerFullscreenRef.current = false;
      setIsViewerFullscreen(false);
      setShowViewerControls(true);
    }
  }, []);

  const revealViewerControls = useCallback(() => {
    setShowViewerControls(true);
    if (viewerControlsTimerRef.current) window.clearTimeout(viewerControlsTimerRef.current);
    if (isViewerFullscreen) {
      viewerControlsTimerRef.current = window.setTimeout(() => setShowViewerControls(false), 3200);
    }
  }, [isViewerFullscreen]);

  useEffect(() => {
    const hostVideo = previewVideoRef.current;
    const viewerVideo = viewerVideoRef.current;
    const handleNativeHostBegin = () => {
      nativeHostFullscreenRef.current = true;
      setIsHostFullscreen(true);
      setShowHostControls(false);
    };
    const handleNativeHostEnd = () => {
      nativeHostFullscreenRef.current = false;
      setIsHostFullscreen(false);
      setShowHostControls(true);
    };
    const handleNativeViewerBegin = () => {
      nativeViewerFullscreenRef.current = true;
      setIsViewerFullscreen(true);
      setShowViewerControls(false);
    };
    const handleNativeViewerEnd = () => {
      nativeViewerFullscreenRef.current = false;
      setIsViewerFullscreen(false);
      setShowViewerControls(true);
    };
    const handleFullscreenChange = () => {
      const hostFullscreen =
        nativeHostFullscreenRef.current ||
        document.fullscreenElement === hostStageRef.current ||
        document.fullscreenElement === hostVideo ||
        (mode === 'host' && document.fullscreenElement === document.documentElement);
      const viewerFullscreen =
        nativeViewerFullscreenRef.current ||
        document.fullscreenElement === viewerStageRef.current ||
        document.fullscreenElement === viewerVideo ||
        (mode === 'viewer' && document.fullscreenElement === document.documentElement);
      setIsHostFullscreen(hostFullscreen);
      setIsViewerFullscreen(viewerFullscreen);
      setShowHostControls(!hostFullscreen);
      setShowViewerControls(!viewerFullscreen);
      if (hostControlsTimerRef.current) window.clearTimeout(hostControlsTimerRef.current);
      if (viewerControlsTimerRef.current) window.clearTimeout(viewerControlsTimerRef.current);
    };
    hostVideo?.addEventListener('webkitbeginfullscreen', handleNativeHostBegin);
    hostVideo?.addEventListener('webkitendfullscreen', handleNativeHostEnd);
    viewerVideo?.addEventListener('webkitbeginfullscreen', handleNativeViewerBegin);
    viewerVideo?.addEventListener('webkitendfullscreen', handleNativeViewerEnd);
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => {
      hostVideo?.removeEventListener('webkitbeginfullscreen', handleNativeHostBegin);
      hostVideo?.removeEventListener('webkitendfullscreen', handleNativeHostEnd);
      viewerVideo?.removeEventListener('webkitbeginfullscreen', handleNativeViewerBegin);
      viewerVideo?.removeEventListener('webkitendfullscreen', handleNativeViewerEnd);
      document.removeEventListener('fullscreenchange', handleFullscreenChange);
      if (hostControlsTimerRef.current) window.clearTimeout(hostControlsTimerRef.current);
      if (viewerControlsTimerRef.current) window.clearTimeout(viewerControlsTimerRef.current);
    };
  }, [mode]);

  useEffect(() => {
    const context = (document as Document & { modelContext?: ModelContextLike })
      .modelContext;
    if (!context?.registerTool) return;

    const lifecycle = new AbortController();
    const register = async () => {
      await context.registerTool(
        {
          name: 'create_linkcast_room',
          title: '송출 링크 만들기',
          description: '연결된 캡처보드로 실제 P2P 송출 방과 공유 링크를 만듭니다.',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
          annotations: { readOnlyHint: false, untrustedContentHint: false },
          execute: async () => {
            if (!streamRef.current) throw new Error('캡처보드를 먼저 연결해 주세요.');
            const createdRoomId = await createShareLink();
            if (!createdRoomId) throw new Error('방을 만들지 못했어요.');
            return {
              roomId: createdRoomId,
              shareUrl: createRoomLink(window.location.href, createdRoomId),
            };
          },
        },
        { signal: lifecycle.signal },
      );
      await context.registerTool(
        {
          name: 'join_linkcast_room',
          title: '송출에 참가하기',
          description: '방 코드로 Linkcast P2P 영상 송출에 참가합니다.',
          inputSchema: {
            type: 'object',
            properties: { roomId: { type: 'string', minLength: 8 } },
            required: ['roomId'],
            additionalProperties: false,
          },
          annotations: { readOnlyHint: false, untrustedContentHint: true },
          execute: async (input) => {
            const value =
              typeof input === 'object' && input !== null && 'roomId' in input
                ? String(input.roomId)
                : '';
            const connected = await connectViewer(value);
            if (!connected) throw new Error('송출에 참가하지 못했어요.');
            return { roomId: normalizeRoomValue(value), status: 'connecting' };
          },
        },
        { signal: lifecycle.signal },
      );
    };
    void register().catch(() => undefined);
    return () => lifecycle.abort();
  }, [connectViewer, createShareLink]);

  const resolution =
    captureInfo.width && captureInfo.height
      ? `${captureInfo.width} × ${captureInfo.height}`
      : '1920 × 1080';
  const frameRate = captureInfo.frameRate
    ? `${Math.round(captureInfo.frameRate)} fps`
    : '60 fps';
  const activeRoom = Boolean(roomId && status !== 'idle');

  return (
    <main className="min-h-dvh bg-background text-foreground">
      <header className="mx-auto flex h-20 max-w-[1480px] items-center justify-between px-3 sm:px-8 lg:px-12">
        <div className="flex items-center gap-2.5" aria-label="Linkcast">
          <span className="grid size-8 place-items-center rounded-full bg-foreground text-background">
            <Radio className="size-4" strokeWidth={2.2} />
          </span>
          <span className="text-lg font-semibold tracking-[-0.035em]">Linkcast</span>
        </div>
        <div className="flex max-w-[48%] items-center gap-2 truncate text-xs text-muted-foreground sm:max-w-none sm:text-sm">
          <span className={`size-2 rounded-full ${status === 'connected' ? 'bg-[#58d68d] shadow-[0_0_0_4px_rgba(88,214,141,0.12)]' : 'bg-border'}`} />
          <span className="truncate">{statusLabel(status)}</span>
        </div>
      </header>

      <section className="mx-auto max-w-[1480px] px-3 pb-5 sm:px-8 sm:pb-8 lg:px-12">
        <Tabs value={mode} onValueChange={(value) => changeMode(value as 'host' | 'viewer')} className="gap-6">
          <div className="flex flex-col gap-4 border-b border-border pb-4 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <h1 className="text-2xl font-semibold tracking-[-0.04em] sm:text-3xl">지연 없이, 링크 하나로</h1>
            </div>
            <TabsList className="h-10 w-full rounded-full bg-muted/80 p-1 sm:w-auto">
              <TabsTrigger value="host" className="h-8 flex-1 rounded-full px-4 sm:flex-none">송출</TabsTrigger>
              <TabsTrigger value="viewer" className="h-8 flex-1 rounded-full px-4 sm:flex-none">참가</TabsTrigger>
            </TabsList>
          </div>

          <TabsContent value="host">
            <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_340px]">
              <section ref={hostStageRef} style={!isHostFullscreen && hostAspectRatio ? { aspectRatio: hostAspectRatio } : undefined} className={`group overflow-hidden bg-[#0b0d0f] shadow-[0_24px_80px_rgba(8,11,14,0.16)] ${isHostFullscreen ? 'fixed inset-0 z-50 h-dvh w-screen rounded-none' : 'relative aspect-video min-h-0 rounded-2xl sm:min-h-[280px] sm:rounded-[28px]'}`}>
                <video ref={previewVideoRef} muted={!hostAudioEnabled} playsInline onLoadedMetadata={updateHostAspectRatio} className={`block h-full w-full object-contain transition-opacity duration-300 ${isPreviewing ? 'opacity-100' : 'opacity-0'}`}>
                  <track kind="captions" srcLang="ko" label="한국어" src="/captions-empty.vtt" />
                </video>

                {!isPreviewing && (
                  <div className="absolute inset-0 grid place-items-center px-6 text-center">
                    <div>
                      <span className="mx-auto mb-5 grid size-14 place-items-center rounded-full border border-white/10 bg-white/[0.06] text-white"><Video className="size-5" /></span>
                      <h2 className="text-xl font-medium tracking-[-0.025em] text-white">캡처보드를 연결하세요</h2>
                      <p className="mt-2 text-sm text-white/45">1080p 60fps로 입력을 요청합니다</p>
                      <Button size="lg" onClick={() => void startPreview(selectedDevice, selectedAudio)} className="mt-6 h-11 rounded-full bg-white px-5 text-[#0b0d0f] hover:bg-white/90">
                        <MonitorUp data-icon="inline-start" /> 캡처보드 연결
                      </Button>
                    </div>
                  </div>
                )}

                {isPreviewing && <LaserOverlay ratio={hostAspectRatio || 16 / 9} strokes={laserStrokes} onSend={sendLaserStroke} />}
                {activeRoom && isHostFullscreen && showHostControls && <div className="absolute inset-x-3 bottom-20 z-20 mx-auto max-h-[60dvh] max-w-2xl overflow-y-auto"><VoiceControls voice={voice} host /></div>}
                {isHostFullscreen && <button type="button" aria-label="영상 메뉴 열기" onClick={revealHostControls} className="absolute bottom-2 right-4 z-10 h-11 w-11 rounded-full bg-black/35 text-xl text-white">···</button>}
                {(!isHostFullscreen || showHostControls) && (
                  <div className="absolute inset-x-0 top-0 flex items-center justify-between p-4 sm:p-5">
                    <span className="rounded-full border border-white/10 bg-black/35 px-3 py-1.5 text-xs font-medium text-white/80 backdrop-blur-md">
                      {activeRoom ? 'ON AIR' : isPreviewing ? 'PREVIEW' : 'NO SIGNAL'}
                    </span>
                    <div className="flex items-center gap-2">
                      {isPreviewing && (
                        <>
                          <span className="hidden rounded-full border border-white/10 bg-black/35 px-3 py-1.5 text-xs font-medium text-white/80 backdrop-blur-md sm:inline-flex">
                            {resolution} · {frameRate}
                          </span>
                          <Button variant="ghost" size="icon" onClick={() => void toggleHostAudio()} aria-label={hostAudioEnabled ? '송출자 소리 끄기' : '송출자 소리 켜기'} className="rounded-full border border-white/10 bg-black/35 text-white/80 hover:bg-black/55 hover:text-white">
                            {hostAudioEnabled ? <Volume2 /> : <VolumeX />}
                          </Button>
                          <Button variant="ghost" size="icon" onClick={() => void toggleHostFullscreen()} aria-label={isHostFullscreen ? '전체화면 종료' : '전체화면 보기'} className="rounded-full border border-white/10 bg-black/35 text-white/80 hover:bg-black/55 hover:text-white">
                            {isHostFullscreen ? <Minimize2 /> : <Maximize2 />}
                          </Button>
                        </>
                      )}
                    </div>
                  </div>
                )}
              </section>

              <aside className="flex flex-col rounded-2xl border border-border bg-card p-4 sm:rounded-[28px] sm:p-6">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm text-muted-foreground">영상 입력</p>
                    <h2 className="mt-1 text-lg font-semibold tracking-[-0.025em]">캡처 설정</h2>
                  </div>
                  <Button variant="ghost" size="icon" aria-label="입력 장치 새로고침" onClick={() => void refreshDevices()} className="rounded-full"><RefreshCw /></Button>
                </div>

                <div className="mt-7 space-y-5">
                  <div className="space-y-2">
                    <Label htmlFor="video-device">영상 장치</Label>
                    <Select value={selectedDevice} onValueChange={(value) => {
                      setSelectedDevice(value as string);
                      if (isPreviewing) void startPreview(value as string, selectedAudio);
                    }} disabled={activeRoom}>
                      <SelectTrigger id="video-device" className="h-11 w-full rounded-xl px-3"><SelectValue placeholder="캡처보드를 선택하세요">{videoDevices.find(d => d.deviceId === selectedDevice)?.label || '캡처보드를 선택하세요'}</SelectValue></SelectTrigger>
                      <SelectContent>
                        {videoDevices.length ? videoDevices.map((device) => <SelectItem key={device.deviceId} value={device.deviceId}>{device.label}</SelectItem>) : <SelectItem value="none" disabled>연결된 장치 없음</SelectItem>}
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="audio-device">오디오 장치</Label>
                    <Select value={selectedAudio} onValueChange={(value) => {
                      setSelectedAudio(value as string);
                      if (isPreviewing) void startPreview(selectedDevice, value as string);
                    }} disabled={activeRoom}>
                      <SelectTrigger id="audio-device" className="h-11 w-full rounded-xl px-3"><Volume2 className="size-4 text-muted-foreground" /><SelectValue placeholder="오디오 입력을 선택하세요">{audioDevices.find(d => d.deviceId === selectedAudio)?.label || '오디오 입력을 선택하세요'}</SelectValue></SelectTrigger>
                      <SelectContent>
                        {audioDevices.length ? audioDevices.map((device) => <SelectItem key={device.deviceId} value={device.deviceId}>{device.label}</SelectItem>) : <SelectItem value="none" disabled>연결된 장치 없음</SelectItem>}
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div className="rounded-2xl bg-muted/65 p-4"><p className="text-xs text-muted-foreground">해상도</p><p className="mt-1 text-sm font-medium">{resolution}</p></div>
                    <div className="rounded-2xl bg-muted/65 p-4"><p className="text-xs text-muted-foreground">프레임</p><p className="mt-1 text-sm font-medium">{frameRate}</p></div>
                  </div>
                </div>

                {(captureError || connectionError) && <p role="alert" className="mt-4 text-sm leading-6 text-destructive">{captureError || connectionError}</p>}

                <div className="mt-6 border-t border-border pt-6 lg:mt-auto">
                  {!shareUrl ? (
                    <Button size="lg" disabled={!isPreviewing || status === 'creating'} onClick={() => void createShareLink()} className="h-12 w-full rounded-full text-base">
                      <Link2 data-icon="inline-start" /> {status === 'creating' ? '방 만드는 중' : '링크 만들고 복사'}
                    </Button>
                  ) : (
                    <div className="space-y-3">
                      <div className="flex items-center gap-2 rounded-2xl border border-border bg-muted/40 p-2 pl-3">
                        <p className="min-w-0 flex-1 truncate text-sm text-muted-foreground">{shareUrl}</p>
                        <Button onClick={() => void copyLink()} aria-label="송출 링크 복사" className="shrink-0 rounded-xl">{copied ? <Check /> : <Copy />}{copied ? '복사됨' : '링크 복사'}</Button>
                      </div>
                      <div className="flex items-center justify-between gap-2 text-sm text-muted-foreground">
                        <span>참가 코드 <span className="select-all font-mono">{roomId}</span></span>
                        <button type="button" onClick={() => void copyCode()} className="shrink-0 hover:text-foreground">{codeCopied ? '복사됨' : '코드만 복사'}</button>
                      </div>
                      <div className="flex items-center justify-between text-xs text-muted-foreground">
                        <span className="flex items-center gap-2"><Users className="size-3.5" /> {viewerCount}/5명 연결</span>
                        <button type="button" onClick={stopPreview} className="transition-colors hover:text-foreground">송출 종료</button>
                      </div>
                    </div>
                  )}
                </div>
              </aside>
            </div>
          </TabsContent>

          <TabsContent value="viewer">
            {roomId && status !== 'not-found' && status !== 'full' && status !== 'failed' ? (
              <section ref={viewerStageRef} style={!isViewerFullscreen && viewerAspectRatio ? { aspectRatio: viewerAspectRatio } : undefined} className={`group overflow-hidden bg-[#0b0d0f] shadow-[0_24px_80px_rgba(8,11,14,0.16)] ${isViewerFullscreen ? 'fixed inset-0 z-50 h-dvh w-screen rounded-none' : 'relative aspect-video min-h-0 rounded-2xl sm:min-h-[300px] sm:rounded-[28px]'}`}>
                <video ref={viewerVideoRef} autoPlay playsInline className={`block h-full w-full object-contain transition-opacity duration-300 ${remoteStream && viewerVideoReady ? 'opacity-100' : 'opacity-0'}`}>
                  <track kind="captions" srcLang="ko" label="한국어" src="/captions-empty.vtt" />
                </video>
                {(!remoteStream || !viewerVideoReady) && (
                  <div className="absolute inset-0 grid place-items-center text-center text-white">
                    <div>
                      <span className="mx-auto mb-5 block size-3 animate-pulse rounded-full bg-[#58d68d] shadow-[0_0_0_8px_rgba(88,214,141,0.1)]" />
                      <h2 className="text-xl font-medium">송출자와 연결 중</h2>
                      <p className="mt-2 text-sm text-white/45">직접 연결 경로를 찾고 있어요</p>
                    </div>
                  </div>
                )}
                {remoteStream && viewerVideoReady && <LaserOverlay ratio={viewerAspectRatio || 16 / 9} strokes={laserStrokes} onSend={sendLaserStroke} />}
                {isViewerFullscreen && showViewerControls && <div className="absolute inset-x-3 bottom-20 z-20 mx-auto max-h-[60dvh] max-w-2xl overflow-y-auto"><VoiceControls voice={voice} host={false} /></div>}
                {isViewerFullscreen && <button type="button" aria-label="영상 메뉴 열기" onClick={revealViewerControls} className="absolute bottom-2 right-4 z-10 h-11 w-11 rounded-full bg-black/35 text-xl text-white">···</button>}
                {(!isViewerFullscreen || showViewerControls) && (
                  <div className="absolute inset-x-0 top-0 flex items-center justify-between p-4 sm:p-5">
                    <span className="rounded-full border border-white/10 bg-black/35 px-3 py-1.5 text-xs font-medium text-white/80 backdrop-blur-md">{status === 'connected' ? 'LIVE' : 'CONNECTING'}</span>
                    <div className="flex items-center gap-2">
                      {remoteStream && viewerPipSupported && (
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => void toggleViewerPictureInPicture()}
                          aria-label={isViewerPip ? 'PiP 종료' : 'PiP로 보기'}
                          aria-pressed={isViewerPip}
                          className="rounded-full border border-white/10 bg-black/35 text-white/80 hover:bg-black/55 hover:text-white"
                        >
                          <PictureInPicture />
                        </Button>
                      )}
                      {remoteStream && (
                        <Button variant="ghost" size="icon" onClick={() => void toggleViewerFullscreen()} aria-label={isViewerFullscreen ? '전체화면 종료' : '전체화면 보기'} className="rounded-full border border-white/10 bg-black/35 text-white/80 hover:bg-black/55 hover:text-white">
                          {isViewerFullscreen ? <Minimize2 /> : <Maximize2 />}
                        </Button>
                      )}
                      <Button variant="ghost" size="sm" onClick={() => void (async () => { await exitViewerPictureInPicture(); await leave(); setJoinValue(''); window.history.replaceState(null, '', '/'); })()} className="rounded-full border border-white/10 bg-black/35 px-3 text-white/80 hover:bg-black/55 hover:text-white"><LogOut /> 나가기</Button>
                    </div>
                  </div>
                )}
                {viewerPipError && (!isViewerFullscreen || showViewerControls) && (
                  <p role="alert" className="absolute inset-x-4 bottom-5 rounded-full bg-black/60 px-4 py-2 text-center text-xs text-white/80 backdrop-blur-md">{viewerPipError}</p>
                )}
                {playbackBlocked && (!isViewerFullscreen || showViewerControls) && (
                  <div className="absolute inset-x-0 bottom-6 flex justify-center">
                    <Button onClick={() => {
                      const video = viewerVideoRef.current;
                      if (!video) return;
                      video.muted = false;
                      void video.play().then(() => setPlaybackBlocked(false)).catch(() => setPlaybackBlocked(true));
                    }} className="h-11 rounded-full bg-white px-5 text-[#0b0d0f] hover:bg-white/90"><Volume2 /> 소리와 함께 재생</Button>
                  </div>
                )}
              </section>
            ) : (
              <div className="grid min-h-[min(520px,calc(100dvh-170px))] place-items-center rounded-2xl border border-border bg-card px-4 py-10 sm:min-h-[min(680px,calc(100dvh-190px))] sm:rounded-[28px] sm:px-5 sm:py-12">
                <div className="w-full max-w-md text-center">
                  <span className="mx-auto grid size-14 place-items-center rounded-full bg-muted text-foreground"><Link2 className="size-5" /></span>
                  <h2 className="mt-6 text-2xl font-semibold tracking-[-0.04em]">송출에 참가하기</h2>
                  <p className="mt-2 text-sm leading-6 text-muted-foreground">받은 링크 또는 방 코드를 입력하세요</p>
                  <div className="mt-7 flex flex-col gap-3 sm:flex-row sm:gap-2">
                    <Input value={joinValue} onChange={(event) => setJoinValue(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void connectViewer(joinValue); }} placeholder="링크 또는 방 코드" aria-label="링크 또는 방 코드" className="h-12 rounded-full px-5" />
                    <Button size="lg" onClick={() => void connectViewer(joinValue)} disabled={!joinValue.trim() || status === 'connecting'} className="h-12 w-full rounded-full px-5 sm:w-auto">참가</Button>
                  </div>
                  {connectionError && <p role="alert" className="mt-5 text-sm text-destructive">{connectionError}</p>}
                </div>
              </div>
            )}
          </TabsContent>
        </Tabs>
        {activeRoom && !isHostFullscreen && !isViewerFullscreen && (
          <div className="mt-4">
            <VoiceControls voice={voice} host={mode === 'host'} />
          </div>
        )}
      </section>
    </main>
  );
}
