param([Parameter(Mandatory = $true)][string]$MainServer)
$ErrorActionPreference = 'Stop'
& "$env:WINDIR\System32\OpenSSH\ssh.exe" -N `
  -o BatchMode=yes -o ExitOnForwardFailure=yes `
  -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -o TCPKeepAlive=yes `
  -R '127.0.0.1:53943:127.0.0.1:53944' $MainServer
exit $LASTEXITCODE
