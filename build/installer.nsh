# The previous copy may sit in the folder named by the old product name; installing beside it keeps every copy at Programs\OneLaunch, and otherwise a hand-run install nests into One Launch\OneLaunch (electron-builder appends the app folder name to a path that lacks it).
!macro leaveOldProductFolder
  ${if} $perUserInstallationFolder != ""
  ${andIf} $INSTDIR == $perUserInstallationFolder
    Push $0
    StrCpy $0 $INSTDIR "" -11
    ${if} $0 == "\One Launch"
      StrCpy $INSTDIR $INSTDIR -11
      StrCpy $INSTDIR "$INSTDIR\OneLaunch"
    ${endIf}
    Pop $0
  ${endIf}
!macroend

# A silent update shows no pages, so .onInit decides the folder.
!macro customInit
  !insertmacro leaveOldProductFolder
!macroend

# The wizard's install mode page reads the folder from the registry again when it is left, so its leave function decides it there; customInstallMode is expanded inside that page, where the define lands on it.
!macro customHeader
  !ifndef BUILD_UNINSTALLER
    Function leaveOldProductFolderOnLeave
      !insertmacro leaveOldProductFolder
    FunctionEnd
  !endif
!macroend

!macro customInstallMode
  !ifndef BUILD_UNINSTALLER
    !define MUI_PAGE_CUSTOMFUNCTION_LEAVE leaveOldProductFolderOnLeave
  !endif
!macroend

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
