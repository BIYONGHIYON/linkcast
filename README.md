# Linkcast

캡처보드로 입력한 콘솔·PC 게임 화면을 링크 하나로 실시간 공유하는 소규모 WebRTC 스트리밍 서비스입니다.
Nintendo Switch와 Nintendo Switch 2 같은 콘솔 플레이를 친구에게 보여주거나, 게임 화면을 함께 보며 음성으로 대화하는 용도에 적합합니다.

[Linkcast 바로 열기](https://linkcast.byeonghyeon383.workers.dev/)

## 이런 상황에 적합합니다

- Nintendo Switch 등 콘솔 게임 화면을 실시간으로 공유할 때
- 친구와 플레이를 함께 보며 음성으로 대화할 때
- 게임 공략, 원격 도움, 화면 확인이 필요할 때
- 복잡한 방송 설정 없이 링크 하나로 빠르게 공유할 때

Linkcast는 녹화 영상을 서버에 올려 재생하는 서비스가 아닙니다. 송출자와 참가자의 브라우저를 직접 연결해 소규모 실시간 공유에 집중합니다.

## 사용 방법

### 송출자

1. 콘솔과 컴퓨터를 호환되는 캡처보드로 연결합니다.
2. Linkcast에서 캡처보드의 영상 장치와 오디오 장치를 선택합니다.
3. **링크 만들고 복사**를 누릅니다.
4. 자동으로 복사된 참가 링크를 공유하거나, 참가 코드만 따로 공유합니다.

### 참가자

1. 받은 링크를 열거나 Linkcast의 **참가** 화면에 코드를 입력합니다.
2. 연결되면 영상 음량, PiP, 전체화면 기능을 사용할 수 있습니다.
3. 음성 대화가 필요하면 방에 있는 각 사용자가 **통화 시작**을 누릅니다.

## 주요 기능

- 캡처보드에 1920 × 1080, 최대 60fps 입력 요청
- 비트레이트 상한 없이 해상도 유지에 우선순위를 둔 WebRTC 전송
- 원본 영상 비율을 유지하는 송출자 화면과 참가자 전체화면
- 공유 링크와 참가 코드 자동 복사
- 한 방당 최대 5명의 참가자 연결
- 캡처보드 음성과 분리된 방 전체 음성 대화
- 통화 음량, 마이크 민감도, 마이크 장치와 말하는 중 표시
- 참가자의 영상 음량 조절, PiP, 전체화면
- 클릭·터치 드래그 위치를 공유하는 포인터
- 포인터 자취 중첩과 자연스러운 사라짐 효과
- 데스크톱과 모바일에 맞춘 반응형 화면
- 선택한 영상·오디오·마이크 장치와 음량 설정 저장
- 연결 끊김 감지, 자동 재연결, 비정상 종료 인원 정리

## 연결 구조

영상, 캡처보드 음성, 마이크 음성은 WebRTC P2P로 전달됩니다. Cloudflare Durable Object는 방 입장, 참가 인원, WebRTC 연결 신호만 WebSocket으로 관리합니다.

```text
송출자 ── WebRTC 영상·캡처보드 음성 ── 참가자 1~5명
  │                    │
  └──── WebRTC 방 음성 네트워크 ────┘

모든 사용자 ── WebSocket 연결 신호 ── Cloudflare Durable Object
```

참가자끼리의 마이크 음성도 오디오 전용 P2P 연결로 전달됩니다. 주기적인 HTTP 조회나 D1 기반 시그널링은 사용하지 않습니다.

## 영상 품질 정책

Linkcast는 캡처보드에 1920 × 1080, 최대 60fps 입력을 요청합니다. 전송 과정에서는 별도의 최대 비트레이트를 설정하지 않고, 해상도 유지에 우선순위를 둔 단순한 품질 정책을 사용합니다. 화면은 강제로 늘리거나 자르지 않고 캡처보드가 전달한 원본 비율로 표시합니다.

## 로컬 실행

Node.js 22.13 이상이 필요합니다.

```bash
npm install
npm run dev
```

코드 검증과 프로덕션 빌드:

```bash
npm run lint
npx tsc --noEmit
npm run build
```

## 배포

Cloudflare 로그인과 프로젝트 설정을 마친 뒤 다음 명령으로 배포합니다.

```bash
npm run build
npx wrangler deploy --config dist/server/wrangler.json
```

Durable Object의 SQLite 마이그레이션은 빌드된 Wrangler 설정에 포함됩니다. 기존 D1 바인딩은 배포 설정과의 호환성을 위해 유지되지만, 현재 실시간 연결 신호에는 사용하지 않습니다.

## 기술 구성

- React 19
- Vinext
- WebRTC
- Cloudflare Workers
- Cloudflare Durable Objects와 WebSocket Hibernation
- Tailwind CSS

## 참고

Linkcast는 대규모 공개 방송이나 영상 저장·다시보기보다 최대 5명의 소규모 실시간 공유를 목표로 합니다. Nintendo 및 Nintendo Switch는 Nintendo의 상표이며, Linkcast는 Nintendo와 제휴하거나 공식적으로 승인받은 서비스가 아닙니다.
