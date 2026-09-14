// Optional scalar reference adapter; the generated include is extracted from
// the original CPU box loop retained in the adjacent LayerBitmapIntf.cpp.
// This adapter is never linked into the browser application.
#include <algorithm>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <new>
#include <vector>
#include "argb.h"

struct tTVPRect {
  int left, top, right, bottom;
  tTVPRect(int l,int t,int r,int b):left(l),top(t),right(r),bottom(b){}
};
static void *TJSAlignedAlloc(size_t bytes,int power) {
  void *result = nullptr;
  if (posix_memalign(&result, size_t(1) << power, bytes)) throw std::bad_alloc();
  // The original loop also advances a sum through its spare column after
  // emitting the last pixel. Give that otherwise-uninitialized sentinel 0.
  std::memset(result, 0, bytes);
  return result;
}
static void TJSAlignedDealloc(void *ptr) { std::free(ptr); }
class tTVPBaseBitmap {
  int width, height;
public:
  std::vector<tjs_uint32> pixels;
  tTVPBaseBitmap(int w,int h):width(w),height(h),pixels(w*h){}
  int GetWidth() const {return width;}
  int GetHeight() const {return height;}
  const void *GetScanLine(int y) const {return pixels.data()+y*width;}
  void *GetScanLineForWrite(int y) {return pixels.data()+y*width;}
  template <typename tARGB> void DoBoxBlurLoop(const tTVPRect &,const tTVPRect &);
};
#include "box-loop.inc"
static tjs_uint32 swapRB(tjs_uint32 p) {return (p&0xff00ff00u)|((p&255)<<16)|((p>>16)&255);}
int main() {
  TVPInitTVPGL();
  int operation,width,height,x,y,w,h,rx,ry;
  while(std::scanf("%d %d %d %d %d %d %d %d %d",&operation,&width,&height,&x,&y,&w,&h,&rx,&ry)==9) {
    tTVPBaseBitmap bitmap(width,height);
    for(auto &pixel:bitmap.pixels){unsigned p;if(std::scanf("%u",&p)!=1)return 2;pixel=swapRB(p);}
    if(operation==0)TVPConvertAlphaToAdditiveAlpha(bitmap.pixels.data(),width*height);
    else if(operation==1)TVPConvertAdditiveAlphaToAlpha(bitmap.pixels.data(),width*height);
    else if(operation==2){for(int row=y;row<y+h;row++)TVPDoGrayScale(bitmap.pixels.data()+row*width+x,w);}
    else if(w>0&&h>0&&(rx||ry)){
      rx=std::abs(rx);ry=std::abs(ry);
      const tTVPRect rect(x,y,x+w,y+h),area(-rx,-ry,rx,ry);
      if((2*rx+1)*(2*ry+1)<256){
        if(operation==4)bitmap.DoBoxBlurLoop<tTVPARGB_AA<tjs_uint16>>(rect,area);
        else bitmap.DoBoxBlurLoop<tTVPARGB<tjs_uint16>>(rect,area);
      }else{
        if(operation==4)bitmap.DoBoxBlurLoop<tTVPARGB_AA<tjs_uint32>>(rect,area);
        else bitmap.DoBoxBlurLoop<tTVPARGB<tjs_uint32>>(rect,area);
      }
    }
    for(auto pixel:bitmap.pixels)std::printf("%u\n",swapRB(pixel));
  }
  TVPUninitTVPGL();
}
