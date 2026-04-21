Set oShell = CreateObject("WScript.Shell")
Set oEnv = oShell.Environment("Process")

' Set env var so child process inherits it
oEnv("ELECTRON_EXTRA_LAUNCH_ARGS") = "--remote-debugging-port=9222"

' Try direct exe launch (inherits env var from this process)
Dim tvExe
tvExe = ""

' Check MSIX WindowsApps install (user-provided path takes priority)
Dim fso
Set fso = CreateObject("Scripting.FileSystemObject")
Dim msixBase
msixBase = "C:\Program Files\WindowsApps"
If fso.FolderExists(msixBase) Then
  Dim oFolder, oSubFolder
  Set oFolder = fso.GetFolder(msixBase)
  For Each oSubFolder In oFolder.SubFolders
    If Left(oSubFolder.Name, 18) = "TradingView.Desktop" Then
      Dim candidate
      candidate = oSubFolder.Path & "\TradingView.exe"
      If fso.FileExists(candidate) Then
        tvExe = candidate
        Exit For
      End If
    End If
  Next
End If

' Fall back to classic install paths
If tvExe = "" Then
  Dim paths(2)
  paths(0) = oShell.ExpandEnvironmentStrings("%LOCALAPPDATA%\TradingView\TradingView.exe")
  paths(1) = oShell.ExpandEnvironmentStrings("%PROGRAMFILES%\TradingView\TradingView.exe")
  paths(2) = oShell.ExpandEnvironmentStrings("%PROGRAMFILES(X86)%\TradingView\TradingView.exe")
  Dim i
  For i = 0 To 2
    If fso.FileExists(paths(i)) Then
      tvExe = paths(i)
      Exit For
    End If
  Next
End If

If tvExe <> "" Then
  ' Launch exe directly — inherits ELECTRON_EXTRA_LAUNCH_ARGS from this process
  oShell.Run """" & tvExe & """", 1, False
  WScript.Echo "Launched: " & tvExe
Else
  WScript.Echo "Error: TradingView.exe not found"
End If
