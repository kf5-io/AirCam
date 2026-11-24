; DirectShow virtual camera (64-bit regsvr32 via Sysnative: the installer is 32-bit).
; The Media Foundation camera (resources\mfcam) is experimental and not registered yet: see native/mfcam/README.md.
!macro customInstall
  ExecWait '"$WINDIR\Sysnative\regsvr32.exe" /s "$INSTDIR\resources\softcam\softcam.dll"'
!macroend
!macro customUnInstall
  ExecWait '"$WINDIR\Sysnative\regsvr32.exe" /u /s "$INSTDIR\resources\softcam\softcam.dll"'
!macroend
