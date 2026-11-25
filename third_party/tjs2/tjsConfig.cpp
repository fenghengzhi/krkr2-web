//---------------------------------------------------------------------------
/*
        TJS2 Script Engine
        Copyright (C) 2000 W.Dee <dee@kikyou.info> and contributors

        See details of license at "license.txt"
*/
//---------------------------------------------------------------------------
// configuration
//---------------------------------------------------------------------------

#include "tjsCommHead.h"
#include <clocale>
#include <cstdlib>

#include <cassert>
#include <boost/locale/encoding_utf.hpp>
#include <spdlog/spdlog.h>

#ifdef _WIN32
#include <float.h>
#define isfinite _finite
#else
#define isfinite std::isfinite
#endif
#define INTMAX_MAX 0x7fffffffffffffff

static int utf8_mbtowc(/*conv_t conv,*/ tjs_char *pwc, const unsigned char *s,
                       int n) {
    unsigned char c = s[0];

    if(c < 0x80) {
        *pwc = c;
        return 1;
    } else if(c < 0xc2) {
        return -1;
    } else if(c < 0xe0) {
        if(n < 2)
            return -1;
        if(!((s[1] ^ 0x80) < 0x40))
            return -1;
        *pwc = ((tjs_char)(c & 0x1f) << 6) | (tjs_char)(s[1] ^ 0x80);
        return 2;
    } else if(c < 0xf0) {
        if(n < 3)
            return -1;
        if(!((s[1] ^ 0x80) < 0x40 && (s[2] ^ 0x80) < 0x40 &&
             (c >= 0xe1 || s[1] >= 0xa0)))
            return -1;
        *pwc = ((tjs_char)(c & 0x0f) << 12) | ((tjs_char)(s[1] ^ 0x80) << 6) |
            (tjs_char)(s[2] ^ 0x80);
        return 3;
    } else
        return -1;
}

static int utf8_wctomb(/*conv_t conv,*/ unsigned char *r, tjs_char wc,
                       int n) /* n == 0 is acceptable */
{
    int count;
    if(wc < 0x80)
        count = 1;
    else if(wc < 0x800)
        count = 2;
    else if(wc < 0x10000)
        count = 3;
    // 	else if (wc < 0x200000)
    // 		count = 4;
    // 	else if (wc < 0x4000000)
    // 		count = 5;
    // 	else if (wc <= 0x7fffffff)
    // 		count = 6;
    else
        return -1;
    if(n < count)
        return -2;
    switch(count) { /* note: code falls through cases! */
            // 	case 6: r[5] = 0x80 | (wc & 0x3f); wc = wc >> 6; wc |=
            // 0x4000000; 	case 5: r[4] = 0x80 | (wc & 0x3f); wc = wc
            // >> 6; wc |= 0x200000; 	case 4: r[3] = 0x80 | (wc &
            // 0x3f); wc = wc >> 6; wc |= 0x10000;
        case 3:
            r[2] = 0x80 | (wc & 0x3f);
            wc = wc >> 6;
            wc |= 0x800;
        case 2:
            r[1] = 0x80 | (wc & 0x3f);
            wc = wc >> 6;
            wc |= 0xc0;
        case 1:
            r[0] = wc;
    }
    return count;
}

namespace TJS {

    //---------------------------------------------------------------------------
    // some wchar_t support functions
    //---------------------------------------------------------------------------
    tjs_int TJS_atoi(const tjs_char *s) {
        int r = 0;
        bool sign = false;
        while(*s && *s <= 0x20)
            s++; // skip spaces
        if(!*s)
            return 0;
        if(*s == TJS_W('-')) {
            sign = true;
            s++;
            while(*s && *s <= 0x20)
                s++; // skip spaces
            if(!*s)
                return 0;
        }

        while(*s >= TJS_W('0') && *s <= TJS_W('9')) {
            r *= 10;
            r += *s - TJS_W('0');
            s++;
        }
        if(sign)
            r = -r;
        return r;
    }

