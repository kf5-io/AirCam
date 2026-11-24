# Caméra virtuelle Media Foundation (Windows 11) — expérimental

But : une caméra visible aussi par l'app Caméra de Windows et les apps du Store (la caméra DirectShow `softcam` ne l'est pas).

- `FrameGenerator.*` remplace celui de [VCamSample](https://github.com/smourier/VCamSample) (MIT) : la source lit les images
  que l'app écrit dans la mémoire partagée `Global\AirCamMF` (format dans `FrameGenerator.h`, écriture dans `src/preload.js`).
- `aircam-mfcam.exe install|remove` déclare la caméra (`MFCreateVirtualCamera`, durée de vie System, tous les utilisateurs).
- `.github/workflows/mfcam.yml` compile tout (release `mfcam-v1`, avec une version debug tracée en ETW).

**État** : la caméra s'enregistre (« AirCam (Caméra virtuelle Windows) » apparaît dans les applications, format 1920×1080
négocié par le Frame Server) mais le flux ne démarre pas (« Device in use » dans Chromium, erreur d'E/S dans ffmpeg).
La version debug ne reçoit aucun appel pendant ces tentatives. Désactivée par défaut : l'app ne l'installe que si
`AIRCAM_MF=1`, l'installeur ne l'installe pas.

Pistes : tester le VCamSample d'origine sur la même machine (le problème vient-il de nos modifications ?), lire le journal
`Microsoft-Windows-MF-FrameServer/Camera_FrameServer`, vérifier l'accès du service Frame Server à la DLL.
