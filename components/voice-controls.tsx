'use client';
import { useSyncExternalStore } from 'react';
import { Mic, MicOff, Phone, PhoneOff, SlidersHorizontal } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/select';
import type { useVoiceChat } from '@/hooks/use-voice-chat';
import type { CallParticipant } from '@/hooks/use-call-presence';

const emptyLevel = () => 0;
function VoiceMeter({ voice }: { voice: ReturnType<typeof useVoiceChat> }) {
  const level = useSyncExternalStore(voice.subscribeLevel, voice.getLevel, emptyLevel);
  return <meter aria-label="마이크 입력 크기" min={0} max={100}
    value={voice.muted ? 0 : level} className="h-2 w-full" />;
}

export function VoiceControls({
  voice,
  host,
}: {
  voice: ReturnType<typeof useVoiceChat> & { participants: CallParticipant[] };
  host: boolean;
}) {
  const id = host ? 'host-call' : 'viewer-call';
  return (
    <div className="rounded-2xl border border-border bg-card p-4 text-foreground shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span
            className={`grid size-10 place-items-center rounded-full ${voice.speaking ? 'bg-green-500/15 text-green-600' : 'bg-muted text-muted-foreground'}`}
          >
            <Mic className="size-4" />
          </span>
          <div>
            <p className="text-sm font-medium">음성 통화</p>
            <p className="text-xs text-muted-foreground">
              {voice.enabled
                ? voice.muted
                  ? '마이크 꺼짐'
                  : voice.speaking
                    ? '말하는 중'
                    : '마이크 켜짐'
                : host
                  ? '수신자와 마이크로 대화'
                  : '송출자와 마이크로 대화'}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {voice.enabled ? (
            <>
              <Button
                variant="outline"
                size="icon"
                aria-label={voice.muted ? '마이크 켜기' : '마이크 끄기'}
                aria-pressed={voice.muted}
                onClick={voice.toggleMute}
              >
                {voice.muted ? <MicOff /> : <Mic />}
              </Button>
              <Button variant="outline" onClick={voice.stop}>
                <PhoneOff /> 종료
              </Button>
            </>
          ) : (
            <Button disabled={voice.busy} onClick={() => void voice.start()}>
              <Phone /> {voice.busy ? '연결 중' : '통화 시작'}
            </Button>
          )}
        </div>
      </div>
      <div className="mt-3 flex flex-wrap gap-2" aria-label="통화 참가자">
        {[{ id: 'self', label: '나', enabled: voice.enabled, muted: voice.muted, speaking: voice.speaking }, ...voice.participants].map(person => (
          <span key={person.id} className={`inline-flex items-center gap-2 rounded-full border px-3 py-2 text-xs ${person.enabled && person.speaking && !person.muted ? 'border-green-500/50 bg-green-500/10' : 'border-border bg-muted/30'}`}>
            {person.muted ? <MicOff className="size-3" /> : <span className={`size-1.5 rounded-full ${person.enabled ? 'bg-green-500' : 'bg-muted-foreground/40'}`} />}
            {person.label}<span className="text-muted-foreground">{!person.enabled ? '미참여' : person.muted ? '음소거' : person.speaking ? '말하는 중' : '참여 중'}</span>
          </span>
        ))}
      </div>
      {voice.error && (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {voice.error}
        </p>
      )}
      {voice.enabled && voice.playbackBlocked && <Button variant="outline" onClick={() => void voice.resumePlayback()} className="mt-3 w-full">통화 소리 재생</Button>}
      <details className="mt-3 border-t border-border pt-3">
        <summary className="cursor-pointer text-sm text-muted-foreground">
          <SlidersHorizontal className="mr-2 inline size-3.5" />
          통화 설정
        </summary>
        <div className="mt-4 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          <div className="space-y-3">
            <label id={`${id}-volume`} className="flex justify-between text-sm">
              통화 음량{' '}
              <span className="text-muted-foreground">{voice.volume}%</span>
            </label>
            <Slider
              aria-labelledby={`${id}-volume`}
              value={[voice.volume]}
              min={0}
              max={450}
              onValueChange={(v) =>
                voice.setVolume(Array.isArray(v) ? v[0] : v)
              }
            />
          </div>
          <div className="space-y-3">
            <label
              id={`${id}-sensitivity`}
              className="flex justify-between text-sm"
            >
              마이크 민감도{' '}
              <span className="text-muted-foreground">
                {voice.sensitivity}%
              </span>
            </label>
            <Slider
              aria-labelledby={`${id}-sensitivity`}
              value={[voice.sensitivity]}
              min={0}
              max={100}
              onValueChange={(v) =>
                voice.setSensitivity(Array.isArray(v) ? v[0] : v)
              }
            />
            <p className="text-xs text-muted-foreground">
              높을수록 작은 목소리도 말하는 중으로 표시해요
            </p>
            <VoiceMeter voice={voice} />
          </div>
          <div className="space-y-2">
            <p id={`${id}-device`} className="text-sm">
              마이크 장치
            </p>
            <Select
              value={voice.device || 'default'}
              onValueChange={(v) =>
                voice.setDevice(v === 'default' ? '' : String(v))
              }
              disabled={voice.enabled || voice.busy}
            >
              <SelectTrigger
                aria-labelledby={`${id}-device`}
                className="w-full"
              >
                <SelectValue>{voice.device ? voice.devices.find(d => d.deviceId === voice.device)?.label || '선택한 마이크' : '시스템 기본 마이크'}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="default">시스템 기본 마이크</SelectItem>
                {voice.devices
                  .filter((d) => d.deviceId && d.deviceId !== 'default')
                  .map((d, i) => (
                    <SelectItem key={d.deviceId} value={d.deviceId}>
                      {d.label || `마이크 ${i + 1}`}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              장치 변경은 통화 종료 후 가능해요
            </p>
          </div>
        </div>
        <p className="mt-4 text-xs text-muted-foreground">
          양쪽에서 통화 시작을 눌러주세요.
          이어폰을 사용하면 소리 울림을 줄일 수 있어요.
        </p>
      </details>
    </div>
  );
}
