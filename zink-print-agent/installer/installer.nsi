Unicode True
!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "x64.nsh"
Name "MOS Print Setup"
OutFile "..\..\generated-artifacts\mos-print-installer\MOS-Print-Setup-pilot.exe"
InstallDir "C:\ZinkPrintAgent"
RequestExecutionLevel admin
SetCompressor /SOLID lzma
!define MUI_WELCOMEPAGE_TITLE "Set up MOS shop printing"
!define MUI_WELCOMEPAGE_TEXT "Install the print agent, connect your shop, and enroll your printer.$\r$\n$\r$\nThis is an unsigned pilot build. Windows installation, reboot and physical printer qualification are still pending. Do not distribute as a production release.$\r$\n$\r$\nUpdates pause printing until setup finishes. Existing enrollment and print history are preserved. Existing TCP installations require a reviewed migration."
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_INSTFILES
!define MUI_FINISHPAGE_RUN "$SYSDIR\WindowsPowerShell\v1.0\powershell.exe"
!define MUI_FINISHPAGE_RUN_PARAMETERS "-NoProfile -ExecutionPolicy Bypass -File C:\ZinkPrintAgent\SetupWizard.ps1"
!define MUI_FINISHPAGE_RUN_TEXT "Open the shop setup wizard"
!define MUI_FINISHPAGE_TEXT "Files installed. Printing remains paused until you finish the setup wizard. Use the Start menu shortcut to resume.$\r$\n$\r$\nDo not delete print journals to resolve an uncertain print."
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"
Function .onInit
  ${IfNot} ${RunningX64}
    MessageBox MB_ICONSTOP "This installer requires 64-bit Windows."
    Abort
  ${EndIf}
  System::Call 'kernel32::CreateMutexW(p0, i0, w "Global\MOSPrintInstaller") p.r0 ?e'
  Pop $1
  ${If} $1 = 183
    MessageBox MB_ICONSTOP "Another MOS installer is running."
    Abort
  ${EndIf}
FunctionEnd
Section
  InitPluginsDir
  SetOutPath "$PLUGINSDIR"
  File "Prepare.ps1"
  ExecWait '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$PLUGINSDIR\Prepare.ps1"' $0
  ${If} $0 != 0
    Abort "Preparation failed. Existing print records were retained."
  ${EndIf}
  SetOutPath "$INSTDIR"
  ClearErrors
  File "..\dist\pilot\zink-print-agent-win.exe"
  File "SetupWizard.ps1"
  File "..\dist\pilot\config.ipp.example.json"
  File "..\dist\pilot\SAVED-IPP-RUNBOOK.md"
  SetOutPath "$INSTDIR\startup"
  File "..\dist\pilot\startup\Register-ZinkAgent.ps1"
  ${If} ${Errors}
    Abort "Installation failed. Printing remains paused; repair the installation before starting."
  ${EndIf}
  SetShellVarContext all
  CreateDirectory "$SMPROGRAMS\MOS Print"
  CreateShortcut "$SMPROGRAMS\MOS Print\Shop Setup.lnk" "$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" '-NoProfile -Command "Start-Process powershell.exe -Verb RunAs -ArgumentList $\'-NoProfile -ExecutionPolicy Bypass -File C:\ZinkPrintAgent\SetupWizard.ps1$\'"'
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\MOSPrint" "DisplayName" "MOS Print (pilot)"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\MOSPrint" "UninstallString" '"$INSTDIR\Uninstall.exe"'
SectionEnd
Section "Uninstall"
  ExecWait '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -Command "Get-ScheduledTask -TaskName ZinkPrintAgent -ErrorAction SilentlyContinue | Stop-ScheduledTask; Get-ScheduledTask -TaskName ZinkPrintAgent -ErrorAction SilentlyContinue | Unregister-ScheduledTask -Confirm:$$false"' $0
  ${If} $0 != 0
    Abort "Could not remove automatic startup. No files were removed."
  ${EndIf}
  Delete "$INSTDIR\zink-print-agent-win.exe"
  Delete "$INSTDIR\SetupWizard.ps1"
  Delete "$INSTDIR\startup\Register-ZinkAgent.ps1"
  Delete "$INSTDIR\Uninstall.exe"
  SetShellVarContext all
  Delete "$SMPROGRAMS\MOS Print\Shop Setup.lnk"
  RMDir "$SMPROGRAMS\MOS Print"
  DeleteRegKey HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\MOSPrint"
  MessageBox MB_OK "Program removed. Shop configuration, credentials, printer enrollment and print journals were retained for safe recovery. Revoke the dedicated shop key in MOS if retiring this computer."
SectionEnd
