//---------------------------------------------------------------------------
/*
        TJS2 Script Engine( Byte Code )
        Copyright (c), Takenori Imoto

        See details of license at "license.txt"
*/
//---------------------------------------------------------------------------
#include "tjsCommHead.h"

#include "tjs.h"
#include "tjsScriptBlock.h"
#include "tjsByteCodeLoader.h"
#include "tjsGlobalStringMap.h"
#include "BytecodeValidation.h"
#include "WebHost.h"
#include <bit>

namespace TJS {
    bool tTJSByteCodeLoader::IsTJS2ByteCode(const tjs_uint8 *buff) {
        return read4byte(buff) == FILE_TAG_LE && read4byte(buff + 4) == VER_TAG_LE;
    }

    void tTJSByteCodeLoader::ClearPools() {
        ByteArray.set(nullptr, 0);
        ShortArray.clear(); LongArray.clear(); LongLongArray.clear();
        DoubleArray.clear(); StringArray.clear(); OctetArray.clear();
    }

    tTJSScriptBlock *tTJSByteCodeLoader::ReadByteCode(tTJS *owner,
        const tjs_char *name, const tjs_uint8 *buf, size_t size) {
        ClearPools();
        try {
            krkr::validateBytecode(buf, size);
            KrkrCompilerScope work(6);
            const int dataSize = read4byte(buf + 16);
            ReadDataArea(buf, 20);
            const int objects = 12 + dataSize;
            krkr::NativeOwner<tTJSScriptBlock> block(new tTJSScriptBlock(owner, name, 0));
            ReadObjects(block.get(), buf, objects + 8);
            ClearPools();
            return block.release();
        } catch(...) {
            ClearPools();
            throw;
        }
    }

    void tTJSByteCodeLoader::ReadDataArea(const tjs_uint8 *buff, int offset) {
        int count = read4byte(buff + offset); offset += 4;
        ByteArray.set((tjs_int8 *)(buff + offset), count);
        offset += (count + 3) & ~3;
        const auto numbers = [&](auto& target, int width, auto read) {
            const int length = read4byte(buff + offset); offset += 4;
            target.reserve(length);
            for(int i = 0; i < length; ++i) {
                krkr_compiler_work(i);
                target.push_back(read(buff + offset));
                offset += width;
            }
            offset += (4 - (length * width) % 4) % 4;
        };
        numbers(ShortArray, 2, [](const tjs_uint8* at) { return (tjs_int16)read2byte(at); });
        numbers(LongArray, 4, read4byte);
        numbers(LongLongArray, 8, read8byte);
        numbers(DoubleArray, 8, [](const tjs_uint8* at) { return std::bit_cast<double>(read8byte(at)); });
        count = read4byte(buff + offset); offset += 4;
        StringArray.reserve(count);
        for(int i = 0; i < count; ++i) {
            krkr_compiler_work(i);
            const int length = read4byte(buff + offset); offset += 4;
            std::vector<tjs_char> chars(length + 1);
            for(int j = 0; j < length; ++j) {
                krkr_compiler_work(j);
                chars[j] = read2byte(buff + offset); offset += 2;
            }
            StringArray.push_back(TJSMapGlobalStringMap(ttstr(chars.data(), length)));
            offset += (length & 1) * 2;
        }
        count = read4byte(buff + offset); offset += 4;
        OctetArray.reserve(count);
        for(int i = 0; i < count; ++i) {
            krkr_compiler_work(i);
            const int length = read4byte(buff + offset); offset += 4;
            krkr::NativeOwner<tTJSVariantOctet> octet(new tTJSVariantOctet(buff + offset, length));
            OctetArray.push_back(std::move(octet));
            offset += (length + 3) & ~3;
        }
    }

