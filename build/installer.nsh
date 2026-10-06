; Autostart bei der Installation einrichten (nur Erstinstallation – bei Updates bleibt die
; Einstellung des Nutzers erhalten; die App gleicht den Eintrag beim Start selbst ab).
!macro customInstall
  ${ifNot} ${isUpdated}
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "de.rbenz.moodledesktop" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --hidden'
  ${endIf}
!macroend

!macro customUnInstall
  ${ifNot} ${isUpdated}
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "de.rbenz.moodledesktop"
  ${endIf}
!macroend
