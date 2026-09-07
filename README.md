# Linkcast

캡처보드 영상을 링크 하나로 공유하는 초저지연 WebRTC 서비스입니다.
송출자는 브라우저에서 영상을 선택하고, 참가자는 링크를 열어 바로 시청합니다.

## 서비스

[Linkcast 바로 열기](https://linkcast.byeonghyeon383.workers.dev/)

## 주요 기능

- 1080p 60fps 캡처보드 입력
- 대역폭 부족 시 프레임레이트를 먼저 조절하는 해상도 유지 우선 전송
- 송출 화면 미리보기와 실제 해상도·프레임 표시
- 링크 기반 방 생성 및 참가
- 최대 5명까지 시청
- 데스크톱·모바일 반응형 화면
- 클릭·터치 자취 공유 및 별도 전체화면 메뉴
- 캡처보드 소리와 분리된 송출자 ↔ 수신자 마이크 통화
- 통화 음량·마이크 민감도 조절, 음소거 및 입력 레벨 표시

## 음성 통화

방에 연결한 뒤 양쪽에서 **통화 시작**을 누르면 마이크 권한을 요청합니다.
마이크는 기본적으로 꺼져 있으며, 통화 종료나 방 나가기 시 장치 사용을 해제합니다.
접을 수 있는 통화 설정에서 상대 음량(0–150%), 마이크 민감도, 마이크 장치를 선택합니다.
전체화면에서는 영상 메뉴를 열면 통화 패널도 표시됩니다.

통화는 송출자와 각 수신자 사이의 P2P 연결을 사용합니다. 수신자끼리의 대화는 지원하지 않습니다.
마이크에는 에코 제거·잡음 억제와 민감도에 따른 입력 차단을 적용하며,
캡처보드 음성에는 이 처리를 적용하지 않습니다. 이어폰 사용을 권장합니다.

## 연결 구조

영상과 오디오는 서버를 거치지 않고 WebRTC P2P로 직접 전달됩니다.
방마다 Cloudflare Durable Object가 WebSocket 연결과 참가 인원을 관리합니다.
연결 신호는 즉시 전달하며, 정기 HTTP 조회와 시그널용 D1 읽기·쓰기는 사용하지 않습니다.

```text
송출자 ───── WebRTC P2P ───── 참가자
   └── WebSocket 연결 신호 ── Durable Object
```

WebSocket Hibernation과 30초 자동 ping/pong을 사용합니다. 끊어진 연결은 종료 이벤트로 정리하며,
이벤트가 오지 않는 단절은 정상 방 기준 5분 간격 검사로 회수합니다. 새 입장 시에도 만료 연결을 확인합니다.
송출자 소켓 재연결에는 2분의 유예 시간을 둡니다. 절전·모바일 백그라운드에서는 재연결이 필요할 수 있습니다.
실제 1080p 유지 여부는 캡처보드 입력, 송출자의 업로드·인코딩 성능, 수신자의 회선에 따라 달라집니다.

## 실행

```bash
npm install
npm run dev
```

프로덕션 빌드:

```bash
npm run build
```

## 기술 구성

- Next.js 호환 Vinext
- WebRTC
- Cloudflare Workers + SQLite 기반 Durable Objects (WebSocket Hibernation)

## 배포 및 검증

`npm run build` 후 `npx wrangler deploy --config dist/server/wrangler.json`으로 배포합니다.
최초 배포 시 `v1-rooms` 마이그레이션이 Durable Object를 생성합니다.
기존 D1 데이터와 바인딩은 보존하지만 새 연결 흐름에서는 사용하지 않습니다.
업데이트 후 송출자·수신자 모두 새로고침하고 새 방을 만들어야 합니다.

로컬 연결 검증:

```bash
npx wrangler dev --config dist/server/wrangler.json --port 8799 --local
# 다른 터미널에서
node scripts/test-signaling.mjs
```
