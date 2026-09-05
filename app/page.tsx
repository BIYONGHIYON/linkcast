'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Check,
  Copy,
  Link2,
  MonitorUp,
  Radio,
  RefreshCw,
  Users,
  Video,
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

const captureConstraints: MediaStreamConstraints = {
  video: {
    width: { ideal: 1920 },
    height: { ideal: 1080 },
    frameRate: { ideal: 60, max: 60 },
  },
  audio: true,
};

function createRoomId() {
  return crypto.randomUUID().replaceAll('-', '').slice(0, 10);
}

export default function Home() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [mode, setMode] = useState<'host' | 'viewer'>('host');
  const [videoDevices, setVideoDevices] = useState<DeviceOption[]>([]);
  const [selectedDevice, setSelectedDevice] = useState('');
  const [captureInfo, setCaptureInfo] = useState<CaptureInfo>({});
  const [isPreviewing, setIsPreviewing] = useState(false);
  const [roomId, setRoomId] = useState('');
  const [joinValue, setJoinValue] = useState('');
  const [waitingForHost, setWaitingForHost] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');

  const shareUrl = useMemo(() => {
    if (!roomId || typeof window === 'undefined') return '';
    return `${window.location.origin}/?room=${roomId}&mode=viewer`;
  }, [roomId]);

  const stopPreview = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setIsPreviewing(false);
    setCaptureInfo({});
  }, []);

  const refreshDevices = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    const devices = await navigator.mediaDevices.enumerateDevices();
    const cameras = devices
      .filter((device) => device.kind === 'videoinput')
      .map((device, index) => ({
        deviceId: device.deviceId,
        label: device.label || `영상 입력 ${index + 1}`,
      }));
    setVideoDevices(cameras);
    setSelectedDevice((current) => current || cameras[0]?.deviceId || '');
  }, []);

  const startPreview = useCallback(
    async (deviceId?: string) => {
      setError('');
      stopPreview();

      try {
        const constraints: MediaStreamConstraints = {
          ...captureConstraints,
          video: {
            ...(captureConstraints.video as MediaTrackConstraints),
            ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
          },
        };
        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
        }
        const settings = stream.getVideoTracks()[0]?.getSettings();
        setCaptureInfo({
          width: settings?.width,
          height: settings?.height,
          frameRate: settings?.frameRate,
        });
        setSelectedDevice(settings?.deviceId || deviceId || '');
        setIsPreviewing(true);
        await refreshDevices();
      } catch (reason) {
        const message =
          reason instanceof DOMException && reason.name === 'NotAllowedError'
            ? '카메라 권한을 허용해야 캡처보드를 연결할 수 있어요.'
            : '캡처보드를 찾지 못했어요. 연결 상태를 확인해 주세요.';
        setError(message);
      }
    },
    [refreshDevices, stopPreview],
  );

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('mode') === 'viewer' || params.get('room')) {
      window.setTimeout(() => {
        setMode('viewer');
        setJoinValue(params.get('room') || '');
        setWaitingForHost(params.has('room'));
      }, 0);
    }
    window.setTimeout(() => void refreshDevices(), 0);
    return stopPreview;
  }, [refreshDevices, stopPreview]);

  const createLink = () => {
    setRoomId(createRoomId());
    setCopied(false);
  };

  const copyLink = async () => {
    if (!shareUrl) return;
    await navigator.clipboard.writeText(shareUrl);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  };

  const joinRoom = () => {
    const match = joinValue.match(/[?&]room=([^&]+)/);
    const normalized = match ? decodeURIComponent(match[1]) : joinValue.trim();
    if (!normalized) return;
    window.history.replaceState(null, '', `/?room=${normalized}&mode=viewer`);
    setJoinValue(normalized);
    setWaitingForHost(true);
  };

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
          description: '연결된 캡처보드로 새 Linkcast 송출 링크를 만듭니다.',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
          annotations: { readOnlyHint: false, untrustedContentHint: false },
          execute: () => {
            if (!isPreviewing) throw new Error('캡처보드를 먼저 연결해 주세요.');
            const id = createRoomId();
            const url = `${window.location.origin}/?room=${id}&mode=viewer`;
            setRoomId(id);
            setCopied(false);
            return { roomId: id, shareUrl: url };
          },
        },
        { signal: lifecycle.signal },
      );
      await context.registerTool(
        {
          name: 'join_linkcast_room',
          title: '송출에 참가하기',
          description: '방 코드로 Linkcast 시청 화면을 엽니다.',
          inputSchema: {
            type: 'object',
            properties: { roomId: { type: 'string', minLength: 1 } },
            required: ['roomId'],
            additionalProperties: false,
          },
          annotations: { readOnlyHint: false, untrustedContentHint: true },
          execute: (input) => {
            const room =
              typeof input === 'object' && input !== null && 'roomId' in input
                ? String(input.roomId).trim()
                : '';
            if (!room) throw new Error('유효한 방 코드가 필요합니다.');
            setMode('viewer');
            setJoinValue(room);
            setWaitingForHost(true);
            window.history.replaceState(null, '', `/?room=${encodeURIComponent(room)}&mode=viewer`);
            return { roomId: room, status: 'waiting_for_host' };
          },
        },
        { signal: lifecycle.signal },
      );
    };
    void register().catch(() => undefined);
    return () => lifecycle.abort();
  }, [isPreviewing]);

  const resolution =
    captureInfo.width && captureInfo.height
      ? `${captureInfo.width} × ${captureInfo.height}`
      : '1920 × 1080 요청';
  const frameRate = captureInfo.frameRate
    ? `${Math.round(captureInfo.frameRate)} fps`
    : '60 fps 요청';
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
          <span className="size-2 rounded-full bg-[#58d68d] shadow-[0_0_0_4px_rgba(88,214,141,0.12)]" />
          직접 연결
        </div>
      </header>

      <section className="mx-auto max-w-[1480px] px-5 pb-6 sm:px-8 sm:pb-8 lg:px-12">
        <Tabs value={mode} onValueChange={(value) => setMode(value as 'host' | 'viewer')} className="gap-6">
          <div className="flex items-end justify-between gap-4 border-b border-border pb-4">
            <div>
              <p className="mb-1 text-sm text-muted-foreground">1080p · 60fps · WebRTC</p>
              <h1 className="text-2xl font-semibold tracking-[-0.04em] sm:text-3xl">
                지연 없이, 링크 하나로.
              </h1>
            </div>
            <TabsList className="h-10 rounded-full bg-muted/80 p-1">
              <TabsTrigger value="host" className="h-8 rounded-full px-4">송출</TabsTrigger>
              <TabsTrigger value="viewer" className="h-8 rounded-full px-4">참가</TabsTrigger>
            </TabsList>
          </div>

          <TabsContent value="host">
            <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_340px]">
              <section className="relative aspect-video min-h-[280px] overflow-hidden rounded-[28px] bg-[#0b0d0f] shadow-[0_24px_80px_rgba(8,11,14,0.16)]">
                <video
                  ref={videoRef}
                  muted
                  playsInline
                  className={`h-full w-full object-contain transition-opacity duration-300 ${isPreviewing ? 'opacity-100' : 'opacity-0'}`}
                />

                {!isPreviewing && (
                  <div className="absolute inset-0 grid place-items-center px-6 text-center">
                    <div>
                      <span className="mx-auto mb-5 grid size-14 place-items-center rounded-full border border-white/10 bg-white/[0.06] text-white">
                        <Video className="size-5" />
                      </span>
                      <h2 className="text-xl font-medium tracking-[-0.025em] text-white">캡처보드를 연결하세요</h2>
                      <p className="mt-2 text-sm text-white/45">브라우저에서 영상 입력 권한을 허용해 주세요</p>
                      <Button
                        size="lg"
                        onClick={() => void startPreview(selectedDevice)}
                        className="mt-6 h-11 rounded-full bg-white px-5 text-[#0b0d0f] hover:bg-white/90"
                      >
                        <MonitorUp data-icon="inline-start" />
                        캡처보드 연결
                      </Button>
                    </div>
                  </div>
                )}

                <div className="pointer-events-none absolute inset-x-0 top-0 flex items-center justify-between p-4 sm:p-5">
                  <span className="rounded-full border border-white/10 bg-black/35 px-3 py-1.5 text-xs font-medium text-white/80 backdrop-blur-md">
                    {isPreviewing ? 'PREVIEW' : 'NO SIGNAL'}
                  </span>
                  {isPreviewing && (
                    <span className="flex items-center gap-2 rounded-full border border-white/10 bg-black/35 px-3 py-1.5 text-xs font-medium text-white/80 backdrop-blur-md">
                      <span className="size-1.5 rounded-full bg-[#58d68d]" />
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
                  <Button variant="ghost" size="icon" aria-label="영상 입력 장치 새로고침" onClick={() => void refreshDevices()} className="rounded-full">
                    <RefreshCw />
                  </Button>
                </div>

                <div className="mt-7 space-y-5">
                  <div className="space-y-2">
                    <Label htmlFor="video-device">장치</Label>
                    <Select
                      value={selectedDevice}
                      onValueChange={(value) => {
                        setSelectedDevice(value as string);
                        if (isPreviewing) void startPreview(value as string);
                      }}
                    >
                      <SelectTrigger id="video-device" className="h-11 w-full rounded-xl px-3">
                        <SelectValue placeholder="캡처보드를 선택하세요" />
                      </SelectTrigger>
                      <SelectContent>
                        {videoDevices.length ? videoDevices.map((device) => (
                          <SelectItem key={device.deviceId} value={device.deviceId}>{device.label}</SelectItem>
                        )) : (
                          <SelectItem value="none" disabled>연결된 장치 없음</SelectItem>
                        )}
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div className="rounded-2xl bg-muted/65 p-4">
                      <p className="text-xs text-muted-foreground">해상도</p>
                      <p className="mt-1 text-sm font-medium">{resolution}</p>
                    </div>
                    <div className="rounded-2xl bg-muted/65 p-4">
                      <p className="text-xs text-muted-foreground">프레임</p>
                      <p className="mt-1 text-sm font-medium">{frameRate}</p>
                    </div>
                  </div>
                </div>

                {error && <p role="alert" className="mt-4 text-sm leading-6 text-destructive">{error}</p>}

                <div className="mt-auto border-t border-border pt-6">
                  {!shareUrl ? (
                    <Button size="lg" disabled={!isPreviewing} onClick={createLink} className="h-12 w-full rounded-full text-base">
                      <Link2 data-icon="inline-start" />
                      송출 링크 만들기
                    </Button>
                  ) : (
                    <div className="space-y-3">
                      <div className="flex items-center gap-2 rounded-2xl border border-border bg-muted/40 p-2 pl-3">
                        <p className="min-w-0 flex-1 truncate text-sm text-muted-foreground">{shareUrl}</p>
                        <Button size="icon" variant="outline" onClick={() => void copyLink()} aria-label="송출 링크 복사" className="shrink-0 rounded-xl">
                          {copied ? <Check /> : <Copy />}
                        </Button>
                      </div>
                      <p className="flex items-center justify-center gap-2 text-xs text-muted-foreground">
                        <Users className="size-3.5" /> 최대 2명 직접 연결
                      </p>
                    </div>
                  )}
                </div>
              </aside>
            </div>
          </TabsContent>

          <TabsContent value="viewer">
            <div className="grid min-h-[min(680px,calc(100dvh-190px))] place-items-center rounded-[28px] border border-border bg-card px-5 py-12">
              <div className="w-full max-w-md text-center">
                <span className="mx-auto grid size-14 place-items-center rounded-full bg-muted text-foreground"><Link2 className="size-5" /></span>
                <h2 className="mt-6 text-2xl font-semibold tracking-[-0.04em]">송출에 참가하기</h2>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">받은 링크 또는 방 코드를 입력하세요</p>
                <div className="mt-7 flex gap-2">
                  <Input
                    value={joinValue}
                    onChange={(event) => setJoinValue(event.target.value)}
                    onKeyDown={(event) => { if (event.key === 'Enter') joinRoom(); }}
                    placeholder="링크 또는 방 코드"
                    aria-label="링크 또는 방 코드"
                    className="h-12 rounded-full px-5"
                  />
                  <Button size="lg" onClick={joinRoom} disabled={!joinValue.trim()} className="h-12 rounded-full px-5">참가</Button>
                </div>
                {waitingForHost && (
                  <p className="mt-5 flex items-center justify-center gap-2 text-sm text-muted-foreground">
                    <span className="size-2 animate-pulse rounded-full bg-[#f0b429]" />
                    송출자 연결을 기다리는 중
                  </p>
                )}
              </div>
            </div>
          </TabsContent>
        </Tabs>
      </section>
    </main>
  );
}
