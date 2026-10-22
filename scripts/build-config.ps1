# .env를 읽어 waitmap/js/config.js를 만든다 (빌드 도구 없이 PowerShell만 사용)
# 사용법: powershell -ExecutionPolicy Bypass -File scripts/build-config.ps1 [-EnvFile .env]
# config.js는 브라우저로 그대로 전달되므로, 비밀 키로 보이는 값이 있으면 만들지 않고 멈춘다.
param([string]$EnvFile = (Join-Path $PSScriptRoot "..\.env"))

$ErrorActionPreference = "Stop"
$root = Resolve-Path (Join-Path $PSScriptRoot "..")
$out = Join-Path $root "waitmap\js\config.js"

if (-not (Test-Path -LiteralPath $EnvFile)) {
  Write-Error ".env 파일이 없습니다: $EnvFile  (.env.example을 .env로 복사해 값을 채우세요)"
}

# KEY=VALUE 읽기: 빈 줄과 # 주석은 건너뛰고, 값 양끝의 따옴표는 떼어 낸다
$vars = @{}
foreach ($line in [IO.File]::ReadAllLines((Resolve-Path $EnvFile), [Text.Encoding]::UTF8)) {
  $t = $line.Trim()
  if ($t -eq "" -or $t.StartsWith("#")) { continue }
  $i = $t.IndexOf("=")
  if ($i -lt 1) { continue }
  $k = $t.Substring(0, $i).Trim()
  $v = $t.Substring($i + 1).Trim()
  if ($v.Length -ge 2 -and (($v[0] -eq '"' -and $v[-1] -eq '"') -or ($v[0] -eq "'" -and $v[-1] -eq "'"))) { $v = $v.Substring(1, $v.Length - 2) }
  $vars[$k] = $v
}

$problems = @()
foreach ($k in "SUPABASE_URL", "SUPABASE_KEY") {
  if (-not $vars[$k]) { $problems += "$k 값이 비어 있습니다." }
}
$kakao = if ($vars["KAKAO_JS_KEY"]) { $vars["KAKAO_JS_KEY"] } else { "" }

# 브라우저에 나가면 안 되는 값 막기
if ($vars["SUPABASE_URL"] -and $vars["SUPABASE_URL"] -notmatch '^https://[a-z0-9-]+\.supabase\.co$') {
  $problems += "SUPABASE_URL 형식이 다릅니다(https://<프로젝트>.supabase.co)."
}
if ($vars["SUPABASE_KEY"] -and $vars["SUPABASE_KEY"] -notmatch '^sb_publishable_[A-Za-z0-9_-]+$') {
  $problems += "SUPABASE_KEY는 공개용(sb_publishable_...) 키만 넣을 수 있습니다. secret/service_role 키는 브라우저에 넣으면 안 됩니다."
}
if ($kakao -and $kakao -notmatch '^[0-9a-f]{32}$') {
  $problems += "KAKAO_JS_KEY는 32자리 JavaScript 키여야 합니다. 로그인 토큰이나 REST/Admin 키를 넣지 마세요."
}
if ($problems.Count) {
  $problems | ForEach-Object { Write-Host "  - $_" -ForegroundColor Red }
  Write-Error "config.js를 만들지 않았습니다."
}
if (-not $kakao) { Write-Host "경고: KAKAO_JS_KEY가 비어 있어 지도가 뜨지 않습니다." -ForegroundColor Yellow }

$js = @"
// 이 파일은 scripts/build-config.ps1이 .env로 만든다. 직접 고치지 말고 .env를 고친 뒤 스크립트를 다시 실행할 것.
// Supabase 프로젝트 food-waitmap (ap-northeast-2)
// 브라우저에 두어도 되는 공개용(publishable) 키만 넣습니다. service_role/secret 키는 절대 넣지 마세요.
// 테이블은 직접 읽고 쓸 수 없고, RPC(get_wait_summaries, submit_wait)로만 접근합니다.
const WAITMAP_CONFIG = {
  SUPABASE_URL: "$($vars["SUPABASE_URL"])",
  SUPABASE_KEY: "$($vars["SUPABASE_KEY"])",
  // 카카오 JavaScript 키(카카오 지도 + 식당 정보 조회). 비워 두면 지도가 뜨지 않습니다.
  // 카카오 개발자 콘솔 > 앱 > 플랫폼 키 > JavaScript 키 > JavaScript SDK 도메인에 등록한 도메인에서만 동작합니다. REST API 키·Admin 키는 넣지 마세요.
  KAKAO_JS_KEY: "$kakao"
};

"@

# UTF-8(BOM 없음), LF 줄바꿈으로 저장
[IO.File]::WriteAllText($out, ($js -replace "`r`n", "`n"), (New-Object Text.UTF8Encoding $false))
Write-Host "만들었습니다: $out"
Write-Host "CSS·JS를 바꿔 배포할 때처럼 waitmap/index.html의 ?v= 값도 올리세요."
