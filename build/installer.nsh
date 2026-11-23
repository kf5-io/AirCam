; Registers the AirCam virtual camera (softcam DLL) system-wide. 64-bit regsvr32 via Sysnative (the installer is 32-bit).
!macro customInstall
  ExecWait '"$WINDIR\Sysnative\regsvr32.exe" /s "$INSTDIR\resources\softcam\softcam.dll"'
!macroend
!macro customUnInstall
  ExecWait '"$WINDIR\Sysnative\regsvr32.exe" /u /s "$INSTDIR\resources\softcam\softcam.dll"'
!macroend
