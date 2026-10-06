; "Open in Anbo" shell verbs for folders, folder backgrounds, and drives.
; HKCU matches installer currentUser scope. %V = clicked path.
; NoWorkingDirectory keeps Explorer from overriding %V (System32 on Drive).

; Where an update moved anbo.exe and anbo-browser.exe aside, or "".
Var AnboMovedExe
Var AnboMovedSidecar

; The in-app updater starts this installer with /UPDATE and then exits Anbo
; with std::process::exit, so Anbo can still be on its way out when the
; template's running-app check runs right after this hook. That check asks
; Restart Manager to shut down whatever uses anbo.exe and stops the update
; with "Failed to kill Anbo" when that fails. An exiting Anbo is not the only
; user: while an anbo.exe process starts or ends (an agent's hook helper, for
; one), Restart Manager also lists csrss and System, which it can never shut
; down, and the process that started it, which it tries to. So for updates:
; wait until nothing uses anbo.exe, at most 20 s, close the Anbo processes
; still left, then move anbo.exe and anbo-browser.exe aside. Windows lets a
; running executable be renamed, so the check finds nothing to shut down
; and the new files go in under the old names.
!macro NSIS_HOOK_PREINSTALL
  ${If} $UpdateMode = 1
    Push $0
    Push $1
    Push $2
    Push $3
    Push $R7
    Push $R8
    Push $R9
    StrCpy $R9 0
    ; 20 s of clock time: each Restart Manager query slows down while many
    ; processes start, so a count of polls ran past a minute.
    System::Call 'kernel32::GetTickCount() i .R7'
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
      System::Call 'kernel32::GetTickCount() i .r1'
      IntOp $1 $1 - $R7
      ${If} $0 = ${ERROR_MORE_DATA}
      ${AndIf} $1 < 20000
        ${IfThen} $R9 = 0 ${|} DetailPrint "Waiting for Anbo to close..." ${|}
        Sleep 250
        IntOp $R9 $R9 + 1
        Goto anbo_wait_for_exit
      ${EndIf}
    ${IfThen} $0 = ${ERROR_MORE_DATA} ${|} Call AnboCloseLeftoverAnbo ${|}
    Push "$INSTDIR\${MAINBINARYNAME}.exe"
    Call AnboMoveAside
    Pop $AnboMovedExe
    Push "$INSTDIR\anbo-browser.exe"
    Call AnboMoveAside
    Pop $AnboMovedSidecar
    Pop $R9
    Pop $R8
    Pop $R7
    Pop $3
    Pop $2
    Pop $1
    Pop $0
  ${EndIf}
!macroend

; Still in use after the wait: names every process Restart Manager sees using
; anbo.exe, in the installer details and in %TEMP%\anbo-update-check.txt, then
; closes the Anbo processes still running. Restart Manager cannot be trusted
; for that: while other anbo.exe processes come and go it can list nothing at
; all, and a running Anbo then stays open next to the one the update starts.
; They are found by name instead, as the Tauri template did before 2.12, which
; matches only this user's anbo.exe processes; anything else that holds the
; file (a scanner, Explorer, the agent that started a hook helper) is left to
; the move aside. RM_PROCESS_INFO is 668 bytes: pid at 0, strAppName[256] at
; 12, strServiceShortName[64] at 524, then ApplicationType, AppStatus and
; TSSessionId from 652.
Function AnboCloseLeftoverAnbo
  Push $0
  Push $1
  Push $2
  Push $3
  Push $4
  Push $5
  Push $6
  Push $7
  Push $8
  Push $9
  Push $R0
  Push $R1
  Push $R2
  Push $R3
  Push $R4
  Push $R7
  !insertmacro RestartManager_StartSession $R0
  ${If} $R0 != ""
    !insertmacro RestartManager_RegisterFile $R0 "$INSTDIR\${MAINBINARYNAME}.exe"
    ${If} $0 = 0
      System::Alloc 6680
      Pop $R1
      StrCpy $2 10
      System::Call 'RSTRTMGR::RmGetList(p R0, *i .r1, *i r2r2, p R1, *i .r3) i .r0'
      ${IfThen} $0 <> 0 ${|} StrCpy $2 0 ${|}
      FileOpen $R2 "$TEMP\anbo-update-check.txt" w
      DetailPrint "Still in use after the wait (RmGetList $0, $1 process(es)):"
      FileWrite $R2 "RmGetList $0, $1 process(es), reboot reasons $3$\r$\n"
      StrCpy $R3 0
      ${DoWhile} $R3 < $2
        IntOp $R4 $R3 * 668
        IntOp $R4 $R4 + $R1
        System::Call '*$R4(i .r4)'
        IntOp $9 $R4 + 12
        System::Call '*$9(&w256 .r5)'
        IntOp $9 $R4 + 524
        System::Call '*$9(&w64 .r6)'
        IntOp $9 $R4 + 652
        System::Call '*$9(i .r7, i .r8, i .r9)'
        Push $4
        Call AnboProcessImage
        Pop $R7
        DetailPrint "  pid $4 '$5' service '$6' type $7 status $8 session $9 image '$R7'"
        FileWrite $R2 "pid $4 '$5' service '$6' type $7 status $8 session $9 image '$R7'$\r$\n"
        IntOp $R3 $R3 + 1
      ${Loop}
      FileClose $R2
      System::Free $R1
    ${EndIf}
    !insertmacro RestartManager_EndSession $R0
  ${EndIf}
  nsis_tauri_utils::FindProcessCurrentUser "${MAINBINARYNAME}.exe"
  Pop $0
  ${If} $0 = 0
    nsis_tauri_utils::KillProcessCurrentUser "${MAINBINARYNAME}.exe"
    Pop $0
    DetailPrint "Closed the Anbo processes still running: $0"
    FileOpen $R2 "$TEMP\anbo-update-check.txt" a
    FileSeek $R2 0 END
    FileWrite $R2 "closed the Anbo processes still running: $0$\r$\n"
    FileClose $R2
    Sleep 500
  ${EndIf}
  Pop $R7
  Pop $R4
  Pop $R3
  Pop $R2
  Pop $R1
  Pop $R0
  Pop $9
  Pop $8
  Pop $7
  Pop $6
  Pop $5
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Pop $0
FunctionEnd

