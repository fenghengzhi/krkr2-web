#include "tlg-encoder.hpp"
int TLGProbeFilter = -1, TLGProbePrediction = -1;
int main() {
  TVPInitTVPGL();
  int version,colors,width,height;
  while (std::cin >> version >> colors >> width >> height >> TLGProbeFilter >> TLGProbePrediction) {
    iTVPBaseBitmap bitmap(width,height,colors);
    for (int i=0;i<width*height;i++) {
      tjs_uint32 rgba; if (!(std::cin >> rgba)) return 2;
      if (colors==1) bitmap.bytes[i]=rgba&255;
      else {
        // Canonical TLG planes are BGRA. Test input and expected output are RGBA.
        bitmap.bytes[i*4]=(rgba>>16)&255;
        bitmap.bytes[i*4+1]=(rgba>>8)&255;
        bitmap.bytes[i*4+2]=rgba&255;
        bitmap.bytes[i*4+3]=rgba>>24;
      }
    }
    tTJSBinaryStream stream;
    if (version==5) SaveTLG5(&stream,&bitmap,colors==3);
    else SaveTLG6(&stream,&bitmap,colors==3);
    tjs_uint32 size=stream.bytes.size();
    for (int i=0;i<4;i++) std::putchar((size>>(i*8))&255);
    std::fwrite(stream.bytes.data(),1,size,stdout);
  }
}