    tjs_int64 TJS_atoll(const tjs_char *s) {
        tjs_int64 r = 0;
        bool sign = false;
        while(*s && *s <= 0x20)
            s++; // skip spaces
        if(!*s)
            return 0;
        if(*s == TJS_W('-')) {
            sign = true;
            s++;
            while(*s && *s <= 0x20)
                s++; // skip spaces
            if(!*s)
                return 0;
        }

        while(*s >= TJS_W('0') && *s <= TJS_W('9')) {
            r *= 10;
            r += *s - TJS_W('0');
            s++;
        }
        if(sign)
            r = -r;
        return r;
    }

    //---------------------------------------------------------------------------
    tjs_char *TJS_int_to_str(tjs_int value, tjs_char *string) {
        tjs_char *ostring = string;

        if(value < 0)
            *(string++) = TJS_W('-'), value = -value;

        tjs_char buf[40];

        tjs_char *p = buf;

        do {
            *(p++) = (value % 10) + TJS_W('0');
            value /= 10;
        } while(value);

        p--;
        while(buf <= p)
            *(string++) = *(p--);
        *string = 0;

        return ostring;
    }

    //---------------------------------------------------------------------------
    tjs_char *TJS_tTVInt_to_str(tjs_int64 value, tjs_char *string) {
        if(value == TJS_UI64_VAL(0x8000000000000000)) {
            // this is a special number which we must avoid normal
            // conversion
            TJS_strcpy(string, TJS_W("-9223372036854775808"));
            return string;
        }

        tjs_char *ostring = string;

        if(value < 0)
            *(string++) = TJS_W('-'), value = -value;

        tjs_char buf[40];

        tjs_char *p = buf;

        do {
            *(p++) = (value % 10) + TJS_W('0');
            value /= 10;
        } while(value);

        p--;
        while(buf <= p)
            *(string++) = *(p--);
        *string = 0;

        return ostring;
    }

    //---------------------------------------------------------------------------
    tjs_int TJS_strnicmp(const tjs_char *s1, const tjs_char *s2,
                         size_t maxlen) {
        while(maxlen--) {
            if(*s1 == TJS_W('\0'))
                return (*s2 == TJS_W('\0')) ? 0 : -1;
            if(*s2 == TJS_W('\0'))
                return (*s1 == TJS_W('\0')) ? 0 : 1;
            if(*s1 < *s2)
                return -1;
            if(*s1 > *s2)
                return 1;
            s1++;
            s2++;
        }

        return 0;
    }

    //---------------------------------------------------------------------------
    tjs_int TJS_stricmp(const tjs_char *s1, const tjs_char *s2) {
        // we only support basic alphabets
        // fixme: complete alphabets support

        for(;;) {
            tjs_char c1 = *s1, c2 = *s2;
            if(c1 >= TJS_W('a') && c1 <= TJS_W('z'))
                c1 += TJS_W('Z') - TJS_W('z');
            if(c2 >= TJS_W('a') && c2 <= TJS_W('z'))
                c2 += TJS_W('Z') - TJS_W('z');
            if(c1 == TJS_W('\0'))
                return (c2 == TJS_W('\0')) ? 0 : -1;
            if(c2 == TJS_W('\0'))
                return (c1 == TJS_W('\0')) ? 0 : 1;
            if(c1 < c2)
                return -1;
            if(c1 > c2)
                return 1;
            s1++;
            s2++;
        }
    }

    //---------------------------------------------------------------------------
    void TJS_strcpy_maxlen(tjs_char *d, const tjs_char *s, size_t len) {
        tjs_char ch;
        len++;
        while((ch = *s) != 0 && --len)
            *(d++) = ch, s++;
        *d = 0;
    }

    //---------------------------------------------------------------------------
    void TJS_strcpy(tjs_char *d, const tjs_char *s) {
        tjs_char ch;
        while((ch = *s) != 0)
            *(d++) = ch, s++;
        *d = 0;
    }

    //---------------------------------------------------------------------------
    size_t TJS_strlen(const tjs_char *d) {
        const tjs_char *p = d;
        while(*d)
            d++;
        return d - p;
    }

//---------------------------------------------------------------------------
#define TJS_MB_MAX_CHARLEN 2

