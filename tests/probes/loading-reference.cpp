// Optional independent TVP scalar key/mask/matte output; no app linkage.
#include <cstdio>
#include <cstdint>
#include "tvpgl.h"
static uint32_t swap(uint32_t v){return (v&0xff00ff00u)|((v&255)<<16)|((v>>16)&255);}
int main(){
  TVPInitTVPGL();
  const uint32_t colors[]={0,0xffffff,0xc86432,0x13b8ed};
  for(int operation=0;operation<3;operation++)for(auto color:colors)for(auto key:colors)for(int alpha=0;alpha<256;alpha++){
    uint32_t source=swap(color|(uint32_t(alpha)<<24)),out=source;
    if(operation==0)TVPAlphaColorMat(&out,swap(key),1);
    else if(operation==1)TVPMakeAlphaFromKey(&out,1,swap(key));
    else{uint8_t mask=alpha;TVPBindMaskToMain(&out,&mask,1);}
    std::printf("%d %u %u %u\n",operation,source,key,out);
  }
  TVPUninitTVPGL();
}
