// Registers / removes the AirCam Media Foundation virtual camera (Windows 11+). Needs admin.
//   aircam-mfcam.exe install   -> camera "AirCam" for all users, persists across reboots
//   aircam-mfcam.exe remove
// The media source itself is AirCamMF.dll (regsvr32 first). Exit code: 0 ok, 2 not Windows 11, else HRESULT.
#include <windows.h>
#include <mfapi.h>
#include <mfvirtualcamera.h>
#include <cstdio>
#pragma comment(lib, "ole32")
#pragma comment(lib, "mfplat")

static const wchar_t* SOURCE_CLSID = L"{1576B23A-51A4-4423-96FE-2388C2ED1EB0}"; // must match dllmain.cpp patch in mfcam.yml

typedef HRESULT(WINAPI* CreateVCam)(MFVirtualCameraType, MFVirtualCameraLifetime, MFVirtualCameraAccess, LPCWSTR, LPCWSTR, const GUID*, ULONG, IMFVirtualCamera**);

int wmain(int argc, wchar_t** argv)
{
	bool remove = argc > 1 && !_wcsicmp(argv[1], L"remove");
	if (argc < 2 || (!remove && _wcsicmp(argv[1], L"install"))) { fwprintf(stderr, L"usage: aircam-mfcam install|remove\n"); return 1; }

	// mfsensorgroup.dll only has MFCreateVirtualCamera on Windows 11: resolve it at run time.
	auto lib = LoadLibraryW(L"mfsensorgroup.dll");
	auto create = lib ? (CreateVCam)GetProcAddress(lib, "MFCreateVirtualCamera") : nullptr;
	if (!create) { fwprintf(stderr, L"Media Foundation virtual cameras need Windows 11\n"); return 2; }

	CoInitializeEx(nullptr, COINIT_MULTITHREADED);
	MFStartup(MF_VERSION);
	IMFVirtualCamera* cam = nullptr;
	HRESULT hr = create(MFVirtualCameraType_SoftwareCameraSource, MFVirtualCameraLifetime_System, MFVirtualCameraAccess_AllUsers,
		L"AirCam", SOURCE_CLSID, nullptr, 0, &cam);
	if (SUCCEEDED(hr)) hr = remove ? cam->Remove() : cam->Start(nullptr);
	if (cam) cam->Release(); // no Shutdown(): it would unregister a System-lifetime camera
	MFShutdown();
	CoUninitialize();
	fwprintf(SUCCEEDED(hr) ? stdout : stderr, L"%s: 0x%08X\n", remove ? L"remove" : L"install", (unsigned)hr);
	return SUCCEEDED(hr) ? 0 : (int)hr;
}
