#include "pch.h"
#include "Undocumented.h"
#include "Tools.h"
#include "EnumNames.h"
#include "MFTools.h"
#include "FrameGenerator.h"
#include <sddl.h>
#include <algorithm>
#pragma comment(lib, "advapi32")

// CPU only: frames are copied from the app's shared memory into a WIC bitmap, then into the MF sample.
const bool FrameGenerator::HasD3DManager() const { return false; }
HRESULT FrameGenerator::SetD3DManager(IUnknown*, UINT, UINT) { return S_OK; }

void FrameGenerator::OpenSharedMemory()
{
	if (_view) return;
	// SYSTEM, LocalService (Frame Server), admins: full; interactive users (the AirCam app): read/write.
	PSECURITY_DESCRIPTOR sd = nullptr;
	if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(L"D:P(A;;GA;;;SY)(A;;GA;;;LS)(A;;GA;;;BA)(A;;GRGW;;;IU)", SDDL_REVISION_1, &sd, nullptr))
		return;
	SECURITY_ATTRIBUTES sa{ sizeof(sa), sd, FALSE };
	_mapping = CreateFileMappingW(INVALID_HANDLE_VALUE, &sa, PAGE_READWRITE, 0, AIRCAM_MF_SIZE, AIRCAM_MF_NAME);
	LocalFree(sd);
	if (!_mapping)
	{
		WINTRACE(L"AirCam CreateFileMapping failed: %u", GetLastError());
		return;
	}
	_view = (BYTE*)MapViewOfFile(_mapping, FILE_MAP_ALL_ACCESS, 0, 0, AIRCAM_MF_SIZE);
	if (!_view) { CloseHandle(_mapping); _mapping = nullptr; }
}

HRESULT FrameGenerator::EnsureRenderTarget(UINT width, UINT height)
{
	OpenSharedMemory();
	if (_renderTarget) return S_OK;

	wil::com_ptr_nothrow<ID2D1Factory> d2d1Factory;
	RETURN_IF_FAILED(D2D1CreateFactory(D2D1_FACTORY_TYPE_MULTI_THREADED, IID_PPV_ARGS(&d2d1Factory)));
	wil::com_ptr_nothrow<IWICImagingFactory> wicFactory;
	RETURN_IF_FAILED(CoCreateInstance(CLSID_WICImagingFactory, nullptr, CLSCTX_ALL, IID_PPV_ARGS(&wicFactory)));
	RETURN_IF_FAILED(wicFactory->CreateBitmap(width, height, GUID_WICPixelFormat32bppPBGRA, WICBitmapCacheOnDemand, &_bitmap));

	D2D1_RENDER_TARGET_PROPERTIES props{};
	props.pixelFormat.format = DXGI_FORMAT_B8G8R8A8_UNORM;
	props.pixelFormat.alphaMode = D2D1_ALPHA_MODE_PREMULTIPLIED;
	RETURN_IF_FAILED(d2d1Factory->CreateWicBitmapRenderTarget(_bitmap.get(), props, &_renderTarget));
	return CreateRenderTargetResources(width, height);
}

HRESULT FrameGenerator::CreateRenderTargetResources(UINT width, UINT height)
{
	RETURN_IF_FAILED(_renderTarget->CreateSolidColorBrush(D2D1::ColorF(0.6f, 0.6f, 0.65f, 1), &_whiteBrush));
	RETURN_IF_FAILED(DWriteCreateFactory(DWRITE_FACTORY_TYPE_SHARED, __uuidof(IDWriteFactory), (IUnknown**)&_dwrite));
	RETURN_IF_FAILED(_dwrite->CreateTextFormat(L"Segoe UI", nullptr, DWRITE_FONT_WEIGHT_SEMI_BOLD, DWRITE_FONT_STYLE_NORMAL, DWRITE_FONT_STRETCH_NORMAL, 44, L"", &_textFormat));
	RETURN_IF_FAILED(_textFormat->SetParagraphAlignment(DWRITE_PARAGRAPH_ALIGNMENT_CENTER));
	RETURN_IF_FAILED(_textFormat->SetTextAlignment(DWRITE_TEXT_ALIGNMENT_CENTER));
	_width = width;
	_height = height;
	return S_OK;
}