; Replaces the pid on the stack with that process's full image path, or ""
; when the process cannot be queried (csrss, System, another user's).
Function AnboProcessImage
  Exch $0
  Push $1
  Push $2
  StrCpy $2 ""
  System::Call 'kernel32::OpenProcess(i 0x1000, i 0, i r0) p .r1'
  ${If} $1 P<> 0
    System::Call 'kernel32::QueryFullProcessImageNameW(p r1, i 0, w .r2, *i ${NSIS_MAX_STRLEN}) i .r0'
    ${IfThen} $0 = 0 ${|} StrCpy $2 "" ${|}
    System::Call 'kernel32::CloseHandle(p r1)'
  ${EndIf}
  StrCpy $0 $2
  Pop $2
  Pop $1
  Exch $0
FunctionEnd

; Renames the file on the stack to <file>.<tick>.old and replaces it with the
; new name, or with "" when there is no such file or it cannot be moved (a
; holder that does not allow it), in which case the update goes on as before.
Function AnboMoveAside
  Exch $0
  Push $1
  Push $2
  StrCpy $1 ""
  ${If} ${FileExists} "$0"
    StrCpy $2 0
    ${Do}
      System::Call 'kernel32::GetTickCount() i .r1'
      IntFmt $1 "%u" $1
      StrCpy $1 "$0.$1.old"
      ClearErrors
      Rename "$0" "$1"
      ${IfNot} ${Errors}
        DetailPrint "Moved $0 aside"
        ${Break}
      ${EndIf}
      StrCpy $1 ""
      IntOp $2 $2 + 1
      ${If} $2 >= 10
        DetailPrint "Could not move $0 aside"
        ${Break}
      ${EndIf}
      Sleep 100
    ${Loop}
  ${EndIf}
  StrCpy $0 $1
  Pop $2
  Pop $1
  Exch $0
FunctionEnd

; An update that stops after moving the old files aside puts them back, so
; the installed Anbo still starts.
Function .onInstFailed
  ${If} $AnboMovedExe != ""
    Delete "$INSTDIR\${MAINBINARYNAME}.exe"
    Rename "$AnboMovedExe" "$INSTDIR\${MAINBINARYNAME}.exe"
  ${EndIf}
  ${If} $AnboMovedSidecar != ""
    Delete "$INSTDIR\anbo-browser.exe"
    Rename "$AnboMovedSidecar" "$INSTDIR\anbo-browser.exe"
  ${EndIf}
FunctionEnd

; The files an update moved aside. One that something still runs cannot be
; deleted yet and goes with the next update or the uninstall.
!macro AnboRemoveMovedAside
  Delete "$INSTDIR\${MAINBINARYNAME}.exe.*.old"
  Delete "$INSTDIR\anbo-browser.exe.*.old"
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

  !insertmacro AnboRemoveMovedAside
!macroend

; Before the template's uninstall, so its RMDir finds the folder empty.
!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro AnboRemoveMovedAside
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
