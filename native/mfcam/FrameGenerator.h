#pragma once
// AirCam replacement for VCamSample's FrameGenerator (built by .github/workflows/mfcam.yml).
// Frames come from the AirCam app through the shared memory below; CPU path only.

// Shared memory "Global\AirCamMF", created here (the Frame Server can create Global objects, the app can't)
// and opened by the app (src/preload.js). Layout, little endian:
//   0 u32 magic 'ACMF' | 4 u32 width | 8 u32 height | 12 u32 seq (odd while the app writes)
//  16 u64 app GetTickCount64 at last frame | 24 u64 our GetTickCount64 at last read | 64.. BGRA pixels, top-down
#define AIRCAM_MF_NAME L"Global\\AirCamMF"
#define AIRCAM_MF_MAGIC 0x464D4341
#define AIRCAM_MF_HEADER 64
#define AIRCAM_MF_MAX_PIXELS (1920 * 1920)
#define AIRCAM_MF_SIZE (AIRCAM_MF_HEADER + AIRCAM_MF_MAX_PIXELS * 4)

struct AirCamMFHeader
{
	UINT32 magic;
	UINT32 width;
	UINT32 height;
	volatile UINT32 seq;
	volatile UINT64 writerTick;
	volatile UINT64 readerTick;
};

class FrameGenerator
{
	UINT _width;
	UINT _height;
	HANDLE _mapping;
	BYTE* _view;
	wil::com_ptr_nothrow<ID2D1RenderTarget> _renderTarget;
	wil::com_ptr_nothrow<ID2D1SolidColorBrush> _whiteBrush;
	wil::com_ptr_nothrow<IDWriteTextFormat> _textFormat;
	wil::com_ptr_nothrow<IDWriteFactory> _dwrite;
	wil::com_ptr_nothrow<IWICBitmap> _bitmap;

	HRESULT CreateRenderTargetResources(UINT width, UINT height);
	void OpenSharedMemory();
	bool CopyAppFrame();

public:
	FrameGenerator() : _width(0), _height(0), _mapping(nullptr), _view(nullptr) {}
	~FrameGenerator()
	{
		if (_view) UnmapViewOfFile(_view);
		if (_mapping) CloseHandle(_mapping);
	}

	HRESULT SetD3DManager(IUnknown* manager, UINT width, UINT height);
	const bool HasD3DManager() const;
	HRESULT EnsureRenderTarget(UINT width, UINT height);
	HRESULT Generate(IMFSample* sample, REFGUID format, IMFSample** outSample);
};
