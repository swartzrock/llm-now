$ErrorActionPreference = 'Stop'
$toolsDir = Split-Path -Parent $MyInvocation.MyCommand.Definition

Install-ChocolateyZipPackage `
  -PackageName $env:ChocolateyPackageName `
  -Url64bit '__WINDOWS_X64_URL__' `
  -Checksum64 '__WINDOWS_X64_SHA256__' `
  -ChecksumType64 'sha256' `
  -UnzipLocation $toolsDir
