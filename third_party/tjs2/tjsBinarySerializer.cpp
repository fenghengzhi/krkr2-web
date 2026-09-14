//---------------------------------------------------------------------------
/*
        TJS2 Script Engine( Byte Code )
        Copyright (c), Takenori Imoto

        See details of license at "license.txt"
*/
//---------------------------------------------------------------------------
#include "tjsCommHead.h"

#include "tjs.h"
#include "tjsBinarySerializer.h"
#include "tjsDictionary.h"
#include "tjsArray.h"
#include "BinaryInput.h"
#include "WebHost.h"
#include <memory>

namespace TJS {

    namespace {
        void ValidateValue(krkr::BinaryInput& input, unsigned depth,
                           unsigned& nodes, bool key = false) {
            if(depth > 256 || ++nodes > 1000000) input.fail();
            krkr_compiler_work(nodes);
            const auto type = input.u8();
            unsigned count = 0;
            if(type >= 0xa0 && type <= 0xbf) count = type - 0xa0;
            else if(type == 0xc4) count = input.u8();
            else if(type == 0xc5) count = input.u16();
            else if(type == 0xc6) count = input.u32();
            else {
                if(key) input.fail();
                if(type <= 0x7f || type >= 0xe0 || (type >= 0xc0 && type <= 0xc3)) return;
                if(type >= 0xd4 && type <= 0xd9) { input.take(type - 0xd4); return; }
                switch(type) {
                    case 0xca: case 0xce: case 0xd2: input.take(4); return;
                    case 0xcb: case 0xcf: case 0xd3: input.take(8); return;
                    case 0xcc: case 0xd0: input.take(1); return;
                    case 0xcd: case 0xd1: input.take(2); return;
                    case 0xda: count = input.u16(); input.take(count); return;
                    case 0xdb: count = input.u32(); input.take(count); return;
                }
                bool dictionary = false;
                if(type >= 0x80 && type <= 0x8f) { dictionary = true; count = type - 0x80; }
                else if(type >= 0x90 && type <= 0x9f) count = type - 0x90;
                else if(type == 0xdc) count = input.u16();
                else if(type == 0xdd) count = input.u32();
                else if(type == 0xde) { dictionary = true; count = input.u16(); }
                else if(type == 0xdf) { dictionary = true; count = input.u32(); }
                else input.fail();
                if(count > input.remaining() / (dictionary ? 2 : 1) || count > 1000000) input.fail();
                for(unsigned i = 0; i < count; ++i) {
                    if(dictionary) ValidateValue(input, depth + 1, nodes, true);
                    ValidateValue(input, depth + 1, nodes);
                }
                return;
            }
            input.items(count, 2);
        }
        struct ReleaseObject {
            void operator()(iTJSDispatch2* object) const { if(object) object->Release(); }
        };
        struct ReleaseString {
            void operator()(tTJSVariantString* value) const { if(value) value->Release(); }
        };
    }

    const tjs_uint8
        tTJSBinarySerializer::HEADER[tTJSBinarySerializer::HEADER_LENGTH] = {
            'K', 'B', 'A', 'D', '1', '0', '0', 0
        };

    bool tTJSBinarySerializer::IsBinary(
        const tjs_uint8 header[tTJSBinarySerializer::HEADER_LENGTH]) {
        return memcmp(HEADER, header, tTJSBinarySerializer::HEADER_LENGTH) == 0;
    }

    /**
     * バイアント値を格納する
     */
    void tTJSBinarySerializer::PutVariant(tTJSBinaryStream *stream,
                                          tTJSVariant &v) {
        tTJSVariantType type = v.Type();
        switch(type) {
            case tvtVoid: {
                tjs_uint8 tmp[1];
                tmp[0] = TYPE_VOID;
                stream->Write(tmp, sizeof(tmp));
                break;
            }
            case tvtObject:
                break;
                /*
                                {
                                iTJSDispatch2* obj =
                   v.AsObjectNoAddRef(); iTJSDispatch2* objthis =
                   v.AsObjectThisNoAddRef(); if( obj == nullptr &&
                   objthis == nullptr ) { Put( TYPE_NIL ); } else {
                                        SaveStructured
                                }
                                break;
                        }
                */
            case tvtString:
                PutString(stream, v.AsStringNoAddRef());
                break;
            case tvtOctet:
                PutOctet(stream, v.AsOctetNoAddRef());
                break;
            case tvtInteger:
                PutInteger(stream, v.AsInteger());
                break;
            case tvtReal:
                PutDouble(stream, v.AsReal());
                break;
            default:
                break;
        }
    }

