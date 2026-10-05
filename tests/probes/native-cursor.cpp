// GitHub-hosted Windows only. Reference User32 behavior, not original KRKR/VCL.
// No HWND, SetCursor, SetCursorPos, global input or system cursor replacement.
// Primary contracts:
// https://learn.microsoft.com/windows/win32/api/winuser/nf-winuser-loadcursorfromfilew
// https://learn.microsoft.com/windows/win32/api/winuser/nf-winuser-drawiconex
// https://learn.microsoft.com/windows/win32/api/winuser/ns-winuser-iconinfo
// Microsoft Multimedia Standards Update, 1994-04-15 revision 3, ACON pp.9-10:
// https://billposer.org/Linguistics/Computation/riffnew.pdf
#define NOMINMAX
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <algorithm>
#include <cstdint>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <sstream>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

using Bytes = std::vector<std::uint8_t>;
namespace fs = std::filesystem;
void put16(Bytes& b, unsigned v) { b.push_back(v & 255); b.push_back((v >> 8) & 255); }
void put32(Bytes& b, std::uint32_t v) { put16(b, v & 65535); put16(b, v >> 16); }
void be32(Bytes& b, std::uint32_t v) { b.push_back(v >> 24); b.push_back((v >> 16) & 255); b.push_back((v >> 8) & 255); b.push_back(v & 255); }
void four(Bytes& b, const char* s) { b.insert(b.end(), s, s + 4); }
void append(Bytes& b, const Bytes& x) { b.insert(b.end(), x.begin(), x.end()); }
void patch32(Bytes& b, size_t at, std::uint32_t v) { for (unsigned i = 0; i < 4; i++) b.at(at + i) = (v >> (8 * i)) & 255; }
std::string quote(const std::string& s) {
    std::ostringstream o; o << '"';
    for (unsigned char c : s) {
        if (c == '"' || c == '\\') o << '\\' << c;
        else if (c < 32) { const char* h = "0123456789abcdef"; o << "\\u00" << h[c >> 4] << h[c & 15]; }
        else o << c;
    }
    o << '"'; return o.str();
}
std::string array(const std::vector<unsigned>& a) {
    std::ostringstream o; o << '[';
    for (size_t i = 0; i < a.size(); i++) { if (i) o << ','; o << a[i]; }
    o << ']'; return o.str();
}
void write(const fs::path& path, const Bytes& bytes) {
    std::ofstream file(path, std::ios::binary | std::ios::trunc);
    file.write(reinterpret_cast<const char*>(bytes.data()), static_cast<std::streamsize>(bytes.size()));
    if (!file) throw std::runtime_error("Cannot write " + path.string());
}
void writeText(const fs::path& path, const std::string& text) {
    write(path, Bytes(text.begin(), text.end()));
}