    void tTJSByteCodeLoader::ReadObjects(tTJSScriptBlock *block,
        const tjs_uint8 *buff, int offset) {
        const int top = read4byte(buff + offset); offset += 4;
        const int count = read4byte(buff + offset); offset += 4;
        struct Links {
            int parent, setter, getter, superclass;
            std::vector<int> properties;
        };
        std::vector<Links> links(count);
        std::vector<krkr::NativeOwner<tTJSInterCodeContext>> objects(count);
        // Each object retains its original construction reference until every
        // link is installed. Rollback invalidates all unpublished objects while
        // those references still protect them, breaking arbitrary native cycles.
        struct Transaction {
            decltype(objects)& owned;
            bool committed = false;
            ~Transaction() {
                if(!committed)
                    for(auto& object : owned)
                        if(object) object->Invalidate(0, nullptr, nullptr, object.get());
            }
        } transaction{objects};
        std::vector<VariantRepalace> replacements;
        {
            KrkrCompilerScope work(7);
            for(int o = 0; o < count; ++o) {
                krkr_compiler_work(o);
                offset += 8; // validated object tag and length
                const auto integer = [&]() { const int value = read4byte(buff + offset); offset += 4; return value; };
                auto& link = links[o];
                link.parent = integer();
                const int name = integer(), type = integer(), variables = integer(), reserved = integer(),
                    frames = integer(), args = integer(), unnamed = integer(), collapse = integer();
                link.setter = integer(); link.getter = integer(); link.superclass = integer();
                const int positions = integer();
                auto source = krkr::allocateTjs<tTJSInterCodeContext::tSourcePos>(positions);
                for(int i = 0; i < positions; ++i) { krkr_compiler_work(i); source[i].CodePos = integer(); }
                for(int i = 0; i < positions; ++i) { krkr_compiler_work(i); source[i].SourcePos = integer(); }
                const int codeSize = integer();
                auto code = krkr::allocateTjs<tjs_int32>(codeSize);
                for(int i = 0; i < codeSize; ++i) {
                    krkr_compiler_work(i);
                    code[i] = (tjs_int16)read2byte(buff + offset); offset += 2;
                }
                TranslateCodeAddress(block, code.get(), codeSize);
                offset += (codeSize & 1) * 2;
                const int dataSize = integer();
                auto data = std::make_unique<tTJSVariant[]>(dataSize);
                for(int i = 0; i < dataSize; ++i) {
                    krkr_compiler_work(i);
                    const int kind = (tjs_int16)read2byte(buff + offset),
                        index = (tjs_int16)read2byte(buff + offset + 2);
                    offset += 4;
                    switch(kind) {
                        case TYPE_VOID: break;
                        case TYPE_OBJECT: data[i] = (iTJSDispatch2*)nullptr; break;
                        case TYPE_INTER_OBJECT: case TYPE_INTER_GENERATOR:
                            replacements.emplace_back(&data[i], index); break;
                        case TYPE_STRING: data[i] = StringArray[index]; break;
                        case TYPE_OCTET: data[i] = OctetArray[index].get(); break;
                        case TYPE_REAL: data[i] = (tjs_real)DoubleArray[index]; break;
                        case TYPE_BYTE: data[i] = (tjs_int)ByteArray[index]; break;
                        case TYPE_SHORT: data[i] = (tjs_int)ShortArray[index]; break;
                        case TYPE_INTEGER: data[i] = (tjs_int)LongArray[index]; break;
                        case TYPE_LONG: data[i] = (tjs_int64)LongLongArray[index]; break;
                    }
                }
                std::vector<tjs_int> superPointers(integer());
                for(auto& pointer : superPointers) { krkr_compiler_scan(&pointer); pointer = integer(); }
                const int propertyCount = integer();
                link.properties.resize(propertyCount * 2);
                for(auto& property : link.properties) { krkr_compiler_scan(&property); property = integer(); }
                objects[o].reset(new tTJSInterCodeContext(block,
                    name < 0 ? nullptr : StringArray[name].c_str(), (tTJSContextType)type,
                    code.get(), codeSize, data.get(), dataSize, variables, reserved, frames,
                    args, unnamed, collapse, true, source.get(), positions, superPointers));
                code.release(); data.release(); source.release();
            }
        }
        {
            KrkrCompilerScope work(8);
            unsigned operations = 0;
            const auto object = [&](int index) { return index < 0 ? nullptr : objects[index].get(); };
            for(int o = 0; o < count; ++o) {
                krkr_compiler_work(operations++);
                auto& link = links[o];
                objects[o]->SetCodeObject(object(link.parent), object(link.setter), object(link.getter), object(link.superclass));
                for(size_t i = 0; i < link.properties.size(); i += 2) {
                    krkr_compiler_work(operations++);
                    tTJSVariant value(object(link.properties[i + 1]));
                    const auto status = object(link.parent)->PropSet(TJS_MEMBERENSURE | TJS_IGNOREPROP,
                        StringArray[link.properties[i]].c_str(), nullptr, &value, object(link.parent));
                    if(TJS_FAILED(status)) TJSThrowFrom_tjs_error(status, StringArray[link.properties[i]].c_str());
                }
            }
            for(auto& replacement : replacements) {
                krkr_compiler_work(operations++);
                *replacement.Work = objects[replacement.Index].get();
            }
            block->SetBytecodeTopLevel(object(top));
            transaction.committed = true;
        }
    }

#define TJS_OFFSET_VM_REG_ADDR(x) ((x) = TJS_TO_VM_REG_ADDR(x))
#define TJS_OFFSET_VM_CODE_ADDR(x) ((x) = TJS_TO_VM_CODE_ADDR(x))

