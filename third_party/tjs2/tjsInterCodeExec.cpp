//---------------------------------------------------------------------------
/*
        TJS2 Script Engine
        Copyright (C) 2000 W.Dee <dee@kikyou.info> and contributors

        See details of license at "license.txt"
*/
//---------------------------------------------------------------------------
// Intermediate Code Execution
//---------------------------------------------------------------------------

#include "tjsCommHead.h"

#include "tjsInterCodeExec.h"
#include "tjsInterCodeGen.h"
#include "tjsScriptBlock.h"
#include "tjsError.h"
#include "tjs.h"
#include "tjsUtils.h"
#include "tjsNative.h"
#include "tjsDictionary.h"
#include "tjsArray.h"
#include "tjsDebug.h"
#include "tjsOctPack.h"
#include "tjsGlobalStringMap.h"
#include <algorithm>
#include <cctype>
#include <csignal>
#include <set>
#include <mutex>
#include <string>
#include <utility>

#include <thread>
#include <fmt/format.h>
#include <spdlog/spdlog.h>
#include "LogoTrace.h"
#include "WebHost.h"
#include "ExecutionBudget.h"
#include "NativeOwnership.h"
#include <exception>

namespace TJS {
    //---------------------------------------------------------------------------
    // utility functions
    //---------------------------------------------------------------------------
    static void ThrowFrom_tjs_error_num(tjs_error hr, tjs_int num) {
        tjs_char buf[34];
        TJS_int_to_str(num, buf);
        TJSThrowFrom_tjs_error(hr, buf);
    }

    //---------------------------------------------------------------------------
    static void ThrowInvalidVMCode() { TJS_eTJSError(TJSInvalidOpecode); }

    //---------------------------------------------------------------------------
    static const tjs_char *GetSafeStringValue(const tTJSVariantString *str) {
        return str ? str->operator const tjs_char *() : TJS_W("");
    }

    //---------------------------------------------------------------------------
    static bool ShouldUseStackTracer() {
        return TJSStackTracerEnabled();
    }

    static bool TJSLogoChainTraceEnabledForVM() {
        return TVPLogoTraceEnabled();
    }

    static std::string TJSTraceSanitize(std::string value, size_t limit = 220) {
        for(char &ch : value) {
            if(ch == '\n' || ch == '\r' || ch == '\t')
                ch = ' ';
        }
        if(value.size() > limit) {
            value.resize(limit);
            value += "...";
        }
        return value;
    }

    static std::string TJSTraceNarrow(const tjs_char *value) {
        return value ? TJSTraceSanitize(ttstr(value).AsStdString()) : "";
    }

    static std::string TJSTraceLower(std::string value) {
        std::transform(value.begin(), value.end(), value.begin(),
                       [](unsigned char ch) {
                           return static_cast<char>(std::tolower(ch));
                       });
        return value;
    }

    static bool TJSTraceContains(std::string haystack, const char *needle) {
        return TJSTraceLower(std::move(haystack)).find(needle) !=
            std::string::npos;
    }

    static std::string TJSTraceVariantBrief(const tTJSVariant *value) {
        if(!value)
            return "<null>";
        try {
            switch(value->Type()) {
                case tvtVoid:
                    return "<void>";
                case tvtString:
                    return std::string("\"") +
                        TJSTraceNarrow(value->GetString()) + "\"";
                case tvtInteger:
                    return std::to_string(
                        static_cast<long long>(value->AsInteger()));
                case tvtReal:
                    return std::to_string(static_cast<double>(value->AsReal()));
                case tvtOctet:
                    return "<octet>";
                case tvtObject:
                    return fmt::format("<object:{}>",
                                       static_cast<const void *>(
                                           value->AsObjectNoAddRef()));
            }
        } catch(...) {
            return "<exception>";
        }
        return "<unknown>";
    }

    static std::string TJSTraceArgsBrief(tTJSVariant **args, tjs_int numargs) {
        std::string joined;
        for(tjs_int i = 0; i < numargs; ++i) {
            if(i != 0)
                joined += ",";
            joined += TJSTraceVariantBrief(args ? args[i] : nullptr);
        }
        return joined;
    }

    static bool TJSTraceInterestingCall(const std::string &name,
                                        const std::string &args,
                                        const std::string &result) {
        const std::string joined = name + " " + args + " " + result;
        return TJSTraceContains(name, "gettype") ||
            TJSTraceContains(name, "getclass") ||
            TJSTraceContains(name, "creategenericflip") ||
            TJSTraceContains(name, "findaffinesource") ||
            TJSTraceContains(name, "loadimages") ||
            TJSTraceContains(name, "setoptions") ||
            TJSTraceContains(name, "flipstart") ||
            TJSTraceContains(name, "startflip") ||
            TJSTraceContains(name, "updateimagesource") ||
            TJSTraceContains(name, "setimagefile") ||
            TJSTraceContains(name, "docommand") ||
            TJSTraceContains(name, "execcommand") ||
            TJSTraceContains(name, "objwait") ||
            TJSTraceContains(name, "addfasttag") ||
            TJSTraceContains(name, "sync") ||
            TJSTraceContains(name, "waitlayermotion") ||
            TJSTraceContains(name, "waitlayermovie") ||
            TJSTraceContains(name, "onmotionstart") ||
            TJSTraceContains(name, "onmotionupdate") ||
            TJSTraceContains(name, "calcaffine") ||
            TJSTraceContains(name, "drawaffine") ||
            TJSTraceContains(name, "getimagedata") ||
            TJSTraceContains(name, "extractstorageext") ||
            TJSTraceContains(name, "getcommandtarget") ||
            TJSTraceContains(name, "getenvobject") ||
            TJSTraceContains(joined, "yuzulogo") ||
            TJSTraceContains(joined, "m2logo") ||
            TJSTraceContains(joined, "gfx_motion") ||
            TJSTraceContains(joined, "affinesourcemotion") ||
            TJSTraceContains(joined, "genericflip");
    }

    static void TJSTraceCallResult(const char *stage, const tjs_char *membername,
                                   tjs_error hr, tTJSVariant **args,
                                   tjs_int numargs,
                                   const tTJSVariant *result) {
        if(!TJSLogoChainTraceEnabledForVM())
            return;
        const std::string name = TJSTraceNarrow(membername);
        const std::string argText = TJSTraceArgsBrief(args, numargs);
        const std::string resultText = TJSTraceVariantBrief(result);
        if(!TJSTraceInterestingCall(name, argText, resultText))
            return;
        if(auto logger = spdlog::get("core")) {
            logger->warn(
                "TCHAIN stage={} member='{}' hr={} argc={} args=[{}] result={}",
                stage ? stage : "", name, static_cast<int>(hr),
                static_cast<int>(numargs), argText, resultText);
        }
    }

    static bool TJSTraceInterestingProperty(const std::string &name) {
        return TJSTraceContains(name, "playing") ||
            TJSTraceContains(name, "allplaying") ||
            TJSTraceContains(name, "motionplaying") ||
            TJSTraceContains(name, "movieplaying") ||
            TJSTraceContains(name, "_playing") ||
            TJSTraceContains(name, "_player") ||
            TJSTraceContains(name, "_image") ||
            TJSTraceContains(name, "visible") ||
            TJSTraceContains(name, "waitmovie");
    }

    static void TJSTracePropertyResult(const char *stage,
                                       const tjs_char *membername,
                                       tjs_uint32 flags, tjs_error hr,
                                       const tTJSVariant *result) {
        if(!TJSLogoChainTraceEnabledForVM())
            return;
        const std::string name = TJSTraceNarrow(membername);
        if(!TJSTraceInterestingProperty(name))
            return;
        if(auto logger = spdlog::get("core")) {
            logger->warn("TCHAIN stage={} prop='{}' flags={} hr={} result={}",
                         stage ? stage : "", name,
                         static_cast<unsigned int>(flags),
                         static_cast<int>(hr),
                         TJSTraceVariantBrief(result));
        }
    }

    //---------------------------------------------------------------------------
    static void GetStringProperty(tTJSVariant *result, const tTJSVariant *str,
                                  const tTJSVariant &member) {
        // processes properties toward strings.
        if(member.Type() != tvtInteger && member.Type() != tvtReal) {
            const tjs_char *name = member.GetString();
            if(!name)
                TJSThrowFrom_tjs_error(TJS_E_MEMBERNOTFOUND, TJS_W(""));

            if(!TJS_strcmp(name, TJS_W("length"))) {
                // get string length
                const tTJSVariantString *s = str->AsStringNoAddRef();
                *result = tTVInteger(s ? s->GetLength() : 0);
                return;
            }
            if(name[0] >= TJS_W('0') && name[0] <= TJS_W('9')) {
                const tTJSVariantString *valstr = str->AsStringNoAddRef();
                const tjs_char *s = str->GetString();
                tjs_int n = TJS_atoi(name);
                tjs_int len = valstr ? valstr->GetLength() : 0;
                if(n == len) {
                    *result = tTJSVariant(TJS_W(""));
                    return;
                }
                if(n < 0 || n > len)
                    TJS_eTJSError(TJSRangeError);
                tjs_char bf[2];
                bf[1] = 0;
                bf[0] = s[n];
                *result = tTJSVariant(bf);
                return;
            }

            TJSThrowFrom_tjs_error(TJS_E_MEMBERNOTFOUND, name);
        } else // member.Type() == tvtInteger || member.Type() ==
               // tvtReal
        {
            const tTJSVariantString *valstr = str->AsStringNoAddRef();
            const tjs_char *s = str->GetString();
            tjs_int n = (tjs_int)member.AsInteger();
            tjs_int len = valstr ? valstr->GetLength() : 0;
            if(n == len) {
                *result = tTJSVariant(TJS_W(""));
                return;
            }
            if(n < 0 || n > len)
                TJS_eTJSError(TJSRangeError);
            tjs_char bf[2];
            bf[1] = 0;
            bf[0] = s[n];
            *result = tTJSVariant(bf);
        }
    }

    //---------------------------------------------------------------------------
    static void SetStringProperty(tTJSVariant *param, const tTJSVariant *str,
                                  const tTJSVariant &member) {
        // processes properties toward strings.
        if(member.Type() != tvtInteger && member.Type() != tvtReal) {
            const tjs_char *name = member.GetString();
            if(!name)
                TJSThrowFrom_tjs_error(TJS_E_MEMBERNOTFOUND, TJS_W(""));

            if(!TJS_strcmp(name, TJS_W("length"))) {
                TJSThrowFrom_tjs_error(TJS_E_ACCESSDENYED, TJS_W(""));
            } else if(name[0] >= TJS_W('0') && name[0] <= TJS_W('9')) {
                TJSThrowFrom_tjs_error(TJS_E_ACCESSDENYED, TJS_W(""));
            }

            TJSThrowFrom_tjs_error(TJS_E_MEMBERNOTFOUND, name);
        } else // member.Type() == tvtInteger || member.Type() ==
               // tvtReal
        {
            TJSThrowFrom_tjs_error(TJS_E_ACCESSDENYED, TJS_W(""));
        }
    }

    //---------------------------------------------------------------------------
    static void GetOctetProperty(tTJSVariant *result, const tTJSVariant *octet,
                                 const tTJSVariant &member) {
        // processes properties toward octets.
        if(member.Type() != tvtInteger && member.Type() != tvtReal) {
            const tjs_char *name = member.GetString();
            if(!name)
                TJSThrowFrom_tjs_error(TJS_E_MEMBERNOTFOUND, TJS_W(""));

            if(!TJS_strcmp(name, TJS_W("length"))) {
                // get string length
                tTJSVariantOctet *o = octet->AsOctetNoAddRef();
                if(o)
                    *result = tTVInteger(o->GetLength());
                else
                    *result = tTVInteger(0);
                return;
            }
            if(name[0] >= TJS_W('0') && name[0] <= TJS_W('9')) {
                tTJSVariantOctet *o = octet->AsOctetNoAddRef();
                tjs_int n = TJS_atoi(name);
                tjs_int len = o ? o->GetLength() : 0;
                if(n < 0 || n >= len)
                    TJS_eTJSError(TJSRangeError);
                *result = tTVInteger(o->GetData()[n]);
                return;
            }

            TJSThrowFrom_tjs_error(TJS_E_MEMBERNOTFOUND, name);
        } else // member.Type() == tvtInteger || member.Type() ==
               // tvtReal
        {
            tTJSVariantOctet *o = octet->AsOctetNoAddRef();
            tjs_int n = (tjs_int)member.AsInteger();
            tjs_int len = o ? o->GetLength() : 0;
            if(n < 0 || n >= len)
                TJS_eTJSError(TJSRangeError);
            *result = tTVInteger(o->GetData()[n]);
        }
    }

    //---------------------------------------------------------------------------
    static void SetOctetProperty(tTJSVariant *param, const tTJSVariant *octet,
                                 const tTJSVariant &member) {
        // processes properties toward octets.
        if(member.Type() != tvtInteger && member.Type() != tvtReal) {
            const tjs_char *name = member.GetString();
            if(!name)
                TJSThrowFrom_tjs_error(TJS_E_MEMBERNOTFOUND, TJS_W(""));

            if(!TJS_strcmp(name, TJS_W("length"))) {
                TJSThrowFrom_tjs_error(TJS_E_ACCESSDENYED, TJS_W(""));
            } else if(name[0] >= TJS_W('0') && name[0] <= TJS_W('9')) {
                TJSThrowFrom_tjs_error(TJS_E_ACCESSDENYED, TJS_W(""));
            }

            TJSThrowFrom_tjs_error(TJS_E_MEMBERNOTFOUND, name);
        } else // member.Type() == tvtInteger || member.Type() ==
               // tvtReal
        {
            TJSThrowFrom_tjs_error(TJS_E_ACCESSDENYED, TJS_W(""));
        }
    }

    //---------------------------------------------------------------------------
    // tTJSObjectProxy
    //---------------------------------------------------------------------------
    class tTJSObjectProxy : public iTJSDispatch2 {
        /*
                a class that do:
                1. first access to the Dispatch1
                2. if failed, then access to the Dispatch2
        */
        //	tjs_uint RefCount;

    public:
        tTJSObjectProxy() {
            //		RefCount = 1;
            //		Dispatch1 = nullptr;
            //		Dispatch2 = nullptr;
            // Dispatch1 and Dispatch2 are to be set by subsequent
            // call of
            // SetObjects
        };

        virtual ~tTJSObjectProxy() {
            if(Dispatch1)
                Dispatch1->Release();
            if(Dispatch2)
                Dispatch2->Release();
        };

        void SetObjects(iTJSDispatch2 *dsp1, iTJSDispatch2 *dsp2) {
            Dispatch1 = dsp1;
            Dispatch2 = dsp2;
            if(dsp1)
                dsp1->AddRef();
            if(dsp2)
                dsp2->AddRef();
        }

    private:
        iTJSDispatch2 *Dispatch1;
        iTJSDispatch2 *Dispatch2;

    public:
        tjs_uint AddRef() override { return 1; }

        tjs_uint Release() override { return 1; }

#define OBJ1 ((objthis) ? (objthis) : (Dispatch1))
#define OBJ2 ((objthis) ? (objthis) : (Dispatch2))