    tTJSBinarySerializer::tTJSBinarySerializer() :
        DicClass(nullptr), RootDictionary(nullptr), RootArray(nullptr) {}

    tTJSBinarySerializer::tTJSBinarySerializer(
        class tTJSDictionaryObject *root) :
        DicClass(nullptr), RootDictionary(root), RootArray(nullptr) {}

    tTJSBinarySerializer::tTJSBinarySerializer(class tTJSArrayObject *root) :
        DicClass(nullptr), RootDictionary(nullptr), RootArray(root) {}

    tTJSBinarySerializer::~tTJSBinarySerializer() {
        if(DicClass)
            DicClass->Release();
        DicClass = nullptr;
    }

    tTJSDictionaryObject *
    tTJSBinarySerializer::CreateDictionary(tjs_uint count) {
        if(RootDictionary) {
            tTJSDictionaryObject *ret = RootDictionary;
            RootDictionary = nullptr;
            ret->RebuildHash((tjs_int)count);
            ret->AddRef();
            return ret;
        }
        if(RootArray) {
            TJSThrowFrom_tjs_error(TJS_E_INVALIDPARAM); // 型が違う
        }
        if(DicClass == nullptr) {
            iTJSDispatch2 *dsp = TJSCreateDictionaryObject(&DicClass);
            dsp->Release();
        }
        tTJSDictionaryObject *dic;
        tTJSVariant param[1] = { (tjs_int)count };
        tTJSVariant *pparam[1] = { param };
        DicClass->CreateNew(0, nullptr, nullptr, (iTJSDispatch2 **)&dic, 1,
                            pparam, DicClass);
        return dic;
    }

    tTJSArrayObject *tTJSBinarySerializer::CreateArray(tjs_uint count) {
        if(RootArray) {
            tTJSArrayObject *ret = RootArray;
            RootArray = nullptr;
            ret->AddRef();
            return ret;
        }
        if(RootDictionary) {
            TJSThrowFrom_tjs_error(TJS_E_INVALIDPARAM); // 型が違う
        }
        auto *array = (tTJSArrayObject *)TJSCreateArrayObject();
        return array;
    }

    void tTJSBinarySerializer::AddDictionary(tTJSDictionaryObject *dic,
                                             tTJSVariantString *name,
                                             tTJSVariant *value) {
        if(value == nullptr)
            TJS_eTJSError(TJSReadError);
        // TJS represents the empty string with a null string object.
        if(name) dic->PropSetByVS(TJS_MEMBERENSURE, name, value, dic);
        else dic->PropSet(TJS_MEMBERENSURE, TJS_W(""), nullptr, value, dic);
    }

    void tTJSBinarySerializer::InsertArray(tTJSArrayObject *array,
                                           tjs_uint index, tTJSVariant *value) {
        if(value == nullptr)
            TJS_eTJSError(TJSReadError);
        tTJSArrayNI *ni = nullptr;
        tjs_error hr = array->NativeInstanceSupport(TJS_NIS_GETINSTANCE,
                                                    TJSGetArrayClassID(),
                                                    (iTJSNativeInstance **)&ni);
        if(TJS_SUCCEEDED(hr)) {
            // array->Insert( ni, *value, index );
            array->Add(ni, *value);
        }
    }

