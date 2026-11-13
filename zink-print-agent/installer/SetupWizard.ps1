#Requires -RunAsAdministrator
# Native UI only. No local HTTP listener and no credentials in process arguments.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[Windows.Forms.Application]::EnableVisualStyles()
$Dir = 'C:\ZinkPrintAgent'
$script:verified = $null
$script:saved = $false
$script:started = $false
$created = $false
$setupMutex = New-Object Threading.Mutex($true, 'Global\MOSPrintWizard', [ref]$created)
if (-not $created) { [Windows.Forms.MessageBox]::Show('Another setup wizard is already open.') | Out-Null; exit 1 }
function Invoke-Agent($data) {
  $start = New-Object Diagnostics.ProcessStartInfo
  $start.FileName = "$Dir\zink-print-agent-win.exe"
  $start.Arguments = '--setup-json'
  $start.WorkingDirectory = $Dir
  $start.UseShellExecute = $false
  $start.CreateNoWindow = $true
  $start.RedirectStandardInput = $true
  $start.RedirectStandardOutput = $true
  $start.RedirectStandardError = $true
  $p = New-Object Diagnostics.Process
  $p.StartInfo = $start
  try {
    $p.Start() | Out-Null
    $stdout = $p.StandardOutput.ReadToEndAsync()
    $stderr = $p.StandardError.ReadToEndAsync()
    $p.StandardInput.Write(($data | ConvertTo-Json -Compress))
    $p.StandardInput.Close()
    if (-not $p.WaitForExit(60000)) {
      $p.Kill()
      throw 'Setup timed out. Do not delete enrollment locks; contact support if it persists.'
    }
    $result = $stdout.Result | ConvertFrom-Json
    if ($p.ExitCode -ne 0 -or -not $result.ok) { throw 'Setup failed. Check your shop key, connection, printer support and exact stock. No automatic print was sent.' }
    return $result
  } finally { $p.Dispose() }
}
function Work($operation) {
  $form.Enabled = $false
  $form.UseWaitCursor = $true
  $status.Text = 'Working…'
  $form.Refresh()
  try { & $operation } catch { $status.Text = $_.Exception.Message }
  finally { $form.Enabled = $true; $form.UseWaitCursor = $false }
}
function Label($text, $y) {
  $c = New-Object Windows.Forms.Label
  $c.Text = $text; $c.Location = New-Object Drawing.Point(24, $y)
  $c.Size = New-Object Drawing.Size(680, 25); $form.Controls.Add($c)
}
function Field($y, $value = '') {
  $c = New-Object Windows.Forms.TextBox
  $c.Text = $value; $c.Location = New-Object Drawing.Point(24, $y)
  $c.Size = New-Object Drawing.Size(660, 28); $form.Controls.Add($c)
  return $c
}
function Button($text, $x, $y, $action) {
  $c = New-Object Windows.Forms.Button
  $c.Text = $text; $c.Location = New-Object Drawing.Point($x, $y)
  $c.Size = New-Object Drawing.Size(210, 34); $c.Add_Click($action); $form.Controls.Add($c)
  return $c
}
$form = New-Object Windows.Forms.Form
$form.Text = 'MOS Print — Shop setup'
$form.ClientSize = New-Object Drawing.Size(720, 790)
$form.StartPosition = 'CenterScreen'
$form.Font = New-Object Drawing.Font('Segoe UI', 10)
$form.BackColor = [Drawing.Color]::FromArgb(240, 246, 249)
$form.FormBorderStyle = 'FixedDialog'
$form.MaximizeBox = $false
Label '1. Connect your shop' 18
Label 'Connect in your MOS browser. No API key copying is needed.' 45
$key = Field 73
$key.UseSystemPasswordChar = $true
$key.Visible = $false
$existing = Test-Path "$Dir\config.json"
if ($existing) { $key.Enabled = $false }
$connect = Button 'Connect this computer' 24 73 {
  Work {
    $result = Invoke-Agent @{ action = 'pair-begin' }
    if ($result.approvalUrl) {
      if ($result.approvalUrl -notmatch '^https://mos\.tools/dashboard/settings/printing#pair=[a-f0-9]{64}$') {
        throw 'Unexpected connection URL. Setup stopped.'
      }
      Start-Process $result.approvalUrl
      $status.Text = 'Sign in to MOS, confirm the correct shop, then click Check connection here.'
    } else {
      $script:verified = $result.shop
      $confirm.Text = "I confirm: $($result.shop.name) (shop $($result.shop.shopId))"
      $confirm.Checked = $false
      $status.Text = 'Existing shop connection retained. Confirm this location.'
    }
  }
}
$verify = Button 'Check connection' 24 110 {
  Work {
    $result = Invoke-Agent @{ action = 'pair-check' }
    $script:verified = $result.shop
    $confirm.Text = "I confirm: $($result.shop.name) (shop $($result.shop.shopId))"
    $confirm.Checked = $false
    $status.Text = 'Shop verified. Confirm the location before enrolling a printer.'
  }
}
$confirm = New-Object Windows.Forms.CheckBox
$confirm.Text = 'Verify and confirm your shop'
$confirm.Location = New-Object Drawing.Point(24, 153); $confirm.Size = New-Object Drawing.Size(660, 30)
$form.Controls.Add($confirm)
$key.Add_TextChanged({ $script:verified = $null; $confirm.Checked = $false })
Label '2. Choose a printer and the loaded label stock' 193
$discover = Button 'Find printers' 24 225 {
  Work {
    $result = Invoke-Agent @{ action = 'discover' }
    $printers.Items.Clear()
    foreach ($p in $result.candidates) { $printers.Items.Add($p.uri) | Out-Null }
    $status.Text = 'Select a discovered address, or enter its IPP address. Nothing is selected automatically.'
  }
}
$printers = New-Object Windows.Forms.ComboBox
$printers.Location = New-Object Drawing.Point(24, 269); $printers.Size = New-Object Drawing.Size(660, 28)
$form.Controls.Add($printers)
Label 'Printer name (for example, Front Counter)' 306
$name = Field 335
Label 'Loaded stock in millimetres: width × height (use measured dimensions)' 374
$width = New-Object Windows.Forms.NumericUpDown
$height = New-Object Windows.Forms.NumericUpDown
foreach ($c in @($width, $height)) {
  $c.DecimalPlaces = 2; $c.Minimum = 1; $c.Maximum = 1000
  $c.Size = New-Object Drawing.Size(150, 28); $form.Controls.Add($c)
}
$width.Location = New-Object Drawing.Point(24, 405)
$height.Location = New-Object Drawing.Point(200, 405)
Label 'Sticker printers only. Keytag IPP hardware is not qualified yet.' 443
$save = Button 'Enroll selected printer' 24 480 {
  Work {
    if (-not $script:verified -or -not $confirm.Checked) { throw 'Verify and confirm the correct shop first.' }
    if ([string]::IsNullOrWhiteSpace($name.Text)) { throw 'Enter a printer name.' }
    $task = Get-ScheduledTask -TaskName 'ZinkPrintAgent' -ErrorAction SilentlyContinue
    if ($task) {
      Stop-ScheduledTask -TaskName 'ZinkPrintAgent'
      Disable-ScheduledTask -TaskName 'ZinkPrintAgent' | Out-Null
      Start-Sleep -Seconds 2
    }
    $script:started = $false
    if (Get-CimInstance Win32_Process -Filter "Name='zink-print-agent-win.exe'" |
      Where-Object { $_.ExecutablePath -eq "$Dir\zink-print-agent-win.exe" }) {
      throw 'Close the foreground agent before changing printers. Printing is paused.'
    }
    $result = Invoke-Agent @{
      action = 'save'; key = $key.Text; confirmedShopId = $script:verified.shopId
      uri = $printers.Text; name = $name.Text
      width = [int]($width.Value * 100); height = [int]($height.Value * 100)
    }
    $key.Clear(); $key.Enabled = $false; $script:saved = $true
    $status.Text = "Enrolled $($result.printer.name). No label has been printed. Enable startup when ready."
  }
}
Label '3. Start the agent, then calibrate in MOS' 526
$start = Button 'Enable automatic startup' 24 562 {
  Work {
    if (-not $script:saved) { throw 'Enroll and verify a printer before starting.' }
    $registration = Start-Process powershell.exe -ArgumentList '-NoProfile -ExecutionPolicy Bypass -File "C:\ZinkPrintAgent\startup\Register-ZinkAgent.ps1"' -Wait -PassThru
    if ($registration.ExitCode -ne 0) { throw 'Startup registration failed; the agent was not started.' }
    Start-ScheduledTask -TaskName 'ZinkPrintAgent'
    Start-Sleep -Seconds 2
    if ((Get-ScheduledTask -TaskName 'ZinkPrintAgent').State -ne 'Running') { throw 'The agent did not stay running. Open diagnostics before retrying.' }
    $script:started = $true
    $status.Text = 'Agent running. Open Printing settings, select the destination, and send a calibration label.'
  }
}
$calibrate = Button 'Open Printing settings' 249 562 {
  if ($script:started) { Start-Process 'https://mos.tools/dashboard/settings/printing' }
  else { $status.Text = 'Start the agent first. Calibration requires your normal MOS manager sign-in.' }
}
$logs = Button 'Open diagnostic log' 474 562 {
  $log = "$env:ProgramData\ZinkPrintAgent\zink-print-agent.log"
  if (Test-Path $log) { Start-Process notepad.exe -ArgumentList $log }
  else { $status.Text = 'No agent log yet. Enable startup first.' }
}
Label 'Measure size and cuts, check the QR, then reboot and test again.' 614
Label 'If an outcome is unknown, inspect the printer before printing again.' 642
$status = New-Object Windows.Forms.Label
$status.Location = New-Object Drawing.Point(24, 682); $status.Size = New-Object Drawing.Size(660, 85)
$status.Text = 'Setup does not print automatically. Existing print history is retained during updates.'
$form.Controls.Add($status)
$form.Add_FormClosing({
  if (-not $script:started) {
    $answer = [Windows.Forms.MessageBox]::Show('Setup is incomplete and automatic printing remains paused. Close anyway?', 'Setup incomplete', 'YesNo')
    if ($answer -eq 'No') { $_.Cancel = $true }
  }
})
try { [void]$form.ShowDialog() } finally { $setupMutex.ReleaseMutex(); $setupMutex.Dispose() }
