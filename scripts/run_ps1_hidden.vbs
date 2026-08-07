' Launches a .ps1 in this same scripts folder with NO visible window at all.
' Unlike "powershell.exe -WindowStyle Hidden", WScript.Shell.Run(cmd, 0, False)
' never creates a console window in the first place, so there is no create-then-hide
' flash. Windows Task Scheduler tasks running as LogonType=Interactive show that
' flash even with -WindowStyle Hidden, because conhost.exe paints the window before
' powershell.exe gets a chance to apply the hidden style.
'
' Usage: wscript.exe //B //Nologo run_ps1_hidden.vbs <script-name.ps1>

Set oShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

If WScript.Arguments.Count < 1 Then
  WScript.Echo "Usage: run_ps1_hidden.vbs <script-name.ps1>"
  WScript.Quit 1
End If

scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
ps1Path = scriptDir & "\" & WScript.Arguments(0)

cmd = "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File """ & ps1Path & """"
oShell.Run cmd, 0, False