    //---------------------------------------------------------------------------
    size_t TJS_mbstowcs(tjs_char *pwcs, const tjs_nchar *s, size_t n) {
#if 0
                                                                                                                                if(pwcs && n == 0) return 0;

	if(pwcs)
	{
		size_t count = SJISToUnicodeString( s, pwcs, n );
		if( n > count )
		{
			pwcs[count] = TJS_W('\0');
		}
		return count;
	}
	else
	{	// count length
		return SJISToUnicodeString( s, nullptr );
	}
#endif
        if(!s)
            return -1;
        if(pwcs && n == 0)
            return 0;

        tjs_char wc;
        size_t count = 0;
        int cl;
        if(!pwcs) {
            n = strlen(s);
            while(*s) {
                cl = utf8_mbtowc(&wc, (const unsigned char *)s, n);
                if(cl <= 0)
                    break;
                s += cl;
                n -= cl;
                ++count;
            }
        } else {
            tjs_char *pwcsend = pwcs + n;
            n = strlen(s);
            while(*s && pwcs < pwcsend) {
                cl = utf8_mbtowc(&wc, (const unsigned char *)s, n);
                if(cl <= 0)
                    return -1;
                s += cl;
                n -= cl;
                *pwcs++ = wc;
                ++count;
            }
        }
        return count;
    }

    //---------------------------------------------------------------------------
    size_t TJS_wcstombs(tjs_nchar *s, const tjs_char *pwcs, size_t n) {
#if 0
                                                                                                                                if(s && !n) return 0;

	if(s)
	{
		tjs_size count = UnicodeToSJISString( pwcs, s, n );
		if( n > count )
		{
			s[count] = '\0';
		}
		return count;
	}
	else
	{
		// Returns the buffer size to store the result
		return UnicodeToSJISString(pwcs,nullptr);
	}
#endif
        if(!pwcs)
            return -1;
        if(s && !n)
            return 0;

        int cl;
        if(!s) {
            unsigned char tmp[6];
            size_t count = 0;
            while(*pwcs) {
                cl = utf8_wctomb(tmp, *pwcs, 6);
                if(cl <= 0)
                    return -1;
                pwcs++;
                count += cl;
            }
            return count;
        } else {
            tjs_nchar *d = s;
            while(*pwcs && n > 0) {
                cl = utf8_wctomb((unsigned char *)d, *pwcs, n);
                if(cl <= 0)
                    return -1;
                n -= cl;
                d += cl;
                pwcs++;
            }
            return d - s;
        }
    }

    //---------------------------------------------------------------------------
    // gíêÄ¢È¢æ¤ÈÌÅ¢mFÓ
    int TJS_mbtowc(tjs_char *pwc, const tjs_nchar *s, size_t n) {
#if 0
                                                                                                                                if(!s || !n) return 0;

	if(*s == 0)
	{
		if(pwc) *pwc = 0;
		return 0;
	}

	/* Borland's RTL seems to assume always MB_MAX_CHARLEN = 2. */
	/* This may true while we use Win32 platforms ... */
	if( IsSJISLeadByte( *s ) )
	{
		// multi(double) byte character
		if((int)n < TJS_MB_MAX_CHARLEN) return -1;
		tjs_size count = SJISToUnicodeString( s, pwc, 1 );
		if( count <= 0 )
		{
			return -1;
		}
		return TJS_MB_MAX_CHARLEN;
	}
	else
	{
		// single byte character
		return (int)SJISToUnicodeString( s, pwc, 1 );
	}
#endif
        if(!s || !n)
            return 0;

        if(*s == 0) {
            if(pwc)
                *pwc = 0;
            return 0;
        }
        tjs_char wc;
        int ret = utf8_mbtowc(&wc, (const unsigned char *)s, n);
        if(ret >= 0) {
            *pwc = wc;
        }
        return ret;
    }

    //---------------------------------------------------------------------------
    // gíêÄ¢È¢æ¤ÈÌÅ¢mFÓ
    int TJS_wctomb(tjs_nchar *s, tjs_char wc) {
#if 0
                                                                                                                                if(!s) return 0;
	tjs_uint c = UnicodeToSJIS(wc);
	if( c == 0 ) return -1;
	int size = 0;
	if( c & 0xff00 )
	{
		*s = static_cast<tjs_nchar>((c>>8)&0xff);
		s++;
		size++;
	}
	*s = static_cast<tjs_nchar>( c&0xff );
	size++;
	return size;
#endif
        if(!s)
            return 0;
        tjs_char tmp[2] = { wc, 0 };
        return utf8_wctomb((unsigned char *)s, wc, 2);
    }
    //---------------------------------------------------------------------------

