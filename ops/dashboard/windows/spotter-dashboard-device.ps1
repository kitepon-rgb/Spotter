$ErrorActionPreference = 'Stop'
$spotter = Join-Path $env:APPDATA 'npm\spotter.cmd'
& $spotter dashboard device --id fox-windows --name 'FOX Windows native' --host 127.0.0.1 --port 53944
exit $LASTEXITCODE
