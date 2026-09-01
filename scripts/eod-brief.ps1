# scripts/eod-brief.ps1 — daily evening brief at 17:45.
# Registered via: schtasks /Create /TN "Cortex EOD Brief" /SC DAILY /ST 17:45 ^
#   /TR "powershell -NoProfile -ExecutionPolicy Bypass -File C:\work\cortex\scripts\eod-brief.ps1"
$root = Split-Path -Parent $PSScriptRoot
$date = Get-Date -Format yyyy-MM-dd
$html = Join-Path $root "reports\eod\$date.html"
# Task Scheduler's launch environment doesn't always carry the user PATH (scoop shims
# live there, not in the machine PATH), so `node` can resolve here but not under schtasks.
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  $env:Path = "$env:USERPROFILE\scoop\shims;$env:Path"
}
# If node still can't resolve, & node never sets $LASTEXITCODE and the script would
# exit 0 — Task Scheduler would report success for a run that sent nothing.
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { exit 9009 }
# Task Scheduler's default start-in directory is C:\Windows\System32, and storage.js
# resolves .cortex relative to cwd — without this, node tries (and fails) to mkdir
# .cortex under System32.
Set-Location $root
& node (Join-Path $root "src\cli.js") eod --html $html --notify --digest
exit $LASTEXITCODE
