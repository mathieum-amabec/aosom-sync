#!/usr/bin/env pwsh
# Run the vitest suite under an x64 Node runtime.
#
# Why: this is a Windows ARM64 machine, but several native deps (libsql,
# rolldown via vitest, @next/swc) publish NO win32-arm64-msvc build — only
# win32-x64-msvc. The system Node/Bun are arm64, so they fail to load the
# native bindings. Windows ARM emulates x64, so we run under a portable x64
# Node. Deps must also be installed under x64 (use: bun-x64 install).
#
# Usage:  .\test.ps1                          # run the whole suite once
#         .\test.ps1 tests/database.test.ts   # extra args forwarded to vitest
$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $MyInvocation.MyCommand.Path

$nodeX64 = if ($env:AOSOM_NODE_X64) { $env:AOSOM_NODE_X64 } else { Join-Path $env:USERPROFILE "node-x64\node.exe" }
if (-not (Test-Path $nodeX64)) {
  Write-Error "x64 Node not found at '$nodeX64'. Download the win-x64 zip from https://nodejs.org/dist and extract to %USERPROFILE%\node-x64, or set `$env:AOSOM_NODE_X64."
  exit 1
}
$arch = & $nodeX64 -p "process.arch"
if ($arch -ne "x64") { Write-Error "Expected an x64 Node at '$nodeX64' but got '$arch'."; exit 1 }

$env:Path = "$(Split-Path -Parent $nodeX64);$env:Path"
$vitest = Join-Path $repo "node_modules\vitest\vitest.mjs"
& $nodeX64 $vitest run @args
exit $LASTEXITCODE
