# Otter installer for Windows: one PowerShell command installs or updates `otter` through WSL2.
#
#   irm https://raw.githubusercontent.com/KimJiSeong1994/AgentFramework/master/install.ps1 | iex
#
# otter relies on POSIX ownership and permission checks, so it runs inside WSL2 (Ubuntu by default). This script runs
# install.sh inside the WSL distribution, then writes an `otter.cmd` launcher into %LOCALAPPDATA%\otter\bin (added to
# the user PATH) so `otter` works from PowerShell, cmd and Windows Terminal. Re-running it updates in place.
#
# Environment:
#   OTTER_DISTRO     WSL distribution to use (default: the WSL default distribution)
#   OTTER_UNINSTALL  set to 1 to remove otter from WSL and the Windows launcher (config and session state are kept)
#   OTTER_REPO, OTTER_REF, OTTER_HOME, OTTER_BIN_DIR, OTTER_NO_MODIFY_PATH, OTTER_NO_BUN_INSTALL, OTTER_FORCE
#                    forwarded to install.sh inside WSL
& {
  $ErrorActionPreference = 'Stop'
  $script = 'https://raw.githubusercontent.com/KimJiSeong1994/AgentFramework/master/install.sh'
  $marker = 'rem managed by the otter installer (install.ps1)'
  $binDir = Join-Path $env:LOCALAPPDATA 'otter\bin'
  $shim = Join-Path $binDir 'otter.cmd'

  function Say([string]$message) { Write-Host "otter: $message" }
  function Fail([string]$message) { Write-Host "otter: $message" -ForegroundColor Red; throw "otter install failed" }

  # wsl.exe prints UTF-16 by default; ask for UTF-8 so messages stay readable.
  $env:WSL_UTF8 = '1'
  $distroArgs = @()
  if ($env:OTTER_DISTRO) { $distroArgs = @('-d', $env:OTTER_DISTRO) }
  # Forward OTTER_* settings into WSL unchanged (WSLENV /u = Windows -> WSL only).
  $forward = @('OTTER_REPO', 'OTTER_REF', 'OTTER_HOME', 'OTTER_BIN_DIR', 'OTTER_NO_MODIFY_PATH', 'OTTER_NO_BUN_INSTALL', 'OTTER_FORCE') |
    Where-Object { Test-Path "env:$_" } | ForEach-Object { "$_/u" }
  if ($forward) { $env:WSLENV = (@($env:WSLENV) + $forward | Where-Object { $_ }) -join ':' }

  # Commands passed to bash use single quotes only: Windows PowerShell 5.1 does not escape embedded double quotes
  # when it builds a native command line.
  function Invoke-Wsl([string]$command) {
    & wsl.exe @distroArgs -e bash -lc $command | Out-Host
    return $LASTEXITCODE
  }

  if (-not (Get-Command wsl.exe -ErrorAction SilentlyContinue)) {
    Fail "WSL is not installed. Run 'wsl --install' in an administrator PowerShell, restart Windows, open Ubuntu once to create your user, then run this command again."
  }
  & wsl.exe @distroArgs -e true
  if ($LASTEXITCODE -ne 0) {
    Fail "no usable WSL distribution$(if ($env:OTTER_DISTRO) { " named '$env:OTTER_DISTRO'" }). Run 'wsl --install -d Ubuntu', open Ubuntu once to create your user, then run this command again."
  }
  $kernel = (& wsl.exe @distroArgs -e uname -r) -join ''
  if ($kernel -notmatch 'microsoft-standard|WSL2') {
    Fail "the WSL distribution runs on WSL 1 ($kernel). Convert it with 'wsl --set-version <distro> 2' and run this command again."
  }
  if ((Invoke-Wsl 'command -v git >/dev/null && command -v curl >/dev/null') -ne 0) {
    Fail "git and curl are required inside WSL. Open your WSL distribution and run: sudo apt update && sudo apt install -y git curl"
  }

  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  $pathEntries = @($userPath -split ';' | Where-Object { $_ })

  if ($env:OTTER_UNINSTALL -eq '1') {
    if ((Invoke-Wsl "curl -fsSL '$script' | bash -s -- --uninstall") -ne 0) { Fail 'uninstall inside WSL failed' }
    if ((Test-Path $shim) -and (Select-String -Path $shim -SimpleMatch $marker -Quiet)) {
      Remove-Item $shim
      Say "removed $shim"
    }
    if ($pathEntries -contains $binDir) {
      [Environment]::SetEnvironmentVariable('Path', (($pathEntries | Where-Object { $_ -ne $binDir }) -join ';'), 'User')
      Say "removed $binDir from the user PATH"
    }
    return
  }

  Say 'installing inside WSL'
  if ((Invoke-Wsl "curl -fsSL '$script' | bash") -ne 0) { Fail 'install.sh failed inside WSL; see the messages above' }

  if ((Test-Path $shim) -and -not (Select-String -Path $shim -SimpleMatch $marker -Quiet) -and $env:OTTER_FORCE -ne '1') {
    Fail "$shim already exists and was not created by this installer; remove it or set OTTER_FORCE=1"
  }
  # Resolve absolute WSL paths now, so the Windows launcher passes the user's arguments through --exec unquoted.
  # `wsl --exec` runs no shell (no ~/.profile, no ~/.bashrc), so codex/claude installed with nvm, npm or a vendor
  # installer would not be on PATH; scripts/otter-wsl loads the user's login shell environment, then starts otter.
  $launcher = ((& wsl.exe @distroArgs -e bash -lc 'printf %s ${OTTER_BIN_DIR:-$HOME/.local/bin}/otter') -join '').Trim()
  if ($launcher -notmatch '^/\S+/otter$') { Fail "could not resolve the otter launcher inside WSL (got '$launcher'); set OTTER_BIN_DIR to a path without spaces" }
  $wrapper = ((& wsl.exe @distroArgs -e bash -lc 'printf %s ${OTTER_HOME:-$HOME/.local/share/otter}/AgentFramework/scripts/otter-wsl') -join '').Trim()
  if ($wrapper -notmatch '^/\S+/otter-wsl$') { Fail "could not resolve the otter checkout inside WSL (got '$wrapper'); set OTTER_HOME to a path without spaces" }
  & wsl.exe @distroArgs -e test -x $launcher
  if ($LASTEXITCODE -ne 0) { Fail "$launcher is missing inside WSL; re-run this command" }
  & wsl.exe @distroArgs -e test -f $wrapper
  if ($LASTEXITCODE -ne 0) { Fail "$wrapper is missing inside WSL; re-run this command" }

  New-Item -ItemType Directory -Force -Path $binDir | Out-Null
  $distro = if ($env:OTTER_DISTRO) { "-d `"$($env:OTTER_DISTRO)`" " } else { '' }
  # The current Windows folder becomes the WSL working directory (C:\work -> /mnt/c/work).
  $lines = @(
    '@echo off',
    $marker,
    "wsl.exe $distro--exec /bin/sh $wrapper $launcher %*"
  )
  [IO.File]::WriteAllLines($shim, $lines, [Text.Encoding]::ASCII)
  Say "launcher at $shim"

  if ($pathEntries -notcontains $binDir) {
    [Environment]::SetEnvironmentVariable('Path', (($pathEntries + $binDir) -join ';'), 'User')
    Say "added $binDir to the user PATH"
  }
  if (($env:Path -split ';') -notcontains $binDir) { $env:Path = "$env:Path;$binDir" }

  # Engines and their sign-in live inside WSL: a Windows codex/claude keeps its credentials on the Windows side, which
  # otter (running in WSL) cannot use. The launcher loads the WSL login shell (PATH from ~/.profile and ~/.bashrc, e.g.
  # nvm), which needs the console, so the status check is left to the user's terminal.
  Say "next: open a new terminal and run 'otter auth'. Sign in with 'otter login codex' or 'otter login claude'; a CLI shown as 'not found' must be installed inside WSL (for example: npm install -g @openai/codex)."

  Say "done. Run 'otter' in a project folder. Projects inside the WSL file system (e.g. \\wsl$\Ubuntu\home\<you>\project) are faster than C:\ drives."
}