    tTJSVariant *tTJSBinarySerializer::ReadBasicType(const tjs_uint8 *buff,
                                                     const tjs_uint size,
                                                     tjs_uint &index) {
        krkr_compiler_work(index);
        if(index >= size) TJS_eTJSError(TJSReadError);
        tjs_uint8 type = buff[index];
        index++;
        switch(type) {
            case TYPE_NIL:
                return new tTJSVariant((iTJSDispatch2 *)nullptr);
            case TYPE_VOID:
                return new tTJSVariant();
            case TYPE_TRUE:
                return new tTJSVariant((tjs_int)1);
            case TYPE_FALSE:
                return new tTJSVariant((tjs_int)0);
            case TYPE_STRING8: {
                if((index + sizeof(tjs_uint8)) > size)
                    TJS_eTJSError(TJSReadError);
                tjs_uint8 len = buff[index];
                index++;
                if((index + (len * sizeof(tjs_char))) > size)
                    TJS_eTJSError(TJSReadError);
                return ReadStringVarint(buff, len, index);
            }
            case TYPE_STRING16: {
                if((index + sizeof(tjs_uint16)) > size)
                    TJS_eTJSError(TJSReadError);
                tjs_uint16 len = Read16(buff, index);
                if((index + (len * sizeof(tjs_char))) > size)
                    TJS_eTJSError(TJSReadError);
                return ReadStringVarint(buff, len, index);
            }
            case TYPE_STRING32: {
                if((index + sizeof(tjs_uint32)) > size)
                    TJS_eTJSError(TJSReadError);
                tjs_uint32 len = Read32(buff, index);
                if((index + (len * sizeof(tjs_char))) > size)
                    TJS_eTJSError(TJSReadError);
                return ReadStringVarint(buff, len, index);
            }
            case TYPE_FLOAT: {
                if((index + sizeof(float)) > size)
                    TJS_eTJSError(TJSReadError);
                tjs_uint32 t = Read32(buff, index);
                return new tTJSVariant(*(float *)&t);
            }
            case TYPE_DOUBLE: {
                if((index + sizeof(double)) > size)
                    TJS_eTJSError(TJSReadError);
                tjs_uint64 t = Read64(buff, index);
                return new tTJSVariant(*(double *)&t);
            }
            case TYPE_UINT8: {
                if((index + sizeof(tjs_uint8)) > size)
                    TJS_eTJSError(TJSReadError);
                tjs_uint8 t = buff[index];
                index++;
                return new tTJSVariant(t);
            }
            case TYPE_UINT16: {
                if((index + sizeof(tjs_uint16)) > size)
                    TJS_eTJSError(TJSReadError);
                tjs_uint16 t = Read16(buff, index);
                return new tTJSVariant(t);
            }
            case TYPE_UINT32: {
                if((index + sizeof(tjs_uint32)) > size)
                    TJS_eTJSError(TJSReadError);
                tjs_uint32 t = Read32(buff, index);
                return new tTJSVariant((tjs_int64)t);
            }
            case TYPE_UINT64: {
                if((index + sizeof(tjs_uint64)) > size)
                    TJS_eTJSError(TJSReadError);
                tjs_uint64 t = Read64(buff, index);
                return new tTJSVariant((tjs_int64)t);
            }
            case TYPE_INT8: {
                if((index + sizeof(tjs_uint8)) > size)
                    TJS_eTJSError(TJSReadError);
                tjs_uint8 t = buff[index];
                index++;
                return new tTJSVariant((tjs_int8)t);
            }
            case TYPE_INT16: {
                if((index + sizeof(tjs_uint16)) > size)
                    TJS_eTJSError(TJSReadError);
                tjs_uint16 t = Read16(buff, index);
                return new tTJSVariant((tjs_int16)t);
            }
            case TYPE_INT32: {
                if((index + sizeof(tjs_uint32)) > size)
                    TJS_eTJSError(TJSReadError);
                tjs_uint32 t = Read32(buff, index);
                return new tTJSVariant((tjs_int32)t);
            }
            case TYPE_INT64: {
                if((index + sizeof(tjs_uint64)) > size)
                    TJS_eTJSError(TJSReadError);
                tjs_uint64 t = Read64(buff, index);
                return new tTJSVariant((tjs_int64)t);
            }
            case TYPE_RAW16: {
                if((index + sizeof(tjs_uint16)) > size)
                    TJS_eTJSError(TJSReadError);
                tjs_uint16 len = Read16(buff, index);
                if((index + len) > size)
                    TJS_eTJSError(TJSReadError);
                return ReadOctetVarint(buff, len, index);
            }
            case TYPE_RAW32: {
                if((index + sizeof(tjs_uint32)) > size)
                    TJS_eTJSError(TJSReadError);
                tjs_uint32 len = Read32(buff, index);
                if((index + len) > size)
                    TJS_eTJSError(TJSReadError);
                return ReadOctetVarint(buff, len, index);
            }
            case TYPE_ARRAY16: {
                if((index + sizeof(tjs_uint16)) > size)
                    TJS_eTJSError(TJSReadError);
                tjs_uint16 count = Read16(buff, index);
                return ReadArray(buff, size, count, index);
            }
            case TYPE_ARRAY32: {
                if((index + sizeof(tjs_uint32)) > size)
                    TJS_eTJSError(TJSReadError);
                tjs_uint32 count = Read32(buff, index);
                return ReadArray(buff, size, count, index);
            }
            case TYPE_MAP16: {
                if((index + sizeof(tjs_uint16)) > size)
                    TJS_eTJSError(TJSReadError);
                tjs_uint16 count = Read16(buff, index);
                return ReadDictionary(buff, size, count, index);
            }
            case TYPE_MAP32: {
                if((index + sizeof(tjs_uint32)) > size)
                    TJS_eTJSError(TJSReadError);
                tjs_uint32 count = Read32(buff, index);
                return ReadDictionary(buff, size, count, index);
            }
            default: {
                if(type >= TYPE_POSITIVE_FIX_NUM_MIN &&
                   type <= TYPE_POSITIVE_FIX_NUM_MAX) {
                    tjs_int value = type;
                    return new tTJSVariant(value);
                } else if(type >= TYPE_NEGATIVE_FIX_NUM_MIN &&
                          type <= TYPE_NEGATIVE_FIX_NUM_MAX) {
                    tjs_int value = static_cast<tjs_int8>(type);
                    return new tTJSVariant(value);
                } else if(type >= TYPE_FIX_RAW_MIN &&
                          type <= TYPE_FIX_RAW_MAX) { // octet
                    tjs_int len = type - TYPE_FIX_RAW_MIN;
                    if((len * sizeof(tjs_uint8) + index) > size)
                        TJS_eTJSError(TJSReadError);
                    return ReadOctetVarint(buff, len, index);
                } else if(type >= TYPE_FIX_STRING_MIN &&
                          type <= TYPE_FIX_STRING_MAX) {
                    tjs_int len = type - TYPE_FIX_STRING_MIN;
                    if((len * sizeof(tjs_char) + index) > size)
                        TJS_eTJSError(TJSReadError);
                    return ReadStringVarint(buff, len, index);
                } else if(type >= TYPE_FIX_ARRAY_MIN &&
                          type <= TYPE_FIX_ARRAY_MAX) {
                    tjs_int count = type - TYPE_FIX_ARRAY_MIN;
                    return ReadArray(buff, size, count, index);
                } else if(type >= TYPE_FIX_MAP_MIN &&
                          type <= TYPE_FIX_MAP_MAX) {
                    tjs_int count = type - TYPE_FIX_MAP_MIN;
                    return ReadDictionary(buff, size, count, index);
                } else {
                    TJS_eTJSError(TJSReadError);
                    return nullptr;
                }
            }
        }
    }

