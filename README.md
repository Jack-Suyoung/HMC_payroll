# HM Payroll PWA (Next.js)

이 디렉터리는 급여 스크립트를 웹/PWA 형태로 제공하기 위한 Next.js 14(TypeScript) 프런트엔드입니다.  
동일 Next.js 앱 내부의 `/api/payroll` 라우트를 호출해 로그/테이블/그래프를 보여줍니다.

## 주요 기능
- 로그인 정보/조회 기간 입력 → `/api/payroll/start` 로 작업 생성 → 모바일 승인 → 진행 상황 실시간 표시
- 연도별/그룹별 요약 테이블과 누적 카드, Chart.js 기반 막대/라인 그래프
- `manifest.json` + 서비스 워커 등록으로 홈 화면 추가 가능한 PWA 구성

## 사용 방법
- ```bash
  npm install
  npm run dev          # http://localhost:3000
  ```
- 기본값으로 `/api/payroll` 라우트를 직접 호출합니다.  
  만약 별도의 백엔드 URL을 사용하고 싶다면 `NEXT_PUBLIC_API_BASE` 환경 변수를 지정하세요.
  ```bash
  NEXT_PUBLIC_API_BASE=https://your-api.example.com npm run dev
  ```
- `npm run build` → `npm start` 로 프로덕션 번들을 확인할 수 있습니다.

## 배포 팁
- Vercel에 배포할 때 PWA로 동작하도록 `manifest.json` 과 `public/service-worker.js` 가 포함되어 있습니다.  
  홈 화면 아이콘은 `public/icons/` 폴더에 실제 PNG 이미지를 채워 넣어 주세요.
- `/api/payroll/start` 는 작업을 생성하고 즉시 `jobId` 를 반환합니다.  
  백엔드에서 로그인→모바일 승인 대기→데이터 수집을 비동기 처리하며, `/api/payroll/status?jobId=...` 로 현재 상태/진행률/결과를 확인합니다.
- Node 런타임(Serverless Function)으로 배포되며, Vercel이 자동 감지합니다.