struct Image {
    unsigned width = 32, height = 32, hotX = 3, hotY = 5, bpp = 32;
    unsigned header = 40, compression = BI_RGB, alphaMode = 0, tag = 1;
    bool topDown = false, omitMask = false;
    std::string encoding = "dib";
    // Empty preserves the original half-plane AND/XOR fixture. Named patterns
    // below are generated in source coordinates independently of Web scaling.
    std::string bitPattern;
    std::string colorPattern;
    Bytes payload;
};
std::string colorPatternDefinition(const std::string& name) {
    if (name == "x-axis") return "RGBA=((17*x+3)%256,(73*x+91)%256,(127*x+113)%256,0)";
    if (name == "y-axis") return "RGBA=((17*y+3)%256,(73*y+91)%256,(127*y+113)%256,0)";
    if (name == "xy-asymmetric") return "RGBA=((17*x+37*y+3)%256,(73*x+11*y+91)%256,(127*x+61*y+113)%256,0)";
    if (name == "checker") return "RGBA=(255*(x%2),255*(y%2),255*((x+y)%2),0)";
    if (name == "impulses") return "RGBA=(255*[x==1&&y==1],255*[x==floor(width/2)&&y==floor(height/2)],255*[x==width-2&&y==height-2],0)";
    throw std::runtime_error("Unknown color-plane fixture pattern: " + name);
}
struct ColorChannels { unsigned r, g, b; };
ColorChannels colorPatternValue(const std::string& name, unsigned x, unsigned y, unsigned width, unsigned height) {
    if (name == "x-axis") return {(17 * x + 3) & 255, (73 * x + 91) & 255, (127 * x + 113) & 255};
    if (name == "y-axis") return {(17 * y + 3) & 255, (73 * y + 91) & 255, (127 * y + 113) & 255};
    if (name == "xy-asymmetric") return {(17 * x + 37 * y + 3) & 255,
        (73 * x + 11 * y + 91) & 255, (127 * x + 61 * y + 113) & 255};
    if (name == "checker") return {255 * (x % 2), 255 * (y % 2), 255 * ((x + y) % 2)};
    if (name == "impulses") return {x == 1 && y == 1 ? 255u : 0u,
        x == width / 2 && y == height / 2 ? 255u : 0u,
        x == width - 2 && y == height - 2 ? 255u : 0u};
    throw std::runtime_error("Unknown color-plane fixture pattern: " + name);
}
std::string bitPatternDefinition(const std::string& name) {
    if (name == "multi-edge") return "(3<=x<9)||(63<=x<129)||(193<=x<251)";
    if (name == "isolated-one") return "(x%32==floor(y/32))&&(y%32==floor(x/32))";
    if (name == "isolated-zero") return "!((x%32==floor(y/32))&&(y%32==floor(x/32)))";
    if (name == "checkerboard") return "((x+y)%2)==1";
    throw std::runtime_error("Unknown bit-plane fixture pattern: " + name);
}
bool bitPatternValue(const std::string& name, unsigned x, unsigned y) {
    if (name == "multi-edge") return (x >= 3 && x < 9) || (x >= 63 && x < 129) || (x >= 193 && x < 251);
    if (name == "checkerboard") return ((x + y) & 1) != 0;
    const bool isolated = (x % 32 == y / 32) && (y % 32 == x / 32);
    if (name == "isolated-one") return isolated;
    if (name == "isolated-zero") return !isolated;
    throw std::runtime_error("Unknown bit-plane fixture pattern: " + name);
}
std::string imageJson(const Image& i) {
    std::ostringstream o;
    o << "{\"width\":" << i.width << ",\"height\":" << i.height
      << ",\"hotspot\":{\"x\":" << i.hotX << ",\"y\":" << i.hotY << "},\"bpp\":" << i.bpp
      << ",\"encoding\":" << quote(i.encoding) << ",\"headerBytes\":" << i.header
      << ",\"compression\":" << i.compression << ",\"alphaMode\":" << i.alphaMode
      << ",\"tag\":" << i.tag << ",\"topDown\":" << (i.topDown ? "true" : "false")
      << ",\"omitMask\":" << (i.omitMask ? "true" : "false");
    if (!i.bitPattern.empty()) {
        o << ",\"bitPlanePattern\":{\"id\":" << quote(i.bitPattern)
          << ",\"coordinateSpace\":\"top-down 256x256 source pixels\",\"baseFunction\":"
          << quote(bitPatternDefinition(i.bitPattern))
          << ",\"and\":\"F(x,y)\",\"monochromeXor\":\"F(y,255-x)\"}";
    }
    if (!i.colorPattern.empty()) {
        o << ",\"colorPlanePattern\":{\"id\":" << quote(i.colorPattern)
          << ",\"coordinateSpace\":\"top-down source pixels\",\"rgba\":" << quote(colorPatternDefinition(i.colorPattern))
          << ",\"and\":\"y>=floor(height/2)\"}";
    }
    o << '}';
    return o.str();
}
std::string imagesJson(const std::vector<Image>& images) {
    std::ostringstream o; o << '[';
    for (size_t n = 0; n < images.size(); n++) { if (n) o << ','; o << imageJson(images[n]); }
    o << ']'; return o.str();
}
Bytes dib(const Image& i) {
    if (!i.bitPattern.empty() && (i.width != 256 || i.height != 256 ||
        (i.bpp != 1 && i.bpp != 32) || i.alphaMode != 0 || i.omitMask))
        throw std::runtime_error("Named bit-plane patterns require complete 256x256 monochrome or zero-alpha DIBs");
    if (!i.colorPattern.empty() && (i.width < 3 || i.height < 3 || i.bpp != 32 ||
        i.header != 40 || i.compression != BI_RGB || i.alphaMode != 0 || i.topDown || i.omitMask || !i.bitPattern.empty()))
        throw std::runtime_error("Named color patterns require complete bottom-up 32bpp zero-alpha INFO DIBs");
    const unsigned palette = i.bpp <= 8 ? 1u << i.bpp : 0,
        xorStride = ((i.width * i.bpp + 31) / 32) * 4,
        andStride = ((i.width + 31) / 32) * 4;
    Bytes b;
    put32(b, i.header);
    if (i.header == 12) {
        put16(b, i.width); put16(b, i.height * 2); put16(b, 1); put16(b, i.bpp);
    } else {
        put32(b, i.width);
        const auto height = static_cast<std::int32_t>(i.height * 2);
        put32(b, static_cast<std::uint32_t>(i.topDown ? -height : height));
        put16(b, 1); put16(b, i.bpp); put32(b, i.compression);
        put32(b, xorStride * i.height + (i.omitMask ? 0 : andStride * i.height));
        put32(b, 0); put32(b, 0); put32(b, palette); put32(b, 0);
        if (i.header > 40) b.resize(i.header, 0);
        if (i.compression == BI_BITFIELDS || i.compression == 6) {
            const unsigned r = i.bpp == 16 ? 0xf800 : 0x00ff0000,
                g = i.bpp == 16 ? 0x07e0 : 0x0000ff00,
                bl = i.bpp == 16 ? 0x001f : 0x000000ff;
            if (i.header == 40) {
                put32(b, r); put32(b, g); put32(b, bl);
                if (i.compression == 6) put32(b, 0xff000000);
            } else {
                patch32(b, 40, r); patch32(b, 44, g); patch32(b, 48, bl);
                if (i.header >= 56) patch32(b, 52, i.bpp == 32 ? 0xff000000 : 0);
                if (i.header >= 108) patch32(b, 56, 0x73524742); // LCS_sRGB, no color profile payload.
            }
        }
    }
    for (unsigned p = 0; p < palette; p++) {
        const unsigned c = palette == 2 ? p * 255 : (p * 53) & 255;
        b.push_back(c); b.push_back(palette == 2 ? c : (p * 97) & 255);
        b.push_back(palette == 2 ? c : (p * 193) & 255);
        if (i.header != 12) b.push_back(0);
    }
    const auto xorAt = b.size(); b.resize(xorAt + xorStride * i.height, 0);
    for (unsigned y = 0; y < i.height; y++) {
        const unsigned row = i.topDown ? y : i.height - 1 - y;
        for (unsigned x = 0; x < i.width; x++) {
            const auto at = xorAt + row * xorStride;
            const unsigned index = ((x >= i.width / 2) ? 1 : 0) + ((y >= i.height / 2) ? 2 : 0);
            if (i.bpp == 1) {
                const unsigned bit = i.bitPattern.empty() ? index & 1
                    : static_cast<unsigned>(bitPatternValue(i.bitPattern, y, 255 - x));
                b[at + x / 8] |= bit << (7 - x % 8);
            }
            else if (i.bpp == 4) b[at + x / 2] |= ((x + y * 3 + i.tag) & 15) << ((1 - x % 2) * 4);
            else if (i.bpp == 8) b[at + x] = (x + y * 3 + i.tag) & 255;
            else {
                unsigned r = (37 * i.tag + x * 3) & 255, g = (71 * i.tag + y * 5) & 255,
                    bl = (113 * i.tag + x + y) & 255,
                    alpha = i.alphaMode ? (x % 3 == 0 ? 0 : x % 3 == 1 ? 128 : 255) : 0;
                // Every possible alpha, with independently varying source
                // channels. Mode 3 is raw straight data, not premultiplied.
                if (i.alphaMode == 3) alpha = (x + y * i.width) & 255;
                if (i.alphaMode == 2) { r = r * alpha / 255; g = g * alpha / 255; bl = bl * alpha / 255; }
                if (!i.colorPattern.empty()) {
                    const auto color = colorPatternValue(i.colorPattern, x, y, i.width, i.height);
                    r = color.r; g = color.g; bl = color.b;
                }
                const auto pixel = at + x * (i.bpp / 8);
                if (i.bpp == 16) {
                    const unsigned v = i.compression == BI_BITFIELDS
                        ? ((r >> 3) << 11) | ((g >> 2) << 5) | (bl >> 3)
                        : ((r >> 3) << 10) | ((g >> 3) << 5) | (bl >> 3);
                    b[pixel] = v & 255; b[pixel + 1] = v >> 8;
                } else {
                    b[pixel] = bl; b[pixel + 1] = g; b[pixel + 2] = r;
                    if (i.bpp == 32) b[pixel + 3] = alpha;
                }
            }
        }
    }
    if (!i.omitMask) {
        const auto andAt = b.size(); b.resize(andAt + andStride * i.height, 0);
        for (unsigned y = 0; y < i.height; y++) for (unsigned x = 0; x < i.width; x++) {
            const unsigned row = i.topDown ? y : i.height - 1 - y;
            // The default half-plane fixture covers all four AND/XOR cases.
            // Named patterns retain their independent source-coordinate bits.
            const bool bit = i.bitPattern.empty() ? y >= i.height / 2 : bitPatternValue(i.bitPattern, x, y);
            if (bit) b[andAt + row * andStride + x / 8] |= 1 << (7 - x % 8);
        }
    }
    return b;
}
std::uint32_t crc32(const Bytes& data) {
    std::uint32_t crc = 0xffffffff;
    for (auto byte : data) { crc ^= byte; for (unsigned n = 0; n < 8; n++) crc = (crc >> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
    return ~crc;
}
void pngChunk(Bytes& file, const char* type, const Bytes& data) {
    be32(file, static_cast<std::uint32_t>(data.size()));
    Bytes chunk; four(chunk, type); append(chunk, data); append(file, chunk); be32(file, crc32(chunk));
}
Bytes png(unsigned width, unsigned height, unsigned mode) {
    Bytes file{137, 80, 78, 71, 13, 10, 26, 10}, header;
    be32(header, width); be32(header, height);
    header.insert(header.end(), {8, static_cast<std::uint8_t>(mode == 2 ? 3 : mode == 1 ? 2 : 6), 0, 0, 0});
    pngChunk(file, "IHDR", header);
    if (mode == 2) {
        pngChunk(file, "PLTE", {
            255, 0, 0,
            0, 255, 0,
            0, 0, 255,
            255, 255, 255,
        });
        pngChunk(file, "tRNS", {0, 64, 128, 255});
    }
    Bytes scan;
    for (unsigned y = 0; y < height; y++) {
        scan.push_back(0);
        for (unsigned x = 0; x < width; x++) {
            if (mode == 2) scan.push_back((x + y) % 4);
            else {
                scan.push_back((x * 5 + 31) & 255); scan.push_back((y * 7 + 61) & 255); scan.push_back((x + y + 127) & 255);
                if (mode == 0 || mode == 3)
                    scan.push_back(mode == 3 ? (x + y * width) & 255 : x % 3 == 0 ? 0 : x % 3 == 1 ? 128 : 255);
            }
        }
    }
    Bytes compressed{0x78, 0x01};
    for (size_t offset = 0; offset < scan.size();) {
        const auto count = static_cast<unsigned>(std::min<size_t>(65535, scan.size() - offset));
        compressed.push_back(offset + count == scan.size() ? 1 : 0);
        put16(compressed, count); put16(compressed, count ^ 65535);
        compressed.insert(compressed.end(), scan.begin() + offset, scan.begin() + offset + count);
        offset += count;
    }
    unsigned a = 1, b = 0;
    for (auto byte : scan) { a = (a + byte) % 65521; b = (b + a) % 65521; }
    be32(compressed, (b << 16) | a); pngChunk(file, "IDAT", compressed); pngChunk(file, "IEND", {});
    return file;
}
Bytes cur(const std::vector<Image>& images, unsigned type = 2) {
    Bytes file; put16(file, 0); put16(file, type); put16(file, static_cast<unsigned>(images.size()));
    std::vector<Bytes> payloads;
    unsigned offset = 6 + 16 * static_cast<unsigned>(images.size());
    for (const auto& image : images) {
        payloads.push_back(image.payload.empty() ? dib(image) : image.payload);
        const auto size = static_cast<unsigned>(payloads.back().size());
        file.push_back(image.width == 256 ? 0 : image.width); file.push_back(image.height == 256 ? 0 : image.height);
        file.push_back(image.bpp < 8 ? 1u << image.bpp : 0); file.push_back(0);
        put16(file, type == 1 ? 1 : image.hotX); put16(file, type == 1 ? image.bpp : image.hotY);
        put32(file, size); put32(file, offset); offset += size;
    }
    for (const auto& payload : payloads) append(file, payload);
    return file;
}
void riffChunk(Bytes& file, const char* name, const Bytes& data) {
    four(file, name); put32(file, static_cast<unsigned>(data.size())); append(file, data);
    if (data.size() & 1) file.push_back(0);
}
struct Fixture {
    std::string id, kind = "cur", classification = "format";
    std::vector<Image> images;
    std::vector<std::vector<Image>> frames;
    std::vector<unsigned> sequence, rates;
    unsigned steps = 0, defaultRate = 6, flags = 1;
    unsigned nominalWidth = 0, nominalHeight = 0, nominalDepth = 0, nominalPlanes = 0, embeddedType = 2;
    Bytes bytes;
};
Bytes ani(const Fixture& f) {
    Bytes body, header; four(body, "ACON");
    // Include odd-sized non-animation metadata to exercise RIFF padding.
    Bytes info; four(info, "INFO"); riffChunk(info, "INAM", {'k', 'r', 'k', 'r', 0});
    riffChunk(body, "LIST", info); riffChunk(body, "JUNK", {1, 2, 3});
    for (unsigned n : {36u, static_cast<unsigned>(f.frames.size()), f.steps, f.nominalWidth, f.nominalHeight,
        f.nominalDepth, f.nominalPlanes, f.defaultRate, f.flags}) put32(header, n);
    riffChunk(body, "anih", header);
    if (!f.sequence.empty()) { Bytes seq; for (auto n : f.sequence) put32(seq, n); riffChunk(body, "seq ", seq); }
    if (!f.rates.empty()) { Bytes rates; for (auto n : f.rates) put32(rates, n); riffChunk(body, "rate", rates); }
    Bytes frames; four(frames, "fram"); for (const auto& frame : f.frames) riffChunk(frames, "icon", cur(frame, f.embeddedType));
    riffChunk(body, "LIST", frames);
    Bytes file; riffChunk(file, "RIFF", body); return file;
}
std::vector<Fixture> fixtures() {
    std::vector<Fixture> output;
    auto add = [&](std::string id, std::vector<Image> images, std::string classification = "format") {
        Fixture f; f.id = id; f.images = images; f.classification = classification; f.bytes = cur(images); output.push_back(f);
    };
    for (unsigned bpp : {1u, 4u, 8u, 16u, 24u, 32u}) {
        Image i; i.bpp = bpp;
        add("dib-info-" + std::to_string(bpp), {i});
    }
    for (unsigned bpp : {1u, 4u, 8u, 24u}) {
        Image i; i.header = 12; i.bpp = bpp; add("dib-core-" + std::to_string(bpp), {i});
    }
    for (unsigned bpp : {16u, 32u}) {
        Image i; i.bpp = bpp; i.compression = BI_BITFIELDS; add("dib-bitfields-" + std::to_string(bpp), {i});
    }
    for (unsigned header : {52u, 56u}) {
        Image i; i.header = header; i.compression = BI_BITFIELDS; i.alphaMode = header == 56 ? 1 : 0;
        add("dib-bitfields-header-" + std::to_string(header), {i});
    }
    for (unsigned header : {40u, 108u, 124u}) for (unsigned alpha : {1u, 2u}) {
        Image i; i.header = header; i.alphaMode = alpha; i.compression = header == 40 ? BI_RGB : BI_BITFIELDS;
        add("dib-alpha-" + std::to_string(header) + "-" + std::to_string(alpha), {i});
    }
    { Image i; i.alphaMode = 3; add("dib-alpha-sweep", {i}); }
    { Image i; i.header = 0; i.encoding = "png-rgba"; i.alphaMode = 3; i.payload = png(32, 32, 3); add("png-alpha-sweep", {i}); }
    // Loading itself can resize a single candidate to the system cursor size.
    // Keep the source files and masks independent of any portable scaler.
    for (unsigned bpp : {1u, 24u}) {
        Image i; i.width = 8; i.height = 4; i.hotX = 2; i.hotY = 1; i.bpp = bpp;
        add("dib-small-" + std::to_string(bpp), {i}, "scaling");
    }
    { Image i; i.width = 13; i.height = 9; i.hotX = 12; i.hotY = 8; i.alphaMode = 3; add("dib-alpha-small", {i}, "scaling"); }
    { Image i; i.width = 13; i.height = 9; i.hotX = 12; i.hotY = 8; i.header = 0; i.encoding = "png-rgba"; i.alphaMode = 3; i.payload = png(13, 9, 3); add("png-small", {i}, "scaling"); }
    { Image i; i.width = 13; i.height = 9; i.bpp = 4; i.hotX = 12; i.hotY = 8; add("dib-odd-stride", {i}); }
    { Image i; i.topDown = true; add("dib-top-down", {i}, "characterization"); }
    { Image i; i.alphaMode = 1; i.omitMask = true; add("dib-alpha-no-mask", {i}, "characterization"); }
    { Image i; i.hotX = 33; i.hotY = 40; add("hotspot-outside", {i}, "characterization"); }
    { Image i; i.hotX = 65535; i.hotY = 32768; add("hotspot-wide-natural", {i}, "characterization"); }
    { Image i; i.width = 8; i.height = 4; i.bpp = 24; i.hotX = 65535; i.hotY = 32768; add("hotspot-wide-small", {i}, "characterization"); }
    for (unsigned mode : {0u, 1u, 2u}) {
        Image i; i.encoding = mode == 2 ? "png-indexed-trns" : mode == 1 ? "png-rgb" : "png-rgba";
        i.header = 0; i.bpp = mode == 2 ? 8 : mode == 1 ? 24 : 32; i.payload = png(32, 32, mode);
        add(i.encoding, {i});
    }
    { Image i; i.width = i.height = 256; i.hotX = 191; i.hotY = 203; i.header = 0; i.encoding = "png-rgba"; i.payload = png(256, 256, 0); add("png-256", {i}); }
    std::vector<Image> sizes;
    for (unsigned size : {16u, 32u, 48u, 64u}) { Image i; i.width = i.height = size; i.hotX = size / 4; i.hotY = size / 2; i.tag = size / 16; sizes.push_back(i); }
    add("multi-sizes", sizes, "selection"); std::reverse(sizes.begin(), sizes.end()); add("multi-sizes-reversed", sizes, "selection");
    std::vector<Image> depths;
    for (unsigned bpp : {1u, 4u, 8u, 24u, 32u}) { Image i; i.bpp = bpp; i.tag = bpp; i.hotX = bpp / 2; depths.push_back(i); }
    add("multi-depths", depths, "selection"); std::reverse(depths.begin(), depths.end()); add("multi-depths-reversed", depths, "selection");
    auto withoutExact = sizes;
    withoutExact.erase(std::remove_if(withoutExact.begin(), withoutExact.end(), [](const Image& i) { return i.width == 32; }), withoutExact.end());
    add("multi-without-exact", withoutExact, "selection");
    std::reverse(withoutExact.begin(), withoutExact.end()); add("multi-without-exact-reversed", withoutExact, "selection");
    Image tieA, tieB; tieA.tag = 3; tieA.hotX = 4; tieB.tag = 9; tieB.hotX = 23;
    add("multi-equal-tie", {tieA, tieB}, "selection"); add("multi-equal-tie-reversed", {tieB, tieA}, "selection");
    // Keep dimension, depth, directory order and malformed alternatives
    // independent. A file loader need not share resource-directory selection.
    auto selectionPair = [&](const std::string& id, std::vector<Image> images) {
        add(id, images, "selection"); std::reverse(images.begin(), images.end());
        add(id + "-reversed", images, "selection");
    };
    std::vector<Image> smallOnly, largeOnly, rectangles;
    for (unsigned size : {16u, 24u}) { Image i; i.width = i.height = size; i.tag = size / 8; i.hotX = size / 3; smallOnly.push_back(i); }
    for (unsigned size : {48u, 64u}) { Image i; i.width = i.height = size; i.tag = size / 8; i.hotX = size / 3; largeOnly.push_back(i); }
    for (unsigned n = 0; n < 4; n++) {
        Image i; i.width = n == 0 ? 32 : n == 1 ? 16 : n == 2 ? 48 : 40;
        i.height = n == 0 ? 16 : n == 1 ? 32 : n == 2 ? 40 : 48;
        i.tag = n + 1; i.hotX = n * 3; rectangles.push_back(i);
    }
    selectionPair("multi-small-only", smallOnly); selectionPair("multi-large-only", largeOnly);
    selectionPair("multi-crossed-rectangles", rectangles);
    Image exactMono, smallColor; exactMono.bpp = 1; smallColor.width = smallColor.height = 16; smallColor.tag = 3;
    selectionPair("multi-size-before-depth", {exactMono, smallColor});
    Image validExact, brokenSmall; brokenSmall.width = brokenSmall.height = 16; brokenSmall.payload = {0, 0, 0, 0};
    selectionPair("multi-broken-smaller", {validExact, brokenSmall});
    Image brokenExact, validSmall; brokenExact.payload = {0, 0, 0, 0}; validSmall.width = validSmall.height = 16;
    selectionPair("multi-broken-exact", {brokenExact, validSmall});
    for (unsigned bpp : {1u, 4u, 8u, 16u, 24u, 32u}) {
        Image i; i.width = 13; i.height = 9; i.hotX = 12; i.hotY = 8; i.bpp = bpp;
        add("dib-scale-13x9-" + std::to_string(bpp), {i}, "scaling");
    }
    for (unsigned bpp : {24u, 32u}) {
        Image i; i.width = i.height = 48; i.hotX = 23; i.hotY = 17; i.bpp = bpp;
        add("dib-scale-48x48-" + std::to_string(bpp), {i}, "scaling");
    }
    { Image i; i.width = i.height = 48; i.hotX = 23; i.hotY = 17; i.header = 0; i.encoding = "png-rgba"; i.alphaMode = 3; i.payload = png(48, 48, 3); add("png-scale-48x48", {i}, "scaling"); }
    { Image i; i.width = i.height = 256; i.hotX = 191; i.hotY = 203; i.alphaMode = 3; add("dib-alpha-scale-256", {i}, "scaling"); }
    for (unsigned size : {64u, 96u}) {
        Image i; i.width = i.height = size; i.hotX = size / 3; i.hotY = size / 4; i.alphaMode = 3;
        add("dib-alpha-scale-" + std::to_string(size), {i}, "scaling");
        i.header = 0; i.encoding = "png-rgba"; i.payload = png(size, size, 3);
        add("png-alpha-scale-" + std::to_string(size), {i}, "scaling");
    }
    for (unsigned bpp : {1u, 32u}) {
        Image i; i.width = i.height = 256; i.hotX = 191; i.hotY = 203; i.bpp = bpp;
        add("dib-mask-scale-256-" + std::to_string(bpp), {i}, "scaling");
    }
    // Distinguish nearest sampling, Boolean shrink, and shifted boundaries.
    // The isolated lattice has one pixel per 32x32 cell, exercising each of
    // the eight phases of the 256-to-32 reduction. Monochrome XOR rotates the
    // pattern independently; 32-bit color keeps the original gradient/alpha=0.
    for (unsigned bpp : {1u, 32u}) {
        for (const char* pattern : {"multi-edge", "isolated-one", "isolated-zero", "checkerboard"}) {
            Image i; i.width = i.height = 256; i.hotX = 191; i.hotY = 203; i.bpp = bpp;
            i.bitPattern = pattern;
            add("dib-mask-" + i.bitPattern + "-256-" + std::to_string(bpp), {i}, "scaling");
        }
    }
    Image a; a.tag = 1; a.hotX = 2; a.hotY = 3;
    Image b = a; b.tag = 2; b.hotX = 7; b.hotY = 11;
    Image c = a; c.tag = 3; c.hotX = 17; c.hotY = 23;
    auto addAni = [&](std::string id, std::vector<unsigned> seq, std::vector<unsigned> rates, unsigned flags) {
        Fixture f; f.id = id; f.kind = "ani"; f.frames = {{a}, {b}, {c}}; f.sequence = seq; f.rates = rates;
        f.steps = seq.empty() ? 3 : static_cast<unsigned>(seq.size()); f.flags = flags; f.bytes = ani(f); output.push_back(f);
    };
    addAni("ani-default", {}, {}, 1);
    addAni("ani-rate", {}, {1, 7, 13}, 1);
    addAni("ani-sequence", {2, 0, 2, 1, 0}, {}, 3);
    addAni("ani-sequence-rate", {2, 0, 2, 1, 0}, {1, 4, 7, 2, 9}, 3);
    addAni("ani-sequence-without-flag", {2, 0, 2, 1, 0}, {1, 4, 7, 2, 9}, 1);
    addAni("ani-flag-without-sequence", {}, {}, 3);
    { Fixture f; f.id = "ani-multi-image"; f.kind = "ani"; f.frames = {sizes, depths, {a}}; f.steps = 3; f.bytes = ani(f); output.push_back(f); }
    { Fixture f; f.id = "ani-nominal-fields"; f.kind = "ani"; f.frames = {sizes, depths, {a}}; f.steps = 3; f.nominalWidth = 48; f.nominalHeight = 64; f.nominalDepth = 4; f.nominalPlanes = 1; f.classification = "characterization"; f.bytes = ani(f); output.push_back(f); }
    { Fixture f; f.id = "ani-embedded-ico"; f.kind = "ani"; f.frames = {{a}, {b}, {c}}; f.steps = 3; f.embeddedType = 1; f.classification = "characterization"; f.bytes = ani(f); output.push_back(f); }
    { Fixture f; f.id = "ani-single"; f.kind = "ani"; f.frames = {{a}}; f.steps = 1; f.defaultRate = 9; f.bytes = ani(f); output.push_back(f); }
    { Fixture f; f.id = "ani-zero-rate"; f.kind = "ani"; f.frames = {{a}, {b}, {c}}; f.steps = 3; f.defaultRate = 0; f.rates = {0, 1, 0}; f.classification = "characterization"; f.bytes = ani(f); output.push_back(f); }
    { Fixture f; f.id = "ani-bad-sequence"; f.kind = "ani"; f.frames = {{a}, {b}, {c}}; f.steps = 3; f.sequence = {0, 3, 1}; f.flags = 3; f.classification = "malformed"; f.bytes = ani(f); output.push_back(f); }
    { Fixture f; f.id = "cur-truncated-directory"; f.bytes = {0, 0, 2, 0, 1, 0}; f.classification = "malformed"; output.push_back(f); }
    { Fixture f; f.id = "cur-truncated-pixels"; f.images = {a}; f.bytes = cur(f.images); f.bytes.resize(f.bytes.size() - 20); f.classification = "malformed"; output.push_back(f); }
    { Fixture f; f.id = "ani-truncated-container"; f.kind = "ani"; f.frames = {{a}, {b}}; f.steps = 2; f.bytes = ani(f); f.bytes.resize(f.bytes.size() - 30); f.classification = "malformed"; output.push_back(f); }
    // Preserve the original 95 identities/order. Independent byte fields expose
    // horizontal-only, vertical-only and two-dimensional truncation stages;
    // transposed enlargement and a mixed ratio must not be inferred from 48^2.
    if (output.size() != 95) throw std::runtime_error("Historical cursor fixture inventory changed");
    // Append 089's integer-Y paths after the original 20 fields. At 13x32
    // and 13x63 every output row maps to an exact source Y, distinguishing a
    // coordinate-based shortcut from a first-row initialization shortcut.
    for (const auto shape : {std::pair<unsigned, unsigned>{13, 9}, {9, 13}, {48, 48}, {17, 41},
        {13, 32}, {13, 63}}) {
        for (const char* pattern : {"x-axis", "y-axis", "xy-asymmetric", "checker", "impulses"}) {
            Image i; i.width = shape.first; i.height = shape.second;
            i.hotX = i.width / 3; i.hotY = i.height / 4; i.colorPattern = pattern;
            add("color-stages-" + std::to_string(i.width) + "x" + std::to_string(i.height) + "-" + i.colorPattern,
                {i}, "scaling");
        }
    }
    if (output.size() != 125) throw std::runtime_error("Color stage fixture inventory is incomplete");
    // 090 holdouts preserve all 125 prior identities/bytes. Straddle the
    // target size on separate axes, reduce larger nonintegral rectangles,
    // and exercise unequal integer ratios independently of the smooth path.
    // These are source fields, not expected pixels from a candidate scaler.
    for (const auto shape : {std::pair<unsigned, unsigned>{31, 33}, {33, 31}, {80, 80}, {127, 255},
        {64, 96}, {96, 64}}) {
        for (const char* pattern : {"x-axis", "y-axis", "xy-asymmetric", "checker", "impulses"}) {
            Image i; i.width = shape.first; i.height = shape.second;
            i.hotX = i.width / 3; i.hotY = i.height / 4; i.colorPattern = pattern;
            add("color-stages-" + std::to_string(i.width) + "x" + std::to_string(i.height) + "-" + i.colorPattern,
                {i}, "scaling");
        }
    }
    if (output.size() != 155) throw std::runtime_error("Color holdout fixture inventory is incomplete");
    return output;
}

struct BitmapPlane {
    bool present = false, ok = false;
    DWORD error = 0;
    unsigned width = 0, height = 0, depth = 0, stride = 0, lines = 0;
    std::string file;
    std::vector<unsigned> palette;
    std::string json() const {
        std::ostringstream o; o << "{\"present\":" << (present ? "true" : "false")
          << ",\"ok\":" << (ok ? "true" : "false") << ",\"error\":" << error
          << ",\"width\":" << width << ",\"height\":" << height << ",\"depth\":" << depth
          << ",\"stride\":" << stride << ",\"scanlines\":" << lines
          << ",\"topDown\":true,\"file\":" << quote(file) << ",\"paletteRGB\":" << array(palette) << '}';
        return o.str();
    }
};
BitmapPlane copyPlane(const fs::path& output, const std::string& name, HBITMAP bitmap,
    LONG width, LONG height, unsigned depth) {
    BitmapPlane out; out.present = bitmap != nullptr;
    if (!bitmap) return out;
    if (width <= 0 || height <= 0 || width > 512 || height > 1024 || (depth != 1 && depth != 32)) {
        out.error = ERROR_INVALID_DATA; return out;
    }
    out.width = static_cast<unsigned>(width); out.height = static_cast<unsigned>(height); out.depth = depth;
    out.stride = ((out.width * depth + 31) / 32) * 4;
    Bytes pixels(static_cast<size_t>(out.stride) * out.height, 0);
    struct { BITMAPINFOHEADER header; RGBQUAD colors[2]; } information{};
    information.header.biSize = sizeof(BITMAPINFOHEADER);
    information.header.biWidth = width; information.header.biHeight = -height;
    information.header.biPlanes = 1; information.header.biBitCount = static_cast<WORD>(depth);
    information.header.biCompression = BI_RGB;
    if (depth == 1) { information.header.biClrUsed = 2; information.colors[1] = {255, 255, 255, 0}; }
    HDC dc = CreateCompatibleDC(nullptr);
    if (!dc) { out.error = GetLastError(); return out; }
    SetLastError(0);
    const int lines = GetDIBits(dc, bitmap, 0, out.height, pixels.data(),
        reinterpret_cast<BITMAPINFO*>(&information), DIB_RGB_COLORS);
    out.error = lines == height ? 0 : GetLastError();
    out.lines = lines > 0 ? static_cast<unsigned>(lines) : 0;
    const bool deleted = DeleteDC(dc) != FALSE;
    if (!deleted && !out.error) out.error = GetLastError();
    out.ok = lines == height && deleted;
    if (depth == 1) for (const auto& color : information.colors)
        out.palette.push_back((color.rgbRed << 16) | (color.rgbGreen << 8) | color.rgbBlue);
    out.file = name + (depth == 1 ? ".mask1" : ".bgra");
    // Preserve partial bytes too; scanlines/ok distinguish them from evidence.
    write(output / out.file, pixels);
    return out;
}
struct CursorInfo {
    bool ok = false, icon = false;
    bool bitmapsDeleted = true;
    DWORD error = 0, x = 0, y = 0;
    LONG width = 0, height = 0, maskWidth = 0, maskHeight = 0;
    int maskQueryBytes = 0, colorQueryBytes = 0;
    WORD bpp = 0;
    BitmapPlane colorPlane, maskPlane;
    bool planesCopied = false;
    std::string json() const {
        std::ostringstream o; o << "{\"ok\":" << (ok ? "true" : "false") << ",\"error\":" << error
          << ",\"fIcon\":" << (icon ? "true" : "false") << ",\"hotspot\":{\"x\":" << x << ",\"y\":" << y
          << "},\"width\":" << width << ",\"height\":" << height << ",\"colorBpp\":" << bpp
          << ",\"maskWidth\":" << maskWidth << ",\"maskHeight\":" << maskHeight
          << ",\"maskQueryBytes\":" << maskQueryBytes << ",\"colorQueryBytes\":" << colorQueryBytes
          << ",\"bitmapsDeleted\":" << (bitmapsDeleted ? "true" : "false")
          << ",\"planesCopied\":" << (planesCopied ? "true" : "false")
          << ",\"colorPlane\":" << colorPlane.json() << ",\"maskPlane\":" << maskPlane.json() << '}'; return o.str();
    }
};
CursorInfo cursorInfo(HCURSOR cursor, const fs::path& output, const std::string& name) {
    CursorInfo out; ICONINFO info{}; SetLastError(0);
    if (!GetIconInfo(cursor, &info)) { out.error = GetLastError(); return out; }
    out.ok = true; out.icon = info.fIcon != FALSE; out.x = info.xHotspot; out.y = info.yHotspot;
    BITMAP mask{}, color{};
    if (info.hbmMask) {
        SetLastError(0); out.maskQueryBytes = GetObjectW(info.hbmMask, sizeof(mask), &mask);
        if (out.maskQueryBytes != sizeof(mask)) { out.ok = false; out.error = GetLastError(); }
        else { out.maskWidth = mask.bmWidth; out.maskHeight = mask.bmHeight; }
    } else { out.ok = false; out.error = ERROR_INVALID_DATA; }
    if (info.hbmColor) {
        SetLastError(0); out.colorQueryBytes = GetObjectW(info.hbmColor, sizeof(color), &color);
        if (out.colorQueryBytes != sizeof(color)) { out.ok = false; out.error = GetLastError(); }
        else { out.width = color.bmWidth; out.height = color.bmHeight; out.bpp = color.bmBitsPixel; }
    } else { out.width = mask.bmWidth; out.height = mask.bmHeight / 2; }
    if (out.width <= 0 || out.height <= 0) { out.ok = false; if (!out.error) out.error = ERROR_INVALID_DATA; }
    try {
        out.colorPlane = copyPlane(output, name + "-color", info.hbmColor, color.bmWidth, color.bmHeight, 32);
        out.maskPlane = copyPlane(output, name + "-mask", info.hbmMask, mask.bmWidth, mask.bmHeight, 1);
        out.planesCopied = out.maskPlane.ok && (!out.colorPlane.present || out.colorPlane.ok);
    } catch (...) {
        if (info.hbmColor) DeleteObject(info.hbmColor);
        if (info.hbmMask) DeleteObject(info.hbmMask);
        throw;
    }
    if (info.hbmColor && !DeleteObject(info.hbmColor)) { out.bitmapsDeleted = false; out.ok = false; out.error = GetLastError(); }
    if (info.hbmMask && !DeleteObject(info.hbmMask)) { out.bitmapsDeleted = false; out.ok = false; out.error = GetLastError(); }
    return out;
}
std::string draw(const fs::path& output, const std::string& id, HCURSOR cursor, unsigned step,
    unsigned flags, unsigned background, int requestedWidth, int requestedHeight, const CursorInfo& info) {
    const int width = std::max(80, std::min(512, static_cast<int>(info.width) + 32)),
        height = std::max(80, std::min(512, static_cast<int>(info.height) + 32));
    HDC dc = CreateCompatibleDC(nullptr);
    if (!dc) throw std::runtime_error("CreateCompatibleDC failed");
    BITMAPINFO bitmap{}; bitmap.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
    bitmap.bmiHeader.biWidth = width; bitmap.bmiHeader.biHeight = -height;
    bitmap.bmiHeader.biPlanes = 1; bitmap.bmiHeader.biBitCount = 32; bitmap.bmiHeader.biCompression = BI_RGB;
    void* pixels = nullptr;
    HBITMAP dib = CreateDIBSection(dc, &bitmap, DIB_RGB_COLORS, &pixels, nullptr, 0);
    if (!dib || !pixels) { if (dib) DeleteObject(dib); DeleteDC(dc); throw std::runtime_error("CreateDIBSection failed"); }
    HGDIOBJ previous = SelectObject(dc, dib);
    if (!previous || previous == HGDI_ERROR) { DeleteObject(dib); DeleteDC(dc); throw std::runtime_error("SelectObject failed"); }
    const auto words = static_cast<DWORD*>(pixels);
    for (int n = 0; n < width * height; n++) words[n] = 0xff000000 | background;
    SetLastError(0);
    const bool ok = DrawIconEx(dc, 16, 16, cursor, requestedWidth, requestedHeight, step, nullptr, flags) != FALSE;
    const DWORD error = ok ? 0 : GetLastError(); GdiFlush();
    const std::string filename = id + "-s" + std::to_string(step) + "-f" + std::to_string(flags) + "-b" + std::to_string(background)
        + "-" + std::to_string(requestedWidth) + "x" + std::to_string(requestedHeight) + ".bgra";
    Bytes bytes(static_cast<std::uint8_t*>(pixels), static_cast<std::uint8_t*>(pixels) + width * height * 4);
    SelectObject(dc, previous); DeleteObject(dib); DeleteDC(dc);
    write(output / filename, bytes);
    std::ostringstream o; o << "{\"flags\":" << flags << ",\"drawX\":16,\"drawY\":16,\"requestedWidth\":" << requestedWidth
      << ",\"requestedHeight\":" << requestedHeight << ",\"backgroundRGB\":" << background << ",\"canvasWidth\":" << width
      << ",\"canvasHeight\":" << height << ",\"stride\":" << width * 4 << ",\"ok\":" << (ok ? "true" : "false")
      << ",\"error\":" << error << ",\"pixelsFile\":" << quote(filename) << '}'; return o.str();
}
// This optional export has no documented SDK contract. Its metadata is recorded
// separately as empirical evidence, never called a guaranteed Win32 API rule.
// Wine's public cursoricon tests document the observed signature/ownership;
// frame handles are borrowed, and only the original loaded cursor is destroyed.
using GetCursorFrameInfoFn = HCURSOR (WINAPI*)(HCURSOR, DWORD, DWORD, DWORD*, DWORD*);
std::string observe(const fs::path& output, const Fixture& f, GetCursorFrameInfoFn frameInfo, bool& cleanupFailed) {
    const std::string filename = f.id + "." + f.kind; const auto path = output / filename;
    write(path, f.bytes);
    std::ostringstream o; o << "{\"id\":" << quote(f.id) << ",\"file\":" << quote(filename) << ",\"kind\":" << quote(f.kind)
      << ",\"classification\":" << quote(f.classification) << ",\"bytes\":" << f.bytes.size() << ",\"entries\":" << imagesJson(f.images);
    if (f.kind == "ani") {
        o << ",\"ani\":{\"frames\":" << f.frames.size() << ",\"steps\":" << f.steps << ",\"sequence\":" << array(f.sequence)
          << ",\"rates\":" << array(f.rates) << ",\"defaultRate\":" << f.defaultRate << ",\"flags\":" << f.flags
          << ",\"nominalWidth\":" << f.nominalWidth << ",\"nominalHeight\":" << f.nominalHeight
          << ",\"nominalDepth\":" << f.nominalDepth << ",\"nominalPlanes\":" << f.nominalPlanes
          << ",\"embeddedType\":" << f.embeddedType << ",\"frameEntries\":[";
        for (size_t n = 0; n < f.frames.size(); n++) { if (n) o << ','; o << imagesJson(f.frames[n]); } o << "]}";
    }
    SetLastError(0); HCURSOR cursor = LoadCursorFromFileW(path.c_str()); const DWORD error = cursor ? 0 : GetLastError();
    o << ",\"loaded\":" << (cursor ? "true" : "false") << ",\"loadError\":" << error
      << ",\"frameInfoAvailable\":" << (frameInfo ? "true" : "false");
    if (!cursor) { o << ",\"steps\":[]} "; return o.str(); }
    try {
        const auto info = cursorInfo(cursor, output, f.id + "-root");
        if (!info.bitmapsDeleted) cleanupFailed = true;
        o << ",\"info\":" << info.json() << ",\"steps\":[";
        // Include the first out-of-range step as characterization. Static
        // cursors ignore this parameter, so only step 0 is needed for them.
        const unsigned count = f.kind == "ani" ? std::min(32u, f.steps + 1) : 1;
        for (unsigned step = 0; step < count; step++) {
            if (step) o << ',';
            o << "{\"step\":" << step;
            CursorInfo frame = info;
            if (frameInfo) {
                DWORD rate = 0xdeadbeef, steps = 0xdeadbeef; SetLastError(0);
                HCURSOR handle = frameInfo(cursor, 0, step, &rate, &steps);
                const DWORD frameError = handle ? 0 : GetLastError();
                if (handle) {
                    frame = cursorInfo(handle, output, f.id + "-frame-" + std::to_string(step));
                    if (!frame.bitmapsDeleted) cleanupFailed = true;
                }
                o << ",\"frameInfo\":{\"available\":true,\"ok\":" << (handle ? "true" : "false") << ",\"error\":" << frameError
                  << ",\"rateJiffies\":" << rate << ",\"steps\":" << steps << ",\"info\":" << (handle ? frame.json() : "null") << '}';
            } else o << ",\"frameInfo\":{\"available\":false}";
            o << ",\"draws\":[";
            bool first = true;
            std::vector<unsigned> backgrounds{0u, 0xffffffu, 0x123456u};
            if (f.id == "dib-alpha-sweep" || f.id == "png-alpha-sweep")
                for (unsigned channel : {1u, 127u, 129u, 253u}) backgrounds.push_back(channel * 0x010101u);
            for (unsigned flags : {static_cast<unsigned>(DI_NORMAL | DI_NOMIRROR), static_cast<unsigned>(DI_MASK | DI_NOMIRROR), static_cast<unsigned>(DI_IMAGE | DI_NOMIRROR)})
                for (unsigned background : backgrounds) for (unsigned size : {0u, 1u}) {
                    if (!first) o << ','; first = false;
                    o << draw(output, f.id, cursor, step, flags, background, size ? 48 : 0, size ? 40 : 0, frame);
                }
            o << "]}";
        }
        o << ']';
    } catch (...) { DestroyCursor(cursor); throw; }
    SetLastError(0); const bool destroyed = DestroyCursor(cursor) != FALSE; const DWORD destroyError = destroyed ? 0 : GetLastError();
    if (!destroyed) cleanupFailed = true;
    o << ",\"destroyed\":" << (destroyed ? "true" : "false") << ",\"destroyError\":" << destroyError << '}'; return o.str();
}
std::string environment() {
    using RtlGetVersionFn = LONG (WINAPI*)(OSVERSIONINFOW*);
    OSVERSIONINFOW version{}; version.dwOSVersionInfoSize = sizeof(version);
    auto getVersion = reinterpret_cast<RtlGetVersionFn>(GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "RtlGetVersion"));
    const bool available = getVersion && getVersion(&version) == 0;
    HDC dc = GetDC(nullptr); const int depth = dc ? GetDeviceCaps(dc, BITSPIXEL) * GetDeviceCaps(dc, PLANES) : 0;
    const int dpiX = dc ? GetDeviceCaps(dc, LOGPIXELSX) : 0, dpiY = dc ? GetDeviceCaps(dc, LOGPIXELSY) : 0;
    if (dc) ReleaseDC(nullptr, dc);
    std::ostringstream o; o << "{\"windowsVersion\":" << quote(available ? std::to_string(version.dwMajorVersion) + "." + std::to_string(version.dwMinorVersion) + "." + std::to_string(version.dwBuildNumber) : "unavailable")
      << ",\"architecture\":" << quote(sizeof(void*) == 8 ? "x64" : "x86") << ",\"systemCursor\":{\"width\":" << GetSystemMetrics(SM_CXCURSOR)
      << ",\"height\":" << GetSystemMetrics(SM_CYCURSOR) << "},\"displayBitsPerPixel\":" << depth << ",\"dpi\":{\"x\":" << dpiX << ",\"y\":" << dpiY << "}}";
    return o.str();
}

// Separate finite-domain mask observations: no DrawIconEx, animation, or
// portable scaler/candidate runs. Every source coordinate gets its own line
// fixture so source support is measured, never assigned to a guessed region.
struct MaskFootprint {
    std::string kind;
    std::string plane = "crossed";
    char axis = 'x';
    unsigned coordinate = 0, x = 0, y = 0, constant = 0;
};
bool footprintBit(const MaskFootprint& pattern, unsigned x, unsigned y, bool xorPlane) {
    if ((pattern.plane == "AND" && xorPlane) || (pattern.plane == "XOR" && !xorPlane)) return true;
    const bool crossed = pattern.plane == "crossed";
    if (pattern.kind == "constant") return pattern.constant != 0;
    if (pattern.kind == "zero-line") {
        const char axis = crossed && xorPlane ? (pattern.axis == 'x' ? 'y' : 'x') : pattern.axis;
        return (axis == 'x' ? x : y) != pattern.coordinate;
    }
    if (pattern.kind == "zero-point")
        return !(x == (crossed && xorPlane ? pattern.y : pattern.x) && y == (crossed && xorPlane ? pattern.x : pattern.y));
    throw std::runtime_error("Unknown footprint pattern");
}
Bytes footprintCursor(unsigned depth, const MaskFootprint& pattern, unsigned width = 256, unsigned height = 256) {
    if (depth != 1 && depth != 32) throw std::runtime_error("Invalid footprint depth");
    if (!width || !height || width > 256 || height > 256) throw std::runtime_error("Invalid footprint dimensions");
    const unsigned maskStride = ((width + 31) / 32) * 4, colorStride = ((width * depth + 31) / 32) * 4;
    Bytes payload;
    put32(payload, 40); put32(payload, width); put32(payload, height * 2);
    put16(payload, 1); put16(payload, depth); put32(payload, BI_RGB);
    put32(payload, (colorStride + maskStride) * height); put32(payload, 0); put32(payload, 0);
    put32(payload, depth == 1 ? 2 : 0); put32(payload, 0);
    if (depth == 1) { put32(payload, 0); put32(payload, 0x00ffffff); }
    const auto colorAt = payload.size(), maskAt = colorAt + colorStride * height;
    payload.resize(maskAt + maskStride * height, 0);
    // Top-down fixture coordinates are written into independent bottom-up DIB
    // planes. Constant non-grey RGB prevents an all-black color image from
    // collapsing to a monochrome representation; alpha remains exactly zero.
    for (unsigned y = 0; y < height; y++) for (unsigned x = 0; x < width; x++) {
        const unsigned row = height - 1 - y, bit = 1u << (7 - x % 8);
        if (footprintBit(pattern, x, y, false)) payload[maskAt + row * maskStride + x / 8] |= bit;
        if (depth == 1 && footprintBit(pattern, x, y, true)) payload[colorAt + row * colorStride + x / 8] |= bit;
        if (depth == 32) {
            const auto at = colorAt + row * colorStride + x * 4;
            payload[at] = 65; payload[at + 1] = 33; payload[at + 2] = 17;
        }
    }
    Image image; image.width = width; image.height = height; image.bpp = depth;
    image.hotX = image.hotY = 0; image.payload = std::move(payload);
    return cur({image});
}
int observeMaskFootprints(const fs::path& output, bool geometry = false) {
    const unsigned expected = geometry ? 2670 : 1100;
    const std::string basename = geometry ? "mask-geometry" : "mask-footprints";
    const char* sha = std::getenv("GITHUB_SHA");
    const auto platform = environment();
    std::vector<std::string> rows;
    unsigned failures = 0;
    bool cleanupFailed = false;
    std::ofstream journal(output / (basename + ".jsonl"), std::ios::binary | std::ios::trunc);
    if (!journal) throw std::runtime_error("Cannot open footprint journal");
    auto save = [&](bool completed) {
        std::ostringstream json;
        json << "{\"schema\":1,\"scope\":\"Independent User32 raw mask support observations; no portable compatibility claim\","
          << "\"globalInputUsed\":false,\"drawIconExUsed\":false,\"portableCandidatesUsed\":false,\"completed\":"
          << (completed ? "true" : "false") << ",\"cleanupFailed\":" << (cleanupFailed ? "true" : "false")
          << ",\"failures\":" << failures << ",\"sourceCommit\":" << quote(sha ? sha : "")
          << ",\"platform\":" << platform << ",\"sourceExtent\":" << (geometry ? "null" : "256")
          << ",\"expectedSamples\":" << expected
          << ",\"observedSamples\":" << rows.size()
          << ",\"design\":{\"axisLines\":" << (geometry ? 1872 : 1024)
          << ",\"constants\":" << (geometry ? 42 : 4) << ",\"points\":" << (geometry ? 756 : 72)
          << ",\"coordinateSpace\":\"top-down source pixels\",\"lineXor\":"
          << quote(geometry ? "only named plane changes; other plane stays one" : "other axis, same source coordinate")
          << ",\"pointXor\":" << quote(geometry ? "only named plane changes; no transpose" : "transpose source x and y")
          << ",\"sourceShapes\":" << (geometry ? "[[64,64],[48,48],[13,9],[64,48],[48,64],[64,13],[13,64]]" : "[[256,256]]")
          << ",\"color32\":\"BGRA=(65,33,17,0), independent AND plane\"},\"samples\":[";
        for (size_t n = 0; n < rows.size(); n++) { if (n) json << ','; json << rows[n]; }
        json << "]}\n"; writeText(output / (basename + ".json"), json.str());
    };
    save(false);
    auto observeOne = [&](unsigned depth, const MaskFootprint& pattern, unsigned width = 256, unsigned height = 256) {
        std::string suffix = pattern.kind + "-";
        if (pattern.kind == "zero-line") suffix += std::string(1, pattern.axis) + "-" + std::to_string(pattern.coordinate);
        else if (pattern.kind == "zero-point") suffix += std::to_string(pattern.x) + "-" + std::to_string(pattern.y);
        else suffix += std::to_string(pattern.constant);
        const std::string prefix = geometry ? "mask-geometry-" + std::to_string(width) + "x" + std::to_string(height) + "-"
          + pattern.plane + "-" : "mask-footprint-";
        const std::string id = prefix + std::to_string(depth) + "-" + suffix, filename = id + ".cur";
        std::cout << "BEGIN " << id << std::endl;
        const auto bytes = footprintCursor(depth, pattern, width, height);
        write(output / filename, bytes);
        std::ostringstream row;
        row << "{\"id\":" << quote(id) << ",\"file\":" << quote(filename) << ",\"bytes\":" << bytes.size()
          << ",\"depth\":" << depth << ",\"width\":" << width << ",\"height\":" << height
          << ",\"pattern\":{\"kind\":" << quote(pattern.kind) << ",\"plane\":" << quote(pattern.plane)
          << ",\"axis\":" << quote(std::string(1, pattern.axis)) << ",\"coordinate\":" << pattern.coordinate
          << ",\"x\":" << pattern.x << ",\"y\":" << pattern.y << ",\"constant\":" << pattern.constant << '}';
        SetLastError(0);
        HCURSOR cursor = LoadCursorFromFileW((output / filename).c_str());
        const DWORD loadError = cursor ? 0 : GetLastError();
        row << ",\"loaded\":" << (cursor ? "true" : "false") << ",\"loadError\":" << loadError;
        if (cursor) {
            try {
                const auto info = cursorInfo(cursor, output, id);
                row << ",\"info\":" << info.json();
                if (!info.ok || !info.planesCopied) failures++;
                if (!info.bitmapsDeleted) cleanupFailed = true;
            } catch (...) { DestroyCursor(cursor); throw; }
            SetLastError(0);
            const bool destroyed = DestroyCursor(cursor) != FALSE;
            const DWORD destroyError = destroyed ? 0 : GetLastError();
            if (!destroyed) cleanupFailed = true;
            row << ",\"destroyed\":" << (destroyed ? "true" : "false") << ",\"destroyError\":" << destroyError;
        } else failures++;
        row << '}'; rows.push_back(row.str());
        journal << rows.back() << '\n'; journal.flush();
        if (!journal) throw std::runtime_error("Cannot append footprint journal");
        if (rows.size() % 16 == 0) save(false);
        std::cout << "OBSERVED " << id << std::endl;
    };
    if (geometry) {
        const unsigned shapes[][2] = {{64,64},{48,48},{13,9},{64,48},{48,64},{64,13},{13,64}};
        for (const auto& shape : shapes) for (unsigned depth : {1u, 32u}) for (const auto& plane : {"AND", "XOR"}) {
            if (depth == 32 && std::string(plane) == "XOR") continue;
            const unsigned width = shape[0], height = shape[1];
            for (unsigned value : {0u, 1u}) {
                MaskFootprint p; p.plane = plane; p.kind = "constant"; p.constant = value;
                observeOne(depth, p, width, height);
            }
            for (char axis : {'x', 'y'}) for (unsigned coordinate = 0; coordinate < (axis == 'x' ? width : height); coordinate++) {
                MaskFootprint p; p.plane = plane; p.kind = "zero-line"; p.axis = axis; p.coordinate = coordinate;
                observeOne(depth, p, width, height);
            }
            for (unsigned x : {0u, 1u, 4u, 5u, width - 2, width - 1})
              for (unsigned y : {0u, 1u, 4u, 5u, height - 2, height - 1}) {
                MaskFootprint p; p.plane = plane; p.kind = "zero-point"; p.x = x; p.y = y;
                observeOne(depth, p, width, height);
            }
        }
    } else for (unsigned depth : {1u, 32u}) {
        for (unsigned value : {0u, 1u}) {
            MaskFootprint pattern; pattern.kind = "constant"; pattern.constant = value;
            observeOne(depth, pattern);
        }
        for (char axis : {'x', 'y'}) for (unsigned coordinate = 0; coordinate < 256; coordinate++) {
            MaskFootprint pattern; pattern.kind = "zero-line"; pattern.axis = axis; pattern.coordinate = coordinate;
            observeOne(depth, pattern);
        }
        for (unsigned x : {0u, 4u, 5u, 252u, 253u, 255u}) for (unsigned y : {0u, 4u, 5u, 252u, 253u, 255u}) {
            MaskFootprint pattern; pattern.kind = "zero-point"; pattern.x = x; pattern.y = y;
            observeOne(depth, pattern);
        }
    }
    if (rows.size() != expected) throw std::runtime_error("Footprint observation inventory changed");
    save(true);
    std::cout << "COMPLETE " << rows.size() << " independent mask observations; no compatibility pass claim\n";
    return failures || cleanupFailed ? 2 : 0;
}
int wmain(int argc, wchar_t** argv) {
    try {
        const char* actions = std::getenv("GITHUB_ACTIONS"), *runner = std::getenv("RUNNER_ENVIRONMENT"), *os = std::getenv("RUNNER_OS");
        if (!actions || std::string(actions) != "true" || !runner || std::string(runner) != "github-hosted" || !os || std::string(os) != "Windows")
            throw std::runtime_error("This probe runs only on GitHub-hosted Windows Actions");
        if (argc != 2 && (argc != 3 || (std::wstring(argv[2]) != L"--mask-footprints" && std::wstring(argv[2]) != L"--mask-geometry")))
            throw std::runtime_error("Expected output directory and optional --mask-footprints or --mask-geometry");
        SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX);
        const fs::path output = fs::absolute(argv[1]); fs::create_directories(output);
        if (argc == 3) return observeMaskFootprints(output, std::wstring(argv[2]) == L"--mask-geometry");
        const auto cases = fixtures(); const std::string platform = environment();
        const char* sha = std::getenv("GITHUB_SHA");
        auto frameInfo = reinterpret_cast<GetCursorFrameInfoFn>(GetProcAddress(GetModuleHandleW(L"user32.dll"), "GetCursorFrameInfo"));
        std::vector<std::string> rows;
        bool cleanupFailed = false;
        auto save = [&](bool completed) {
            std::ostringstream json; json << "{\"schema\":1,\"scope\":\"User32 file load and offscreen draw; not original KRKR or VCL\",\"globalInputUsed\":false,\"wallClockAnimationMeasured\":false,\"completed\":"
              << (completed ? "true" : "false") << ",\"cleanupFailed\":" << (cleanupFailed ? "true" : "false")
              << ",\"sourceCommit\":" << quote(sha ? sha : "") << ",\"platform\":" << platform
              << ",\"expectedFixtures\":" << cases.size() << ",\"observedFixtures\":" << rows.size() << ",\"fixtures\":[";
            for (size_t n = 0; n < rows.size(); n++) { if (n) json << ','; json << rows[n]; } json << "]}\n";
            writeText(output / "observations.json", json.str());
        };
        save(false);
        for (const auto& f : cases) {
            std::cout << "BEGIN " << f.id << std::endl;
            rows.push_back(observe(output, f, frameInfo, cleanupFailed)); save(false);
            std::cout << "OBSERVED " << f.id << std::endl;
        }
        save(true); std::cout << "COMPLETE " << rows.size() << " fixtures; observations are not compatibility pass claims\n";
        if (cleanupFailed) { std::cerr << "Native cursor/bitmap cleanup failed; complete rows preserved\n"; return 2; }
        return 0;
    } catch (const std::exception& error) { std::cerr << error.what() << '\n'; return 1; }
}