    tTJSVariant *tTJSBinarySerializer::ReadArray(const tjs_uint8 *buff,
                                                 const tjs_uint size,
                                                 const tjs_uint count,
                                                 tjs_uint &index) {
        if(index > size)
            return nullptr;

        std::unique_ptr<tTJSArrayObject, ReleaseObject> owner(CreateArray(count));
        auto* array = owner.get();
        for(tjs_uint i = 0; i < count; i++) {
            krkr_compiler_work(i);
            std::unique_ptr<tTJSVariant> value(ReadBasicType(buff, size, index));
            InsertArray(array, i, value.get());
        }
        auto *ret = new tTJSVariant(array, array);
        return ret;
    }

    tTJSVariant *tTJSBinarySerializer::ReadDictionary(const tjs_uint8 *buff,
                                                      const tjs_uint size,
                                                      const tjs_uint count,
                                                      tjs_uint &index) {
        if(index > size)
            return nullptr;

        std::unique_ptr<tTJSDictionaryObject, ReleaseObject> owner(CreateDictionary(count));
        auto* dic = owner.get();
        for(tjs_uint i = 0; i < count; i++) {
            krkr_compiler_work(i);
            tjs_uint8 type = buff[index];
            index++;
            // 最初に文字を読む
            tTJSVariantString *name = nullptr;
            switch(type) {
                case TYPE_STRING8: {
                    if((index + sizeof(tjs_uint8)) > size)
                        TJS_eTJSError(TJSReadError);
                    tjs_uint8 len = buff[index];
                    index++;
                    if((index + (len * sizeof(tjs_char))) > size)
                        TJS_eTJSError(TJSReadError);
                    name = ReadString(buff, len, index);
                    break;
                }
                case TYPE_STRING16: {
                    if((index + sizeof(tjs_uint16)) > size)
                        TJS_eTJSError(TJSReadError);
                    tjs_uint16 len = Read16(buff, index);
                    if((index + (len * sizeof(tjs_char))) > size)
                        TJS_eTJSError(TJSReadError);
                    name = ReadString(buff, len, index);
                    break;
                }
                case TYPE_STRING32: {
                    if((index + sizeof(tjs_uint32)) > size)
                        TJS_eTJSError(TJSReadError);
                    tjs_uint32 len = Read32(buff, index);
                    if((index + (len * sizeof(tjs_char))) > size)
                        TJS_eTJSError(TJSReadError);
                    name = ReadString(buff, len, index);
                    break;
                }
                default:
                    if(type >= TYPE_FIX_STRING_MIN &&
                       type <= TYPE_FIX_STRING_MAX) {
                        tjs_int len = type - TYPE_FIX_STRING_MIN;
                        if((len * sizeof(tjs_char) + index) > size)
                            TJS_eTJSError(TJSReadError);
                        name = ReadString(buff, len, index);
                    } else { // Dictionary形式の場合、最初に文字列がこないといけない
                        TJS_eTJSError(TJSReadError);
                    }
                    break;
            }
            // 次に要素を読む
            std::unique_ptr<tTJSVariantString, ReleaseString> key(name);
            std::unique_ptr<tTJSVariant> value(ReadBasicType(buff, size, index));
            AddDictionary(dic, key.get(), value.get());
        }
        auto *ret = new tTJSVariant(dic, dic);
        return ret;
    }

    tTJSVariant *tTJSBinarySerializer::Read(tTJSBinaryStream *stream) {
        const auto pos = stream->GetPosition(), total = stream->GetSize();
        if(pos > total || total - pos > 64u * 1024 * 1024) TJS_eTJSError(TJSReadError);
        const auto size = static_cast<tjs_uint>(total - pos);
        std::vector<tjs_uint8> buffer(size);
        if(size != stream->Read(buffer.data(), size)) {
            TJS_eTJSError(TJSReadError);
        }
        return Read(buffer.data(), size);
    }

    tTJSVariant *tTJSBinarySerializer::Read(const tjs_uint8 *buffer, size_t size) {
        KrkrCompilerScope work(5);
        krkr::BinaryInput input(buffer, size, TJSReadError);
        unsigned nodes = 0;
        ValidateValue(input, 0, nodes);
        // Native structured streams contain one value; trailing file data is
        // allowed (including data following an offset inside another resource).
        tjs_uint index = 0;
        return ReadBasicType(buffer, static_cast<tjs_uint>(size), index);
    }

} // namespace TJS
