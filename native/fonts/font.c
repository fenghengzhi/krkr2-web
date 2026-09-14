#include <emscripten/emscripten.h>
#include <ft2build.h>
#include FT_FREETYPE_H
#include FT_SYNTHESIS_H
#include FT_OUTLINE_H
#include FT_GLYPH_H
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

typedef struct { FT_Face face; unsigned char *bytes; } Font;
static Font fonts[64];
static FT_Library library;
static int error_code;
/* left, top, right, bottom, advance, ascent, underline, thickness, strike */
static int32_t metrics[9];
/* 26.6 horizontal/vertical bearings and advances, then pixel font decorations. */
static int32_t indexed_metrics[12];
/* width, height, left, top, advance, ascent, pixel pointer, byte count */
static int32_t glyph[8];
static unsigned char *pixels;
static size_t pixel_capacity;
static int pixel(FT_Pos value) { return (int)((value + 32) >> 6); }
static Font *lookup(int id) { return id > 0 && id <= 64 && fonts[id-1].face ? &fonts[id-1] : NULL; }
static int ascent(FT_Face face) {
  return face->units_per_EM ? (int)((int64_t)face->ascender * face->size->metrics.y_ppem / face->units_per_EM) : pixel(face->size->metrics.ascender);
}
static int prepare(int id, int height, int flags, unsigned code, int fallback) {
  Font *font = lookup(id);
  if (!font || height < 1 || height > 256 || code > 65535) { error_code = -1; return 0; }
  FT_Face face = font->face;
  error_code = FT_Set_Pixel_Sizes(face, 0, height);
  if (error_code) return 0;
  FT_UInt index = flags & 32 ? code : FT_Get_Char_Index(face, code);
  if (!(flags & 32) && !index && fallback) {
    index = FT_Get_Char_Index(face, 32);
    if (!index) FT_Get_First_Char(face, &index);
  }
  if ((!(flags & 32) && !index) || index >= face->num_glyphs) { error_code = -2; return 0; }
  FT_Set_Transform(face, NULL, NULL);
  error_code = FT_Load_Glyph(face, index, (flags & 16 ? FT_LOAD_TARGET_MONO : FT_LOAD_NO_BITMAP) | (flags & 64 ? FT_LOAD_NO_BITMAP : 0));
  if (error_code) return 0;
  if (flags & 1) FT_GlyphSlot_Embolden(face->glyph);
  if (flags & 2) FT_GlyphSlot_Oblique(face->glyph);
  if (face->glyph->format == FT_GLYPH_FORMAT_OUTLINE) {
    FT_BBox box; FT_Outline_Get_CBox(&face->glyph->outline, &box);
    if ((int64_t)box.xMax - box.xMin > 4096 * 64 || (int64_t)box.yMax - box.yMin > 4096 * 64 ||
        box.xMin < -16777216*64 || box.xMax > 16777216*64 || box.yMin < -16777216*64 || box.yMax > 16777216*64) { error_code = -3; return 0; }
  }
  return 1;
}
EMSCRIPTEN_KEEPALIVE int krfont_abi(void) { return 2; }
EMSCRIPTEN_KEEPALIVE int krfont_error(void) { return error_code; }
EMSCRIPTEN_KEEPALIVE int krfont_version(void) { return FREETYPE_MAJOR * 10000 + FREETYPE_MINOR * 100 + FREETYPE_PATCH; }
EMSCRIPTEN_KEEPALIVE int krfont_ascent(int id, int height) {
  Font *font=lookup(id);if(!font||height<1||height>256){error_code=-1;return 0;}
  error_code=FT_Set_Pixel_Sizes(font->face,0,height);return error_code?0:ascent(font->face);
}
EMSCRIPTEN_KEEPALIVE int krfont_has(int id, unsigned code) {
  Font *font=lookup(id);error_code=font&&code<=65535?0:-1;
  return error_code?0:FT_Get_Char_Index(font->face,code)!=0;
}
EMSCRIPTEN_KEEPALIVE int krfont_index(int id, unsigned code) {
  Font *font=lookup(id);error_code=font&&code<=65535?0:-1;
  return error_code?0:FT_Get_Char_Index(font->face,code);
}
EMSCRIPTEN_KEEPALIVE int krfont_open(const unsigned char *source, int length, int face_index) {
  error_code = 0;
  if (length < 1 || length > 16 * 1024 * 1024 || face_index < 0) { error_code = -1; return 0; }
  if (!library && (error_code = FT_Init_FreeType(&library))) return 0;
  int slot = 0; while (slot < 64 && fonts[slot].face) slot++;
  if (slot == 64) { error_code = -4; return 0; }
  unsigned char *bytes = malloc((size_t)length);
  if (!bytes) { error_code = -5; return 0; }
  memcpy(bytes, source, (size_t)length);
  FT_Face face = NULL;
  error_code = FT_New_Memory_Face(library, bytes, length, face_index, &face);
  if (error_code) { free(bytes); return 0; }
  if (FT_Select_Charmap(face, FT_ENCODING_UNICODE) && !face->charmap) {
    FT_Done_Face(face); free(bytes); error_code = -6; return 0;
  }
  fonts[slot].face = face; fonts[slot].bytes = bytes;
  return slot + 1;
}
EMSCRIPTEN_KEEPALIVE void krfont_close(int id) {
  Font *font = lookup(id); if (!font) return;
  FT_Done_Face(font->face); free(font->bytes);
  font->face = NULL; font->bytes = NULL;
}
EMSCRIPTEN_KEEPALIVE int krfont_advance(int id, int height, int flags, unsigned code) {
  if (!prepare(id, height, flags, code, 0)) {
    if(error_code==-2){error_code=0;return height;}return 0;
  }
  return pixel(lookup(id)->face->glyph->metrics.horiAdvance);
}
static void decoration(FT_Face face, int *underline, int *thickness, int *strike) {
  const int a = ascent(face), ppem = face->size->metrics.y_ppem, units = face->units_per_EM;
  *underline = units ? (int)((int64_t)(face->ascender - face->underline_position) * ppem / units) : a;
  *thickness = units ? (int)((int64_t)face->underline_thickness * ppem / units) : 1;
  if (*thickness < 1) *thickness = 1;
  int height = pixel(face->size->metrics.height);
  if (*underline > height) *underline = height - 1;
  *strike = units ? (int)((int64_t)face->ascender * 7 * ppem / (10 * units)) : a * 7 / 10;
}
EMSCRIPTEN_KEEPALIVE const int32_t *krfont_metrics(int id, int height, int flags, unsigned code) {
  if (!prepare(id, height, flags & ~16, code, 1)) return NULL;
  FT_Face face = lookup(id)->face; FT_GlyphSlot slot = face->glyph;
  int a = ascent(face), l = pixel(slot->metrics.horiBearingX), t = a - pixel(slot->metrics.horiBearingY);
  int r = l + pixel(slot->metrics.width), b = t + pixel(slot->metrics.height);
  int advance = pixel(slot->advance.x), underline, thickness, strike;
  decoration(face, &underline, &thickness, &strike);
  const int positions[2] = {underline, strike};
  for (int i=0; i<2; i++) if ((flags & (4<<i)) && positions[i]>=0) {
    if (l>0) l=0; if (r<advance) r=advance; if (t>positions[i]) t=positions[i];
    if (positions[i]+thickness>=b) b=positions[i]+thickness+1;
  }
  metrics[0]=l;metrics[1]=t;metrics[2]=r;metrics[3]=b;metrics[4]=advance;metrics[5]=a;
  metrics[6]=underline;metrics[7]=thickness;metrics[8]=strike;
  return metrics;
}
static const int32_t *copy_bitmap(FT_Bitmap *bitmap, int left, int top, int advance, int a) {
  if(bitmap->width>4096||bitmap->rows>4096){error_code=-3;return NULL;}
  size_t size=(size_t)bitmap->width*bitmap->rows;
  if(size>pixel_capacity){
    unsigned char *next=realloc(pixels,size);
    if(!next){error_code=-5;return NULL;}pixels=next;pixel_capacity=size;
  }
  for(unsigned y=0;size && y<bitmap->rows;y++){
    const unsigned char *row=bitmap->buffer+(bitmap->pitch>=0?y:bitmap->rows-1-y)*(size_t)abs(bitmap->pitch);
    for(unsigned x=0;x<bitmap->width;x++){
      unsigned value;
      if(bitmap->pixel_mode==FT_PIXEL_MODE_MONO)value=(row[x/8]&(0x80>>(x%8)))?255:0;
      else if(bitmap->pixel_mode==FT_PIXEL_MODE_GRAY){
        if(bitmap->num_grays<2){error_code=-7;return NULL;}
        value=bitmap->num_grays==256?row[x]:(unsigned)row[x]*255/(bitmap->num_grays-1);
      }
      else if(bitmap->pixel_mode==FT_PIXEL_MODE_GRAY2)value=((row[x/4]>>(6-2*(x%4)))&3)*85;
      else if(bitmap->pixel_mode==FT_PIXEL_MODE_GRAY4)value=((row[x/2]>>(4-4*(x%2)))&15)*17;
      else if(bitmap->pixel_mode==FT_PIXEL_MODE_BGRA)value=row[4*x+3];
      else {error_code=-7;return NULL;}
      pixels[(size_t)y*bitmap->width+x]=(unsigned char)value;
    }
  }
  glyph[0]=bitmap->width;glyph[1]=bitmap->rows;glyph[2]=left;glyph[3]=top;
  glyph[4]=advance;glyph[5]=a;glyph[6]=(int32_t)(uintptr_t)pixels;glyph[7]=(int32_t)size;
  return glyph;
}
EMSCRIPTEN_KEEPALIVE const int32_t *krfont_glyph(int id, int height, int flags, unsigned code) {
  if (!prepare(id,height,flags,code,1)) return NULL;
  FT_Face face=lookup(id)->face; FT_GlyphSlot slot=face->glyph;
  error_code=FT_Render_Glyph(slot,flags&16?FT_RENDER_MODE_MONO:FT_RENDER_MODE_NORMAL);
  if(error_code)return NULL;
  return copy_bitmap(&slot->bitmap,slot->bitmap_left,ascent(face)-slot->bitmap_top,pixel(slot->advance.x),ascent(face));
}
EMSCRIPTEN_KEEPALIVE const int32_t *krfont_metrics_index(int id, int height, int flags, unsigned index) {
  if(!prepare(id,height,(flags&~16)|32|64,index,0))return NULL;
  FT_Face face=lookup(id)->face;FT_Glyph_Metrics *m=&face->glyph->metrics;
  int underline,thickness,strike;decoration(face,&underline,&thickness,&strike);
  indexed_metrics[0]=m->horiBearingX;indexed_metrics[1]=m->horiBearingY;
  indexed_metrics[2]=m->vertBearingX;indexed_metrics[3]=m->vertBearingY;
  indexed_metrics[4]=m->horiAdvance;indexed_metrics[5]=m->vertAdvance;
  indexed_metrics[6]=ascent(face);indexed_metrics[7]=underline;indexed_metrics[8]=thickness;
  indexed_metrics[9]=strike;indexed_metrics[10]=!!FT_HAS_VERTICAL(face);indexed_metrics[11]=face->num_glyphs;
  return indexed_metrics;
}
/* Command: unit rotation matrix (16.16), translation (26.6), rectangle count,
   followed by up to two [left,bottom,right,top] decoration rectangles (26.6).
   The caller owns layout and glyph substitution; this kernel only rasterizes. */
