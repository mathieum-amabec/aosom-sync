#!/usr/bin/env pwsh
# Start the Next.js dev server under an x64 Node runtime.
#
# Why: this is a Windows ARM64 machine, but several native deps (libsql,
# rolldown via vitest, @next/swc) publish NO win32-arm64-msvc build — only
# win32-x64-msvc. The system Node/Bun are arm64, so they fail to load the
# native bindings. Windows ARM emulates x64, so we run under a portable x64
# Node. Deps must also be installed under x64 (use: bun-x64 install).
#
# Usage:  .\dev.ps1            # next dev on port 3000
#         .\dev.ps1 -p 3001    # extra args are forwarded to `next dev`
$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $MyInvocation.MyCommand.Path

$nodeX64 = if ($env:AOSOM_NODE_X64) { $env:AOSOM_NODE_X64 } else { Join-Path $env:USERPROFILE "node-x64\node.exe" }
if (-not (Test-Path $nodeX64)) {
  Write-Error "x64 Node not found at '$nodeX64'. Download the win-x64 zip from https://nodejs.org/dist and extract to %USERPROFILE%\node-x64, or set `$env:AOSOM_NODE_X64."
  exit 1
}
$arch = & $nodeX64 -p "process.arch"
if ($arch -ne "x64") { Write-Error "Expected an x64 Node at '$nodeX64' but got '$arch'."; exit 1 }

# Put x64 Node first on PATH so any child processes (next workers) inherit it.
$env:Path = "$(Split-Path -Parent $nodeX64);$env:Path"
$next = Join-Path $repo "node_modules\next\dist\bin\next"
& $nodeX64 $next dev @args
exit $LASTEXITCODE