        tjs_error FuncCall(tjs_uint32 flag, const tjs_char *membername,
                           tjs_uint32 *hint, tTJSVariant *result,
                           tjs_int numparams, tTJSVariant **param,
                           iTJSDispatch2 *objthis) override {
            tjs_error hr = Dispatch1->FuncCall(flag, membername, hint, result,
                                               numparams, param, OBJ1);
            if(hr == TJS_E_MEMBERNOTFOUND && Dispatch1 != Dispatch2)
                return Dispatch2->FuncCall(flag, membername, hint, result,
                                           numparams, param, OBJ2);
            return hr;
        }

        tjs_error FuncCallByNum(tjs_uint32 flag, tjs_int num,
                                tTJSVariant *result, tjs_int numparams,
                                tTJSVariant **param,
                                iTJSDispatch2 *objthis) override {
            tjs_error hr = Dispatch1->FuncCallByNum(flag, num, result,
                                                    numparams, param, OBJ1);
            if(hr == TJS_E_MEMBERNOTFOUND && Dispatch1 != Dispatch2)
                return Dispatch2->FuncCallByNum(flag, num, result, numparams,
                                                param, OBJ2);
            return hr;
        }

        tjs_error PropGet(tjs_uint32 flag, const tjs_char *membername,
                          tjs_uint32 *hint, tTJSVariant *result,
                          iTJSDispatch2 *objthis) override {
            tjs_error hr =
                Dispatch1->PropGet(flag, membername, hint, result, OBJ1);
            if(hr == TJS_E_MEMBERNOTFOUND && Dispatch1 != Dispatch2)
                return Dispatch2->PropGet(flag, membername, hint, result, OBJ2);
            return hr;
        }

        tjs_error PropGetByNum(tjs_uint32 flag, tjs_int num,
                               tTJSVariant *result,
                               iTJSDispatch2 *objthis) override {
            tjs_error hr = Dispatch1->PropGetByNum(flag, num, result, OBJ1);
            if(hr == TJS_E_MEMBERNOTFOUND && Dispatch1 != Dispatch2)
                return Dispatch2->PropGetByNum(flag, num, result, OBJ2);
            return hr;
        }

        tjs_error PropSet(tjs_uint32 flag, const tjs_char *membername,
                          tjs_uint32 *hint, const tTJSVariant *param,
                          iTJSDispatch2 *objthis) override {
            tjs_error hr =
                Dispatch1->PropSet(flag, membername, hint, param, OBJ1);
            if(hr == TJS_E_MEMBERNOTFOUND && Dispatch1 != Dispatch2)
                return Dispatch2->PropSet(flag, membername, hint, param, OBJ2);
            return hr;
        }

        tjs_error PropSetByNum(tjs_uint32 flag, tjs_int num,
                               const tTJSVariant *param,
                               iTJSDispatch2 *objthis) override {
            tjs_error hr = Dispatch1->PropSetByNum(flag, num, param, OBJ1);
            if(hr == TJS_E_MEMBERNOTFOUND && Dispatch1 != Dispatch2)
                return Dispatch2->PropSetByNum(flag, num, param, OBJ2);
            return hr;
        }

        tjs_error GetCount(tjs_int *result, const tjs_char *membername,
                           tjs_uint32 *hint, iTJSDispatch2 *objthis) override {
            tjs_error hr = Dispatch1->GetCount(result, membername, hint, OBJ1);
            if(hr == TJS_E_MEMBERNOTFOUND && Dispatch1 != Dispatch2)
                return Dispatch2->GetCount(result, membername, hint, OBJ2);
            return hr;
        }

        tjs_error GetCountByNum(tjs_int *result, tjs_int num,
                                iTJSDispatch2 *objthis) override {
            tjs_error hr = Dispatch1->GetCountByNum(result, num, OBJ1);
            if(hr == TJS_E_MEMBERNOTFOUND && Dispatch1 != Dispatch2)
                return Dispatch2->GetCountByNum(result, num, OBJ2);
            return hr;
        }

        tjs_error PropSetByVS(tjs_uint32 flag, tTJSVariantString *membername,
                              const tTJSVariant *param,
                              iTJSDispatch2 *objthis) override {
            tjs_error hr =
                Dispatch1->PropSetByVS(flag, membername, param, OBJ1);
            if(hr == TJS_E_MEMBERNOTFOUND && Dispatch1 != Dispatch2)
                return Dispatch2->PropSetByVS(flag, membername, param, OBJ2);
            return hr;
        }

        tjs_error EnumMembers(tjs_uint32 flag, tTJSVariantClosure *callback,
                              iTJSDispatch2 *objthis) override {
            return TJS_E_NOTIMPL;
        }

        tjs_error DeleteMember(tjs_uint32 flag, const tjs_char *membername,
                               tjs_uint32 *hint,
                               iTJSDispatch2 *objthis) override {
            tjs_error hr =
                Dispatch1->DeleteMember(flag, membername, hint, OBJ1);
            if(hr == TJS_E_MEMBERNOTFOUND && Dispatch1 != Dispatch2)
                return Dispatch2->DeleteMember(flag, membername, hint, OBJ2);
            return hr;
        }

        tjs_error DeleteMemberByNum(tjs_uint32 flag, tjs_int num,
                                    iTJSDispatch2 *objthis) override {
            tjs_error hr = Dispatch1->DeleteMemberByNum(flag, num, OBJ1);
            if(hr == TJS_E_MEMBERNOTFOUND && Dispatch1 != Dispatch2)
                return Dispatch2->DeleteMemberByNum(flag, num, OBJ2);
            return hr;
        }

        tjs_error Invalidate(tjs_uint32 flag, const tjs_char *membername,
                             tjs_uint32 *hint,
                             iTJSDispatch2 *objthis) override {
            tjs_error hr = Dispatch1->Invalidate(flag, membername, hint, OBJ1);
            if(hr == TJS_E_MEMBERNOTFOUND && Dispatch1 != Dispatch2)
                return Dispatch2->Invalidate(flag, membername, hint, OBJ2);
            return hr;
        }

        tjs_error InvalidateByNum(tjs_uint32 flag, tjs_int num,
                                  iTJSDispatch2 *objthis) override {
            tjs_error hr = Dispatch1->InvalidateByNum(flag, num, OBJ1);
            if(hr == TJS_E_MEMBERNOTFOUND && Dispatch1 != Dispatch2)
                return Dispatch2->InvalidateByNum(flag, num, OBJ2);
            return hr;
        }

        tjs_error IsValid(tjs_uint32 flag, const tjs_char *membername,
                          tjs_uint32 *hint, iTJSDispatch2 *objthis) override {
            tjs_error hr = Dispatch1->IsValid(flag, membername, hint, OBJ1);
            if(hr == TJS_E_MEMBERNOTFOUND && Dispatch1 != Dispatch2)
                return Dispatch2->IsValid(flag, membername, hint, OBJ2);
            return hr;
        }

        tjs_error IsValidByNum(tjs_uint32 flag, tjs_int num,
                               iTJSDispatch2 *objthis) override {
            tjs_error hr = Dispatch1->IsValidByNum(flag, num, OBJ1);
            if(hr == TJS_E_MEMBERNOTFOUND && Dispatch1 != Dispatch2)
                return Dispatch2->IsValidByNum(flag, num, OBJ2);
            return hr;
        }

        tjs_error CreateNew(tjs_uint32 flag, const tjs_char *membername,
                            tjs_uint32 *hint, iTJSDispatch2 **result,
                            tjs_int numparams, tTJSVariant **param,
                            iTJSDispatch2 *objthis) override {
            tjs_error hr = Dispatch1->CreateNew(flag, membername, hint, result,
                                                numparams, param, OBJ1);
            if(hr == TJS_E_MEMBERNOTFOUND && Dispatch1 != Dispatch2)
                return Dispatch2->CreateNew(flag, membername, hint, result,
                                            numparams, param, OBJ2);
            return hr;
        }

        tjs_error CreateNewByNum(tjs_uint32 flag, tjs_int num,
                                 iTJSDispatch2 **result, tjs_int numparams,
                                 tTJSVariant **param,
                                 iTJSDispatch2 *objthis) override {
            tjs_error hr = Dispatch1->CreateNewByNum(flag, num, result,
                                                     numparams, param, OBJ1);
            if(hr == TJS_E_MEMBERNOTFOUND && Dispatch1 != Dispatch2)
                return Dispatch2->CreateNewByNum(flag, num, result, numparams,
                                                 param, OBJ2);
            return hr;
        }

        tjs_error Reserved1() override { return TJS_E_NOTIMPL; }

        tjs_error IsInstanceOf(tjs_uint32 flag, const tjs_char *membername,
                               tjs_uint32 *hint, const tjs_char *classname,
                               iTJSDispatch2 *objthis) override {
            tjs_error hr = Dispatch1->IsInstanceOf(flag, membername, hint,
                                                   classname, OBJ1);
            if(hr == TJS_E_MEMBERNOTFOUND && Dispatch1 != Dispatch2)
                return Dispatch2->IsInstanceOf(flag, membername, hint,
                                               classname, OBJ2);
            return hr;
        }

        tjs_error IsInstanceOfByNum(tjs_uint32 flag, tjs_int num,
                                    const tjs_char *classname,
                                    iTJSDispatch2 *objthis) override {
            tjs_error hr =
                Dispatch1->IsInstanceOfByNum(flag, num, classname, OBJ1);
            if(hr == TJS_E_MEMBERNOTFOUND && Dispatch1 != Dispatch2)
                return Dispatch2->IsInstanceOfByNum(flag, num, classname, OBJ2);
            return hr;
        }

        tjs_error Operation(tjs_uint32 flag, const tjs_char *membername,
                            tjs_uint32 *hint, tTJSVariant *result,
                            const tTJSVariant *param,
                            iTJSDispatch2 *objthis) override {
            tjs_error hr = Dispatch1->Operation(flag, membername, hint, result,
                                                param, OBJ1);
            if(hr == TJS_E_MEMBERNOTFOUND && Dispatch1 != Dispatch2)
                return Dispatch2->Operation(flag, membername, hint, result,
                                            param, OBJ2);
            return hr;
        }

        tjs_error OperationByNum(tjs_uint32 flag, tjs_int num,
                                 tTJSVariant *result, const tTJSVariant *param,
                                 iTJSDispatch2 *objthis) override {
            tjs_error hr =
                Dispatch1->OperationByNum(flag, num, result, param, OBJ1);
            if(hr == TJS_E_MEMBERNOTFOUND && Dispatch1 != Dispatch2)
                return Dispatch2->OperationByNum(flag, num, result, param,
                                                 OBJ2);
            return hr;
        }

        tjs_error NativeInstanceSupport(tjs_uint32 flag, tjs_int32 classid,
                                        iTJSNativeInstance **pointer) override {
            return TJS_E_NOTIMPL;
        }

        tjs_error ClassInstanceInfo(tjs_uint32 flag, tjs_uint num,
                                    tTJSVariant *value) override {
            return TJS_E_NOTIMPL;
        }

        tjs_error Reserved2() override { return TJS_E_NOTIMPL; }

        tjs_error Reserved3() override { return TJS_E_NOTIMPL; }
    };

#undef OBJ1
#undef OBJ2

//---------------------------------------------------------------------------
// tTJSVariantArrayStack
//---------------------------------------------------------------------------
// TODO: adjust TJS_VA_ONE_ALLOC_MIN
#define TJS_VA_ONE_ALLOC_MAX 1024
#define TJS_COMPACT_FREQ 10000
    static tjs_int TJSCompactVariantArrayMagic = 0;
    static std::mutex TJSVariantArrayStackMutex;
    static std::set<tTJSVariantArrayStack *> TJSVariantArrayStacks;

    //---------------------------------------------------------------------------
    tTJSVariantArrayStack::tTJSVariantArrayStack() {
        NumArraysAllocated = NumArraysUsing = 0;
        Arrays = nullptr;
        Current = nullptr;
        OperationDisabledCount = 0;
        CompactVariantArrayMagic = TJSCompactVariantArrayMagic;
        std::lock_guard<std::mutex> lk(TJSVariantArrayStackMutex);
        TJSVariantArrayStacks.insert(this);
    }

    //---------------------------------------------------------------------------
    tTJSVariantArrayStack::~tTJSVariantArrayStack() {
        OperationDisabledCount++;
        tjs_int i;
        for(i = 0; i < NumArraysAllocated; i++) {
            delete[] Arrays[i].Array;
        }
        TJS_free(Arrays), Arrays = nullptr;
        std::lock_guard<std::mutex> lk(TJSVariantArrayStackMutex);
        TJSVariantArrayStacks.erase(this);
    }

    //---------------------------------------------------------------------------
    void tTJSVariantArrayStack::IncreaseVariantArray(tjs_int num) {
        if(NumArraysUsing == NumArraysAllocated) {
            // Do not publish counts or discard the old descriptor table until
            // both allocations succeed. Existing register pointers stay valid.
            auto values = std::make_unique<tTJSVariant[]>(num);
            auto* next = static_cast<tVariantArray*>(TJS_realloc(
                Arrays, sizeof(tVariantArray) * (NumArraysUsing + 1)));
            if(!next) TJS_eTJSError(TJSInsufficientMem);
            Arrays = next;
            Arrays[NumArraysUsing].Array = values.release();
            Arrays[NumArraysUsing].Allocated = num;
            ++NumArraysAllocated;
        }
        Current = Arrays + NumArraysUsing;
        Current->Using = 0;
        ++NumArraysUsing;
    }

    //---------------------------------------------------------------------------
    void tTJSVariantArrayStack::DecreaseVariantArray() {
        // decrease array block
        NumArraysUsing--;
        if(NumArraysUsing == 0)
            Current = nullptr;
        else
            Current = Arrays + NumArraysUsing - 1;
    }

    //---------------------------------------------------------------------------
    void tTJSVariantArrayStack::InternalCompact() {
        // minimize variant array block
        OperationDisabledCount++;
        try {
            while(NumArraysAllocated > NumArraysUsing) {
                NumArraysAllocated--;
                delete[] Arrays[NumArraysAllocated].Array;
            }

            if(Current) {
                for(tjs_int i = Current->Using; i < Current->Allocated; i++)
                    Current->Array[i].Clear();
            }

            if(NumArraysUsing == 0) {
                if(Arrays)
                    TJS_free(Arrays), Arrays = nullptr;
                Current = nullptr;
            } else {
                tVariantArray *arraytmp = (tVariantArray *)TJS_realloc(
                    Arrays, sizeof(tVariantArray) * (NumArraysUsing));
                if(arraytmp != nullptr) {
                    Arrays = arraytmp;
                } else if(NumArraysUsing > 0) {
                    TJS_eTJSError(TJSInternalError);
                }

                Current = Arrays + NumArraysUsing - 1;
            }
        } catch(...) {
            OperationDisabledCount--;
            throw;
        }
        OperationDisabledCount--;
    }

    //---------------------------------------------------------------------------
    inline tTJSVariant *tTJSVariantArrayStack::Allocate(tjs_int num) {
        //		tTJSCSH csh(CS);

        if(!OperationDisabledCount && num < TJS_VA_ONE_ALLOC_MAX) {
            if(!Current || Current->Using + num > Current->Allocated) {
                IncreaseVariantArray(TJS_VA_ONE_ALLOC_MAX);
            }
            tTJSVariant *ret = Current->Array + Current->Using;
            Current->Using += num;
            return ret;
        } else {
            return new tTJSVariant[num];
        }
    }

