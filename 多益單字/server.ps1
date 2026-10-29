# TOEIC Vocab Master - Windows Native Backend Server (Fallback when Node.js is not in PATH)
# 提供與 server.js 100% 相同的 REST API 並讀寫相同的 data/db.json 與 data/words.json

param(
  [int]$Port = 3000
)

$ErrorActionPreference = "Stop"
$RootDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$DataDir = Join-Path $RootDir "data"
$PublicDir = Join-Path $RootDir "public"
$WordsFile = Join-Path $DataDir "words.json"
$DbFile = Join-Path $DataDir "db.json"

function Get-PasswordHash([string]$Password) {
  $bytes = [System.Text.Encoding]::UTF8.GetBytes("toeic_salt_2026:$Password")
  $hash = [System.Security.Cryptography.SHA256]::Create().ComputeHash($bytes)
  return -join ($hash | ForEach-Object { $_.ToString("x2") })
}

function Read-JsonFile([string]$FilePath) {
  $raw = [System.IO.File]::ReadAllText($FilePath, [System.Text.Encoding]::UTF8)
  return $raw | ConvertFrom-Json
}

function Write-JsonFile([string]$FilePath, $Obj) {
  $json = $Obj | ConvertTo-Json -Depth 12
  [System.IO.File]::WriteAllText($FilePath, $json, [System.Text.Encoding]::UTF8)
}

function Send-JsonResponse($Response, [int]$StatusCode, $DataObj) {
  $Response.StatusCode = $StatusCode
  $Response.ContentType = "application/json; charset=utf-8"
  $Response.AddHeader("Access-Control-Allow-Origin", "*")
  $Response.AddHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
  $Response.AddHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Auth-Token")
  $json = $DataObj | ConvertTo-Json -Depth 12 -Compress
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
  $Response.ContentLength64 = $bytes.Length
  $Response.OutputStream.Write($bytes, 0, $bytes.Length)
  $Response.OutputStream.Close()
}

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$Port/")
$listener.Start()

Write-Host "====================================================" -ForegroundColor Cyan
Write-Host "🎯 TOEIC Vocab Master 伺服器已啟動！" -ForegroundColor Green
Write-Host "🌐 請開啟瀏覽器前往: http://localhost:$Port" -ForegroundColor Yellow
Write-Host "💾 資料庫檔案路徑:   $DbFile" -ForegroundColor Gray
Write-Host "====================================================" -ForegroundColor Cyan

