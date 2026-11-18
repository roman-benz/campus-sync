; Installer-Erweiterungen der Tauri-Version (entspricht build/installer.nsh der Electron-Version)

!macro NSIS_HOOK_PREINSTALL
  ; Umstieg von der Electron-Version: alte Installation still entfernen, bevor die neuen
  ; Verknüpfungen (gleicher Name „Chadoodle“) angelegt werden. Profil und Kursdateien bleiben.
  StrCpy $0 "$LOCALAPPDATA\Programs\moodle-desktop"
  ${If} ${FileExists} "$0\Uninstall Chadoodle.exe"
    ExecWait '"$0\Uninstall Chadoodle.exe" /S _?=$0'
    RMDir /r "$0"
    ; Merken, damit die App nach der Installation startet (electron-updater startet sie nicht neu)
    FileOpen $1 "$TEMP\chadoodle-migrated" w
    FileClose $1
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; Autostart bei der Erstinstallation einrichten (bei Updates bleibt die Einstellung erhalten;
  ; die App gleicht den Eintrag beim Start selbst ab)
  ${If} $UpdateMode <> 1
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "de.rbenz.moodledesktop" '"$INSTDIR\Chadoodle.exe" --hidden'
  ${EndIf}
  ; Nach dem Umstieg von Electron die App wieder starten. War die alte App versteckt, liegt im
  ; gemeinsamen Profil die Markierung „start-hidden“ – dann startet auch die neue versteckt.
  ${If} ${FileExists} "$TEMP\chadoodle-migrated"
    Delete "$TEMP\chadoodle-migrated"
    Exec '"$INSTDIR\Chadoodle.exe"'
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ${If} $UpdateMode <> 1
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "de.rbenz.moodledesktop"
  ${EndIf}
!macroend
