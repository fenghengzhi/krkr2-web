// Minimal stream/bitmap host for the original encoders, never linked to the app.
#pragma once
#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <iostream>
#include <stdexcept>
#include <vector>
#include "tjsTypes.h"
#include "tvpgl.h"
#include "SaveTLG.h"
#define TJS_malloc std::malloc
#define TJS_realloc std::realloc
#define TJS_free std::free
static const char *TVPTlgInsufficientMemory = "out of memory";
static const char *TVPTlgTooLargeBitLength = "bit length";
[[noreturn]] static void TVPThrowExceptionMessage(const char *text) {throw std::runtime_error(text);}
static tjs_uint32 TVPGetRoughTickCount32() {return 0;}
extern int TLGProbeFilter, TLGProbePrediction;
class iTVPBaseBitmap {
  int width, height, stride;
public:
  std::vector<unsigned char> bytes;
  iTVPBaseBitmap(int w,int h,int colors):width(w),height(h),stride(colors==1?1:4),bytes(w*h*stride){}
  int GetWidth() const {return width;}
  int GetHeight() const {return height;}
  bool Is32BPP() const {return stride==4;}
  const void *GetScanLine(int y) const {return bytes.data()+y*width*stride;}
};
class tTJSBinaryStream {
  size_t position = 0;
public:
  std::vector<unsigned char> bytes;
  virtual ~tTJSBinaryStream() = default;
  void Write(const void *data,size_t size) {
    if (position+size > bytes.size()) bytes.resize(position+size);
    std::memcpy(bytes.data()+position,data,size);position+=size;
  }
  void WriteBuffer(const void *data,size_t size) {Write(data,size);}
  size_t GetPosition() const {return position;}
  void SetPosition(size_t value) {position=value;}
  size_t GetSize() const {return bytes.size();}
  const void *GetInternalBuffer() const {return bytes.data();}
};
using tTVPMemoryStream = tTJSBinaryStream;
void SaveTLG5(tTJSBinaryStream *, const iTVPBaseBitmap *, bool);
void SaveTLG6(tTJSBinaryStream *, const iTVPBaseBitmap *, bool);