    /**
     * バイトコード中のアドレスは配列のインデックスを指しているので、それをアドレスに変換する
     */
    void tTJSByteCodeLoader::TranslateCodeAddress(tTJSScriptBlock *block,
                                                  tjs_int32 *code,
                                                  const tjs_int32 codeSize) {
        tjs_int i = 0;
        unsigned operations = 0;
        for(; i < codeSize;) {
            krkr_compiler_work(operations++);
            tjs_int size;
            switch(code[i]) {
                case VM_NOP:
                    size = 1;
                    break;
                case VM_NF:
                    size = 1;
                    break;
                case VM_CONST:
                    TJS_OFFSET_VM_REG_ADDR(code[i + 1]);
                    TJS_OFFSET_VM_REG_ADDR(code[i + 2]);
                    size = 3;
                    break;

#define OP2_DISASM(c)                                                          \
    case c:                                                                    \
        TJS_OFFSET_VM_REG_ADDR(code[i + 1]);                                   \
        TJS_OFFSET_VM_REG_ADDR(code[i + 2]);                                   \
        size = 3;                                                              \
        break

                    OP2_DISASM(VM_CP);
                    OP2_DISASM(VM_CEQ);
                    OP2_DISASM(VM_CDEQ);
                    OP2_DISASM(VM_CLT);
                    OP2_DISASM(VM_CGT);
                    OP2_DISASM(VM_CHKINS);
#undef OP2_DISASM

#define OP2_DISASM(c)                                                          \
    case c:                                                                    \
        TJS_OFFSET_VM_REG_ADDR(code[i + 1]);                                   \
        TJS_OFFSET_VM_REG_ADDR(code[i + 2]);                                   \
        size = 3;                                                              \
        break;                                                                 \
    case c + 1:                                                                \
        TJS_OFFSET_VM_REG_ADDR(code[i + 1]);                                   \
        TJS_OFFSET_VM_REG_ADDR(code[i + 2]);                                   \
        TJS_OFFSET_VM_REG_ADDR(code[i + 3]);                                   \
        TJS_OFFSET_VM_REG_ADDR(code[i + 4]);                                   \
        size = 5;                                                              \
        break;                                                                 \
    case c + 2:                                                                \
        TJS_OFFSET_VM_REG_ADDR(code[i + 1]);                                   \
        TJS_OFFSET_VM_REG_ADDR(code[i + 2]);                                   \
        TJS_OFFSET_VM_REG_ADDR(code[i + 3]);                                   \
        TJS_OFFSET_VM_REG_ADDR(code[i + 4]);                                   \
        size = 5;                                                              \
        break;                                                                 \
    case c + 3:                                                                \
        TJS_OFFSET_VM_REG_ADDR(code[i + 1]);                                   \
        TJS_OFFSET_VM_REG_ADDR(code[i + 2]);                                   \
        TJS_OFFSET_VM_REG_ADDR(code[i + 3]);                                   \
        size = 4;                                                              \
        break

                    OP2_DISASM(VM_LOR);
                    OP2_DISASM(VM_LAND);
                    OP2_DISASM(VM_BOR);
                    OP2_DISASM(VM_BXOR);
                    OP2_DISASM(VM_BAND);
                    OP2_DISASM(VM_SAR);
                    OP2_DISASM(VM_SAL);
                    OP2_DISASM(VM_SR);
                    OP2_DISASM(VM_ADD);
                    OP2_DISASM(VM_SUB);
                    OP2_DISASM(VM_MOD);
                    OP2_DISASM(VM_DIV);
                    OP2_DISASM(VM_IDIV);
                    OP2_DISASM(VM_MUL);
#undef OP2_DISASM

#define OP1_DISASM                                                             \
    TJS_OFFSET_VM_REG_ADDR(code[i + 1]);                                       \
    size = 2;
                case VM_TT:
                    OP1_DISASM
                    break;
                case VM_TF:
                    OP1_DISASM
                    break;
                case VM_SETF:
                    OP1_DISASM
                    break;
                case VM_SETNF:
                    OP1_DISASM
                    break;
                case VM_LNOT:
                    OP1_DISASM
                    break;
                case VM_BNOT:
                    OP1_DISASM
                    break;
                case VM_ASC:
                    OP1_DISASM
                    break;
                case VM_CHR:
                    OP1_DISASM
                    break;
                case VM_NUM:
                    OP1_DISASM
                    break;
                case VM_CHS:
                    OP1_DISASM
                    break;
                case VM_CL:
                    OP1_DISASM
                    break;
                case VM_INV:
                    OP1_DISASM
                    break;
                case VM_CHKINV:
                    OP1_DISASM
                    break;
                case VM_TYPEOF:
                    OP1_DISASM
                    break;
                case VM_EVAL:
                    OP1_DISASM
                    break;
                case VM_EEXP:
                    OP1_DISASM
                    break;
                case VM_INT:
                    OP1_DISASM
                    break;
                case VM_REAL:
                    OP1_DISASM
                    break;
                case VM_STR:
                    OP1_DISASM
                    break;
                case VM_OCTET:
                    OP1_DISASM
                    break;
#undef OP1_DISASM

                case VM_CCL:
                    TJS_OFFSET_VM_REG_ADDR(code[i + 1]);
                    size = 3;
                    break;

#define OP1_DISASM(c)                                                          \
    case c:                                                                    \
        TJS_OFFSET_VM_REG_ADDR(code[i + 1]);                                   \
        size = 2;                                                              \
        break;                                                                 \
    case c + 1:                                                                \
        TJS_OFFSET_VM_REG_ADDR(code[i + 1]);                                   \
        TJS_OFFSET_VM_REG_ADDR(code[i + 2]);                                   \
        TJS_OFFSET_VM_REG_ADDR(code[i + 3]);                                   \
        size = 4;                                                              \
        break;                                                                 \
    case c + 2:                                                                \
        TJS_OFFSET_VM_REG_ADDR(code[i + 1]);                                   \
        TJS_OFFSET_VM_REG_ADDR(code[i + 2]);                                   \
        TJS_OFFSET_VM_REG_ADDR(code[i + 3]);                                   \
        size = 4;                                                              \
        break;                                                                 \
    case c + 3:                                                                \
        TJS_OFFSET_VM_REG_ADDR(code[i + 1]);                                   \
        TJS_OFFSET_VM_REG_ADDR(code[i + 2]);                                   \
        size = 3;                                                              \
        break

                    OP1_DISASM(VM_INC);
                    OP1_DISASM(VM_DEC);
#undef OP1_DISASM

#define OP1A_DISASM                                                            \
    TJS_OFFSET_VM_CODE_ADDR(code[i + 1]);                                      \
    size = 2;
                case VM_JF:
                    OP1A_DISASM
                    break;
                case VM_JNF:
                    OP1A_DISASM
                    break;
                case VM_JMP:
                    OP1A_DISASM
                    break;
#undef OP1A_DISASM

                case VM_CALL:
                case VM_CALLD:
                case VM_CALLI:
                case VM_NEW: {
                    TJS_OFFSET_VM_REG_ADDR(code[i + 1]);
                    TJS_OFFSET_VM_REG_ADDR(code[i + 2]);

                    tjs_int st; // start of arguments
                    if(code[i] == VM_CALLD || code[i] == VM_CALLI) {
                        TJS_OFFSET_VM_REG_ADDR(code[i + 3]);
                        st = 5;
                    } else {
                        st = 4;
                    }
                    tjs_int num = code[i + st - 1]; // st-1 = argument count
                    tjs_int c = 0;
                    if(num == -1) {
                        size = st;
                    } else if(num == -2) {
                        st++;
                        num = code[i + st - 1];
                        size = st + num * 2;
                        for(tjs_int j = 0; j < num; j++) {
                            krkr_compiler_work(operations++);
                            switch(code[i + st + j * 2]) {
                                case fatNormal:
                                    TJS_OFFSET_VM_REG_ADDR(
                                        code[i + st + j * 2 + 1]);
                                    break;
                                case fatExpand:
                                    TJS_OFFSET_VM_REG_ADDR(
                                        code[i + st + j * 2 + 1]);
                                    break;
                                case fatUnnamedExpand:
                                    break;
                            }
                        }
                    } else {
                        // normal operation
                        size = st + num;
                        while(num--) {
                            krkr_compiler_work(operations++);
                            TJS_OFFSET_VM_REG_ADDR(code[i + c + st]);
                            c++;
                        }
                    }
                    break;
                }

                case VM_GPD:
                case VM_GPDS:
                    TJS_OFFSET_VM_REG_ADDR(code[i + 1]);
                    TJS_OFFSET_VM_REG_ADDR(code[i + 2]);
                    TJS_OFFSET_VM_REG_ADDR(code[i + 3]);
                    size = 4;
                    break;

                case VM_SPD:
                case VM_SPDE:
                case VM_SPDEH:
                case VM_SPDS:
                    TJS_OFFSET_VM_REG_ADDR(code[i + 1]);
                    TJS_OFFSET_VM_REG_ADDR(code[i + 2]);
                    TJS_OFFSET_VM_REG_ADDR(code[i + 3]);
                    size = 4;
                    break;

                case VM_GPI:
                case VM_GPIS:
                    TJS_OFFSET_VM_REG_ADDR(code[i + 1]);
                    TJS_OFFSET_VM_REG_ADDR(code[i + 2]);
                    TJS_OFFSET_VM_REG_ADDR(code[i + 3]);
                    size = 4;
                    break;

                case VM_SPI:
                case VM_SPIE:
                case VM_SPIS:
                    TJS_OFFSET_VM_REG_ADDR(code[i + 1]);
                    TJS_OFFSET_VM_REG_ADDR(code[i + 2]);
                    TJS_OFFSET_VM_REG_ADDR(code[i + 3]);
                    size = 4;
                    break;

                case VM_SETP:
                    TJS_OFFSET_VM_REG_ADDR(code[i + 1]);
                    TJS_OFFSET_VM_REG_ADDR(code[i + 2]);
                    size = 3;
                    break;

                case VM_GETP:
                    TJS_OFFSET_VM_REG_ADDR(code[i + 1]);
                    TJS_OFFSET_VM_REG_ADDR(code[i + 2]);
                    size = 3;
                    break;

                case VM_DELD:
                case VM_TYPEOFD:
                    TJS_OFFSET_VM_REG_ADDR(code[i + 1]);
                    TJS_OFFSET_VM_REG_ADDR(code[i + 2]);
                    TJS_OFFSET_VM_REG_ADDR(code[i + 3]);
                    size = 4;
                    break;

                case VM_DELI:
                case VM_TYPEOFI:
                    TJS_OFFSET_VM_REG_ADDR(code[i + 1]);
                    TJS_OFFSET_VM_REG_ADDR(code[i + 2]);
                    TJS_OFFSET_VM_REG_ADDR(code[i + 3]);
                    size = 4;
                    break;

                case VM_SRV:
                    TJS_OFFSET_VM_REG_ADDR(code[i + 1]);
                    size = 2;
                    break;

                case VM_RET:
                    size = 1;
                    break;

                case VM_ENTRY:
                    TJS_OFFSET_VM_CODE_ADDR(code[i + 1]);
                    TJS_OFFSET_VM_REG_ADDR(code[i + 2]);
                    size = 3;
                    break;

                case VM_EXTRY:
                    size = 1;
                    break;

                case VM_THROW:
                    TJS_OFFSET_VM_REG_ADDR(code[i + 1]);
                    size = 2;
                    break;

                case VM_CHGTHIS:
                    TJS_OFFSET_VM_REG_ADDR(code[i + 1]);
                    TJS_OFFSET_VM_REG_ADDR(code[i + 2]);
                    size = 3;
                    break;

                case VM_GLOBAL:
                    TJS_OFFSET_VM_REG_ADDR(code[i + 1]);
                    size = 2;
                    break;

                case VM_ADDCI:
                    TJS_OFFSET_VM_REG_ADDR(code[i + 1]);
                    TJS_OFFSET_VM_REG_ADDR(code[i + 2]);
                    size = 3;
                    break;

                case VM_REGMEMBER:
                    size = 1;
                    break;
                case VM_DEBUGGER:
                    size = 1;
                    break;
                default:
                    size = 1;
                    break;
            } /* switch */
            i += size;
        }
        if(codeSize != i) {
            TJS_eTJSScriptError(TJSByteCodeBroken, block, 0);
        }
    }

} // namespace TJS
