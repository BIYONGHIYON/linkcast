# Linkcast

캡처보드 영상을 링크 하나로 공유하는 초저지연 WebRTC 서비스입니다.
송출자는 브라우저에서 영상을 선택하고, 참가자는 링크를 열어 바로 시청합니다.

## 서비스

[Linkcast 바로 열기](https://linkcast.byeonghyeon383.workers.dev/)

## 주요 기능

- 1080p 60fps 캡처보드 입력
- 송출 화면 미리보기와 실제 해상도·프레임 표시
- 링크 기반 방 생성 및 참가
- 최대 2명까지 시청
- 데스크톱·모바일 반응형 화면

## 연결 구조

영상과 오디오는 서버를 거치지 않고 WebRTC P2P로 직접 전달됩니다.
서버는 방 정보와 WebRTC 연결 협상 정보만 잠시 저장합니다.

```text
송출자 ───── WebRTC P2P ───── 참가자
   └── 방 생성·연결 협상 정보 ── D1
```

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
- Cloudflare D1
- Drizzle ORM
