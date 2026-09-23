# Linkcast

캡처보드로 입력한 콘솔·PC 화면을 링크로 공유하는 소규모 실시간 방송 서비스입니다. 송출자가 최대 5명의 참가자에게 영상을 보내고, 모두가 브라우저에서 음성으로 대화할 수 있습니다.

**서비스:** [Linkcast 열기](https://linkcast.byeonghyeon383.workers.dev/)

## 사용 방법

### 송출자

1. 캡처보드를 컴퓨터에 연결하고 Linkcast에서 영상·오디오 장치를 선택합니다.
2. 미리보기를 확인한 뒤 **링크 만들고 복사**를 누릅니다.
3. 복사한 링크나 참가 코드를 공유합니다. 송출을 끝낼 때는 **송출 종료**를 누릅니다.

### 참가자

1. 공유 링크를 열거나 **참가** 화면에 코드를 입력합니다.
2. 연결되면 영상 음량, 전체화면, PiP, 화면 위 포인터를 사용할 수 있습니다.
3. 대화하려면 각자 **통화 시작**을 누릅니다. 브라우저가 자동 재생을 막으면 화면의 재생 버튼을 누릅니다.

## 주요 기능

- 원본 화면 비율을 유지하는 WebRTC 영상·캡처보드 음성 전송
- 송출자와 참가자, 참가자끼리의 음성 대화
- 클릭·터치 드래그로 공유하는 포인터
- 참가자별 연결 복구와 WebSocket 재접속
- 선택한 장치와 음량 설정 저장, 모바일 화면 지원

캡처 장치에는 1920 × 1080, 최대 60fps 입력을 요청합니다. 실제 화질과 지연은 장치·브라우저·네트워크 상태에 따라 달라집니다. 녹화와 다시보기 기능은 없습니다.

## 연결 방식과 제한

영상, 캡처보드 음성, 통화 음성은 참가자 사이의 WebRTC 연결로 전달됩니다. Cloudflare Durable Object는 WebSocket으로 방 입장과 연결 신호를 관리하며 영상을 저장하거나 중계하지 않습니다. 현재 실시간 시그널링에는 D1을 사용하지 않습니다.

```text
송출자 ── WebRTC 영상·캡처보드 음성 ── 참가자 1~5명
송출자·참가자 전원 ── WebRTC 통화 음성 ── 서로 연결

모든 사용자 ── WebSocket 연결 신호 ── Durable Object
```

현재 ICE 설정은 **STUN만 사용하고 TURN 중계 서버는 사용하지 않습니다.** 모바일 데이터망에서도 직접 연결이 가능한 경우에는 동작하지만, 통신사망이나 공유기의 NAT·방화벽이 직접 연결을 막으면 접속에 실패할 수 있습니다. 다른 참가자가 먼저 접속했다고 해서 이후 참가자의 연결이 보장되지는 않습니다. 안정적인 셀룰러 접속을 위해서는 TURN 설정이 필요합니다.

수신 트랙이 오디오와 비디오 순서로 따로 도착해도 새 스트림을 화면에 반영합니다. 영상 트랙이 활성화되지 않으면 연결을 복구하고, 브라우저 재생이 지연되면 화면에서 재생을 다시 시도할 수 있습니다.

## 개발

Node.js 22.13 이상이 필요합니다.

```bash
npm install
npm run dev
```

정적 검사와 빌드:

```bash
npx tsc --noEmit
npm run lint
npm run build
```

`npm run lint`는 현재 공용 UI 컴포넌트와 `hooks/use-mobile.ts`의 기존 규칙 오류로 전체 통과하지 않습니다. 연결 코드의 회귀 검사는 `scripts/test-*.mjs`에 있으며, 수신 트랙 순서 검사는 다음과 같이 실행합니다.

```bash
node scripts/test-remote-stream.mjs
```

WebSocket 통합 검사는 빌드 후 로컬 Worker를 실행한 상태에서 별도 터미널로 실행합니다.

```bash
npx wrangler dev --config dist/server/wrangler.json --port 8799
```

```bash
node scripts/test-signaling.mjs
node scripts/test-signaling-client.mjs
```

## 배포

Cloudflare 프로젝트를 설정한 뒤 빌드 결과를 배포합니다.

```bash
npm run build
npx wrangler deploy --config dist/server/wrangler.json
```

Durable Object의 SQLite 마이그레이션은 빌드된 Wrangler 설정에 포함됩니다. 기존 D1 바인딩은 설정 호환을 위해 남아 있습니다.

## 기술 구성

React 19 · Vinext · WebRTC · Cloudflare Workers · Durable Objects · Tailwind CSS

Nintendo 및 Nintendo Switch는 Nintendo의 상표입니다. Linkcast는 Nintendo와 제휴하거나 공식 승인을 받은 서비스가 아닙니다.
