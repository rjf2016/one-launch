!macro customInstall
  Push $0
  Push $1
  ReadRegStr $0 HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "OneLaunch"
  ${if} $0 != ""
    StrLen $1 '"$appExe"'
    StrCpy $1 $0 $1
    ${if} $installMode == "all"
    ${orIf} $1 != '"$appExe"'
      DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "OneLaunch"
      DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "OneLaunch"
    ${endIf}
  ${endIf}
  Pop $1
  Pop $0
!macroend

!macro customUnInstall
  ${ifNot} ${isUpdated}
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "OneLaunch"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "OneLaunch"
  ${endIf}
!macroend
