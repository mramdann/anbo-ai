; "Open in Anbo" shell verbs for folders, folder backgrounds, and drives.
; HKCU matches installer currentUser scope. %V = clicked path.
; NoWorkingDirectory keeps Explorer from overriding %V (System32 on Drive).

; The in-app updater starts this installer with /UPDATE and then exits Anbo
; with std::process::exit, so Anbo can still be on its way out when the
; template's running-app check runs right after this hook. That check asks
; Restart Manager to shut down whatever uses anbo.exe, and a process that is
; already exiting cannot be shut down, so the update stopped with "Failed to
; kill Anbo" (tauri-apps/tauri#12309). For updates, wait until nothing uses
; anbo.exe, at most 20 s, then let the check run as before.
!macro NSIS_HOOK_PREINSTALL
  ${If} $UpdateMode = 1
    Push $0
    Push $1
    Push $2
    Push $3
    Push $R8
    Push $R9
    StrCpy $R9 0
    anbo_wait_for_exit:
      StrCpy $0 0
      !insertmacro RestartManager_StartSession $R8
      ${If} $R8 != ""
        !insertmacro RestartManager_RegisterFile $R8 "$INSTDIR\${MAINBINARYNAME}.exe"
        ${If} $0 = 0
          ; ERROR_MORE_DATA: some process still uses anbo.exe
          System::Call 'RSTRTMGR::RmGetList(p R8, *i .r1, *i .r2, p 0, *i .r3) i .r0'
        ${EndIf}
        !insertmacro RestartManager_EndSession $R8
      ${EndIf}
      ${If} $0 = ${ERROR_MORE_DATA}
      ${AndIf} $R9 < 80
        ${IfThen} $R9 = 0 ${|} DetailPrint "Waiting for Anbo to close..." ${|}
        Sleep 250
        IntOp $R9 $R9 + 1
        Goto anbo_wait_for_exit
      ${EndIf}
    Pop $R9
    Pop $R8
    Pop $3
    Pop $2
    Pop $1
    Pop $0
  ${EndIf}
!macroend

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

  ; NTFS keeps the old directory-entry casing when a file is overwritten in
  ; place, so upgrades from lowercase-productName installs would keep showing
  ; "anbo" in the Start Menu. Force-rename via a temp name to apply "Anbo".
  ; Rename only succeeds when the shortcut exists, so fresh installs with
  ; shortcut creation disabled are unaffected.
  Rename "$SMPROGRAMS\anbo.lnk" "$SMPROGRAMS\Anbo.tmp.lnk"
  Rename "$SMPROGRAMS\Anbo.tmp.lnk" "$SMPROGRAMS\Anbo.lnk"
  Rename "$DESKTOP\anbo.lnk" "$DESKTOP\Anbo.tmp.lnk"
  Rename "$DESKTOP\Anbo.tmp.lnk" "$DESKTOP\Anbo.lnk"
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