try {
  while ($listener.IsListening) {
    $ctx = $listener.GetContext()
    $req = $ctx.Request
    $res = $ctx.Response
    $path = $req.Url.AbsolutePath
    $method = $req.HttpMethod.ToUpper()

    try {
      if ($method -eq "OPTIONS") {
        $res.StatusCode = 204
        $res.AddHeader("Access-Control-Allow-Origin", "*")
        $res.AddHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
        $res.AddHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Auth-Token")
        $res.OutputStream.Close()
        continue
      }

      if ($path.StartsWith("/api/")) {
        $db = Read-JsonFile $DbFile
        $authHeader = $req.Headers["Authorization"]
        $token = ""
        if ($authHeader -and $authHeader.StartsWith("Bearer ")) {
          $token = $authHeader.Substring(7).Trim()
        }
        $currentUser = $null
        if ($token -and $db.sessions -and $db.sessions.PSObject.Properties[$token]) {
          $uid = $db.sessions.PSObject.Properties[$token].Value
          $currentUser = $db.users | Where-Object { $_.id -eq $uid } | Select-Object -First 1
        }

        $bodyObj = $null
        if ($req.HasEntityBody) {
          $reader = New-Object System.IO.StreamReader($req.InputStream, [System.Text.Encoding]::UTF8)
          $bodyText = $reader.ReadToEnd()
          $reader.Close()
          if ($bodyText) {
            $bodyObj = $bodyText | ConvertFrom-Json
          }
        }

        if ($path -eq "/api/health" -and $method -eq "GET") {
          $baseWords = Read-JsonFile $WordsFile
          Send-JsonResponse $res 200 @{
            ok = $true
            mode = "server"
            engine = "Local Server"
            wordCount = ($baseWords.Count + $db.customWords.Count)
            userCount = $db.users.Count
          }
          continue
        }

        if ($path -eq "/api/words" -and $method -eq "GET") {
          $baseWords = Read-JsonFile $WordsFile
          $allWords = @()
          foreach ($w in $baseWords) {
            $w | Add-Member -NotePropertyName isCustom -NotePropertyValue $false -Force
            $allWords += $w
          }
          foreach ($cw in $db.customWords) {
            $cw | Add-Member -NotePropertyName isCustom -NotePropertyValue $true -Force
            $allWords += $cw
          }
          Send-JsonResponse $res 200 @{ words = $allWords }
          continue
        }

        if ($path -eq "/api/words" -and $method -eq "POST") {
          if (-not $currentUser) {
            Send-JsonResponse $res 401 @{ error = "請先登入以新增自訂題庫單字" }
            continue
          }
          $wordStr = ([string]$bodyObj.word).Trim().ToLower()
          $meaningStr = ([string]$bodyObj.meaning).Trim()
          if (-not $wordStr -or -not $meaningStr) {
            Send-JsonResponse $res 400 @{ error = "英文單字與中文解釋為必填欄位" }
            continue
          }
          $newWord = [PSCustomObject]@{
            id = "cw_" + [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
            word = $wordStr
            phonetic = if ($bodyObj.phonetic) { ([string]$bodyObj.phonetic).Trim() } else { "/$wordStr/" }
            pos = if ($bodyObj.pos) { ([string]$bodyObj.pos).Trim() } else { "n." }
            meaning = $meaningStr
            synonyms = if ($bodyObj.synonyms) { ([string]$bodyObj.synonyms).Trim() } else { "" }
            example = if ($bodyObj.example) { ([string]$bodyObj.example).Trim() } else { "Please review the usage of $wordStr in business contexts." }
            translation = if ($bodyObj.translation) { ([string]$bodyObj.translation).Trim() } else { "請複習 $wordStr（$meaningStr）在商務情境中的用法。" }
            category = if ($bodyObj.category) { ([string]$bodyObj.category).Trim() } else { "商務與合約" }
            level = if ($bodyObj.level) { ([string]$bodyObj.level).Trim() } else { "750分進階" }
            isCustom = $true
            createdBy = $currentUser.username
            createdAt = (Get-Date).ToUniversalTime().ToString("o")
          }
          $db.customWords = @($newWord) + @($db.customWords)
          Write-JsonFile $DbFile $db
          Send-JsonResponse $res 201 @{ word = $newWord }
          continue
        }

        if ($path.StartsWith("/api/words/") -and $method -eq "DELETE") {
          $delId = [Uri]::UnescapeDataString($path.Replace("/api/words/", ""))
          $db.customWords = @($db.customWords | Where-Object { $_.id -ne $delId })
          Write-JsonFile $DbFile $db
          Send-JsonResponse $res 200 @{ ok = $true; deletedId = $delId }
          continue
        }

        if ($path -eq "/api/auth/login" -and $method -eq "POST") {
          $uname = ([string]$bodyObj.username).Trim().ToLower()
          $pwd = [string]$bodyObj.password
          $hash = Get-PasswordHash $pwd
          $u = $db.users | Where-Object { $_.username.ToLower() -eq $uname -and $_.passwordHash -eq $hash } | Select-Object -First 1
          if (-not $u) {
            Send-JsonResponse $res 401 @{ error = "帳號或密碼錯誤，請重新輸入" }
            continue
          }
          $newTok = [Guid]::NewGuid().ToString("N")
          $db.sessions | Add-Member -NotePropertyName $newTok -NotePropertyValue $u.id -Force
          Write-JsonFile $DbFile $db
          Send-JsonResponse $res 200 @{ token = $newTok; user = $u }
          continue
        }

        if ($path -eq "/api/auth/register" -and $method -eq "POST") {
          $uname = ([string]$bodyObj.username).Trim().ToLower()
          $pwd = [string]$bodyObj.password
          $dname = if ($bodyObj.displayName) { ([string]$bodyObj.displayName).Trim() } else { $uname }
          $tscore = if ($bodyObj.targetScore) { [int]$bodyObj.targetScore } else { 860 }

          if ($uname.Length -lt 2) {
            Send-JsonResponse $res 400 @{ error = "帳號長度至少需 2 個字元" }
            continue
          }
          if ($pwd.Length -lt 4) {
            Send-JsonResponse $res 400 @{ error = "密碼長度至少需 4 個字元" }
            continue
          }
          $exists = $db.users | Where-Object { $_.username.ToLower() -eq $uname }
          if ($exists) {
            Send-JsonResponse $res 409 @{ error = "此帳號已被註冊，請直接登入或更換帳號" }
            continue
          }

          $newUser = [PSCustomObject]@{
            id = "u_" + [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
            username = $uname
            displayName = $dname
            passwordHash = Get-PasswordHash $pwd
            targetScore = $tscore
            createdAt = (Get-Date).ToUniversalTime().ToString("o")
            stats = [PSCustomObject]@{
              totalQuizzes = 0
              totalQuestions = 0
              correctAnswers = 0
              streakDays = 1
              lastStudyDate = (Get-Date).ToString("yyyy-MM-dd")
            }
            wrongWords = [PSCustomObject]@{}
            history = @()
          }
          $newTok = [Guid]::NewGuid().ToString("N")
          $db.users = @($db.users) + @($newUser)
          $db.sessions | Add-Member -NotePropertyName $newTok -NotePropertyValue $newUser.id -Force
          Write-JsonFile $DbFile $db
          Send-JsonResponse $res 201 @{ token = $newTok; user = $newUser }
          continue
        }

        if ($path -eq "/api/auth/logout" -and $method -eq "POST") {
          if ($token -and $db.sessions.PSObject.Properties[$token]) {
            $db.sessions.PSObject.Properties.Remove($token)
            Write-JsonFile $DbFile $db
          }
          Send-JsonResponse $res 200 @{ ok = $true }
          continue
        }

        if ($path -eq "/api/user/me" -and $method -eq "GET") {
          if (-not $currentUser) {
            Send-JsonResponse $res 401 @{ error = "尚未登入" }
            continue
          }
          Send-JsonResponse $res 200 @{ user = $currentUser }
          continue
        }

        if ($path -eq "/api/user/profile" -and $method -eq "PUT") {
          if (-not $currentUser) {
            Send-JsonResponse $res 401 @{ error = "請先登入" }
            continue
          }
          if ($bodyObj.displayName) { $currentUser.displayName = [string]$bodyObj.displayName }
          if ($bodyObj.targetScore) { $currentUser.targetScore = [int]$bodyObj.targetScore }
          Write-JsonFile $DbFile $db
          Send-JsonResponse $res 200 @{ user = $currentUser }
          continue
        }

        if ($path -eq "/api/quiz/submit" -and $method -eq "POST") {
          if (-not $currentUser) {
            Send-JsonResponse $res 401 @{ error = "請先登入" }
            continue
          }
          $results = @($bodyObj.results)
          $total = $results.Count
          $correct = @($results | Where-Object { $_.isCorrect }).Count
          $score = if ($total -gt 0) { [int][Math]::Round(($correct / $total) * 100) } else { 0 }
          $nowIso = (Get-Date).ToUniversalTime().ToString("o")

          $currentUser.stats.totalQuizzes = [int]$currentUser.stats.totalQuizzes + 1
          $currentUser.stats.totalQuestions = [int]$currentUser.stats.totalQuestions + $total
          $currentUser.stats.correctAnswers = [int]$currentUser.stats.correctAnswers + $correct

          if (-not $currentUser.wrongWords) {
            $currentUser | Add-Member -NotePropertyName wrongWords -NotePropertyValue ([PSCustomObject]@{}) -Force
          }

          $wrongIds = @()
          foreach ($item in $results) {
            $wId = [string]$item.wordId
            if (-not $item.isCorrect) {
              $wrongIds += $wId
              $existingProp = $currentUser.wrongWords.PSObject.Properties[$wId]
              if ($existingProp) {
                $ex = $existingProp.Value
                $ex.errorCount = [int]$ex.errorCount + 1
                $ex.correctStreak = 0
                $ex.mastered = $false
                $ex.lastWrongAt = $nowIso
                $ex.lastMode = [string]$item.mode
              } else {
                $newEntry = [PSCustomObject]@{
                  wordId = $wId
                  errorCount = 1
                  correctStreak = 0
                  mastered = $false
                  lastWrongAt = $nowIso
                  lastMode = [string]$item.mode
                  note = ""
                }
                $currentUser.wrongWords | Add-Member -NotePropertyName $wId -NotePropertyValue $newEntry -Force
              }
            } else {
              $existingProp = $currentUser.wrongWords.PSObject.Properties[$wId]
              if ($existingProp) {
                $ex = $existingProp.Value
                $ex.correctStreak = [int]$ex.correctStreak + 1
                if ($ex.correctStreak -ge 3) {
                  $ex.mastered = $true
                }
              }
            }
          }

          $histEntry = [PSCustomObject]@{
            id = "h_" + [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
            mode = [string]$bodyObj.modeLabel
            category = [string]$bodyObj.categoryLabel
            total = $total
            correct = $correct
            score = $score
            durationSec = [int]$bodyObj.durationSec
            wrongWordIds = $wrongIds
            date = $nowIso
          }
          $currentUser.history = @($histEntry) + @($currentUser.history)
          Write-JsonFile $DbFile $db
          Send-JsonResponse $res 200 @{ user = $currentUser; summary = @{ total = $total; correct = $correct; score = $score; wrongWordIds = $wrongIds } }
          continue
        }

        if ($path -eq "/api/wrong-words/toggle" -and $method -eq "POST") {
          if (-not $currentUser) {
            Send-JsonResponse $res 401 @{ error = "請先登入" }
            continue
          }
          $wId = [string]$bodyObj.wordId
          $action = [string]$bodyObj.action
          $prop = $currentUser.wrongWords.PSObject.Properties[$wId]
          if ($action -eq "master" -and $prop) {
            $prop.Value.mastered = -not [bool]$prop.Value.mastered
            $prop.Value.correctStreak = if ($prop.Value.mastered) { 3 } else { 0 }
          } elseif ($action -eq "remove" -and $prop) {
            $currentUser.wrongWords.PSObject.Properties.Remove($wId)
          } else {
            if ($prop) {
              $currentUser.wrongWords.PSObject.Properties.Remove($wId)
            } else {
              $newEntry = [PSCustomObject]@{
                wordId = $wId
                errorCount = 1
                correctStreak = 0
                mastered = $false
                lastWrongAt = (Get-Date).ToUniversalTime().ToString("o")
                lastMode = "手動加入錯題本"
                note = ""
              }
              $currentUser.wrongWords | Add-Member -NotePropertyName $wId -NotePropertyValue $newEntry -Force
            }
          }
          Write-JsonFile $DbFile $db
          Send-JsonResponse $res 200 @{ user = $currentUser }
          continue
        }

        if ($path.StartsWith("/api/wrong-words/") -and $method -eq "PUT") {
          if (-not $currentUser) {
            Send-JsonResponse $res 401 @{ error = "請先登入" }
            continue
          }
          $wId = [Uri]::UnescapeDataString($path.Replace("/api/wrong-words/", "").Replace("/note", ""))
          $prop = $currentUser.wrongWords.PSObject.Properties[$wId]
          if ($prop -and $null -ne $bodyObj.note) {
            $prop.Value.note = [string]$bodyObj.note
          }
          Write-JsonFile $DbFile $db
          Send-JsonResponse $res 200 @{ user = $currentUser }
          continue
        }

        if ($path.StartsWith("/api/wrong-words/") -and $method -eq "DELETE") {
          if (-not $currentUser) {
            Send-JsonResponse $res 401 @{ error = "請先登入" }
            continue
          }
          $wId = [Uri]::UnescapeDataString($path.Replace("/api/wrong-words/", ""))
          if ($currentUser.wrongWords.PSObject.Properties[$wId]) {
            $currentUser.wrongWords.PSObject.Properties.Remove($wId)
          }
          Write-JsonFile $DbFile $db
          Send-JsonResponse $res 200 @{ user = $currentUser }
          continue
        }

        Send-JsonResponse $res 404 @{ error = "API endpoint not found" }
        continue
      }

      # 靜態檔案服務 (public/)
      $relPath = if ($path -eq "/") { "index.html" } else { $path.TrimStart("/") }
      $filePath = Join-Path $PublicDir $relPath
      if (-not (Test-Path $filePath -PathType Leaf)) {
        $filePath = Join-Path $PublicDir "index.html"
      }

      $ext = [System.IO.Path]::GetExtension($filePath).ToLower()
      $mime = switch ($ext) {
        ".html" { "text/html; charset=utf-8" }
        ".css"  { "text/css; charset=utf-8" }
        ".js"   { "application/javascript; charset=utf-8" }
        ".json" { "application/json; charset=utf-8" }
        default { "application/octet-stream" }
      }

      $fileBytes = [System.IO.File]::ReadAllBytes($filePath)
      $res.StatusCode = 200
      $res.ContentType = $mime
      $res.ContentLength64 = $fileBytes.Length
      $res.OutputStream.Write($fileBytes, 0, $fileBytes.Length)
      $res.OutputStream.Close()
    } catch {
      try {
        Send-JsonResponse $res 500 @{ error = $_.Exception.Message }
      } catch {}
    }
  }
} finally {
  $listener.Stop()
}
