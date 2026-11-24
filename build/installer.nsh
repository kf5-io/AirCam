; DirectShow virtual camera (64-bit regsvr32 via Sysnative: the installer is 32-bit).
; The Media Foundation camera (resources\mfcam) is experimental and not registered yet: see native/mfcam/README.md.
; Updates: an app using the camera (Discord, Zoom…) keeps softcam.dll loaded, so it can't be overwritten. A loaded
; DLL can still be renamed: move it aside, the new one is copied next, the old file goes at the next reboot.
!macro customInit
  IfFileExists "$INSTDIR\resources\softcam\softcam.dll" 0 +4
    Delete "$INSTDIR\resources\softcam\softcam.dll.old"
    Rename "$INSTDIR\resources\softcam\softcam.dll" "$INSTDIR\resources\softcam\softcam.dll.old"
    Delete /REBOOTOK "$INSTDIR\resources\softcam\softcam.dll.old"
!macroend
!macro customInstall
  ExecWait '"$WINDIR\Sysnative\regsvr32.exe" /s "$INSTDIR\resources\softcam\softcam.dll"'
!macroend
!macro customUnInstall
  ExecWait '"$WINDIR\Sysnative\regsvr32.exe" /u /s "$INSTDIR\resources\softcam\softcam.dll"'
!macroend