// App frame (any size <= 1920x1920) -> our bitmap, aspect kept (letterbox), nearest neighbour. False if the app isn't feeding us.
bool FrameGenerator::CopyAppFrame()
{
	if (!_view || !_bitmap) return false;
	auto h = (AirCamMFHeader*)_view;
	auto now = GetTickCount64();
	h->readerTick = now; // tells the app someone is watching
	UINT sw = h->width, sh = h->height;
	if (h->magic != AIRCAM_MF_MAGIC || now - h->writerTick > 1500 || !sw || !sh || (UINT64)sw * sh > AIRCAM_MF_MAX_PIXELS) return false;

	wil::com_ptr_nothrow<IWICBitmapLock> lock;
	if (FAILED(_bitmap->Lock(nullptr, WICBitmapLockWrite, &lock))) return false;
	UINT stride = 0, size = 0;
	WICInProcPointer dst = nullptr;
	if (FAILED(lock->GetStride(&stride)) || FAILED(lock->GetDataPointer(&size, &dst)) || !dst) return false;

	auto src = (const UINT32*)(_view + AIRCAM_MF_HEADER);
	double k = (std::min)((double)_width / sw, (double)_height / sh);
	UINT dw = (std::max)(1u, (UINT)(sw * k)), dh = (std::max)(1u, (UINT)(sh * k)), ox = (_width - dw) / 2, oy = (_height - dh) / 2;
	for (UINT y = 0; y < _height; y++)
	{
		auto row = (UINT32*)(dst + (size_t)y * stride);
		if (y < oy || y >= oy + dh) { ZeroMemory(row, _width * 4); continue; }
		auto srow = src + (size_t)((y - oy) * sh / dh) * sw;
		for (UINT x = 0; x < _width; x++)
			row[x] = (x < ox || x >= ox + dw) ? 0xFF000000 : (srow[(x - ox) * sw / dw] | 0xFF000000);
	}
	return true;
}

HRESULT FrameGenerator::Generate(IMFSample* sample, REFGUID format, IMFSample** outSample)
{
	RETURN_HR_IF_NULL(E_POINTER, sample);
	RETURN_HR_IF_NULL(E_POINTER, outSample);
	*outSample = nullptr;

	if (!_view) OpenSharedMemory();
	if (!CopyAppFrame() && _renderTarget)
	{
		_renderTarget->BeginDraw();
		_renderTarget->Clear(D2D1::ColorF(0.027f, 0.027f, 0.04f, 1));
		const wchar_t text[] = L"AirCam\nOuvre l'app AirCam sur le PC";
		wil::com_ptr_nothrow<IDWriteTextLayout> layout;
		if (SUCCEEDED(_dwrite->CreateTextLayout(text, (UINT32)wcslen(text), _textFormat.get(), (FLOAT)_width, (FLOAT)_height, &layout)))
			_renderTarget->DrawTextLayout(D2D1::Point2F(0, 0), layout.get(), _whiteBrush.get());
		_renderTarget->EndDraw();
	}

	wil::com_ptr_nothrow<IMFMediaBuffer> mediaBuffer;
	RETURN_IF_FAILED(sample->GetBufferByIndex(0, &mediaBuffer));
	wil::com_ptr_nothrow<IMF2DBuffer2> buffer2D;
	BYTE* scanline = nullptr;
	LONG pitch = 0;
	BYTE* start = nullptr;
	DWORD length = 0;
	RETURN_IF_FAILED(mediaBuffer->QueryInterface(IID_PPV_ARGS(&buffer2D)));
	RETURN_IF_FAILED(buffer2D->Lock2DSize(MF2DBuffer_LockFlags_Write, &scanline, &pitch, &start, &length));

	wil::com_ptr_nothrow<IWICBitmapLock> lock;
	auto hr = _bitmap->Lock(nullptr, WICBitmapLockRead, &lock);
	if (SUCCEEDED(hr))
	{
		UINT w = 0, h = 0, wicStride = 0, wicSize = 0;
		WICInProcPointer wicPointer = nullptr;
		hr = lock->GetSize(&w, &h);
		if (SUCCEEDED(hr)) hr = lock->GetStride(&wicStride);
		if (SUCCEEDED(hr)) hr = lock->GetDataPointer(&wicSize, &wicPointer);
		if (SUCCEEDED(hr))
		{
			if (format == MFVideoFormat_NV12)
				hr = RGB32ToNV12(wicPointer, wicSize, wicStride, w, h, scanline, length, pitch);
			else if (wicStride == (UINT)pitch && wicSize <= length)
				CopyMemory(scanline, wicPointer, wicSize);
			else
				for (UINT y = 0; y < h; y++) CopyMemory(scanline + (size_t)y * pitch, wicPointer + (size_t)y * wicStride, (std::min)((UINT)abs(pitch), wicStride));
		}
		lock.reset();
	}
	buffer2D->Unlock2D();
	if (SUCCEEDED(hr))
	{
		sample->AddRef();
		*outSample = sample;
	}
	return hr;
}
