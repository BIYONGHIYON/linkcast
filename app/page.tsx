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
  Radio,
  RefreshCw,
  Users,
  Video,
  Volume2,
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

function normalizeRoomValue(value: string) {
  const match = value.match(/[?&]room=([^&]+)/);
  return (match ? decodeURIComponent(match[1]) : value).trim();
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
  const viewerStageRef = useRef<HTMLElement>(null);
  const viewerControlsTimerRef = useRef<number | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const autoJoinRef = useRef('');
  const [mode, setMode] = useState<'host' | 'viewer'>('host');
  const [videoDevices, setVideoDevices] = useState<DeviceOption[]>([]);
  const [audioDevices, setAudioDevices] = useState<DeviceOption[]>([]);
  const [selectedDevice, setSelectedDevice] = useState('');
  const [selectedAudio, setSelectedAudio] = useState('');
  const [captureInfo, setCaptureInfo] = useState<CaptureInfo>({});
  const [isPreviewing, setIsPreviewing] = useState(false);
  const [joinValue, setJoinValue] = useState('');
  const [copied, setCopied] = useState(false);
  const [captureError, setCaptureError] = useState('');
  const [playbackBlocked, setPlaybackBlocked] = useState(false);
  const [isViewerFullscreen, setIsViewerFullscreen] = useState(false);
  const [showViewerControls, setShowViewerControls] = useState(true);

  const {
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
    return `${window.location.origin}/?room=${roomId}&mode=viewer`;
  }, [roomId]);

  const stopPreview = useCallback(() => {
    void leave();
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (previewVideoRef.current) previewVideoRef.current.srcObject = null;
    setIsPreviewing(false);
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
          audio: audioDeviceId
            ? { deviceId: { exact: audioDeviceId }, echoCancellation: false }
            : true,
        });
        streamRef.current = stream;
        if (previewVideoRef.current) {
          previewVideoRef.current.srcObject = stream;
          await previewVideoRef.current.play();
        }
        const videoSettings = stream.getVideoTracks()[0]?.getSettings();
        const audioSettings = stream.getAudioTracks()[0]?.getSettings();
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
      setJoinValue(normalized);
      setMode('viewer');
      window.history.replaceState(
        null,
        '',
        `/?room=${encodeURIComponent(normalized)}&mode=viewer`,
      );
      return joinRoom(normalized);
    },
    [joinRoom],
  );

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const requestedRoom = params.get('room') || '';
    if (requestedRoom && autoJoinRef.current !== requestedRoom) {
      autoJoinRef.current = requestedRoom;
      window.setTimeout(() => void connectViewer(requestedRoom), 0);
    }
    window.setTimeout(() => void refreshDevices(), 0);
    return () => {
      streamRef.current?.getTracks().forEach((track) => track.stop());
    };
  }, [connectViewer, refreshDevices]);

  useEffect(() => {
    if (!viewerVideoRef.current || !remoteStream) return;
    viewerVideoRef.current.srcObject = remoteStream;
    void viewerVideoRef.current
      .play()
      .then(() => setPlaybackBlocked(false))
      .catch(() => setPlaybackBlocked(true));
  }, [remoteStream]);

  const createShareLink = useCallback(async () => {
    if (!streamRef.current) return null;
    const createdRoomId = await createRoom(streamRef.current);
    setCopied(false);
    return createdRoomId;
  }, [createRoom]);

  const copyLink = async () => {
    if (!shareUrl) return;
    await navigator.clipboard.writeText(shareUrl);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  };

  const changeMode = (nextMode: 'host' | 'viewer') => {
    if (nextMode === mode) return;
    void leave();
    setMode(nextMode);
    setJoinValue('');
    setPlaybackBlocked(false);
    window.history.replaceState(null, '', '/');
  };

  const toggleViewerFullscreen = useCallback(async () => {
    if (!viewerStageRef.current) return;
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else {
        setShowViewerControls(false);
        await viewerStageRef.current.requestFullscreen();
      }
    } catch {
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
    const handleFullscreenChange = () => {
      const fullscreen = document.fullscreenElement === viewerStageRef.current;
      setIsViewerFullscreen(fullscreen);
      setShowViewerControls(!fullscreen);
      if (viewerControlsTimerRef.current) window.clearTimeout(viewerControlsTimerRef.current);
    };
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => {
      document.removeEventListener('fullscreenchange', handleFullscreenChange);
      if (viewerControlsTimerRef.current) window.clearTimeout(viewerControlsTimerRef.current);
    };
  }, []);

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
              shareUrl: `${window.location.origin}/?room=${createdRoomId}&mode=viewer`,
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
      : '1920 × 1080 요청';
  const frameRate = captureInfo.frameRate
    ? `${Math.round(captureInfo.frameRate)} fps`
    : '60 fps 요청';
  const activeRoom = Boolean(roomId && status !== 'idle');

  return (
    <main className="min-h-dvh bg-background text-foreground">
      <header className="mx-auto flex h-20 max-w-[1480px] items-center justify-between px-5 sm:px-8 lg:px-12">
        <div className="flex items-center gap-2.5" aria-label="Linkcast">
          <span className="grid size-8 place-items-center rounded-full bg-foreground text-background">
            <Radio className="size-4" strokeWidth={2.2} />
          </span>
          <span className="text-lg font-semibold tracking-[-0.035em]">Linkcast</span>
        </div>
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <span className={`size-2 rounded-full ${status === 'connected' ? 'bg-[#58d68d] shadow-[0_0_0_4px_rgba(88,214,141,0.12)]' : 'bg-border'}`} />
          {statusLabel(status)}
        </div>
      </header>

      <section className="mx-auto max-w-[1480px] px-5 pb-6 sm:px-8 sm:pb-8 lg:px-12">
        <Tabs value={mode} onValueChange={(value) => changeMode(value as 'host' | 'viewer')} className="gap-6">
          <div className="flex items-end justify-between gap-4 border-b border-border pb-4">
            <div>
              <p className="mb-1 text-sm text-muted-foreground">1080p · 60fps · WebRTC</p>
              <h1 className="text-2xl font-semibold tracking-[-0.04em] sm:text-3xl">지연 없이, 링크 하나로.</h1>
            </div>
            <TabsList className="h-10 rounded-full bg-muted/80 p-1">
              <TabsTrigger value="host" className="h-8 rounded-full px-4">송출</TabsTrigger>
              <TabsTrigger value="viewer" className="h-8 rounded-full px-4">참가</TabsTrigger>
            </TabsList>
          </div>

          <TabsContent value="host">
            <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_340px]">
              <section className="relative aspect-video min-h-[280px] overflow-hidden rounded-[28px] bg-[#0b0d0f] shadow-[0_24px_80px_rgba(8,11,14,0.16)]">
                <video ref={previewVideoRef} muted playsInline className={`h-full w-full object-contain transition-opacity duration-300 ${isPreviewing ? 'opacity-100' : 'opacity-0'}`} />

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

                <div className="pointer-events-none absolute inset-x-0 top-0 flex items-center justify-between p-4 sm:p-5">
                  <span className="rounded-full border border-white/10 bg-black/35 px-3 py-1.5 text-xs font-medium text-white/80 backdrop-blur-md">
                    {activeRoom ? 'ON AIR' : isPreviewing ? 'PREVIEW' : 'NO SIGNAL'}
                  </span>
                  {isPreviewing && (
                    <span className="flex items-center gap-2 rounded-full border border-white/10 bg-black/35 px-3 py-1.5 text-xs font-medium text-white/80 backdrop-blur-md">
                      <span className={`size-1.5 rounded-full ${activeRoom ? 'animate-pulse bg-red-500' : 'bg-[#58d68d]'}`} />
                      {resolution} · {frameRate}
                    </span>
                  )}
                </div>
              </section>

              <aside className="flex flex-col rounded-[28px] border border-border bg-card p-5 sm:p-6">
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
                      <SelectTrigger id="video-device" className="h-11 w-full rounded-xl px-3"><SelectValue placeholder="캡처보드를 선택하세요" /></SelectTrigger>
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
                      <SelectTrigger id="audio-device" className="h-11 w-full rounded-xl px-3"><Volume2 className="size-4 text-muted-foreground" /><SelectValue placeholder="오디오 입력을 선택하세요" /></SelectTrigger>
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
                      <Link2 data-icon="inline-start" /> {status === 'creating' ? '방 만드는 중' : '송출 링크 만들기'}
                    </Button>
                  ) : (
                    <div className="space-y-3">
                      <div className="flex items-center gap-2 rounded-2xl border border-border bg-muted/40 p-2 pl-3">
                        <p className="min-w-0 flex-1 truncate text-sm text-muted-foreground">{shareUrl}</p>
                        <Button size="icon" variant="outline" onClick={() => void copyLink()} aria-label="송출 링크 복사" className="shrink-0 rounded-xl">{copied ? <Check /> : <Copy />}</Button>
                      </div>
                      <div className="flex items-center justify-between text-xs text-muted-foreground">
                        <span className="flex items-center gap-2"><Users className="size-3.5" /> {viewerCount}/2명 연결</span>
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
              <section ref={viewerStageRef} onPointerDown={revealViewerControls} className={`group relative overflow-hidden bg-[#0b0d0f] shadow-[0_24px_80px_rgba(8,11,14,0.16)] ${isViewerFullscreen ? 'h-dvh w-screen rounded-none' : 'aspect-video min-h-[300px] rounded-[28px]'}`}>
                <video ref={viewerVideoRef} autoPlay playsInline onDoubleClick={() => void toggleViewerFullscreen()} className={`h-full w-full object-contain transition-opacity duration-300 ${remoteStream ? 'opacity-100' : 'opacity-0'} ${remoteStream ? 'cursor-zoom-in' : ''}`}>
                  <track kind="captions" srcLang="ko" label="한국어" src="/captions-empty.vtt" />
                </video>
                {!remoteStream && (
                  <div className="absolute inset-0 grid place-items-center text-center text-white">
                    <div>
                      <span className="mx-auto mb-5 block size-3 animate-pulse rounded-full bg-[#58d68d] shadow-[0_0_0_8px_rgba(88,214,141,0.1)]" />
                      <h2 className="text-xl font-medium">송출자와 연결 중</h2>
                      <p className="mt-2 text-sm text-white/45">직접 연결 경로를 찾고 있어요</p>
                    </div>
                  </div>
                )}
                {(!isViewerFullscreen || showViewerControls) && (
                  <div className="absolute inset-x-0 top-0 flex items-center justify-between p-4 sm:p-5">
                    <span className="rounded-full border border-white/10 bg-black/35 px-3 py-1.5 text-xs font-medium text-white/80 backdrop-blur-md">{status === 'connected' ? 'LIVE' : 'CONNECTING'}</span>
                    <div className="flex items-center gap-2">
                      {remoteStream && (
                        <Button variant="ghost" size="icon" onClick={() => void toggleViewerFullscreen()} aria-label={isViewerFullscreen ? '전체화면 종료' : '전체화면 보기'} className="rounded-full border border-white/10 bg-black/35 text-white/80 hover:bg-black/55 hover:text-white">
                          {isViewerFullscreen ? <Minimize2 /> : <Maximize2 />}
                        </Button>
                      )}
                      <Button variant="ghost" size="sm" onClick={() => { void leave(); setJoinValue(''); window.history.replaceState(null, '', '/'); }} className="rounded-full border border-white/10 bg-black/35 px-3 text-white/80 hover:bg-black/55 hover:text-white"><LogOut /> 나가기</Button>
                    </div>
                  </div>
                )}
                {playbackBlocked && (!isViewerFullscreen || showViewerControls) && (
                  <div className="absolute inset-x-0 bottom-6 flex justify-center">
                    <Button onClick={() => void viewerVideoRef.current?.play().then(() => setPlaybackBlocked(false))} className="h-11 rounded-full bg-white px-5 text-[#0b0d0f] hover:bg-white/90"><Volume2 /> 소리와 함께 재생</Button>
                  </div>
                )}
              </section>
            ) : (
              <div className="grid min-h-[min(680px,calc(100dvh-190px))] place-items-center rounded-[28px] border border-border bg-card px-5 py-12">
                <div className="w-full max-w-md text-center">
                  <span className="mx-auto grid size-14 place-items-center rounded-full bg-muted text-foreground"><Link2 className="size-5" /></span>
                  <h2 className="mt-6 text-2xl font-semibold tracking-[-0.04em]">송출에 참가하기</h2>
                  <p className="mt-2 text-sm leading-6 text-muted-foreground">받은 링크 또는 방 코드를 입력하세요</p>
                  <div className="mt-7 flex gap-2">
                    <Input value={joinValue} onChange={(event) => setJoinValue(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void connectViewer(joinValue); }} placeholder="링크 또는 방 코드" aria-label="링크 또는 방 코드" className="h-12 rounded-full px-5" />
                    <Button size="lg" onClick={() => void connectViewer(joinValue)} disabled={!joinValue.trim() || status === 'connecting'} className="h-12 rounded-full px-5">참가</Button>
                  </div>
                  {connectionError && <p role="alert" className="mt-5 text-sm text-destructive">{connectionError}</p>}
                </div>
              </div>
            )}
          </TabsContent>
        </Tabs>
      </section>
    </main>
  );
}
