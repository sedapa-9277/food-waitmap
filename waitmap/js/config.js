// 이 파일은 scripts/build-config.ps1이 .env로 만든다. 직접 고치지 말고 .env를 고친 뒤 스크립트를 다시 실행할 것.
// Supabase 프로젝트 food-waitmap (ap-northeast-2)
// 브라우저에 두어도 되는 공개용(publishable) 키만 넣습니다. service_role/secret 키는 절대 넣지 마세요.
// 테이블은 직접 읽고 쓸 수 없고, RPC(get_wait_summaries, submit_wait)로만 접근합니다.
const WAITMAP_CONFIG = {
  SUPABASE_URL: "https://oazntcculpbxdvrnvafc.supabase.co",
  SUPABASE_KEY: "sb_publishable_Z8XuU7rBKNqUeTIAj-SBZQ_sl8ICJW6",
  // 카카오 JavaScript 키(카카오 지도 + 식당 정보 조회). 비워 두면 지도가 뜨지 않습니다.
  // 카카오 개발자 콘솔 > 앱 > 플랫폼 키 > JavaScript 키 > JavaScript SDK 도메인에 등록한 도메인에서만 동작합니다. REST API 키·Admin 키는 넣지 마세요.
  KAKAO_JS_KEY: "ab3304a402bb5ba24ebba115ea2dec31"
};