    //---------------------------------------------------------------------------

    //---------------------------------------------------------------------------
    // tTJSNarrowStringHolder
    //---------------------------------------------------------------------------
    tTJSNarrowStringHolder::tTJSNarrowStringHolder(const tjs_char *wide) {
        int n;
        if(!wide)
            n = -1;
        else
            n = (int)TJS_wcstombs(nullptr, wide, 0);

        if(n == -1) {
            Buf = nullptr;
            Allocated = false;
            return;
        }
        Buf = new tjs_nchar[n + 1];
        Allocated = true;
        Buf[TJS_wcstombs(Buf, wide, n)] = 0;
    }

    //---------------------------------------------------------------------------
    tTJSNarrowStringHolder::~tTJSNarrowStringHolder() {
        if(Allocated)
            delete[] Buf;
    }
    //---------------------------------------------------------------------------

    //---------------------------------------------------------------------------
    // native debugger break point
    //---------------------------------------------------------------------------
    void TJSNativeDebuggerBreak() {
        // This function is to be called mostly when the "debugger"
        // TJS statement is executed. Step you debbuger back to the
        // the caller, and continue debugging. Do not use "debugger"
        // statement unless you run the program under the native
        // debugger, or the program may cause an unhandled debugger
        // breakpoint exception.

#if defined(__WIN32__)
#if defined(_M_IX86)
#ifdef __BORLANDC__
        __emit__(0xcc); // int 3 (Raise debugger breakpoint exception)
#else
        _asm _emit 0xcc; // int 3 (Raise debugger breakpoint
                         // exception)
#endif
#else
        __debugbreak();
#endif
#endif
    }
//---------------------------------------------------------------------------

//---------------------------------------------------------------------------
// FPU control
//---------------------------------------------------------------------------
#if defined(__WIN32__) && !defined(__GNUC__)
    static unsigned int TJSDefaultFPUCW = 0;
    static unsigned int TJSNewFPUCW = 0;
    static unsigned int TJSDefaultMMCW = 0;
    static bool TJSFPUInit = false;
#endif

    // FPUáOð}XN
    void TJSSetFPUE() {
#if defined(__WIN32__) && !defined(__GNUC__)
        if(!TJSFPUInit) {
            TJSFPUInit = true;
#if defined(_M_X64)
            TJSDefaultMMCW = _MM_GET_EXCEPTION_MASK();
#else
            TJSDefaultFPUCW = _control87(0, 0);

#ifdef _MSC_VER
            TJSNewFPUCW = _control87(MCW_EM, MCW_EM);
#else
            _default87 = TJSNewFPUCW = _control87(MCW_EM, MCW_EM);
#endif // _MSC_VER
#ifdef TJS_SUPPORT_VCL
            Default8087CW = TJSNewFPUCW;
#endif // TJS_SUPPORT_VCL
#endif // _M_X64
        }

#if defined(_M_X64)
        _MM_SET_EXCEPTION_MASK(_MM_MASK_INVALID | _MM_MASK_DIV_ZERO |
                               _MM_MASK_DENORM | _MM_MASK_OVERFLOW |
                               _MM_MASK_UNDERFLOW | _MM_MASK_INEXACT);
#else
        //	_fpreset();
        _control87(TJSNewFPUCW, 0xffff);
#endif
#endif // defined(__WIN32__) && !defined(__GNUC__)
    }

    int TJS_strcmp(const tjs_char *src, const tjs_char *dst) {
        int ret = 0;

        while(!(ret = (int)(*src - *dst)) && *dst)
            ++src, ++dst;

        if(ret < 0)
            ret = -1;
        else if(ret > 0)
            ret = 1;

        return (ret);
    }

    int TJS_strncmp(const tjs_char *first, const tjs_char *last, size_t count) {
        if(!count)
            return (0);

        while(--count && *first && *first == *last) {
            first++;
            last++;
        }

        return ((int)(*first - *last));
    }

