#Requires -RunAsAdministrator
$ErrorActionPreference = 'Stop'
$Dir = 'C:\ZinkPrintAgent'
try {
  if (Test-Path $Dir) {
    $items = @((Get-Item -LiteralPath $Dir)) + @(Get-ChildItem -LiteralPath $Dir -Force -Recurse)
    if ($items | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }) {
      throw 'Linked installation paths are not supported.'
    }
    if (Test-Path "$Dir\config.json") {
      $cfg = Get-Content "$Dir\config.json" -Raw | ConvertFrom-Json
      if (-not $cfg.ipp) { throw 'Existing TCP installation was preserved. Contact MOS for a reviewed migration.' }
    }
  }
  $task = Get-ScheduledTask -TaskName 'ZinkPrintAgent' -ErrorAction SilentlyContinue
  if ($task) {
    Stop-ScheduledTask -TaskName 'ZinkPrintAgent'
    Disable-ScheduledTask -TaskName 'ZinkPrintAgent' | Out-Null
    Start-Sleep -Seconds 2
  }
  $processes = Get-CimInstance Win32_Process -Filter "Name='zink-print-agent-win.exe'"
  if ($processes | Where-Object { $_.ExecutablePath -eq "$Dir\zink-print-agent-win.exe" }) {
    throw 'Close the running foreground print agent before installing. Startup has been paused.'
  }
  New-Item -ItemType Directory -Path $Dir -Force | Out-Null
  $acl = New-Object Security.AccessControl.DirectorySecurity
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($sid in @('S-1-5-18', 'S-1-5-32-544')) {
    $identity = New-Object Security.Principal.SecurityIdentifier($sid)
    $rule = New-Object Security.AccessControl.FileSystemAccessRule($identity, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
    $acl.AddAccessRule($rule)
  }
  Set-Acl -LiteralPath $Dir -AclObject $acl
  foreach ($item in @(Get-ChildItem -LiteralPath $Dir -Force -Recurse)) {
    $childAcl = if ($item.PSIsContainer) { New-Object Security.AccessControl.DirectorySecurity } else { New-Object Security.AccessControl.FileSecurity }
    $childAcl.SetAccessRuleProtection($true, $false)
    foreach ($sid in @('S-1-5-18', 'S-1-5-32-544')) {
      $identity = New-Object Security.Principal.SecurityIdentifier($sid)
      $rule = if ($item.PSIsContainer) {
        New-Object Security.AccessControl.FileSystemAccessRule($identity, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
      } else { New-Object Security.AccessControl.FileSystemAccessRule($identity, 'FullControl', 'Allow') }
      $childAcl.AddAccessRule($rule)
    }
    Set-Acl -LiteralPath $item.FullName -AclObject $childAcl
  }
  exit 0
} catch {
  Add-Type -AssemblyName System.Windows.Forms
  [Windows.Forms.MessageBox]::Show($_.Exception.Message, 'MOS Print setup stopped') | Out-Null
  exit 1
}
