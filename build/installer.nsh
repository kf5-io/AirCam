; Virtual cameras (64-bit regsvr32 via Sysnative: the installer is 32-bit).
; DirectShow: softcam.dll in place. Media Foundation (Windows 11): AirCamMF.dll copied to ProgramData (the Frame Server
; service must be able to read it), then declared with aircam-mfcam.exe (exits 2 on Windows 10, harmless).
!macro customInstall
  ExecWait '"$WINDIR\Sysnative\regsvr32.exe" /s "$INSTDIR\resources\softcam\softcam.dll"'
  SetShellVarContext all
  CreateDirectory "$APPDATA\AirCam"
  CopyFiles /SILENT "$INSTDIR\resources\mfcam\AirCamMF.dll" "$APPDATA\AirCam"
  ExecWait '"$WINDIR\Sysnative\regsvr32.exe" /s "$APPDATA\AirCam\AirCamMF.dll"'
  ExecWait '"$INSTDIR\resources\mfcam\aircam-mfcam.exe" install'
!macroend
!macro customUnInstall
  SetShellVarContext all
  ExecWait '"$INSTDIR\resources\mfcam\aircam-mfcam.exe" remove'
  ExecWait '"$WINDIR\Sysnative\regsvr32.exe" /u /s "$APPDATA\AirCam\AirCamMF.dll"'
  Delete "$APPDATA\AirCam\AirCamMF.dll"
  RMDir "$APPDATA\AirCam"
  ExecWait '"$WINDIR\Sysnative\regsvr32.exe" /u /s "$INSTDIR\resources\softcam\softcam.dll"'
!macroend