static FT_Glyph transformed_glyph(int id,int height,int flags,unsigned index,const int32_t *command) {
  if(!command || command[0]!=command[3] || (int64_t)command[1]!=-(int64_t)command[2] ||
     llabs(command[0])>65536 || llabs(command[1])>65536 ||
     llabs(command[4])>16384*64 || llabs(command[5])>16384*64 || command[6]<0 || command[6]>2){error_code=-1;return NULL;}
  int64_t norm=(int64_t)command[0]*command[0]+(int64_t)command[1]*command[1];
  if(llabs(norm-((int64_t)1<<32))>131072){error_code=-1;return NULL;}
  int rectangles=command[6];
  for(int i=0;i<rectangles;i++){
    const int32_t *r=command+7+i*4;
    if(r[0]>=r[2] || r[1]>=r[3] || llabs(r[0])>16384*64 || llabs(r[1])>16384*64 || llabs(r[2])>16384*64 || llabs(r[3])>16384*64){error_code=-1;return NULL;}
  }
  if(!prepare(id,height,flags|32|64,index,0))return NULL;
  FT_Glyph owned=NULL;
  error_code=FT_Get_Glyph(lookup(id)->face->glyph,&owned);
  if(error_code)return NULL;
  if(owned->format!=FT_GLYPH_FORMAT_OUTLINE){error_code=-8;FT_Done_Glyph(owned);return NULL;}
  FT_Outline *outline=&((FT_OutlineGlyph)owned)->outline;
  if(rectangles){
    if(outline->n_points>32767-rectangles*4 || outline->n_contours>32767-rectangles){error_code=-3;FT_Done_Glyph(owned);return NULL;}
    FT_Outline expanded;
    error_code=FT_Outline_New(library,outline->n_points+rectangles*4,outline->n_contours+rectangles,&expanded);
    if(error_code){FT_Done_Glyph(owned);return NULL;}
    if(outline->n_points){
      memcpy(expanded.points,outline->points,outline->n_points*sizeof(FT_Vector));
      memcpy(expanded.tags,outline->tags,outline->n_points*sizeof(char));
    }
    if(outline->n_contours)memcpy(expanded.contours,outline->contours,outline->n_contours*sizeof(short));
    expanded.flags=(outline->flags&~FT_OUTLINE_OWNER)|FT_OUTLINE_OWNER;
    int clockwise=FT_Outline_Get_Orientation(outline)!=FT_ORIENTATION_POSTSCRIPT;
    for(int i=0;i<rectangles;i++){
      const int32_t *r=command+7+i*4;int p=outline->n_points+i*4;
      FT_Vector points[4]={{r[0],r[1]},{r[2],r[1]},{r[2],r[3]},{r[0],r[3]}};
      for(int j=0;j<4;j++){expanded.points[p+j]=points[clockwise?3-j:j];expanded.tags[p+j]=FT_CURVE_TAG_ON;}
      expanded.contours[outline->n_contours+i]=p+3;
    }
    FT_Outline_Done(library,outline);*outline=expanded;
  }
  FT_Matrix matrix={command[0],command[1],command[2],command[3]};
  FT_Outline_Translate(outline,command[4],command[5]);FT_Outline_Transform(outline,&matrix);
  FT_BBox box;FT_Outline_Get_CBox(outline,&box);
  if((int64_t)box.xMax-box.xMin>4096*64 || (int64_t)box.yMax-box.yMin>4096*64 ||
     box.xMin < -16777216*64 || box.xMax > 16777216*64 || box.yMin < -16777216*64 || box.yMax > 16777216*64){error_code=-3;FT_Done_Glyph(owned);return NULL;}
  return owned;
}
EMSCRIPTEN_KEEPALIVE const int32_t *krfont_glyph_index(int id,int height,int flags,unsigned index,const int32_t *command){
  FT_Glyph owned=transformed_glyph(id,height,flags,index,command);
  if(!owned)return NULL;
  error_code=FT_Glyph_To_Bitmap(&owned,flags&16?FT_RENDER_MODE_MONO:FT_RENDER_MODE_NORMAL,NULL,1);
  if(error_code){FT_Done_Glyph(owned);return NULL;}
  FT_BitmapGlyph bitmap=(FT_BitmapGlyph)owned;
  const int32_t *result=copy_bitmap(&bitmap->bitmap,bitmap->left,-bitmap->top,0,ascent(lookup(id)->face));
  FT_Done_Glyph(owned);return result;
}
EMSCRIPTEN_KEEPALIVE const int32_t *krfont_bounds_index(int id,int height,int flags,unsigned index,const int32_t *command){
  FT_Glyph owned=transformed_glyph(id,height,flags&~16,index,command);
  if(!owned)return NULL;
  FT_BBox box;FT_Glyph_Get_CBox(owned,FT_GLYPH_BBOX_SUBPIXELS,&box);
  metrics[0]=pixel(box.xMin);metrics[1]=pixel(-box.yMax);metrics[2]=pixel(box.xMax);metrics[3]=pixel(-box.yMin);
  FT_Done_Glyph(owned);return metrics;
}
EMSCRIPTEN_KEEPALIVE void krfont_done(void) {
  for(int i=1;i<=64;i++)krfont_close(i);
  free(pixels);pixels=NULL;pixel_capacity=0;
  if(library)FT_Done_FreeType(library);library=NULL;
}