    //---------------------------------------------------------------------------
    inline void tTJSVariantArrayStack::Deallocate(tjs_int num, tTJSVariant *ptr) {
        // Keep this frame registered while values are cleared: a finalizer can
        // suspend or reenter TJS and allocate another frame above this one.
        std::exception_ptr failure;
        for(tjs_int i = 0; i < num; ++i) {
            try { ptr[i].Clear(); }
            catch(...) { if(!failure) failure = std::current_exception(); }
        }
        if(!OperationDisabledCount && num < TJS_VA_ONE_ALLOC_MAX) {
            Current->Using -= num;
            if(Current->Using == 0) DecreaseVariantArray();
        } else {
            delete[] ptr; // Every element is now void, including throwing Clear.
        }
        if(!OperationDisabledCount && CompactVariantArrayMagic != TJSCompactVariantArrayMagic) {
            try { Compact(); CompactVariantArrayMagic = TJSCompactVariantArrayMagic; }
            catch(...) { if(!failure) failure = std::current_exception(); }
        }
        if(failure) std::rethrow_exception(failure);
    }

    //---------------------------------------------------------------------------
    // static tjs_int TJSVariantArrayStackRefCount = 0;
    //---------------------------------------------------------------------------
    void tTJSInterCodeContext::TJSVariantArrayStackAddRef() {}

    //---------------------------------------------------------------------------
    void tTJSInterCodeContext::TJSVariantArrayStackRelease() {}

    //---------------------------------------------------------------------------
    void TJSVariantArrayStackCompact() { TJSCompactVariantArrayMagic++; }

    //---------------------------------------------------------------------------
    void TJSVariantArrayStackCompactNow() {}
    //---------------------------------------------------------------------------
    //---------------------------------------------------------------------------

    //---------------------------------------------------------------------------
    // tTJSInterCodeContext ( class definitions are in
    // tjsInterCodeGen.h )
    //---------------------------------------------------------------------------
    void tTJSInterCodeContext::ExecuteAsFunction(iTJSDispatch2 *objthis,
        tTJSVariant **args, tjs_int numargs, tTJSVariant *result, tjs_int start_ip) {
        krkr::CleanupErrors cleanup;
        krkr::ExecutionFrame execution(0);
        if(MaxVariableCount < 0 || MaxFrameCount < 0 || VariableReserveCount < 2 || numargs < 0)
            ThrowInvalidVMCode();
        const auto count = std::uint64_t(MaxVariableCount) + VariableReserveCount + 1 + MaxFrameCount;
        krkr::TemporaryMemory memory;
        memory.reserve(count, sizeof(tTJSVariant));
        const auto num_alloc = static_cast<tjs_int>(count);
        tTJSVariant* regs;
        {
            KrkrCompilerScope allocation(9);
            regs = TJSVariantArrayStack->Allocate(num_alloc);
        }
        auto* ra = regs + MaxVariableCount + VariableReserveCount;
        tTJSObjectProxy proxy;
        bool traced = false;
        std::exception_ptr failure;
        try {
            {
                KrkrCompilerScope preparation(9);
                if(objthis) {
                    proxy.SetObjects(objthis, Block->GetTJS()->GetGlobalNoAddRef());
                    ra[-2] = &proxy;
                } else {
                    proxy.SetObjects(nullptr, nullptr);
                    auto* global = Block->GetTJS()->GetGlobalNoAddRef();
                    ra[-2].SetObject(global, global);
                }
                if(ShouldUseStackTracer()) { TJSStackTracerPush(this, false); traced = true; }
                if(TJSWarnOnExecutionOnDeletingObject && TJSObjectFlagEnabled() &&
                    Block->GetTJS()->GetConsoleOutput())
                    TJSWarnIfObjectIsDeleting(Block->GetTJS()->GetConsoleOutput(), objthis);
                ra[-1].SetObject(objthis, objthis);
                ra[0].Clear();
                for(tjs_int i = 0; i < FuncDeclArgCount; ++i) {
                    krkr_compiler_work(i);
                    if(i < numargs) ra[-3 - i] = *args[i];
                    else ra[-3 - i].Clear();
                }
                if(FuncDeclCollapseBase >= 0) {
                    memory.reserve(std::max(0, numargs - FuncDeclCollapseBase), sizeof(tTJSVariant));
                    krkr::NativeOwner<iTJSDispatch2> array(TJSCreateArrayObject());
                    ra[-3 - FuncDeclCollapseBase] = tTJSVariant(array.get(), array.get());
                    for(tjs_int i = FuncDeclCollapseBase; i < numargs; ++i) {
                        krkr_compiler_work(i);
                        const auto status = array->PropSetByNum(0, i - FuncDeclCollapseBase, args[i], array.get());
                        if(TJS_FAILED(status)) TJSThrowFrom_tjs_error(status);
                    }
                }
            }
            ExecuteCode(ra, start_ip, args, numargs, result);
        } catch(...) { failure = std::current_exception(); }
        try { TJSVariantArrayStack->Deallocate(num_alloc, regs); }
        catch(...) { if(!failure) failure = std::current_exception(); }
        if(traced) TJSStackTracerPop();
        if(failure) { cleanup.suppress(); std::rethrow_exception(failure); }
        cleanup.rethrow();
    }

    //---------------------------------------------------------------------------
    void
    tTJSInterCodeContext::DisplayExceptionGeneratedCode(tjs_int codepos,
                                                        const tTJSVariant *ra) {
        tTJS *tjs = Block->GetTJS();
        ttstr info{ fmt::format(
            "==== An exception occurred at {}, VM ip = {} ==== ",
            GetPositionDescriptionString(codepos).AsNarrowStdString(),
            codepos) };
        tjs_int info_len = info.GetLen();

        tjs->OutputToConsole(info.c_str());
        tjs->OutputToConsole(TJS_W("-- Disassembled VM code --"));
        DisassembleSrcLine(codepos);

        tjs->OutputToConsole(TJS_W("-- Register dump --"));

        const tTJSVariant *ra_start =
            ra - (MaxVariableCount + VariableReserveCount);
        tjs_int ra_count =
            MaxVariableCount + VariableReserveCount + 1 + MaxFrameCount;
        ttstr line;
        for(tjs_int i = 0; i < ra_count; i++) {
            ttstr reg_info = TJS_W("%") +
                ttstr(i - (MaxVariableCount + VariableReserveCount)) +
                TJS_W("=") + TJSVariantToReadableString(ra_start[i]);
            if(line.GetLen() + reg_info.GetLen() + 2 > info_len) {
                tjs->OutputToConsole(line.c_str());
                line = reg_info;
            } else {
                if(!line.IsEmpty())
                    line += TJS_W("  ");
                line += reg_info;
            }
        }

        if(!line.IsEmpty()) {
            tjs->OutputToConsole(line.c_str());
        }

        tjs->OutputToConsoleSeparator(TJS_W("-"), info_len);
    }

    //---------------------------------------------------------------------------
    void tTJSInterCodeContext::ThrowScriptException(tTJSVariant &val,
                                                    tTJSScriptBlock *block,
                                                    tjs_int srcpos) {
        tTJSString msg;
        if(val.Type() == tvtObject) {
            try {
                tTJSVariantClosure clo = val.AsObjectClosureNoAddRef();
                if(clo.Object != nullptr) {
                    tTJSVariant v2;
                    static tTJSString message_name(TJS_W("message"));
                    tjs_error hr =
                        clo.PropGet(0, message_name.c_str(),
                                    message_name.GetHint(), &v2, nullptr);
                    if(TJS_SUCCEEDED(hr)) {
                        msg = ttstr(TJS_W("script exception : ")) + ttstr(v2);
                    }
                }
            } catch(...) {
            }
        }

        if(msg.IsEmpty()) {
            msg = TJS_W("script exception");
        }

        TJS_eTJSScriptException(msg, this, srcpos, val);
    }

