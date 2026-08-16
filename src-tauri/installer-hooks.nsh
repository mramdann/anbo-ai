; "Open in Anbo" shell verbs for folders, folder backgrounds, and drives.
; HKCU matches installer currentUser scope. %V = clicked path.
; NoWorkingDirectory keeps Explorer from overriding %V (System32 on Drive).

!macro NSIS_HOOK_POSTINSTALL
  ; Remove context-menu keys from pre-Anbo installations during migration.
  DeleteRegKey HKCU "Software\Classes\Directory\shell\OpenInTerax"
  DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\OpenInTerax"
  DeleteRegKey HKCU "Software\Classes\Drive\shell\OpenInTerax"

  WriteRegStr HKCU "Software\Classes\Directory\shell\OpenInAnbo" "" "Open in Anbo"
  WriteRegStr HKCU "Software\Classes\Directory\shell\OpenInAnbo" "Icon" '"$INSTDIR\${MAINBINARYNAME}.exe",0'
  WriteRegStr HKCU "Software\Classes\Directory\shell\OpenInAnbo" "NoWorkingDirectory" ""
  WriteRegStr HKCU "Software\Classes\Directory\shell\OpenInAnbo\command" "" '"$INSTDIR\${MAINBINARYNAME}.exe" "%V"'

  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\OpenInAnbo" "" "Open in Anbo"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\OpenInAnbo" "Icon" '"$INSTDIR\${MAINBINARYNAME}.exe",0'
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\OpenInAnbo" "NoWorkingDirectory" ""
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\OpenInAnbo\command" "" '"$INSTDIR\${MAINBINARYNAME}.exe" "%V"'

  WriteRegStr HKCU "Software\Classes\Drive\shell\OpenInAnbo" "" "Open in Anbo"
  WriteRegStr HKCU "Software\Classes\Drive\shell\OpenInAnbo" "Icon" '"$INSTDIR\${MAINBINARYNAME}.exe",0'
  WriteRegStr HKCU "Software\Classes\Drive\shell\OpenInAnbo" "NoWorkingDirectory" ""
  WriteRegStr HKCU "Software\Classes\Drive\shell\OpenInAnbo\command" "" '"$INSTDIR\${MAINBINARYNAME}.exe" "%V"'

  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\App Paths\anbo-browser.exe" "" '"$INSTDIR\anbo-browser.exe"'
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\App Paths\anbo-browser.exe" "Path" "$INSTDIR"
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  DeleteRegKey HKCU "Software\Classes\Directory\shell\OpenInAnbo"
  DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\OpenInAnbo"
  DeleteRegKey HKCU "Software\Classes\Drive\shell\OpenInAnbo"
  ; Also remove context-menu keys left by pre-Anbo installations.
  DeleteRegKey HKCU "Software\Classes\Directory\shell\OpenInTerax"
  DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\OpenInTerax"
  DeleteRegKey HKCU "Software\Classes\Drive\shell\OpenInTerax"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\App Paths\anbo-browser.exe"
!macroend
