# 맛집 대기지도

전국 맛집의 예상 대기시간을 로그인 없이 입력하고 공유하는 지도 서비스입니다. 순수 HTML / CSS / JavaScript로 만들었고 빌드 도구는 없습니다.

## 구성

| 경로 | 내용 |
| --- | --- |
| `PRD-맛집-대기시간.md` | 최종 PRD (v1.1, 정책 확정본) |
| `food.md` | 초기 PRD (v1.0) |
| `food/` | 퍼블리싱 시안 (예시 데이터) |
| `waitmap/` | 실제 지도 버전 (OpenStreetMap + Supabase) |
| `waitmap/supabase/` | DB 마이그레이션 SQL |

## 실행

```bash
powershell -ExecutionPolicy Bypass -File serve.ps1 -Port 5600
```

- 시안: http://localhost:5600/food/index.html
- 실제 지도: http://localhost:5600/waitmap/index.html

Supabase 프로젝트 `food-waitmap`(ap-northeast-2)에 연결됩니다. `waitmap/js/config.js`에는 공개용(publishable) 키만 둡니다.
