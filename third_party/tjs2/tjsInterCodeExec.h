//---------------------------------------------------------------------------
/*
        TJS2 Script Engine
        Copyright (C) 2000 W.Dee <dee@kikyou.info> and contributors

        See details of license at "license.txt"
*/
//---------------------------------------------------------------------------
// Intermediate Code Execution
//---------------------------------------------------------------------------
#pragma once
#include <cstdint>
#include <mutex>

namespace TJS {

    extern void TJSVariantArrayStackCompact();

    extern void TJSVariantArrayStackCompactNow();

    struct tTJSVariantArrayStackStats {
        tjs_uint AllocatedBlocks = 0;
        tjs_uint UsingBlocks = 0;
        tjs_uint AllocatedSlots = 0;
        tjs_uint UsingSlots = 0;
    };

    class tTJSVariantArrayStack {

        struct tVariantArray {
            tTJSVariant *Array;
            tjs_int Using;
            tjs_int Allocated;
        };

        tVariantArray *Arrays; // array of array
        tjs_int NumArraysAllocated;
        tjs_int NumArraysUsing;
        tVariantArray *Current;
        std::uint64_t CompactVariantArrayMagic;
        tjs_int OperationDisabledCount;
        mutable std::mutex MetadataMutex;

        void IncreaseVariantArray(tjs_int num);

        void DecreaseVariantArray();

        void InternalCompact();

    public:
        tTJSVariantArrayStack();

        ~tTJSVariantArrayStack();

        tTJSVariant *Allocate(tjs_int num);

        void Deallocate(tjs_int num, tTJSVariant *ptr);

        void Compact();

        tTJSVariantArrayStackStats Inspect() const;
    };
    //---------------------------------------------------------------------------
} // namespace TJS