    tjs_char *TJS_strncpy(tjs_char *dest, const tjs_char *source,
                          size_t count) {
        tjs_char *start = dest;

        while(count && (*dest++ = *source++)) /* copy string */
            count--;

        if(count) /* pad out with zeroes */
            while(--count)
                *dest++ = L'\0';

        return (start);
    }

    tjs_char *TJS_strcat(tjs_char *dst, const tjs_char *src) {
        tjs_char *cp = dst;

        while(*cp)
            cp++; /* find end of dst */

        while((*cp++ = *src++))
            ; /* Copy src to end of dst */

        return (dst); /* return dst */
    }

    tjs_char *TJS_strstr(const tjs_char *wcs1, const tjs_char *wcs2) {
        tjs_char *cp = (tjs_char *)wcs1;
        tjs_char *s1, *s2;

        if(!*wcs2)
            return (tjs_char *)wcs1;

        while(*cp) {
            s1 = cp;
            s2 = (tjs_char *)wcs2;

            while(*s1 && *s2 && !(*s1 - *s2))
                s1++, s2++;

            if(!*s2)
                return (cp);

            cp++;
        }

        return nullptr;
    }

    tjs_char *TJS_strchr(const tjs_char *string, tjs_char ch) {
        while(*string && *string != (tjs_char)ch)
            string++;

        if(*string == (tjs_char)ch)
            return ((tjs_char *)string);
        return nullptr;
    }

    void *TJS_malloc(size_t len) {
        char *ret = (char *)malloc(len + sizeof(size_t));
        if(!ret)
            return nullptr;
        *(size_t *)ret = len; // embed size
        return ret + sizeof(size_t);
    }

    void *TJS_realloc(void *buf, size_t len) {
        if(!buf)
            return TJS_malloc(len);
        // compare embeded size
        size_t *ptr = (size_t *)((char *)buf - sizeof(size_t));
        if(*ptr >= len)
            return buf; // still adequate
        char *ret = (char *)TJS_malloc(len);
        if(!ret)
            return nullptr;
        memcpy(ret, ptr + 1, *ptr);
        TJS_free(buf);
        return ret;
    }

    void TJS_free(void *buf) {
        if(buf)
            free((char *)buf - sizeof(size_t));
    }

    tjs_char *TJS_strrchr(const tjs_char *s, int c) {
        tjs_char *ret = nullptr;
        do {
            if(*s == (char)c)
                ret = (tjs_char *)s;
        } while(*s++);
        return ret;
    }

    double TJS_strtod(const tjs_char *string, tjs_char **endPtr) {
        // The 2.32 lexer passes an extracted ASCII decimal token to wcstod.
        // TJS uses UTF-16 here while the Web toolchain uses 32-bit wchar_t.
        // Use the matching narrow C-library conversion for this token.
        const tjs_char *last = string;
        while(*last && *last < 128)
            ++last;
        const std::string token(string, last);
        char *end = nullptr;
        const double result = std::strtod(token.c_str(), &end);
        if(endPtr)
            *endPtr = const_cast<tjs_char *>(string + (end - token.c_str()));
        return result;
    }

    // FIXME: 效率低下
    // FIXME: 效率低下
    // FIXME: 效率低下
    size_t TJS_strftime(tjs_char *wstring, size_t maxsize,
                        const tjs_char *wformat, const tm *timeptr) {
        char timebuf[128];
        size_t r =
            strftime(timebuf, maxsize,
                     ttstr{ wformat }.AsNarrowStdString().c_str(), timeptr);
        ttstr r_timebuf{ timebuf };
        auto w_r_timebuf = r_timebuf.toWString();
        size_t len = (w_r_timebuf.length() + 1) * sizeof(wchar_t);
        std::memcpy(wstring, w_r_timebuf.c_str(), len);
        return r;
    }

    tTJSFuncTrace::tTJSFuncTrace(const tjs_char *p) :
        funcname(boost::locale::conv::utf_to_utf<char>(p)) {
        spdlog::debug("enter: {}", funcname);
    }

    tTJSFuncTrace::~tTJSFuncTrace() { spdlog::debug("exit: {}", funcname); }
} // namespace TJS
