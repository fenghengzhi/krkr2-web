// Opt-in reference adapter. Link against the adjacent reference's tvpgl.cpp
// and gl/blend_function.cpp; no reference graphics code ships in the Web app.
#include <cstdio>
#include <cstdint>
#include "tvpgl.h"

static uint32_t blend(uint32_t d, uint32_t s, int mode, int face, int opacity, bool hold) {
  if (!opacity) return d;
#define FOUR(name) do { \
  if (opacity == 255) { if (hold) name##_HDA(&d, &s, 1); else name(&d, &s, 1); } \
  else { if (hold) name##_HDA_o(&d, &s, 1, opacity); else name##_o(&d, &s, 1, opacity); } \
} while (0)
  switch (mode) {
    case 1:
      if (opacity == 255) d = face == 1 ? (hold ? (d & 0xff000000u) | (s & 0xffffff) : s) : s | 0xff000000u;
      else if (face == 0) TVPConstAlphaBlend_d(&d, &s, 1, opacity);
      else if (face == 4) TVPConstAlphaBlend_a(&d, &s, 1, opacity);
      else if (hold) TVPConstAlphaBlend_HDA(&d, &s, 1, opacity);
      else TVPConstAlphaBlend(&d, &s, 1, opacity);
      break;
    case 2:
      if (face == 0) { if (opacity == 255) TVPAlphaBlend_d(&d,&s,1); else TVPAlphaBlend_do(&d,&s,1,opacity); }
      else if (face == 4) { if (opacity == 255) TVPAlphaBlend_a(&d,&s,1); else TVPAlphaBlend_ao(&d,&s,1,opacity); }
      else FOUR(TVPAlphaBlend);
      break;
    case 12:
      if (face == 4) { if (opacity == 255) TVPAdditiveAlphaBlend_a(&d,&s,1); else TVPAdditiveAlphaBlend_ao(&d,&s,1,opacity); }
      else if (face == 1) FOUR(TVPAdditiveAlphaBlend);
      // Portable core does not implement bmAddAlphaOnAlpha.
      break;
    case 3: FOUR(TVPAddBlend); break;
    case 4: FOUR(TVPSubBlend); break;
    case 5: FOUR(TVPMulBlend); break;
    case 8: FOUR(TVPColorDodgeBlend); break;
    case 9: FOUR(TVPDarkenBlend); break;
    case 10: FOUR(TVPLightenBlend); break;
    case 11: FOUR(TVPScreenBlend); break;
    case 13: FOUR(TVPPsAlphaBlend); break;
    case 14: FOUR(TVPPsAddBlend); break;
    case 15: FOUR(TVPPsSubBlend); break;
    case 16: FOUR(TVPPsMulBlend); break;
    case 17: FOUR(TVPPsScreenBlend); break;
    case 18: FOUR(TVPPsOverlayBlend); break;
    case 19: FOUR(TVPPsHardLightBlend); break;
    case 20: FOUR(TVPPsSoftLightBlend); break;
    case 21: FOUR(TVPPsColorDodgeBlend); break;
    case 22: FOUR(TVPPsColorDodge5Blend); break;
    case 23: FOUR(TVPPsColorBurnBlend); break;
    case 24: FOUR(TVPPsLightenBlend); break;
    case 25: FOUR(TVPPsDarkenBlend); break;
    case 26: FOUR(TVPPsDiffBlend); break;
    case 27: FOUR(TVPPsDiff5Blend); break;
    case 28: FOUR(TVPPsExclusionBlend); break;
    default: break;
  }
#undef FOUR
  return d;
}

int main() {
  TVPInitTVPGL();
  uint32_t destination, source;
  int mode, face, opacity, hold;
  while (std::scanf("%u %u %d %d %d %d", &destination, &source, &mode, &face, &opacity, &hold) == 6) {
    if (mode == 12 && face == 0) {
      std::fprintf(stderr, "bmAddAlphaOnAlpha has no portable reference kernel\n");
      return 2;
    }
    std::printf("%u\n", blend(destination, source, mode, face, opacity, hold));
  }
  TVPUninitTVPGL();
}
