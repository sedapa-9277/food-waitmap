# 로컬 정적 서버 (Node/Python 없이 실행)
# 사용법: powershell -ExecutionPolicy Bypass -File serve.ps1 [-Port 5500]
param([int]$Port = 5500)

$root = $PSScriptRoot
$mime = @{
  ".html" = "text/html; charset=utf-8"; ".css" = "text/css; charset=utf-8"; ".js" = "text/javascript; charset=utf-8"
  ".json" = "application/json"; ".svg" = "image/svg+xml"; ".png" = "image/png"; ".jpg" = "image/jpeg"; ".ico" = "image/x-icon"
}

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$Port/")
$listener.Start()
Write-Host "Serving $root at http://localhost:$Port/  (Ctrl+C to stop)"

try {
  while ($listener.IsListening) {
    $ctx = $listener.GetContext()
    $res = $ctx.Response
    try {
      $path = [Uri]::UnescapeDataString($ctx.Request.Url.AbsolutePath).TrimStart("/")
      if ($path -eq "") { $path = "index.html" }
      $file = [IO.Path]::GetFullPath((Join-Path $root $path))
      if ($file.StartsWith($root) -and (Test-Path -LiteralPath $file -PathType Leaf)) {
        $bytes = [IO.File]::ReadAllBytes($file)
        $ext = [IO.Path]::GetExtension($file).ToLower()
        $res.ContentType = if ($mime[$ext]) { $mime[$ext] } else { "application/octet-stream" }
        $res.Headers.Add("Cache-Control", "no-cache")
        if ($ctx.Request.HttpMethod -ne "HEAD") { $res.OutputStream.Write($bytes, 0, $bytes.Length) }
      } else {
        $res.StatusCode = 404
      }
    } catch {
      Write-Host "Error: $($_.Exception.Message)"
    } finally {
      try { $res.Close() } catch {}
    }
  }
} finally {
  $listener.Stop()
}