    //---------------------------------------------------------------------------
    tjs_int
    tTJSInterCodeContext::ExecuteCode(tTJSVariant *ra_org, tjs_int startip,
                                      tTJSVariant **args, tjs_int numargs,
                                      tTJSVariant *result, bool tryCatch) {
        // execute VM codes
        if(startip < 0 || startip >= CodeAreaSize)
            TJS_eTJSScriptError(TJSByteCodeBroken, Block, 0);
        tjs_int32 *codesave;
        try {
            tjs_int32 *code = codesave = CodeArea + startip;

            tTJSVariant *ra = ra_org;
            tTJSVariant *da = DataArea;

            bool flag = false;

            while(true) {
                // A return from a nested try body can advance to one-past-end.
                // Check before dereferencing, including dynamically resumed code.
                if(code < CodeArea || code >= CodeArea + CodeAreaSize)
                    TJS_eTJSScriptError(TJSByteCodeBroken, Block, 0);
                codesave = code;
                if(ShouldUseStackTracer())
                    TJSStackTracerSetCodePosition(code - CodeArea);
                krkr_vm_checkpoint();
                switch(*code) {
                    case VM_NOP:
                        code++;
                        break;

                    case VM_CONST:
                        TJS_GET_VM_REG(ra, code[1])
                            .CopyRef(TJS_GET_VM_REG(da, code[2]));
                        code += 3;
                        break;

                    case VM_CP:
                        TJS_GET_VM_REG(ra, code[1])
                            .CopyRef(TJS_GET_VM_REG(ra, code[2]));
                        code += 3;
                        break;

                    case VM_CL:
                        TJS_GET_VM_REG(ra, code[1]).Clear();
                        code += 2;
                        break;

                    case VM_CCL:
                        ContinuousClear(ra, code);
                        code += 3;
                        break;

                    case VM_TT:
                        flag = TJS_GET_VM_REG(ra, code[1]).operator bool();
                        code += 2;
                        break;

                    case VM_TF:
                        flag = !(TJS_GET_VM_REG(ra, code[1]).operator bool());
                        code += 2;
                        break;

                    case VM_CEQ:
                        flag = TJS_GET_VM_REG(ra, code[1])
                                   .NormalCompare(TJS_GET_VM_REG(ra, code[2]));
                        code += 3;
                        break;

                    case VM_CDEQ:
                        flag = TJS_GET_VM_REG(ra, code[1])
                                   .DiscernCompare(TJS_GET_VM_REG(ra, code[2]));
                        code += 3;
                        break;

                    case VM_CLT:
                        flag = TJS_GET_VM_REG(ra, code[1])
                                   .GreaterThan(TJS_GET_VM_REG(ra, code[2]));
                        code += 3;
                        break;

                    case VM_CGT:
                        flag = TJS_GET_VM_REG(ra, code[1])
                                   .LittlerThan(TJS_GET_VM_REG(ra, code[2]));
                        code += 3;
                        break;

                    case VM_SETF:
                        TJS_GET_VM_REG(ra, code[1]) = flag;
                        code += 2;
                        break;

                    case VM_SETNF:
                        TJS_GET_VM_REG(ra, code[1]) = !flag;
                        code += 2;
                        break;

                    case VM_LNOT:
                        TJS_GET_VM_REG(ra, code[1]).logicalnot();
                        code += 2;
                        break;

                    case VM_NF:
                        flag = !flag;
                        code++;
                        break;

                    case VM_JF:
                        if(flag)
                            TJS_ADD_VM_CODE_ADDR(code, code[1]);
                        else
                            code += 2;
                        break;

                    case VM_JNF:
                        if(!flag)
                            TJS_ADD_VM_CODE_ADDR(code, code[1]);
                        else
                            code += 2;
                        break;

                    case VM_JMP:
                        TJS_ADD_VM_CODE_ADDR(code, code[1]);
                        break;

                    case VM_INC:
                        TJS_GET_VM_REG(ra, code[1]).increment();
                        code += 2;
                        break;

                    case VM_INCPD:
                        OperatePropertyDirect0(ra, code, TJS_OP_INC);
                        code += 4;
                        break;

                    case VM_INCPI:
                        OperatePropertyIndirect0(ra, code, TJS_OP_INC);
                        code += 4;
                        break;

                    case VM_INCP:
                        OperateProperty0(ra, code, TJS_OP_INC);
                        code += 3;
                        break;

                    case VM_DEC:
                        TJS_GET_VM_REG(ra, code[1]).decrement();
                        code += 2;
                        break;

                    case VM_DECPD:
                        OperatePropertyDirect0(ra, code, TJS_OP_DEC);
                        code += 4;
                        break;

                    case VM_DECPI:
                        OperatePropertyIndirect0(ra, code, TJS_OP_DEC);
                        code += 4;
                        break;

                    case VM_DECP:
                        OperateProperty0(ra, code, TJS_OP_DEC);
                        code += 3;
                        break;

#define TJS_DEF_VM_P(vmcode, rope)                                             \
    case VM_##vmcode:                                                          \
        TJS_GET_VM_REG(ra, code[1]).rope(TJS_GET_VM_REG(ra, code[2]));         \
        code += 3;                                                             \
        break;                                                                 \
    case VM_##vmcode##PD:                                                      \
        OperatePropertyDirect(ra, code, TJS_OP_##vmcode);                      \
        code += 5;                                                             \
        break;                                                                 \
    case VM_##vmcode##PI:                                                      \
        OperatePropertyIndirect(ra, code, TJS_OP_##vmcode);                    \
        code += 5;                                                             \
        break;                                                                 \
    case VM_##vmcode##P:                                                       \
        OperateProperty(ra, code, TJS_OP_##vmcode);                            \
        code += 4;                                                             \
        break

                        TJS_DEF_VM_P(LOR, logicalorequal);
                        TJS_DEF_VM_P(LAND, logicalandequal);
                        TJS_DEF_VM_P(BOR, operator|=);
                        TJS_DEF_VM_P(BXOR, operator^=);
                        TJS_DEF_VM_P(BAND, operator&=);
                        TJS_DEF_VM_P(SAR, operator>>=);
                        TJS_DEF_VM_P(SAL, operator<<=);
                        TJS_DEF_VM_P(SR, rbitshiftequal);
                        TJS_DEF_VM_P(ADD, operator+=);
                        TJS_DEF_VM_P(SUB, operator-=);
                        TJS_DEF_VM_P(MOD, operator%=);
                        TJS_DEF_VM_P(DIV, operator/=);
                        TJS_DEF_VM_P(IDIV, idivequal);
                        TJS_DEF_VM_P(MUL, operator*=);

#undef TJS_DEF_VM_P

                    case VM_BNOT:
                        TJS_GET_VM_REG(ra, code[1]).bitnot();
                        code += 2;
                        break;

                    case VM_ASC:
                        CharacterCodeOf(TJS_GET_VM_REG(ra, code[1]));
                        code += 2;
                        break;

                    case VM_CHR:
                        CharacterCodeFrom(TJS_GET_VM_REG(ra, code[1]));
                        code += 2;
                        break;

                    case VM_NUM:
                        TJS_GET_VM_REG(ra, code[1]).tonumber();
                        code += 2;
                        break;

                    case VM_CHS:
                        TJS_GET_VM_REG(ra, code[1]).changesign();
                        code += 2;
                        break;

                    case VM_INV:
                        TJS_GET_VM_REG(ra, code[1]) =
                            TJS_GET_VM_REG(ra, code[1]).Type() != tvtObject
                            ? false
                            : (TJS_GET_VM_REG(ra, code[1])
                                   .AsObjectClosureNoAddRef()
                                   .Invalidate(0, nullptr, nullptr,
                                               ra[-1].AsObjectNoAddRef()) ==
                               TJS_S_TRUE);
                        code += 2;
                        break;

                    case VM_CHKINV:
                        TJS_GET_VM_REG(ra, code[1]) =
                            TJS_GET_VM_REG(ra, code[1]).Type() != tvtObject
                            ? true
                            : TJSIsObjectValid(
                                  TJS_GET_VM_REG(ra, code[1])
                                      .AsObjectClosureNoAddRef()
                                      .IsValid(0, nullptr, nullptr,
                                               ra[-1].AsObjectNoAddRef()));
                        code += 2;
                        break;

                    case VM_INT:
                        TJS_GET_VM_REG(ra, code[1]).ToInteger();
                        code += 2;
                        break;

                    case VM_REAL:
                        TJS_GET_VM_REG(ra, code[1]).ToReal();
                        code += 2;
                        break;

                    case VM_STR:
                        TJS_GET_VM_REG(ra, code[1]).ToString();
                        code += 2;
                        break;

                    case VM_OCTET:
                        TJS_GET_VM_REG(ra, code[1]).ToOctet();
                        code += 2;
                        break;

                    case VM_TYPEOF:
                        TypeOf(TJS_GET_VM_REG(ra, code[1]));
                        code += 2;
                        break;

                    case VM_TYPEOFD:
                        TypeOfMemberDirect(ra, code, TJS_MEMBERMUSTEXIST);
                        code += 4;
                        break;

                    case VM_TYPEOFI:
                        TypeOfMemberIndirect(ra, code, TJS_MEMBERMUSTEXIST);
                        code += 4;
                        break;

                    case VM_EVAL:
                        Eval(TJS_GET_VM_REG(ra, code[1]),
                             TJSEvalOperatorIsOnGlobal
                                 ? nullptr
                                 : ra[-1].AsObjectNoAddRef(),
                             true);
                        code += 2;
                        break;

                    case VM_EEXP:
                        Eval(TJS_GET_VM_REG(ra, code[1]),
                             TJSEvalOperatorIsOnGlobal
                                 ? nullptr
                                 : ra[-1].AsObjectNoAddRef(),
                             false);
                        code += 2;
                        break;

                    case VM_CHKINS:
                        InstanceOf(TJS_GET_VM_REG(ra, code[2]),
                                   TJS_GET_VM_REG(ra, code[1]));
                        code += 3;
                        break;

                    case VM_CALL:
                    case VM_NEW:
                        code += CallFunction(ra, code, args, numargs);
                        break;

                    case VM_CALLD:
                        code += CallFunctionDirect(ra, code, args, numargs);
                        break;

                    case VM_CALLI:
                        code += CallFunctionIndirect(ra, code, args, numargs);
                        break;

                    case VM_GPD:
                        GetPropertyDirect(ra, code, 0);
                        code += 4;
                        break;

                    case VM_GPDS:
                        GetPropertyDirect(ra, code, TJS_IGNOREPROP);
                        code += 4;
                        break;

                    case VM_SPD:
                        SetPropertyDirect(ra, code, 0);
                        code += 4;
                        break;

                    case VM_SPDE:
                        SetPropertyDirect(ra, code, TJS_MEMBERENSURE);
                        code += 4;
                        break;

                    case VM_SPDEH:
                        SetPropertyDirect(ra, code,
                                          TJS_MEMBERENSURE | TJS_HIDDENMEMBER);
                        code += 4;
                        break;

                    case VM_SPDS:
                        SetPropertyDirect(ra, code,
                                          TJS_MEMBERENSURE | TJS_IGNOREPROP);
                        code += 4;
                        break;

                    case VM_GPI:
                        GetPropertyIndirect(ra, code, 0);
                        code += 4;
                        break;

                    case VM_GPIS:
                        GetPropertyIndirect(ra, code, TJS_IGNOREPROP);
                        code += 4;
                        break;

                    case VM_SPI:
                        SetPropertyIndirect(ra, code, 0);
                        code += 4;
                        break;

                    case VM_SPIE:
                        SetPropertyIndirect(ra, code, TJS_MEMBERENSURE);
                        code += 4;
                        break;

                    case VM_SPIS:
                        SetPropertyIndirect(ra, code,
                                            TJS_MEMBERENSURE | TJS_IGNOREPROP);
                        code += 4;
                        break;

                    case VM_GETP:
                        GetProperty(ra, code);
                        code += 3;
                        break;

                    case VM_SETP:
                        SetProperty(ra, code);
                        code += 3;
                        break;

                    case VM_DELD:
                        DeleteMemberDirect(ra, code);
                        code += 4;
                        break;

                    case VM_DELI:
                        DeleteMemberIndirect(ra, code);
                        code += 4;
                        break;

                    case VM_SRV:
                        if(result)
                            result->CopyRef(TJS_GET_VM_REG(ra, code[1]));
                        code += 2;
                        break;

                    case VM_RET:
                        return code + 1 - CodeArea;

                    case VM_ENTRY:
                        code =
                            CodeArea +
                            ExecuteCodeInTryBlock(
                                ra, code - CodeArea + 3, args, numargs, result,
                                TJS_FROM_VM_CODE_ADDR(code[1]) + code -
                                    CodeArea,
                                TJS_FROM_VM_REG_ADDR(code[2]));
                        break;

                    case VM_EXTRY:
                        return code + 1 - CodeArea; // same as ret

                    case VM_THROW:
                        ThrowScriptException(TJS_GET_VM_REG(ra, code[1]), Block,
                                             CodePosToSrcPos(code - CodeArea));
                        code += 2; // actually here not proceed...
                        break;

                    case VM_CHGTHIS:
                        TJS_GET_VM_REG(ra, code[1])
                            .ChangeClosureObjThis(
                                TJS_GET_VM_REG(ra, code[2])
                                    .AsObjectNoAddRef());
                        code += 3;
                        break;

                    case VM_GLOBAL:
                        TJS_GET_VM_REG(ra, code[1]) =
                            Block->GetTJS()->GetGlobalNoAddRef();
                        code += 2;
                        break;

                    case VM_ADDCI:
                        AddClassInstanceInfo(ra, code);
                        code += 3;
                        break;

                    case VM_REGMEMBER:
                        RegisterObjectMember(ra[-1].AsObjectNoAddRef());
                        code++;
                        break;

                    case VM_DEBUGGER:
                        TJSNativeDebuggerBreak();
                        code++;
                        break;

                    default:
                        ThrowInvalidVMCode();
                }
            }
        } catch(eTJSSilent &) {
            throw;
        } catch(krkr::ExecutionLimitError &e) {
            // Do not disassemble every live register at an exhausted resource
            // boundary. Preserve the source location and ordinary TJS catch.
            TJS_eTJSScriptError(e.GetMessage(), this, codesave - CodeArea);
        } catch(eTJSScriptError &e) {
            e.AddTrace(this, codesave - CodeArea);
            throw;
        } catch(eTJS &e) {
            if(tryCatch) {
                spdlog::get("tjs2")->debug(e.GetMessage().AsStdString());
            } else {
                // Diagnostic observers may throw; keep the primary VM error.
                try { DisplayExceptionGeneratedCode(codesave - CodeArea, ra_org); } catch(...) {}
            }
            TJS_eTJSScriptError(e.GetMessage(), this, codesave - CodeArea);
        } catch(exception &e) {
            if(tryCatch) {
                spdlog::get("tjs2")->debug(e.what());
            } else {
                try { DisplayExceptionGeneratedCode(codesave - CodeArea, ra_org); } catch(...) {}
            }
            TJS_eTJSScriptError(e.what(), this, codesave - CodeArea);
        } catch(const char *text) {
            if(tryCatch) {
                spdlog::get("tjs2")->debug(text);
            } else {
                try { DisplayExceptionGeneratedCode(codesave - CodeArea, ra_org); } catch(...) {}
            }
            TJS_eTJSScriptError(text, this, codesave - CodeArea);
        }

        return codesave - CodeArea;
    }

    //---------------------------------------------------------------------------
    tjs_int tTJSInterCodeContext::ExecuteCodeInTryBlock(
        tTJSVariant *ra, tjs_int startip, tTJSVariant **args, tjs_int numargs,
        tTJSVariant *result, tjs_int catchip, tjs_int exobjreg) {
        // execute codes in a try-protected block

        try {
            krkr::CleanupErrors cleanup;
            krkr::ExecutionFrame execution(1);
            if(ShouldUseStackTracer())
                TJSStackTracerPush(this, true);
            tjs_int ret;
            try {
                ret = ExecuteCode(ra, startip, args, numargs, result, true);
            } catch(...) {
                if(ShouldUseStackTracer())
                    TJSStackTracerPop();
                throw;
            }
            if(ShouldUseStackTracer())
                TJSStackTracerPop();
            cleanup.rethrow();
            return ret;
        } catch(eTJSSilent &) {
            throw;
        } catch(eTJSScriptException &e) {
            if(exobjreg)
                *(ra + exobjreg) = e.GetValue();
            return catchip;
        } catch(eTJSScriptError &e) {
            if(exobjreg) {
                tTJSVariant msg(e.GetMessage());
                tTJSVariant trace(e.GetTrace());
                TJSGetExceptionObject(Block->GetTJS(), ra + exobjreg, msg,
                                      &trace);
            }
            return catchip;
        } catch(eTJS &e) {
            if(exobjreg) {
                tTJSVariant msg(e.GetMessage());
                TJSGetExceptionObject(Block->GetTJS(), ra + exobjreg, msg,
                                      nullptr);
            }
            return catchip;
        } catch(std::exception &e) {
            if(exobjreg) {
                tTJSVariant msg(e.what());
                TJSGetExceptionObject(Block->GetTJS(), ra + exobjreg, msg,
                                      nullptr);
            }
            return catchip;
        } catch(...) {
            if(exobjreg)
                (ra + exobjreg)->Clear();
            return catchip;
        }
    }

    //---------------------------------------------------------------------------
    void tTJSInterCodeContext::ContinuousClear(tTJSVariant *ra,
                                               const tjs_int32 *code) {
        tTJSVariant *r = TJS_GET_VM_REG_ADDR(ra, code[1]);
        tTJSVariant *rl = r + code[2]; // code[2] is count ( not reg offset )
        while(r < rl)
            (r++)->Clear();
    }

    //---------------------------------------------------------------------------
    void tTJSInterCodeContext::GetPropertyDirect(tTJSVariant *ra,
                                                 const tjs_int32 *code,
                                                 tjs_uint32 flags) const {
        // ra[code[1]] = ra[code[2]][DataArea[ra[code[3]]]];

        tTJSVariant *ra_code2 = TJS_GET_VM_REG_ADDR(ra, code[2]);
        tTJSVariantType type = ra_code2->Type();
        if(type == tvtString) {
            GetStringProperty(TJS_GET_VM_REG_ADDR(ra, code[1]), ra_code2,
                              TJS_GET_VM_REG(DataArea, code[3]));
            return;
        }
        if(type == tvtOctet) {
            GetOctetProperty(TJS_GET_VM_REG_ADDR(ra, code[1]), ra_code2,
                             TJS_GET_VM_REG(DataArea, code[3]));
            return;
        }

        tTJSVariantClosure clo = ra_code2->AsObjectClosureNoAddRef();
        tTJSVariant *name = TJS_GET_VM_REG_ADDR(DataArea, code[3]);
        tTJSVariant *result = TJS_GET_VM_REG_ADDR(ra, code[1]);
        tjs_error hr =
            clo.PropGet(flags, name->GetString(), name->GetHint(),
                        result,
                        clo.ObjThis ? clo.ObjThis : ra[-1].AsObjectNoAddRef());
        TJSTracePropertyResult("tjs.prop.direct", name->GetString(), flags, hr,
                               result);
        if(TJS_FAILED(hr))
            TJSThrowFrom_tjs_error(
                hr, TJS_GET_VM_REG(DataArea, code[3]).GetString());
    }

    //---------------------------------------------------------------------------
    void tTJSInterCodeContext::SetPropertyDirect(tTJSVariant *ra,
                                                 const tjs_int32 *code,
                                                 tjs_uint32 flags) const {
        // ra[code[1]][DataArea[ra[code[2]]]] = ra[code[3]]]

        tTJSVariant *ra_code1 = TJS_GET_VM_REG_ADDR(ra, code[1]);
        tTJSVariantType type = ra_code1->Type();
        if(type == tvtString) {
            SetStringProperty(TJS_GET_VM_REG_ADDR(ra, code[3]), ra_code1,
                              TJS_GET_VM_REG(DataArea, code[2]));
            return;
        }
        if(type == tvtOctet) {
            SetOctetProperty(TJS_GET_VM_REG_ADDR(ra, code[3]), ra_code1,
                             TJS_GET_VM_REG(DataArea, code[2]));
            return;
        }

        tTJSVariantClosure clo = ra_code1->AsObjectClosureNoAddRef();
        tTJSVariant *name = TJS_GET_VM_REG_ADDR(DataArea, code[2]);
        tjs_error hr = clo.PropSetByVS(
            flags, name->AsStringNoAddRef(), TJS_GET_VM_REG_ADDR(ra, code[3]),
            clo.ObjThis ? clo.ObjThis : ra[-1].AsObjectNoAddRef());
        if(hr == TJS_E_NOTIMPL)
            hr = clo.PropSet(flags, name->GetString(), name->GetHint(),
                             TJS_GET_VM_REG_ADDR(ra, code[3]),
                             clo.ObjThis ? clo.ObjThis
                                         : ra[-1].AsObjectNoAddRef());
        if(TJS_FAILED(hr))
            TJSThrowFrom_tjs_error(
                hr, TJS_GET_VM_REG(DataArea, code[2]).GetString());
    }

    //---------------------------------------------------------------------------
    void tTJSInterCodeContext::GetProperty(tTJSVariant *ra,
                                           const tjs_int32 *code) {
        // ra[code[1]] = * ra[code[2]]
        tTJSVariantClosure clo =
            TJS_GET_VM_REG_ADDR(ra, code[2])->AsObjectClosureNoAddRef();
        tjs_error hr =
            clo.PropGet(0, nullptr, nullptr, TJS_GET_VM_REG_ADDR(ra, code[1]),
                        clo.ObjThis ? clo.ObjThis : ra[-1].AsObjectNoAddRef());
        if(TJS_FAILED(hr))
            TJSThrowFrom_tjs_error(hr, nullptr);
    }

    //---------------------------------------------------------------------------
    void tTJSInterCodeContext::SetProperty(tTJSVariant *ra,
                                           const tjs_int32 *code) {
        // * ra[code[1]] = ra[code[2]]
        tTJSVariantClosure clo =
            TJS_GET_VM_REG_ADDR(ra, code[1])->AsObjectClosureNoAddRef();
        tjs_error hr =
            clo.PropSet(0, nullptr, nullptr, TJS_GET_VM_REG_ADDR(ra, code[2]),
                        clo.ObjThis ? clo.ObjThis : ra[-1].AsObjectNoAddRef());
        if(TJS_FAILED(hr))
            TJSThrowFrom_tjs_error(hr, nullptr);
    }

    //---------------------------------------------------------------------------
    void tTJSInterCodeContext::GetPropertyIndirect(tTJSVariant *ra,
                                                   const tjs_int32 *code,
                                                   tjs_uint32 flags) {
        // ra[code[1]] = ra[code[2]][ra[code[3]]];

        tTJSVariant *ra_code2 = TJS_GET_VM_REG_ADDR(ra, code[2]);
        tTJSVariantType type = ra_code2->Type();
        if(type == tvtString) {
            GetStringProperty(TJS_GET_VM_REG_ADDR(ra, code[1]), ra_code2,
                              TJS_GET_VM_REG(ra, code[3]));
            return;
        }
        if(type == tvtOctet) {
            GetOctetProperty(TJS_GET_VM_REG_ADDR(ra, code[1]), ra_code2,
                             TJS_GET_VM_REG(ra, code[3]));
            return;
        }

        tjs_error hr;
        tTJSVariantClosure clo = ra_code2->AsObjectClosureNoAddRef();
        tTJSVariant *ra_code3 = TJS_GET_VM_REG_ADDR(ra, code[3]);
        if(ra_code3->Type() != tvtInteger) {
            tTJSVariantString *str = ra_code3->AsString();
            const tjs_char *member_name = GetSafeStringValue(str);

            try {
                // TODO: verify here needs hint holding
                tTJSVariant *result = TJS_GET_VM_REG_ADDR(ra, code[1]);
                hr = clo.PropGet(
                    flags, member_name, nullptr,
                    result,
                    clo.ObjThis ? clo.ObjThis : ra[-1].AsObjectNoAddRef());
                TJSTracePropertyResult("tjs.prop.indirect", member_name, flags,
                                       hr, result);
                if(TJS_FAILED(hr))
                    TJSThrowFrom_tjs_error(hr, member_name);
            } catch(...) {
                if(str)
                    str->Release();
                throw;
            }
            if(str)
                str->Release();
        } else {
            hr = clo.PropGetByNum(flags, (tjs_int)ra_code3->AsInteger(),
                                  TJS_GET_VM_REG_ADDR(ra, code[1]),
                                  clo.ObjThis ? clo.ObjThis
                                              : ra[-1].AsObjectNoAddRef());
            if(TJS_FAILED(hr))
                ThrowFrom_tjs_error_num(hr, (tjs_int)ra_code3->AsInteger());
        }
    }

    //---------------------------------------------------------------------------
    void tTJSInterCodeContext::SetPropertyIndirect(tTJSVariant *ra,
                                                   const tjs_int32 *code,
                                                   tjs_uint32 flags) {
        // ra[code[1]][ra[code[2]]] = ra[code[3]]]

        tTJSVariant *ra_code1 = TJS_GET_VM_REG_ADDR(ra, code[1]);
        tTJSVariantType type = ra_code1->Type();
        if(type == tvtString) {
            SetStringProperty(TJS_GET_VM_REG_ADDR(ra, code[3]),
                              TJS_GET_VM_REG_ADDR(ra, code[1]),
                              TJS_GET_VM_REG(ra, code[2]));
            return;
        }
        if(type == tvtOctet) {
            SetOctetProperty(TJS_GET_VM_REG_ADDR(ra, code[3]),
                             TJS_GET_VM_REG_ADDR(ra, code[1]),
                             TJS_GET_VM_REG(ra, code[2]));
            return;
        }

        tTJSVariantClosure clo = ra_code1->AsObjectClosure();
        tTJSVariant *ra_code2 = TJS_GET_VM_REG_ADDR(ra, code[2]);
        if(ra_code2->Type() != tvtInteger) {
            tTJSVariantString *str;
            const tjs_char *member_name = TJS_W("");
            try {
                str = ra_code2->AsString();
                member_name = GetSafeStringValue(str);
            } catch(...) {
                clo.Release();
                throw;
            }

            try {
                tjs_error hr = clo.PropSetByVS(
                    flags, str, TJS_GET_VM_REG_ADDR(ra, code[3]),
                    clo.ObjThis ? clo.ObjThis : ra[-1].AsObjectNoAddRef());
                if(hr == TJS_E_NOTIMPL)
                    hr = clo.PropSet(
                        flags, member_name, nullptr,
                        TJS_GET_VM_REG_ADDR(ra, code[3]),
                        clo.ObjThis ? clo.ObjThis : ra[-1].AsObjectNoAddRef());
                if(TJS_FAILED(hr))
                    TJSThrowFrom_tjs_error(hr, member_name);
            } catch(...) {
                if(str)
                    str->Release();
                clo.Release();
                throw;
            }
            if(str)
                str->Release();
            clo.Release();
        } else {

            try {
                tjs_error hr = clo.PropSetByNum(
                    flags, (tjs_int)ra_code2->AsInteger(),
                    TJS_GET_VM_REG_ADDR(ra, code[3]),
                    clo.ObjThis ? clo.ObjThis : ra[-1].AsObjectNoAddRef());
                if(TJS_FAILED(hr))
                    ThrowFrom_tjs_error_num(hr, (tjs_int)ra_code2->AsInteger());
            } catch(...) {
                clo.Release();
                throw;
            }
            clo.Release();
        }
    }

    //---------------------------------------------------------------------------
    void tTJSInterCodeContext::OperatePropertyDirect(tTJSVariant *ra,
                                                     const tjs_int32 *code,
                                                     tjs_uint32 ope) const {
        // ra[code[1]] = ope(ra[code[2]][DataArea[ra[code[3]]]],
        // /*param=*/ra[code[4]]);

        tTJSVariantClosure clo = TJS_GET_VM_REG(ra, code[2]).AsObjectClosure();
        tjs_error hr;
        try {
            tTJSVariant *name = TJS_GET_VM_REG_ADDR(DataArea, code[3]);
            hr = clo.Operation(
                ope, name->GetString(), name->GetHint(),
                code[1] ? TJS_GET_VM_REG_ADDR(ra, code[1]) : nullptr,
                TJS_GET_VM_REG_ADDR(ra, code[4]),
                clo.ObjThis ? clo.ObjThis : ra[-1].AsObjectNoAddRef());
        } catch(...) {
            clo.Release();
            throw;
        }
        clo.Release();
        if(TJS_FAILED(hr))
            TJSThrowFrom_tjs_error(
                hr, TJS_GET_VM_REG(DataArea, code[3]).GetString());
    }

    //---------------------------------------------------------------------------
    void tTJSInterCodeContext::OperatePropertyIndirect(tTJSVariant *ra,
                                                       const tjs_int32 *code,
                                                       tjs_uint32 ope) {
        // ra[code[1]] = ope(ra[code[2]][ra[code[3]]],
        // /*param=*/ra[code[4]]);

        tTJSVariantClosure clo = TJS_GET_VM_REG(ra, code[2]).AsObjectClosure();
        tTJSVariant *ra_code3 = TJS_GET_VM_REG_ADDR(ra, code[3]);
        if(ra_code3->Type() != tvtInteger) {
            tTJSVariantString *str;
            const tjs_char *member_name = TJS_W("");
            try {
                str = ra_code3->AsString();
                member_name = GetSafeStringValue(str);
            } catch(...) {
                clo.Release();
                throw;
            }
            try {
                tjs_error hr = clo.Operation(
                    ope, member_name, nullptr,
                    code[1] ? TJS_GET_VM_REG_ADDR(ra, code[1]) : nullptr,
                    TJS_GET_VM_REG_ADDR(ra, code[4]),
                    clo.ObjThis ? clo.ObjThis : ra[-1].AsObjectNoAddRef());
                if(TJS_FAILED(hr))
                    TJSThrowFrom_tjs_error(hr, member_name);
            } catch(...) {
                if(str)
                    str->Release();
                clo.Release();
                throw;
            }
            if(str)
                str->Release();
            clo.Release();
        } else {
            tjs_error hr;
            try {
                hr = clo.OperationByNum(
                    ope, (tjs_int)ra_code3->AsInteger(),
                    code[1] ? TJS_GET_VM_REG_ADDR(ra, code[1]) : nullptr,
                    TJS_GET_VM_REG_ADDR(ra, code[4]),
                    clo.ObjThis ? clo.ObjThis : ra[-1].AsObjectNoAddRef());
                if(TJS_FAILED(hr))
                    ThrowFrom_tjs_error_num(
                        hr, (tjs_int)TJS_GET_VM_REG(ra, code[3]).AsInteger());
            } catch(...) {
                clo.Release();
                throw;
            }
            clo.Release();
        }
    }

    //---------------------------------------------------------------------------
    void tTJSInterCodeContext::OperateProperty(tTJSVariant *ra,
                                               const tjs_int32 *code,
                                               tjs_uint32 ope) {
        // ra[code[1]] = ope(ra[code[2]], /*param=*/ra[code[3]]);
        tTJSVariantClosure clo = TJS_GET_VM_REG(ra, code[2]).AsObjectClosure();
        tjs_error hr;
        try {
            hr = clo.Operation(
                ope, nullptr, nullptr,
                code[1] ? TJS_GET_VM_REG_ADDR(ra, code[1]) : nullptr,
                TJS_GET_VM_REG_ADDR(ra, code[3]),
                clo.ObjThis ? clo.ObjThis : ra[-1].AsObjectNoAddRef());
        } catch(...) {
            clo.Release();
            throw;
        }
        clo.Release();
        if(TJS_FAILED(hr))
            TJSThrowFrom_tjs_error(hr, nullptr);
    }

    //---------------------------------------------------------------------------
    void tTJSInterCodeContext::OperatePropertyDirect0(tTJSVariant *ra,
                                                      const tjs_int32 *code,
                                                      tjs_uint32 ope) const {
        // ra[code[1]] = ope(ra[code[2]][DataArea[ra[code[3]]]]);

        tTJSVariantClosure clo = TJS_GET_VM_REG(ra, code[2]).AsObjectClosure();
        tjs_error hr;
        try {
            tTJSVariant *name = TJS_GET_VM_REG_ADDR(DataArea, code[3]);
            hr = clo.Operation(ope, name->GetString(), name->GetHint(),
                               code[1] ? TJS_GET_VM_REG_ADDR(ra, code[1])
                                       : nullptr,
                               nullptr, ra[-1].AsObjectNoAddRef());
        } catch(...) {
            clo.Release();
            throw;
        }
        clo.Release();
        if(TJS_FAILED(hr))
            TJSThrowFrom_tjs_error(
                hr, TJS_GET_VM_REG(DataArea, code[3]).GetString());
    }

    //---------------------------------------------------------------------------
    void tTJSInterCodeContext::OperatePropertyIndirect0(tTJSVariant *ra,
                                                        const tjs_int32 *code,
                                                        tjs_uint32 ope) {
        // ra[code[1]] = ope(ra[code[2]][ra[code[3]]]);

        tTJSVariantClosure clo = TJS_GET_VM_REG(ra, code[2]).AsObjectClosure();
        tTJSVariant *ra_code3 = TJS_GET_VM_REG_ADDR(ra, code[3]);
        if(ra_code3->Type() != tvtInteger) {
            tTJSVariantString *str;
            const tjs_char *member_name = TJS_W("");
            try {
                str = ra_code3->AsString();
                member_name = GetSafeStringValue(str);
            } catch(...) {
                clo.Release();
                throw;
            }
            tjs_error hr;
            try {
                hr = clo.Operation(
                    ope, member_name, nullptr,
                    code[1] ? TJS_GET_VM_REG_ADDR(ra, code[1]) : nullptr,
                    nullptr,
                    clo.ObjThis ? clo.ObjThis : ra[-1].AsObjectNoAddRef());
                if(TJS_FAILED(hr))
                    TJSThrowFrom_tjs_error(hr, member_name);
            } catch(...) {
                if(str)
                    str->Release();
                clo.Release();
                throw;
            }
            if(str)
                str->Release();
            clo.Release();
        } else {
            tjs_error hr;
            try {
                hr = clo.OperationByNum(
                    ope, (tjs_int)TJS_GET_VM_REG(ra, code[3]).AsInteger(),
                    code[1] ? TJS_GET_VM_REG_ADDR(ra, code[1]) : nullptr,
                    nullptr,
                    clo.ObjThis ? clo.ObjThis : ra[-1].AsObjectNoAddRef());
                if(TJS_FAILED(hr))
                    ThrowFrom_tjs_error_num(
                        hr, (tjs_int)TJS_GET_VM_REG(ra, code[3]).AsInteger());
            } catch(...) {
                clo.Release();
                throw;
            }
            clo.Release();
        }
    }

    //---------------------------------------------------------------------------
    void tTJSInterCodeContext::OperateProperty0(tTJSVariant *ra,
                                                const tjs_int32 *code,
                                                tjs_uint32 ope) {
        // ra[code[1]] = ope(ra[code[2]]);
        tTJSVariantClosure clo = TJS_GET_VM_REG(ra, code[2]).AsObjectClosure();
        tjs_error hr;
        try {
            hr = clo.Operation(
                ope, nullptr, nullptr,
                code[1] ? TJS_GET_VM_REG_ADDR(ra, code[1]) : nullptr, nullptr,
                clo.ObjThis ? clo.ObjThis : ra[-1].AsObjectNoAddRef());
        } catch(...) {
            clo.Release();
            throw;
        }
        clo.Release();
        if(TJS_FAILED(hr))
            TJSThrowFrom_tjs_error(hr, nullptr);
    }

    //---------------------------------------------------------------------------
    void tTJSInterCodeContext::DeleteMemberDirect(tTJSVariant *ra,
                                                  const tjs_int32 *code) {
        // ra[code[1]] = delete ra[code[2]][DataArea[ra[code[3]]]];

        tTJSVariantClosure clo = TJS_GET_VM_REG(ra, code[2]).AsObjectClosure();
        tjs_error hr;
        try {
            tTJSVariant *name = TJS_GET_VM_REG_ADDR(DataArea, code[3]);
            hr = clo.DeleteMember(0, name->GetString(), name->GetHint(),
                                  ra[-1].AsObjectNoAddRef());
        } catch(...) {
            clo.Release();
            throw;
        }
        clo.Release();
        if(code[1]) {
            if(TJS_FAILED(hr))
                TJS_GET_VM_REG(ra, code[1]) = false;
            else
                TJS_GET_VM_REG(ra, code[1]) = true;
        }
    }

    //---------------------------------------------------------------------------
    void tTJSInterCodeContext::DeleteMemberIndirect(tTJSVariant *ra,
                                                    const tjs_int32 *code) {
        // ra[code[1]] = delete ra[code[2]][ra[code[3]]];

        tTJSVariantClosure clo = TJS_GET_VM_REG(ra, code[2]).AsObjectClosure();
        tTJSVariantString *str;
        try {
            str = TJS_GET_VM_REG(ra, code[3]).AsString();
        } catch(...) {
            clo.Release();
            throw;
        }
        const tjs_char *member_name = GetSafeStringValue(str);

        try {
            tjs_error hr = clo.DeleteMember(
                0, member_name, nullptr,
                clo.ObjThis ? clo.ObjThis : ra[-1].AsObjectNoAddRef());
            if(code[1]) {
                if(TJS_FAILED(hr))
                    TJS_GET_VM_REG(ra, code[1]) = false;
                else
                    TJS_GET_VM_REG(ra, code[1]) = true;
            }
        } catch(...) {
            if(str)
                str->Release();
            clo.Release();
            throw;
        }
        if(str)
            str->Release();
        clo.Release();
    }

    //---------------------------------------------------------------------------
    void tTJSInterCodeContext::TypeOfMemberDirect(tTJSVariant *ra,
                                                  const tjs_int32 *code,
                                                  tjs_uint32 flags) const {
        // ra[code[1]] = typeof ra[code[2]][DataArea[ra[code[3]]]];
        tTJSVariantType type = TJS_GET_VM_REG(ra, code[2]).Type();
        if(type == tvtString) {
            GetStringProperty(TJS_GET_VM_REG_ADDR(ra, code[1]),
                              TJS_GET_VM_REG_ADDR(ra, code[2]),
                              TJS_GET_VM_REG(DataArea, code[3]));
            TypeOf(TJS_GET_VM_REG(ra, code[1]));
            return;
        }
        if(type == tvtOctet) {
            GetOctetProperty(TJS_GET_VM_REG_ADDR(ra, code[1]),
                             TJS_GET_VM_REG_ADDR(ra, code[2]),
                             TJS_GET_VM_REG(DataArea, code[3]));
            TypeOf(TJS_GET_VM_REG(ra, code[1]));
            return;
        }

        tjs_error hr;
        tTJSVariantClosure clo = TJS_GET_VM_REG(ra, code[2]).AsObjectClosure();
        try {
            tTJSVariant *name = TJS_GET_VM_REG_ADDR(DataArea, code[3]);
            hr = clo.PropGet(flags, name->GetString(), name->GetHint(),
                             TJS_GET_VM_REG_ADDR(ra, code[1]),
                             clo.ObjThis ? clo.ObjThis
                                         : ra[-1].AsObjectNoAddRef());
        } catch(...) {
            clo.Release();
            throw;
        }
        clo.Release();
        if(hr == TJS_S_OK) {
            TypeOf(TJS_GET_VM_REG(ra, code[1]));
        } else if(hr == TJS_E_MEMBERNOTFOUND) {
            static tTJSString undefined_name(
                TJSMapGlobalStringMap(TJS_W("undefined")));
            TJS_GET_VM_REG(ra, code[1]) = undefined_name;
        } else if(TJS_FAILED(hr))
            TJSThrowFrom_tjs_error(
                hr, TJS_GET_VM_REG(DataArea, code[3]).GetString());
    }

    //---------------------------------------------------------------------------
    void tTJSInterCodeContext::TypeOfMemberIndirect(tTJSVariant *ra,
                                                    const tjs_int32 *code,
                                                    tjs_uint32 flags) {
        // ra[code[1]] = typeof ra[code[2]][ra[code[3]]];

        tTJSVariantType type = TJS_GET_VM_REG(ra, code[2]).Type();
        if(type == tvtString) {
            GetStringProperty(TJS_GET_VM_REG_ADDR(ra, code[1]),
                              TJS_GET_VM_REG_ADDR(ra, code[2]),
                              TJS_GET_VM_REG(ra, code[3]));
            TypeOf(ra[code[1]]);
            return;
        }
        if(type == tvtOctet) {
            GetOctetProperty(TJS_GET_VM_REG_ADDR(ra, code[1]),
                             TJS_GET_VM_REG_ADDR(ra, code[2]),
                             TJS_GET_VM_REG(ra, code[3]));
            TypeOf(TJS_GET_VM_REG(ra, code[1]));
            return;
        }

        tjs_error hr;
        tTJSVariantClosure clo = TJS_GET_VM_REG(ra, code[2]).AsObjectClosure();
        if(TJS_GET_VM_REG(ra, code[3]).Type() != tvtInteger) {
            tTJSVariantString *str;
            const tjs_char *member_name = TJS_W("");
            try {
                str = TJS_GET_VM_REG(ra, code[3]).AsString();
                member_name = GetSafeStringValue(str);
            } catch(...) {
                clo.Release();
                throw;
            }

            try {
                // TODO: verify here needs hint holding
                hr = clo.PropGet(
                    flags, member_name, nullptr,
                    TJS_GET_VM_REG_ADDR(ra, code[1]),
                    clo.ObjThis ? clo.ObjThis : ra[-1].AsObjectNoAddRef());
                if(hr == TJS_S_OK) {
                    TypeOf(TJS_GET_VM_REG(ra, code[1]));
                } else // if(hr == TJS_E_MEMBERNOTFOUND)
                {
                    TJS_GET_VM_REG(ra, code[1]) = TJS_W("undefined");
                }
                //			else if(TJS_FAILED(hr))
                // TJSThrowFrom_tjs_error(hr, *str);
            } catch(...) {
                if(str)
                    str->Release();
                clo.Release();
                throw;
            }
            if(str)
                str->Release();
            clo.Release();
        } else {
            try {
                hr = clo.PropGetByNum(
                    flags, (tjs_int)TJS_GET_VM_REG(ra, code[3]).AsInteger(),
                    TJS_GET_VM_REG_ADDR(ra, code[1]),
                    clo.ObjThis ? clo.ObjThis : ra[-1].AsObjectNoAddRef());
                if(hr == TJS_S_OK) {
                    TypeOf(TJS_GET_VM_REG(ra, code[1]));
                } else if(hr == TJS_E_MEMBERNOTFOUND) {
                    TJS_GET_VM_REG(ra, code[1]) = TJS_W("undefined");
                } else if(TJS_FAILED(hr))
                    ThrowFrom_tjs_error_num(
                        hr, (tjs_int)TJS_GET_VM_REG(ra, code[3]).AsInteger());
            } catch(...) {
                clo.Release();
                throw;
            }
            clo.Release();
        }
    }
//---------------------------------------------------------------------------
// Macros for preparing function argument pointer array.
// code[0] is an argument count;
// -1 for omitting ('...') argument to passing unmodified args from
// the caller. -2 for expanding array to argument
#define TJS_PASS_ARGS_PREPARED_ARRAY_COUNT 20

    class tTJSCallArguments {
        static constexpr tjs_int maximumArguments = 1000000;
        krkr::TemporaryMemory memory;
        std::unique_ptr<tTJSVariant[]> expanded;
        std::unique_ptr<tTJSVariant*[]> pointers;
        tTJSVariant* prepared[TJS_PASS_ARGS_PREPARED_ARRAY_COUNT]{};
        tjs_int expandedCount = 0;
        bool cleared = false;
        static void add(tjs_int& count, tjs_int amount) {
            if(amount < 0 || amount > maximumArguments - count)
                throw krkr::ExecutionLimitError(u"VM call exceeds 1000000 arguments");
            count += amount;
        }
    public:
        tjs_int Count = 0, CodeSize = 0;
        tTJSVariant** Values = nullptr;
        tTJSCallArguments(const tjs_int32* code, tTJSVariant* ra,
            tTJSVariant** args, tjs_int numargs, tjs_int unnamedBase) {
            KrkrCompilerScope preparation(10);
            if(code[0] == -1) {
                add(Count, numargs);
                Values = args; CodeSize = 1;
                return;
            }
            const bool expand = code[0] == -2;
            if(expand) {
                const auto written = code[1];
                CodeSize = written * 2 + 2;
                for(tjs_int i = 0; i < written; ++i) {
                    krkr_compiler_work(i);
                    switch(code[i * 2 + 2]) {
                        case fatNormal: add(Count, 1); break;
                        case fatExpand:
                            add(expandedCount, TJSGetArrayElementCount(
                                TJS_GET_VM_REG(ra, code[i * 2 + 3]).AsObjectNoAddRef()));
                            break;
                        case fatUnnamedExpand: add(Count, std::max(0, numargs - unnamedBase)); break;
                        default: ThrowInvalidVMCode();
                    }
                }
                add(Count, expandedCount);
            } else {
                add(Count, code[0]);
                CodeSize = Count + 1;
            }
            memory.reserve(expandedCount, sizeof(tTJSVariant));
            if(Count > TJS_PASS_ARGS_PREPARED_ARRAY_COUNT) memory.reserve(Count, sizeof(tTJSVariant*));
            if(expandedCount) expanded = std::make_unique<tTJSVariant[]>(expandedCount);
            if(Count > TJS_PASS_ARGS_PREPARED_ARRAY_COUNT) pointers = std::make_unique<tTJSVariant*[]>(Count);
            Values = pointers ? pointers.get() : prepared;
            if(!expand) {
                for(tjs_int i = 0; i < Count; ++i) {
                    krkr_compiler_work(i);
                    Values[i] = TJS_GET_VM_REG_ADDR(ra, code[i + 1]);
                }
                return;
            }
            tjs_int out = 0, used = 0;
            for(tjs_int i = 0; i < code[1]; ++i) {
                krkr_compiler_work(i);
                switch(code[i * 2 + 2]) {
                    case fatNormal:
                        if(out == Count) ThrowInvalidVMCode();
                        Values[out++] = TJS_GET_VM_REG_ADDR(ra, code[i * 2 + 3]);
                        break;
                    case fatExpand: {
                        auto* array = TJS_GET_VM_REG(ra, code[i * 2 + 3]).AsObjectNoAddRef();
                        const auto count = TJSGetArrayElementCount(array);
                        if(count > expandedCount - used || count > Count - out) ThrowInvalidVMCode();
                        if(count && TJSCopyArrayElementTo(array, expanded.get() + used, 0, count) != count)
                            ThrowInvalidVMCode();
                        for(tjs_int j = 0; j < count; ++j) {
                            krkr_compiler_work(j);
                            Values[out++] = expanded.get() + used++;
                        }
                        break;
                    }
                    case fatUnnamedExpand:
                        for(tjs_int j = unnamedBase; j < numargs; ++j) {
                            krkr_compiler_work(j);
                            if(out == Count) ThrowInvalidVMCode();
                            Values[out++] = args[j];
                        }
                        break;
                }
            }
            if(out != Count || used != expandedCount) ThrowInvalidVMCode();
        }
        void Clear() {
            if(cleared) return;
            cleared = true;
            std::exception_ptr failure;
            for(tjs_int i = 0; i < expandedCount; ++i) {
                try { expanded[i].Clear(); }
                catch(...) { if(!failure) failure = std::current_exception(); }
            }
            if(failure) std::rethrow_exception(failure);
        }
        ~tTJSCallArguments() { try { Clear(); } catch(...) {} }
    };

#define TJS_BEGIN_FUNC_CALL_ARGS(_code)                                      \
    tTJSCallArguments callArguments((_code), ra, args, numargs, FuncDeclUnnamedArgArrayBase); \
    const auto code_size = callArguments.CodeSize;                            \
    const auto pass_args_count = callArguments.Count;                         \
    auto* pass_args = callArguments.Values;
#define TJS_END_FUNC_CALL_ARGS callArguments.Clear();

    //---------------------------------------------------------------------------
    tjs_int tTJSInterCodeContext::CallFunction(tTJSVariant *ra,
                                               const tjs_int32 *code,
                                               tTJSVariant **args,
                                               tjs_int numargs) {
        // function calling / create new object
        tjs_error hr;

        TJS_BEGIN_FUNC_CALL_ARGS(code + 3)

        tTJSVariantClosure clo = TJS_GET_VM_REG(ra, code[2]).AsObjectClosure();
        try {
            if(code[0] == VM_CALL) {
                hr = clo.FuncCall(
                    0, nullptr, nullptr,
                    code[1] ? TJS_GET_VM_REG_ADDR(ra, code[1]) : nullptr,
                    pass_args_count, pass_args,
                    clo.ObjThis ? clo.ObjThis : ra[-1].AsObjectNoAddRef());
            } else {
                iTJSDispatch2 *dsp;
                hr = clo.CreateNew(
                    0, nullptr, nullptr, &dsp, pass_args_count, pass_args,
                    clo.ObjThis ? clo.ObjThis : ra[-1].AsObjectNoAddRef());
                if(TJS_SUCCEEDED(hr)) {
                    if(dsp) {
                        if(code[1])
                            TJS_GET_VM_REG(ra, code[1]) = tTJSVariant(dsp, dsp);
                        dsp->Release();
                    }
                }
            }
        } catch(...) {
            clo.Release();
            throw;
        }
        clo.Release();
        // TODO: nullptr Check

        TJS_END_FUNC_CALL_ARGS

        if(TJS_FAILED(hr))
            TJSThrowFrom_tjs_error(hr, TJS_W(""));

        return code_size + 3;
    }

#undef _code

    //---------------------------------------------------------------------------
    tjs_int tTJSInterCodeContext::CallFunctionDirect(tTJSVariant *ra,
                                                     const tjs_int32 *code,
                                                     tTJSVariant **args,
                                                     tjs_int numargs) {
        tjs_error hr;

        TJS_BEGIN_FUNC_CALL_ARGS(code + 4)

        tTJSVariantType type = TJS_GET_VM_REG(ra, code[2]).Type();
        tTJSVariant *name = TJS_GET_VM_REG_ADDR(DataArea, code[3]);
        tTJSVariant *callResult =
            code[1] ? TJS_GET_VM_REG_ADDR(ra, code[1]) : nullptr;
        if(type == tvtString) {
            ProcessStringFunction(
                name->GetString(), TJS_GET_VM_REG(ra, code[2]), pass_args,
                pass_args_count, callResult);
            hr = TJS_S_OK;
        } else if(type == tvtOctet) {
            ProcessOctetFunction(name->GetString(),
                                 TJS_GET_VM_REG(ra, code[2]).AsOctetNoAddRef(),
                                 pass_args, pass_args_count, callResult);
            hr = TJS_S_OK;
        } else {
            tTJSVariantClosure clo =
                TJS_GET_VM_REG(ra, code[2]).AsObjectClosure();
            try {
                hr = clo.FuncCall(
                    0, name->GetString(), name->GetHint(), callResult,
                    pass_args_count, pass_args,
                    clo.ObjThis ? clo.ObjThis : ra[-1].AsObjectNoAddRef());
            } catch(...) {
                clo.Release();
                throw;
            }
            clo.Release();
        }
        TJSTraceCallResult("tjs.call.direct", name->GetString(), hr,
                           pass_args, pass_args_count, callResult);

        TJS_END_FUNC_CALL_ARGS

        if(TJS_FAILED(hr))
            TJSThrowFrom_tjs_error(
                hr, ttstr(TJS_GET_VM_REG(DataArea, code[3])).c_str());

        return code_size + 4;
    }

    //---------------------------------------------------------------------------
    tjs_int tTJSInterCodeContext::CallFunctionIndirect(tTJSVariant *ra,
                                                       const tjs_int32 *code,
                                                       tTJSVariant **args,
                                                       tjs_int numargs) {
        tjs_error hr;

        ttstr name = TJS_GET_VM_REG(ra, code[3]);

        TJS_BEGIN_FUNC_CALL_ARGS(code + 4)

        tTJSVariantType type = TJS_GET_VM_REG(ra, code[2]).Type();
        tTJSVariant *callResult =
            code[1] ? TJS_GET_VM_REG_ADDR(ra, code[1]) : nullptr;
        if(type == tvtString) {
            ProcessStringFunction(name.c_str(), TJS_GET_VM_REG(ra, code[2]),
                                  pass_args, pass_args_count, callResult);
            hr = TJS_S_OK;
        } else if(type == tvtOctet) {
            ProcessOctetFunction(
                name.c_str(), TJS_GET_VM_REG(ra, code[2]).AsOctetNoAddRef(),
                pass_args, pass_args_count, callResult);
            hr = TJS_S_OK;
        } else {
            tTJSVariantClosure clo =
                TJS_GET_VM_REG(ra, code[2]).AsObjectClosure();
            try {
                hr = clo.FuncCall(
                    0, name.c_str(), name.GetHint(), callResult,
                    pass_args_count, pass_args,
                    clo.ObjThis ? clo.ObjThis : ra[-1].AsObjectNoAddRef());
            } catch(...) {
                clo.Release();
                throw;
            }
            clo.Release();
        }
        TJSTraceCallResult("tjs.call.indirect", name.c_str(), hr, pass_args,
                           pass_args_count, callResult);

        TJS_END_FUNC_CALL_ARGS

        if(TJS_FAILED(hr))
            TJSThrowFrom_tjs_error(hr, name.c_str());

        return code_size + 4;
    }

    //---------------------------------------------------------------------------
    void tTJSInterCodeContext::AddClassInstanceInfo(tTJSVariant *ra,
                                                    const tjs_int32 *code) {
        iTJSDispatch2 *dsp;
        dsp = TJS_GET_VM_REG(ra, code[1]).AsObjectNoAddRef();
        if(dsp) {
            dsp->ClassInstanceInfo(TJS_CII_ADD, 0,
                                   TJS_GET_VM_REG_ADDR(ra, code[2]));
        } else {
            // ?? must be an error
        }
    }

    //---------------------------------------------------------------------------
    static const tjs_char *StrFuncs[] = {
        TJS_W("charAt"),      TJS_W("indexOf"),   TJS_W("toUpperCase"),
        TJS_W("toLowerCase"), TJS_W("substring"), TJS_W("substr"),
        TJS_W("sprintf"),     TJS_W("replace"),   TJS_W("escape"),
        TJS_W("split"),       TJS_W("trim"),      TJS_W("reverse"),
        TJS_W("repeat")
    };

    enum tTJSStringMethodNameIndex {
        TJSStrMethod_charAt = 0,
        TJSStrMethod_indexOf,
        TJSStrMethod_toUpperCase,
        TJSStrMethod_toLowerCase,
        TJSStrMethod_substring,
        TJSStrMethod_substr,
        TJSStrMethod_sprintf,
        TJSStrMethod_replace,
        TJSStrMethod_escape,
        TJSStrMethod_split,
        TJSStrMethod_trim,
        TJSStrMethod_reverse,
        TJSStrMethod_repeat
    };

#define TJS_STRFUNC_MAX (sizeof(StrFuncs) / sizeof(StrFuncs[0]))
    static tjs_int32 StrFuncHash[TJS_STRFUNC_MAX];
    static bool TJSStrFuncInit = false;

    static void InitTJSStrFunc() {
        TJSStrFuncInit = true;
        for(tjs_int i = 0; i < TJS_STRFUNC_MAX; i++) {
            const tjs_char *p = StrFuncs[i];
            tjs_int32 hash = 0;
            while(*p)
                hash += *p, p++;
            StrFuncHash[i] = hash;
        }
    }

    void tTJSInterCodeContext::ProcessStringFunction(const tjs_char *member,
                                                     const ttstr &target,
                                                     tTJSVariant **args,
                                                     tjs_int numargs,
                                                     tTJSVariant *result) {
        if(!TJSStrFuncInit)
            InitTJSStrFunc();

        tjs_int32 hash;

        if(!member)
            TJSThrowFrom_tjs_error(TJS_E_MEMBERNOTFOUND, TJS_W(""));

        const tjs_char *m = member;
        hash = 0;
        while(*m)
            hash += *m, m++;

        const tjs_char *s = target.c_str(); // target string
        const tjs_int s_len = target.GetLen();

#define TJS_STR_METHOD_IS(_name)                                               \
    (hash == StrFuncHash[TJSStrMethod_##_name] &&                              \
     !TJS_strcmp(StrFuncs[TJSStrMethod_##_name], member))

        if(TJS_STR_METHOD_IS(charAt)) {
            if(numargs != 1)
                TJSThrowFrom_tjs_error(TJS_E_BADPARAMCOUNT);
            if(s_len == 0) {
                if(result)
                    *result = TJS_W("");
                return;
            }
            tjs_int i = (tjs_int)*args[0];
            if(i < 0 || i >= s_len) {
                if(result)
                    *result = TJS_W("");
                return;
            }
            tjs_char bt[2];
            bt[1] = 0;
            bt[0] = s[i];
            if(result)
                *result = bt;
            return;
        } else if(TJS_STR_METHOD_IS(indexOf)) {
            if(numargs != 1 && numargs != 2)
                TJSThrowFrom_tjs_error(TJS_E_BADPARAMCOUNT);
            tTJSVariantString *pstr = args[0]->AsString(); // sub string

            if(!s || !pstr) {
                if(result)
                    *result = (tjs_int)-1;
                if(pstr)
                    pstr->Release();
                return;
            }
            tjs_int start;
            if(numargs == 1) {
                start = 0;
            } else {
                try // integer convertion may raise an exception
                {
                    start = (tjs_int)*args[1];
                } catch(...) {
                    pstr->Release();
                    throw;
                }
            }
            if(start >= s_len) {
                if(result)
                    *result = (tjs_int)-1;
                if(pstr)
                    pstr->Release();
                return;
            }
            const tjs_char *p;
            p = TJS_strstr(s + start, (const tjs_char *)*pstr);
            if(!p) {
                if(result)
                    *result = (tjs_int)-1;
            } else {
                if(result)
                    *result = (tjs_int)(p - s);
            }
            if(pstr)
                pstr->Release();
            return;
        } else if(TJS_STR_METHOD_IS(toUpperCase)) {
            if(numargs != 0)
                TJSThrowFrom_tjs_error(TJS_E_BADPARAMCOUNT);
            if(result) {
                *result = s; // here s is copyed to *result ( not
                             // reference )
                const tjs_char *pstr = result->GetString(); // buffer in *result
                if(pstr) {
                    tjs_char *p =
                        (tjs_char *)pstr; // WARNING!! modification of const
                    while(*p) {
                        if(*p >= TJS_W('a') && *p <= TJS_W('z'))
                            *p += TJS_W('Z') - TJS_W('z');
                        p++;
                    }
                }
            }
            return;
        } else if(TJS_STR_METHOD_IS(toLowerCase)) {
            if(numargs != 0)
                TJSThrowFrom_tjs_error(TJS_E_BADPARAMCOUNT);
            if(result) {
                *result = s;
                const tjs_char *pstr = result->GetString();
                if(pstr) {
                    tjs_char *p =
                        (tjs_char *)pstr; // WARNING!! modification of const
                    while(*p) {
                        if(*p >= TJS_W('A') && *p <= TJS_W('Z'))
                            *p += TJS_W('z') - TJS_W('Z');
                        p++;
                    }
                }
            }
            return;
        } else if(TJS_STR_METHOD_IS(substring) || TJS_STR_METHOD_IS(substr)) {
            if(numargs != 1 && numargs != 2)
                TJSThrowFrom_tjs_error(TJS_E_BADPARAMCOUNT);
            tjs_int start = (tjs_int)*args[0];
            if(start < 0 || start >= s_len) {
                if(result)
                    *result = TJS_W("");
                return;
            }
            tjs_int count;
            if(numargs == 2) {
                count = (tjs_int)*args[1];
                if(count < 0) {
                    if(result)
                        *result = TJS_W("");
                    return;
                }
                if(start + count > s_len)
                    count = s_len - start;
                if(result)
                    *result = ttstr(s + start, count);
                return;
            } else {
                if(result)
                    *result = s + start;
            }
            return;
        } else if(TJS_STR_METHOD_IS(sprintf)) {
            if(result) {
                tTJSVariantString *res;
                res = TJSFormatString(s, numargs, args);
                *result = res;
                if(res)
                    res->Release();
            }
            return;
        } else if(TJS_STR_METHOD_IS(replace)) {
            // string.replace(pattern, replacement-string)  -->
            // pattern.replace(string, replacement-string)
            if(numargs < 2)
                TJSThrowFrom_tjs_error(TJS_E_BADPARAMCOUNT);

            tTJSVariantClosure clo = args[0]->AsObjectClosureNoAddRef();
            tTJSVariant str = target;
            tTJSVariant *params[] = { &str, args[1] };
            static tTJSString replace_name(TJS_W("replace"));
            clo.FuncCall(0, replace_name.c_str(), replace_name.GetHint(),
                         result, 2, params, nullptr);

            return;
        } else if(TJS_STR_METHOD_IS(escape)) {
            if(result)
                *result = target.EscapeC();

            return;
        } else if(TJS_STR_METHOD_IS(split)) {
            // string.split(pattern, reserved, purgeempty) -->
            // Array.split(pattern, string, reserved, purgeempty)
            if(numargs < 1)
                TJSThrowFrom_tjs_error(TJS_E_BADPARAMCOUNT);

            iTJSDispatch2 *array = TJSCreateArrayObject();
            try {
                tTJSVariant str = target;
                tjs_int arg_count = 2;
                tTJSVariant *params[4] = { args[0], &str };
                if(numargs >= 2) {
                    arg_count++;
                    params[2] = args[1];
                }
                if(numargs >= 3) {
                    arg_count++;
                    params[3] = args[2];
                }
                static tTJSString split_name(TJS_W("split"));
                array->FuncCall(0, split_name.c_str(), split_name.GetHint(),
                                nullptr, arg_count, params, array);

                if(result)
                    *result = tTJSVariant(array, array);
            } catch(...) {
                array->Release();
                throw;
            }
            array->Release();

            return;
        } else if(TJS_STR_METHOD_IS(trim)) {
            if(numargs != 0)
                TJSThrowFrom_tjs_error(TJS_E_BADPARAMCOUNT);
            if(!result)
                return;

            tjs_int w_len = s_len;
            const tjs_char *src = s + s_len - 1;
            /*  s/\s+$//;  */
            while(w_len > 0 && *src > 0x00 && *src <= 0x20) {
                w_len--;
                src--;
            }
            src = s;
            /*  s/^\s+//;  */
            while(w_len > 0 && *src > 0x00 && *src <= 0x20) {
                w_len--;
                src++;
            }

            *result = tTJSString(src, w_len);
            return;
        } else if(TJS_STR_METHOD_IS(reverse)) {
            if(numargs != 0)
                TJSThrowFrom_tjs_error(TJS_E_BADPARAMCOUNT);
            if(!result)
                return;
            if(result) {
                *result = s;
                const tjs_char *pstr = result->GetString();
                if(pstr) {
                    tjs_int w_len = s_len;
                    tjs_char *dest =
                        (tjs_char *)pstr; // WARNING!! modification of const
                    const tjs_char *src = s + s_len - 1;

                    while(w_len--) {
                        *dest++ = *src--;
                    }
                }
            }
            return;
        } else if(TJS_STR_METHOD_IS(repeat)) {
            if(numargs != 1)
                TJSThrowFrom_tjs_error(TJS_E_BADPARAMCOUNT);
            if(!result)
                return;
            tjs_int count = (tjs_int)*args[0];

            if(count <= 0 || s_len <= 0) {
                *result = TJS_W("");
                return;
            }

            const int destLength = s_len * count;
            tTJSString new_str = tTJSString(tTJSStringBufferLength(destLength));
            tjs_char *dest = new_str.Independ();
            while(count--) {
                TJS_strcpy(dest, s);
                dest += s_len;
            }
            *result = new_str;

            return;
        }

#undef TJS_STR_METHOD_IS

        TJSThrowFrom_tjs_error(TJS_E_MEMBERNOTFOUND, member);
    }

    //---------------------------------------------------------------------------
    void tTJSInterCodeContext::ProcessOctetFunction(
        const tjs_char *member, const tTJSVariantOctet *target,
        tTJSVariant **args, tjs_int numargs, tTJSVariant *result) {
        if(!member)
            TJSThrowFrom_tjs_error(TJS_E_MEMBERNOTFOUND, TJS_W(""));
        switch(member[0]) {
            case L'u':
                if(!TJS_strcmp(TJS_W("unpack"), member)) {
                    tjs_error err =
                        TJSOctetUnpack(target, args, numargs, result);
                    if(err != TJS_S_OK) {
                        TJSThrowFrom_tjs_error(err);
                    }
                    return;
                }
                break;
        }

        TJSThrowFrom_tjs_error(TJS_E_MEMBERNOTFOUND, member);
    }

    //---------------------------------------------------------------------------
    void tTJSInterCodeContext::TypeOf(tTJSVariant &val) {
        // processes TJS2's typeof operator.
        static tTJSString void_name(TJSMapGlobalStringMap(TJS_W("void")));
        static tTJSString Object_name(TJSMapGlobalStringMap(TJS_W("Object")));
        static tTJSString String_name(TJSMapGlobalStringMap(TJS_W("String")));
        static tTJSString Integer_name(TJSMapGlobalStringMap(TJS_W("Integer")));
        static tTJSString Real_name(TJSMapGlobalStringMap(TJS_W("Real")));
        static tTJSString Octet_name(TJSMapGlobalStringMap(TJS_W("Octet")));

        switch(val.Type()) {
            case tvtVoid:
                val = void_name; // differs from TJS1
                break;

            case tvtObject:
                val = Object_name;
                break;

            case tvtString:
                val = String_name;
                break;

            case tvtInteger:
                val = Integer_name; // differs from TJS1
                break;

            case tvtReal:
                val = Real_name; // differs from TJS1
                break;

            case tvtOctet:
                val = Octet_name;
                break;
        }
    }

    //---------------------------------------------------------------------------
    void tTJSInterCodeContext::Eval(tTJSVariant &val, iTJSDispatch2 *objthis,
                                    bool resneed) {
        if(objthis)
            objthis->AddRef();
        try {
            tTJSVariant res;
            ttstr str(val);
            if(!str.IsEmpty()) {
                if(resneed)
                    Block->GetTJS()->EvalExpression(str, &res, objthis);
                else
                    Block->GetTJS()->EvalExpression(str, nullptr, objthis);
            }
            if(resneed)
                val = res;
        } catch(...) {
            if(objthis)
                objthis->Release();
            throw;
        }
        if(objthis)
            objthis->Release();
    }

    //---------------------------------------------------------------------------
    void tTJSInterCodeContext::CharacterCodeOf(tTJSVariant &val) {
        // puts val's character code on val
        tTJSVariantString *str = val.AsString();
        if(str) {
            const tjs_char *ch = GetSafeStringValue(str);
            val = tTVInteger(ch[0]);
            str->Release();
            return;
        }
        val = tTVInteger(0);
    }

    //---------------------------------------------------------------------------
    void tTJSInterCodeContext::CharacterCodeFrom(tTJSVariant &val) {
        tjs_char ch[2];
        ch[0] = static_cast<tjs_char>(val.AsInteger());
        ch[1] = 0;
        val = ch;
    }

    //---------------------------------------------------------------------------
    void tTJSInterCodeContext::InstanceOf(const tTJSVariant &name,
                                          tTJSVariant &targ) {
        // checks instance inheritance.
        tTJSVariantString *str = name.AsString();
        if(str) {
            const tjs_char *class_name = GetSafeStringValue(str);
            tjs_error hr;
            try {
                hr = TJSDefaultIsInstanceOf(0, targ, class_name,
                                            nullptr);
            } catch(...) {
                str->Release();
                throw;
            }
            str->Release();
            if(TJS_FAILED(hr))
                TJSThrowFrom_tjs_error(hr);

            targ = (hr == TJS_S_TRUE);
            return;
        }
        targ = false;
    }

    //---------------------------------------------------------------------------
    void tTJSInterCodeContext::RegisterObjectMember(iTJSDispatch2 *dest) {
        // register this object member to 'dest' (destination object).
        // called when new object is to be created.
        // a class to receive member callback from class

        class tCallback : public tTJSDispatch {
        public:
            iTJSDispatch2 *Dest; // destination object
            tjs_error FuncCall(tjs_uint32 flag, const tjs_char *membername,
                               tjs_uint32 *hint, tTJSVariant *result,
                               tjs_int numparams, tTJSVariant **param,
                               iTJSDispatch2 *objthis) override {
                // *param[0] = name   *param[1] = flags   *param[2] =
                // value
                tjs_uint32 flags = (tjs_int)*param[1];
                if(!(flags & TJS_STATICMEMBER)) {
                    tTJSVariant val = *param[2];
                    if(val.Type() == tvtObject) {
                        // change object's objthis if the object's
                        // objthis is nullptr
                        //					if(val.AsObjectThisNoAddRef()
                        //== nullptr)
                        val.ChangeClosureObjThis(Dest);
                    }

                    if(Dest->PropSetByVS(TJS_MEMBERENSURE | TJS_IGNOREPROP |
                                             flags,
                                         param[0]->AsStringNoAddRef(), &val,
                                         Dest) == TJS_E_NOTIMPL)
                        Dest->PropSet(TJS_MEMBERENSURE | TJS_IGNOREPROP | flags,
                                      param[0]->GetString(), nullptr, &val,
                                      Dest);
                }
                if(result)
                    *result = (tjs_int)(1); // returns true
                return TJS_S_OK;
            }
        };

        tCallback callback;
        callback.Dest = dest;

        // enumerate members
        tTJSVariantClosure clo(&callback, (iTJSDispatch2 *)nullptr);
        EnumMembers(TJS_IGNOREPROP, &clo, this);
    }
//---------------------------------------------------------------------------
#define TJS_DO_SUPERCLASS_PROXY_BEGIN                                          \
    std::vector<tjs_int> &pointer = SuperClassGetter->SuperClassGetterPointer; \
    if(pointer.size() != 0) {                                                  \
        krkr::ExecutionFrame delegation(2);                                    \
        std::vector<tjs_int>::reverse_iterator i;                              \
        for(i = pointer.rbegin(); i != pointer.rend(); i++) {                  \
            tTJSVariant res;                                                   \
            SuperClassGetter->ExecuteAsFunction(nullptr, nullptr, 0, &res,     \
                                                *i);                           \
            tTJSVariantClosure clo = res.AsObjectClosureNoAddRef();

#define TJS_DO_SUPERCLASS_PROXY_END                                            \
    if(hr != TJS_E_MEMBERNOTFOUND)                                             \
        break;                                                                 \
    }                                                                          \
    }

    tjs_error
    tTJSInterCodeContext::FuncCall(tjs_uint32 flag, const tjs_char *membername,
                                   tjs_uint32 *hint, tTJSVariant *result,
                                   tjs_int numparams, tTJSVariant **param,
                                   iTJSDispatch2 *objthis) {
        if(!GetValidity())
            return TJS_E_INVALIDOBJECT;

        if(membername == nullptr) {
            switch(ContextType) {
                case ctTopLevel:
                    ExecuteAsFunction(
                        objthis ? objthis
                                : Block->GetTJS()->GetGlobalNoAddRef(),
                        nullptr, 0, result, 0);
                    break;

                case ctFunction:
                case ctExprFunction:
                case ctPropertyGetter:
                case ctPropertySetter:
                    ExecuteAsFunction(objthis, param, numparams, result, 0);
                    break;

                case ctClass: // on super class' initialization
                    ExecuteAsFunction(objthis, param, numparams, result, 0);
                    break;

                case ctProperty:
                    return TJS_E_INVALIDTYPE;

                case ctSuperClassGetter:
                    break;
            }

            return TJS_S_OK;
        }

        tjs_error hr = inherited::FuncCall(flag, membername, hint, result,
                                           numparams, param, objthis);

        if(membername != nullptr && hr == TJS_E_MEMBERNOTFOUND &&
           ContextType == ctClass && SuperClassGetter) {
            // look up super class
            TJS_DO_SUPERCLASS_PROXY_BEGIN
            hr = clo.FuncCall(flag, membername, hint, result, numparams, param,
                              objthis);
            TJS_DO_SUPERCLASS_PROXY_END
        }
        return hr;
    }

    //---------------------------------------------------------------------------
    tjs_error tTJSInterCodeContext::PropGet(tjs_uint32 flag,
                                            const tjs_char *membername,
                                            tjs_uint32 *hint,
                                            tTJSVariant *result,
                                            iTJSDispatch2 *objthis) {
        if(!GetValidity())
            return TJS_E_INVALIDOBJECT;

        if(membername == nullptr) {
            if(ContextType == ctProperty) {
                // executed as a property getter
                if(PropGetter)
                    return PropGetter->FuncCall(0, nullptr, nullptr, result, 0,
                                                nullptr, objthis);
                else
                    return TJS_E_ACCESSDENYED;
            }
        }

        tjs_error hr =
            inherited::PropGet(flag, membername, hint, result, objthis);

        if(membername != nullptr && hr == TJS_E_MEMBERNOTFOUND &&
           ContextType == ctClass && SuperClassGetter) {
            // look up super class
            TJS_DO_SUPERCLASS_PROXY_BEGIN
            hr = clo.PropGet(flag, membername, hint, result, objthis);
            TJS_DO_SUPERCLASS_PROXY_END
        }
        return hr;
    }

    //---------------------------------------------------------------------------
    tjs_error tTJSInterCodeContext::PropSet(tjs_uint32 flag,
                                            const tjs_char *membername,
                                            tjs_uint32 *hint,
                                            const tTJSVariant *param,
                                            iTJSDispatch2 *objthis) {
        if(!GetValidity())
            return TJS_E_INVALIDOBJECT;

        if(membername == nullptr) {
            if(ContextType == ctProperty) {
                // executed as a property setter
                if(PropSetter)
                    return PropSetter->FuncCall(
                        0, nullptr, nullptr, nullptr, 1,
                        const_cast<tTJSVariant **>(&param), objthis);
                else
                    return TJS_E_ACCESSDENYED;

                // WARNING!! const tTJSVariant ** -> tTJSVariant**
                // force casting
            }
        }

        tjs_error hr;
        if(membername != nullptr && ContextType == ctClass &&
           SuperClassGetter) {
            tjs_uint32 pseudo_flag =
                (flag & TJS_IGNOREPROP) ? flag : (flag & ~TJS_MEMBERENSURE);
            // member ensuring is temporarily disabled unless
            // TJS_IGNOREPROP

            hr = inherited::PropSet(pseudo_flag, membername, hint, param,
                                    objthis);
            if(hr == TJS_E_MEMBERNOTFOUND) {
                TJS_DO_SUPERCLASS_PROXY_BEGIN
                hr = clo.PropSet(pseudo_flag, membername, hint, param, objthis);
                TJS_DO_SUPERCLASS_PROXY_END
            }

            if(hr == TJS_E_MEMBERNOTFOUND && (flag & TJS_MEMBERENSURE)) {
                // re-ensure the member for "this" object
                hr = inherited::PropSet(flag, membername, hint, param, objthis);
            }
        } else {
            hr = inherited::PropSet(flag, membername, hint, param, objthis);
        }

        return hr;
    }

    //---------------------------------------------------------------------------
    tjs_error
    tTJSInterCodeContext::CreateNew(tjs_uint32 flag, const tjs_char *membername,
                                    tjs_uint32 *hint, iTJSDispatch2 **result,
                                    tjs_int numparams, tTJSVariant **param,
                                    iTJSDispatch2 *objthis) {
        if(!GetValidity())
            return TJS_E_INVALIDOBJECT;

        if(membername == nullptr) {
            if(ContextType != ctClass)
                return TJS_E_INVALIDTYPE;

            iTJSDispatch2 *dsp = new inherited();

            try {
                ExecuteAsFunction(dsp, nullptr, 0, nullptr, 0);
                FuncCall(0, Name, nullptr, nullptr, numparams, param, dsp);
            } catch(...) {
                krkr::CleanupErrors secondary;
                secondary.suppress();
                try { dsp->Release(); } catch(...) {}
                throw;
            }

            *result = dsp;
            return TJS_S_OK;
        }

        tjs_error hr = inherited::CreateNew(flag, membername, hint, result,
                                            numparams, param, objthis);

        if(membername != nullptr && hr == TJS_E_MEMBERNOTFOUND &&
           ContextType == ctClass && SuperClassGetter) {
            // look up super class
            TJS_DO_SUPERCLASS_PROXY_BEGIN
            hr = clo.CreateNew(flag, membername, hint, result, numparams, param,
                               objthis);
            TJS_DO_SUPERCLASS_PROXY_END
        }
        return hr;
    }

    //---------------------------------------------------------------------------
    tjs_error tTJSInterCodeContext::IsInstanceOf(tjs_uint32 flag,
                                                 const tjs_char *membername,
                                                 tjs_uint32 *hint,
                                                 const tjs_char *classname,
                                                 iTJSDispatch2 *objthis) {
        if(!GetValidity())
            return TJS_E_INVALIDOBJECT;

        if(membername == nullptr) {
            switch(ContextType) {
                case ctTopLevel:
                case ctPropertySetter:
                case ctPropertyGetter:
                case ctSuperClassGetter:
                    break;

                case ctFunction:
                case ctExprFunction:
                    if(!TJS_strcmp(classname, TJS_W("Function")))
                        return TJS_S_TRUE;
                    break;

                case ctProperty:
                    if(!TJS_strcmp(classname, TJS_W("Property")))
                        return TJS_S_TRUE;
                    break;

                case ctClass:
                    if(!TJS_strcmp(classname, TJS_W("Class")))
                        return TJS_S_TRUE;
                    break;
            }
        }

        tjs_error hr =
            inherited::IsInstanceOf(flag, membername, hint, classname, objthis);

        if(membername != nullptr && hr == TJS_E_MEMBERNOTFOUND &&
           ContextType == ctClass && SuperClassGetter) {
            // look up super class
            TJS_DO_SUPERCLASS_PROXY_BEGIN
            hr = clo.IsInstanceOf(flag, membername, hint, classname, objthis);
            TJS_DO_SUPERCLASS_PROXY_END
        }
        return hr;
    }

    //---------------------------------------------------------------------------
    tjs_error tTJSInterCodeContext::GetCount(tjs_int *result,
                                             const tjs_char *membername,
                                             tjs_uint32 *hint,
                                             iTJSDispatch2 *objthis) {
        tjs_error hr = inherited::GetCount(result, membername, hint, objthis);

        if(membername != nullptr && hr == TJS_E_MEMBERNOTFOUND &&
           ContextType == ctClass && SuperClassGetter) {
            // look up super class
            TJS_DO_SUPERCLASS_PROXY_BEGIN
            hr = clo.GetCount(result, membername, hint, objthis);
            TJS_DO_SUPERCLASS_PROXY_END
        }
        return hr;
    }

    //---------------------------------------------------------------------------
    tjs_error tTJSInterCodeContext::DeleteMember(tjs_uint32 flag,
                                                 const tjs_char *membername,
                                                 tjs_uint32 *hint,
                                                 iTJSDispatch2 *objthis) {
        tjs_error hr = inherited::DeleteMember(flag, membername, hint, objthis);

        if(membername != nullptr && hr == TJS_E_MEMBERNOTFOUND &&
           ContextType == ctClass && SuperClassGetter) {
            // look up super class
            TJS_DO_SUPERCLASS_PROXY_BEGIN
            hr = clo.DeleteMember(flag, membername, hint, objthis);
            TJS_DO_SUPERCLASS_PROXY_END
        }
        return hr;
    }

    //---------------------------------------------------------------------------
    tjs_error tTJSInterCodeContext::Invalidate(tjs_uint32 flag,
                                               const tjs_char *membername,
                                               tjs_uint32 *hint,
                                               iTJSDispatch2 *objthis) {
        tjs_error hr = inherited::Invalidate(flag, membername, hint, objthis);

        if(membername != nullptr && hr == TJS_E_MEMBERNOTFOUND &&
           ContextType == ctClass && SuperClassGetter) {
            // look up super class
            TJS_DO_SUPERCLASS_PROXY_BEGIN
            hr = clo.Invalidate(flag, membername, hint, objthis);
            TJS_DO_SUPERCLASS_PROXY_END
        }
        return hr;
    }

    //---------------------------------------------------------------------------
    tjs_error tTJSInterCodeContext::IsValid(tjs_uint32 flag,
                                            const tjs_char *membername,
                                            tjs_uint32 *hint,
                                            iTJSDispatch2 *objthis) {
        tjs_error hr = inherited::IsValid(flag, membername, hint, objthis);

        if(membername != nullptr && hr == TJS_E_MEMBERNOTFOUND &&
           ContextType == ctClass && SuperClassGetter) {
            // look up super class
            TJS_DO_SUPERCLASS_PROXY_BEGIN
            hr = clo.IsValid(flag, membername, hint, objthis);
            TJS_DO_SUPERCLASS_PROXY_END
        }
        return hr;
    }

    //---------------------------------------------------------------------------
    tjs_error tTJSInterCodeContext::Operation(
        tjs_uint32 flag, const tjs_char *membername, tjs_uint32 *hint,
        tTJSVariant *result, const tTJSVariant *param, iTJSDispatch2 *objthis) {
        if(membername == nullptr) {
            if(ContextType == ctProperty) {
                // operation for property object
                return tTJSDispatch::Operation(flag, membername, hint, result,
                                               param, objthis);
            } else {
                return inherited::Operation(flag, membername, hint, result,
                                            param, objthis);
            }
        }

        // tjs_error hr;

        if(membername != nullptr && ContextType == ctClass &&
           SuperClassGetter) {
            tjs_uint32 pseudo_flag =
                (flag & TJS_IGNOREPROP) ? flag : (flag & ~TJS_MEMBERENSURE);

            tjs_error hr = inherited::Operation(pseudo_flag, membername, hint,
                                                result, param, objthis);

            if(hr == TJS_E_MEMBERNOTFOUND) {
                // look up super class
                TJS_DO_SUPERCLASS_PROXY_BEGIN
                hr = clo.Operation(pseudo_flag, membername, hint, result, param,
                                   objthis);
                TJS_DO_SUPERCLASS_PROXY_END
            }

            if(hr == TJS_E_MEMBERNOTFOUND)
                hr = inherited::Operation(flag, membername, hint, result, param,
                                          objthis);

            return hr;
        } else {
            return inherited::Operation(flag, membername, hint, result, param,
                                        objthis);
        }
    }
    //---------------------------------------------------------------------------

} // namespace TJS
