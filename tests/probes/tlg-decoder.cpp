// Optional native loader host. The extracted LoadTLG functions and TVP kernels
// are unmodified; the test allocator initializes their extra fetch padding.
#include <algorithm>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <stdexcept>
#include <vector>
#include "tjsTypes.h"
#include "tvpgl.h"
enum tTVPGraphicLoadMode {glmNormal,glmPalettized,glmGrayscale};
enum {gpfRGB,gpfRGBA};
using tTVPGraphicSizeCallback=int(*)(void*,int,int,int);
using tTVPGraphicScanLineCallback=void*(*)(void*,int);
static const tjs_char message[]={0};
#define TVPTLGLoadError message
#define TVPTlgUnsupportedUniversalTransitionRule message
#define TVPUnsupportedColorType message
#define TVPUnsupportedColorCount message
#define TVPDataFlagMustBeZero message
#define TVPUnsupportedColorTypeColon message
#define TVPUnsupportedExternalGolombBitLengthTable message
#define TVPUnsupportedEntropyCodingMethod message
struct ttstr {ttstr(const tjs_char*){} ttstr(int){} ttstr operator+(const ttstr&)const{return *this;}};
template<class... T> [[noreturn]] void TVPThrowExceptionMessage(T...){throw std::runtime_error("Native TLG decoder rejected image");}
static void *TJSAlignedAlloc(size_t size,int alignment){void *p=nullptr;if(posix_memalign(&p,size_t(1)<<alignment,size))throw std::bad_alloc();std::memset(p,0,size);return p;}
static void TJSAlignedDealloc(void *p){std::free(p);}
class tTJSBinaryStream {
  const std::vector<unsigned char>&bytes;size_t position=11;
public:
  tTJSBinaryStream(const std::vector<unsigned char>&value):bytes(value){}
  void ReadBuffer(void *output,size_t length){if(length>bytes.size()-position)throw std::runtime_error("Truncated native input");std::memcpy(output,bytes.data()+position,length);position+=length;}
  tjs_int ReadI32LE(){unsigned char b[4];ReadBuffer(b,4);return uint32_t(b[0])|(uint32_t(b[1])<<8)|(uint32_t(b[2])<<16)|(uint32_t(b[3])<<24);}
  size_t GetPosition()const{return position;}
  void SetPosition(size_t value){if(value>bytes.size())throw std::runtime_error("Native seek out of bounds");position=value;}
};
#include "load-tlg.inc"
struct Bitmap {int width=0,height=0;std::vector<unsigned char> bytes;};
static int size(void *p,int width,int height,int){auto &b=*static_cast<Bitmap*>(p);if(width<1||height<1||width>4096||height>4096)throw std::runtime_error("Invalid dimensions");b.width=width;b.height=height;b.bytes.resize(width*height*4);return width*4;}
static void *line(void *p,int y){auto &b=*static_cast<Bitmap*>(p);return y<0?nullptr:b.bytes.data()+y*b.width*4;}
int main(){
  TVPInitTVPGL();uint32_t length;
  while(std::fread(&length,4,1,stdin)==1){
    std::vector<unsigned char> bytes(length);if(std::fread(bytes.data(),1,length,stdin)!=length)return 2;
    Bitmap bitmap;tTJSBinaryStream stream(bytes);
    if(std::memcmp(bytes.data(),"TLG5.0",6)==0)TVPLoadTLG5(nullptr,&bitmap,size,line,&stream,-1,glmNormal);
    else if(std::memcmp(bytes.data(),"TLG6.0",6)==0)TVPLoadTLG6(nullptr,&bitmap,size,line,&stream,-1,false);
    else return 3;
    uint32_t size=bitmap.bytes.size();std::fwrite(&size,4,1,stdout);std::fwrite(bitmap.bytes.data(),1,size,stdout);
  }
  TVPUninitTVPGL();
}
