# 맛집 대기지도

빌드 없는 정적 사이트(HTML/CSS/바닐라 JS). 주석·커밋 메시지는 한국어.

## 구성
- `waitmap/` - 실제 서비스: 카카오 지도(`KAKAO_JS_KEY` 필수) + Supabase RPC. SDK 로드·식당 조회는 `js/places.js`(카카오 장소 검색 FD6, 실패 시 Nominatim), 지도·마커(CustomOverlay)는 `js/app.js`
- `food/` 시안은 여전히 Leaflet + OSM 타일
- `food/` - 퍼블리싱 시안, 가상 데이터(`js/data.js`). `noindex` 유지
- `index.html` - 소개·FAQ 랜딩(SEO). `PRD-맛집-대기시간.md`가 최종 PRD(v1.1), `food.md`는 초안

## 실행·확인
- `powershell -ExecutionPolicy Bypass -File serve.ps1 -Port 5600` - 로컬 서버 (launch.json 이름 `food-waitmap`)
- serve.ps1은 폴더 주소를 index.html로 연결하지 않음 → 로컬에서는 `/waitmap/index.html`처럼 파일 경로로 열기 (GitHub Pages는 `/waitmap/`도 됨)
- 테스트 프레임워크 없음. 브라우저에서 직접 열어 확인

## 환경 특이점 (Windows)
- node 없음, `python`은 Microsoft Store 스텁이라 실행 안 됨 → 스크립트·이미지 생성은 PowerShell(System.Drawing)
- `gh` CLI 없음 → GitHub 상태는 `curl -s https://api.github.com/repos/sedapa-9277/food-waitmap`로 확인
- 이 PC 네트워크에서는 Overpass API(모든 미러)에 연결되지 않음 → Overpass 기반 변경은 여기서 테스트 불가

## 배포
- GitHub Pages, `main` / root → https://sedapa-9277.github.io/food-waitmap/ (main에 푸시하면 자동 배포)
- 기준 URL이 하드코딩된 곳: `index.html`, `waitmap/index.html`(canonical·OG·JSON-LD), `sitemap.xml`, `llms.txt` → 주소가 바뀌면 모두 수정
- 루트 `index.html`의 `google-site-verification` 메타 태그는 지우지 말 것 (Search Console 소유권)
- `index.html`의 FAQ는 본문(`<details>`)과 JSON-LD `FAQPage` 두 곳에 있음 → 함께 수정

## 서버 정책 (Supabase `food-waitmap`, ap-northeast-2)
- 만료·평균·검증·요청 제한은 DB 함수 `submit_wait`, `get_wait_summaries`가 처리. 테이블은 RLS로 직접 접근 차단
- `waitmap/js/config.js`에는 publishable 키만. service_role 키 금지
- 스키마 변경은 `waitmap/supabase/`에 마이그레이션 SQL로 남기기

## 주의
- Nominatim 공개 서버는 약 1회/초 제한 → 자동완성·연속 호출 금지, 버튼을 눌렀을 때만 요청
- 식당 ID는 `kakao-{id}` 또는 `osm-{osm_type}-{osm_id}` (대기시간 DB의 `place_id`와 같은 값)
- 카카오 JavaScript 키는 콘솔에 등록한 도메인에서만 동작 → 로컬은 `http://localhost:5600`도 등록 필요. REST/Admin 키는 브라우저에 넣지 말 것
- 카카오 도메인 등록 확인: `curl -s -H "Referer: https://sedapa-9277.github.io/" "https://dapi.kakao.com/v2/maps/sdk.js?appkey=<키>&libraries=services"` → 200이면 정상, 401 `domain mismatched`면 미등록
- 카카오 콘솔(2025-12 개편): 도메인은 `앱 > 플랫폼 키 > JavaScript 키 > JavaScript SDK 도메인`, 지도 API는 `카카오맵 > 사용 설정` ON (예전 "플랫폼 > Web" 메뉴 없음)
- `places.js`는 카카오 실패 시 그 요청을 OSM으로 대신함 → 식당이 나와도 카카오가 동작한다는 뜻은 아님. `Places.source`(마지막 실제 출처)로 확인
- 이름 검색: 카카오는 정확도순 유지, OSM만 거리순 정렬 (카카오를 거리순으로 바꾸면 비슷한 이름이 앞에 옴)
- 알려진 보안 문제: 익명 ID를 브라우저가 만들어 보냄 → 요청마다 새 ID를 넣으면 중복 입력 제한이 적용되지 않음 (PRD는 서버 발급 HttpOnly 쿠키)

## 홍보 영상 (`promo/`)
- `promo/promo.html` - 캔버스 애니메이션을 WebCodecs(H.264) + mp4-muxer(jsdelivr)로 MP4 생성. ffmpeg 없음
- 프레임 타임스탬프를 직접 지정하므로 브라우저 창이 가려져 있어도 속도 정확. 콘솔 `showAt(초)`로 특정 장면 확인
- 브라우저에서 만든 파일을 디스크에 저장할 때: 임시 로컬 서버로 `ArrayBuffer`를 POST (Blob에 type이 있으면 사전 확인(preflight) 요청으로 막힘)
