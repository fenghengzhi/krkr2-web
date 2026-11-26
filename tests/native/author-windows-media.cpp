// Author original ASF cutscenes with the system encoder. The independent
// Linux reader checks the codec identifiers, every frame marker and the audio.
#define NOMINMAX
#include <windows.h>
#include <mfapi.h>
#include <mfidl.h>
#include <mfreadwrite.h>
#include <wrl/client.h>

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <cwchar>
#include <fstream>
#include <limits>
#include <stdexcept>

using Microsoft::WRL::ComPtr;
constexpr UINT32 width = 96, height = 64, fps = 25, rate = 48000;
constexpr LONGLONG frameTime = 10000000 / fps;

void check(HRESULT hr, const char* operation) {
    if (FAILED(hr)) {
        std::fprintf(stderr, "%s: HRESULT 0x%08lX\n", operation, static_cast<unsigned long>(hr));
        throw std::runtime_error(operation);
    }
}
#define CHECK(operation) check((operation), #operation)

ComPtr<IMFMediaType> mediaType(const GUID& major, const GUID& subtype) {
    ComPtr<IMFMediaType> type;
    CHECK(MFCreateMediaType(&type));
    CHECK(type->SetGUID(MF_MT_MAJOR_TYPE, major));
    CHECK(type->SetGUID(MF_MT_SUBTYPE, subtype));
    return type;
}

ComPtr<IMFMediaType> videoType(const GUID& subtype) {
    auto type = mediaType(MFMediaType_Video, subtype);
    CHECK(MFSetAttributeSize(type.Get(), MF_MT_FRAME_SIZE, width, height));
    CHECK(MFSetAttributeRatio(type.Get(), MF_MT_FRAME_RATE, fps, 1));
    CHECK(MFSetAttributeRatio(type.Get(), MF_MT_PIXEL_ASPECT_RATIO, 1, 1));
    CHECK(type->SetUINT32(MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive));
    return type;
}

// Use the encoder's advertised format, including its private WMA settings.
ComPtr<IMFMediaType> encodedAudio(const GUID& subtype) {
    ComPtr<IMFCollection> formats;
    const DWORD flags = (MFT_ENUM_FLAG_ALL & ~MFT_ENUM_FLAG_FIELDOFUSE) | MFT_ENUM_FLAG_SORTANDFILTER;
    CHECK(MFTranscodeGetAudioOutputAvailableTypes(subtype, flags, nullptr, &formats));
    DWORD count;
    CHECK(formats->GetElementCount(&count));
    ComPtr<IMFMediaType> best;
    UINT32 distance = std::numeric_limits<UINT32>::max();
    for (DWORD i = 0; i < count; ++i) {
        ComPtr<IUnknown> entry;
        ComPtr<IMFMediaType> type;
        CHECK(formats->GetElement(i, &entry));
        CHECK(entry.As(&type));
        if (MFGetAttributeUINT32(type.Get(), MF_MT_AUDIO_SAMPLES_PER_SECOND, 0) != rate ||
            MFGetAttributeUINT32(type.Get(), MF_MT_AUDIO_NUM_CHANNELS, 0) != 2) continue;
        const UINT32 bytes = MFGetAttributeUINT32(type.Get(), MF_MT_AUDIO_AVG_BYTES_PER_SECOND, 0);
        const UINT32 delta = bytes > 24000 ? bytes - 24000 : 24000 - bytes;
        if (bytes && delta < distance) { best = type; distance = delta; }
    }
    if (!best) throw std::runtime_error("Windows encoder has no 48 kHz stereo format");
    std::printf("Windows audio profile: %u bytes/second\n",
                MFGetAttributeUINT32(best.Get(), MF_MT_AUDIO_AVG_BYTES_PER_SECOND, 0));
    return best;
}

void writeChunk(IMFSinkWriter* writer, DWORD stream, std::ifstream& input, DWORD bytes, LONGLONG time) {
    ComPtr<IMFMediaBuffer> buffer;
    ComPtr<IMFSample> sample;
    CHECK(MFCreateMemoryBuffer(bytes, &buffer));
    BYTE* data;
    CHECK(buffer->Lock(&data, nullptr, nullptr));
    input.read(reinterpret_cast<char*>(data), bytes);
    CHECK(buffer->Unlock());
    if (input.gcount() != bytes) throw std::runtime_error("Short authored source");
    CHECK(buffer->SetCurrentLength(bytes));
    CHECK(MFCreateSample(&sample));
    CHECK(sample->AddBuffer(buffer.Get()));
    CHECK(sample->SetSampleTime(time));
    CHECK(sample->SetSampleDuration(frameTime));
    CHECK(writer->WriteSample(stream, sample.Get()));
}

void encode(const wchar_t* path, bool advanced) {
    ComPtr<IMFAttributes> attributes;
    ComPtr<IMFSinkWriter> writer;
    CHECK(MFCreateAttributes(&attributes, 1));
    CHECK(attributes->SetUINT32(MF_SINK_WRITER_DISABLE_THROTTLING, TRUE));
    CHECK(MFCreateSinkWriterFromURL(path, nullptr, attributes.Get(), &writer));
    const auto videoOut = videoType(advanced ? MFVideoFormat_WVC1 : MFVideoFormat_WMV3);
    CHECK(videoOut->SetUINT32(MF_MT_AVG_BITRATE, 800000));
    const auto audioOut = encodedAudio(advanced ? MFAudioFormat_WMAudioV9 : MFAudioFormat_WMAudioV8);
    DWORD video, sound;
    CHECK(writer->AddStream(videoOut.Get(), &video));
    CHECK(writer->AddStream(audioOut.Get(), &sound));
    auto picture = videoType(MFVideoFormat_NV12);
    CHECK(picture->SetUINT32(MF_MT_DEFAULT_STRIDE, width));
    auto audio = mediaType(MFMediaType_Audio, MFAudioFormat_PCM);
    CHECK(audio->SetUINT32(MF_MT_AUDIO_NUM_CHANNELS, 2));
    CHECK(audio->SetUINT32(MF_MT_AUDIO_SAMPLES_PER_SECOND, rate));
    CHECK(audio->SetUINT32(MF_MT_AUDIO_BITS_PER_SAMPLE, 16));
    CHECK(audio->SetUINT32(MF_MT_AUDIO_BLOCK_ALIGNMENT, 4));
    CHECK(audio->SetUINT32(MF_MT_AUDIO_AVG_BYTES_PER_SECOND, rate * 4));
    CHECK(audio->SetUINT32(MF_MT_AUDIO_CHANNEL_MASK, 3));
    CHECK(writer->SetInputMediaType(video, picture.Get(), nullptr));
    CHECK(writer->SetInputMediaType(sound, audio.Get(), nullptr));
    CHECK(writer->BeginWriting());
    std::ifstream images("source.nv12", std::ios::binary), music("source.pcm", std::ios::binary);
    for (int i = 0; i < 100; ++i) {
        writeChunk(writer.Get(), video, images, width * height * 3 / 2, i * frameTime);
        writeChunk(writer.Get(), sound, music, rate / fps * 4, i * frameTime);
    }
    if (images.peek() != EOF || music.peek() != EOF) throw std::runtime_error("Unexpected trailing author input");
    CHECK(writer->Finalize());
}

int wmain(int argc, wchar_t** argv) {
    const char* runner = std::getenv("RUNNER_ENVIRONMENT");
    if (!runner || std::strcmp(runner, "github-hosted") || argc != 2) return 2;
    const bool advanced = std::wcscmp(argv[1], L"vc1") == 0;
    if (!advanced && std::wcscmp(argv[1], L"wmv9")) return 2;
    HRESULT initialized = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    if (FAILED(initialized)) { std::fprintf(stderr, "COM startup: 0x%08lX\n", static_cast<unsigned long>(initialized)); return 1; }
    const HRESULT started = MFStartup(MF_VERSION);
    int status = 0;
    try {
        CHECK(started);
        encode(advanced ? L"legacy-vc1.wmv" : L"legacy-wmv9.wmv", advanced);
    } catch (const std::exception& error) {
        std::fprintf(stderr, "%s\n", error.what());
        status = 1;
    }
    if (SUCCEEDED(started)) MFShutdown();
    CoUninitialize();
    return status;
}
