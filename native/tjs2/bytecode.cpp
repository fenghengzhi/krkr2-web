#include "BinaryInput.h"
#include "BytecodeValidation.h"
#include "WebHost.h"
#include "tjsInterCodeGen.h"
#include <array>
#include <vector>

namespace krkr {
namespace {
using namespace TJS;
constexpr unsigned maximumIndexCount = 32768;
[[noreturn]] void broken() { TJS_eTJSError(TJSByteCodeBroken); throw 0; }
int shortAt(const std::uint8_t* bytes, std::size_t index) {
    return static_cast<std::int16_t>(std::uint16_t(bytes[index * 2]) |
        (std::uint16_t(bytes[index * 2 + 1]) << 8));
}
struct Object {
    int parent, name, type, variables, reserved, frames, args, unnamed, collapse;
    int setter, getter, superclass;
    const std::uint8_t* code = nullptr;
    unsigned codeSize = 0;
    std::vector<unsigned> types;
    std::vector<int> superPointers;
    std::vector<std::pair<int, int>> properties;
};
void index(int value, unsigned count, bool optional = false) {
    if(value < (optional ? -1 : 0) || (value >= 0 && unsigned(value) >= count)) broken();
}
unsigned poolCount(BinaryInput& input) {
    const unsigned count = input.u32();
    if(count > maximumIndexCount) broken();
    return count;
}
std::array<unsigned, 11> readPools(BinaryInput& input) {
    std::array<unsigned, 11> counts{};
    for(const auto& [type, width] : {std::pair{6, 1}, {7, 2}, {8, 4}, {9, 8}, {5, 8}}) {
        const auto count = counts[type] = poolCount(input);
        input.items(count, width);
        const auto bytes = count * width;
        input.take((4 - bytes % 4) % 4);
    }
    for(const auto& [type, width] : {std::pair{3, 2}, {4, 1}}) {
        const auto count = counts[type] = poolCount(input);
        for(unsigned i = 0; i < count; ++i) {
            krkr_compiler_work(i);
            const auto units = input.u32();
            input.items(units, width);
            input.take((4 - (units * width) % 4) % 4);
        }
    }
    input.finish();
    return counts;
}
Object readObject(BinaryInput& input, const std::array<unsigned, 11>& pools, unsigned count) {
    Object object;
    object.parent = input.i32(); object.name = input.i32(); object.type = input.i32();
    object.variables = input.i32(); object.reserved = input.i32(); object.frames = input.i32();
    object.args = input.i32(); object.unnamed = input.i32(); object.collapse = input.i32();
    object.setter = input.i32(); object.getter = input.i32(); object.superclass = input.i32();
    for(int value : {object.parent, object.setter, object.getter, object.superclass}) index(value, count, true);
    index(object.name, pools[3], true);
    if(object.type < ctTopLevel || object.type > ctSuperClassGetter ||
       object.variables < 0 || object.variables > 32766 || object.frames < 0 || object.frames > 32767 ||
       object.reserved != (object.type == ctProperty ? 0 : 2) ||
       object.args < 0 || object.args > object.variables || object.unnamed < 0 || object.unnamed > object.args ||
       object.collapse < -1 || (object.collapse >= 0 && object.collapse >= object.variables)) broken();

    const auto positions = input.u32();
    const auto* debug = input.items(positions, 8);
    object.codeSize = input.u32();
    object.code = input.items(object.codeSize, 2);
    input.take((object.codeSize & 1) * 2);
    if(!object.codeSize && object.type != ctProperty) broken();
    BinaryInput sourcePositions(debug, positions * 8, TJSByteCodeBroken);
    for(unsigned i = 0; i < positions; ++i) {
        krkr_compiler_work(i);
        const auto position = sourcePositions.i32();
        if(position < 0 || unsigned(position) > object.codeSize) broken();
    }
    for(unsigned i = 0; i < positions; ++i) {
        krkr_compiler_work(i);
        if(sourcePositions.i32() < 0) broken();
    }
    const auto data = poolCount(input);
    if(data > input.remaining() / 4) broken();
    object.types.reserve(data);
    for(unsigned i = 0; i < data; ++i) {
        krkr_compiler_work(i);
        const int type = static_cast<std::int16_t>(input.u16());
        const int value = static_cast<std::int16_t>(input.u16());
        if(type < 0 || type > 10) broken();
        if(type == 2 || type == 10) index(value, count);
        else if(type >= 3) index(value, pools[type]);
        // Null object constants may use -1 to encode an unavailable native object.
        else if(value != 0 && !(type == 1 && value == -1)) broken();
        object.types.push_back(type);
    }
    const auto superCount = input.u32();
    if(superCount > input.remaining() / 4) broken();
    object.superPointers.reserve(superCount);
    for(unsigned i = 0; i < superCount; ++i) {
        krkr_compiler_work(i);
        object.superPointers.push_back(input.i32());
    }
    const auto properties = input.u32();
    if(properties > input.remaining() / 8 || (properties && object.parent < 0)) broken();
    object.properties.reserve(properties);
    for(unsigned i = 0; i < properties; ++i) {
        krkr_compiler_work(i);
        const int name = input.i32(), target = input.i32();
        index(name, pools[3]); index(target, count);
        object.properties.emplace_back(name, target);
    }
    input.finish();
    return object;
}
void instructions(const Object& object) {
    std::vector<std::uint8_t> boundaries(object.codeSize);
    std::vector<int> destinations = object.superPointers;
    unsigned work = 0;
    for(unsigned ip = 0; ip < object.codeSize;) {
        krkr_compiler_work(work++);
        boundaries[ip] = 1;
        const auto at = [&](unsigned offset) {
            if(offset >= object.codeSize - ip) broken();
            return shortAt(object.code, ip + offset);
        };
        const auto reg = [&](unsigned offset) {
            const int value = at(offset);
            if(value < -(object.variables + object.reserved) || value > object.frames) broken();
            return value;
        };
        const auto constant = [&](unsigned offset, bool string = false) {
            const int value = at(offset);
            index(value, object.types.size());
            if(string && object.types[value] != 3) broken();
        };
        const auto jump = [&]() { destinations.push_back(int(ip) + at(1)); };
        const int opcode = at(0);
        unsigned size = 0;
        if(opcode >= VM_LOR && opcode <= VM_MULP) {
            const int form = (opcode - VM_LOR) % 4;
            reg(1); reg(2);
            if(form == 0) size = 3;
            else if(form == 3) { reg(3); size = 4; }
            else {
                if(form == 1) constant(3, true); else reg(3);
                reg(4); size = 5;
            }
        } else if(opcode >= VM_INC && opcode <= VM_DECP) {
            const int form = (opcode - VM_INC) % 4;
            reg(1);
            if(form == 0) size = 2;
            else if(form == 3) { reg(2); size = 3; }
            else {
                reg(2);
                if(form == 1) constant(3, true); else reg(3);
                size = 4;
            }
        } else switch(opcode) {
            case VM_NOP: case VM_NF: case VM_RET: case VM_EXTRY:
            case VM_REGMEMBER: case VM_DEBUGGER: size = 1; break;
            case VM_CONST: reg(1); constant(2); size = 3; break;
            case VM_CP: case VM_CEQ: case VM_CDEQ: case VM_CLT: case VM_CGT:
            case VM_CHKINS: case VM_SETP: case VM_GETP: case VM_CHGTHIS: case VM_ADDCI:
                reg(1); reg(2); size = 3; break;
            case VM_CL: case VM_TT: case VM_TF: case VM_SETF: case VM_SETNF:
            case VM_LNOT: case VM_BNOT: case VM_ASC: case VM_CHR: case VM_NUM:
            case VM_CHS: case VM_INV: case VM_CHKINV: case VM_TYPEOF: case VM_EVAL:
            case VM_EEXP: case VM_INT: case VM_REAL: case VM_STR: case VM_OCTET:
            case VM_SRV: case VM_THROW: case VM_GLOBAL: reg(1); size = 2; break;
            case VM_CCL: {
                const int first = reg(1), count = at(2);
                if(count < 0 || (count && first + count - 1 > object.frames)) broken();
                size = 3; break;
            }
            case VM_JF: case VM_JNF: case VM_JMP: jump(); size = 2; break;
            case VM_ENTRY: jump(); reg(2); size = 3; break;
            case VM_GPD: case VM_GPDS: case VM_DELD: case VM_TYPEOFD:
                reg(1); reg(2); constant(3, true); size = 4; break;
            case VM_SPD: case VM_SPDE: case VM_SPDEH: case VM_SPDS:
                reg(1); constant(2, true); reg(3); size = 4; break;
            case VM_GPI: case VM_GPIS: case VM_SPI: case VM_SPIE: case VM_SPIS:
            case VM_DELI: case VM_TYPEOFI: reg(1); reg(2); reg(3); size = 4; break;
            case VM_CALL: case VM_CALLD: case VM_CALLI: case VM_NEW: {
                reg(1); reg(2);
                unsigned start = 4;
                if(opcode == VM_CALLD || opcode == VM_CALLI) {
                    if(opcode == VM_CALLD) constant(3, true); else reg(3);
                    start = 5;
                }
                int count = at(start - 1);
                if(count == -1) size = start;
                else if(count == -2) {
                    count = at(start++);
                    if(count < 0 || unsigned(count) > (object.codeSize - ip - start) / 2) broken();
                    for(int argument = 0; argument < count; ++argument) {
                        krkr_compiler_work(work++);
                        const int kind = at(start + argument * 2);
                        if(kind == fatNormal || kind == fatExpand) reg(start + argument * 2 + 1);
                        else if(kind != fatUnnamedExpand) broken();
                    }
                    size = start + count * 2;
                } else {
                    if(count < 0 || unsigned(count) > object.codeSize - ip - start) broken();
                    for(int argument = 0; argument < count; ++argument) {
                        krkr_compiler_work(work++);
                        reg(start + argument);
                    }
                    size = start + count;
                }
                break;
            }
            default: broken();
        }
        if(!size || size > object.codeSize - ip) broken();
        // Ordinary fallthrough must reach another complete instruction.
        if(ip + size == object.codeSize && opcode != VM_RET && opcode != VM_EXTRY &&
           opcode != VM_THROW && opcode != VM_JMP) broken();
        ip += size;
    }
    for(unsigned i = 0; i < destinations.size(); ++i) {
        krkr_compiler_work(i);
        const int target = destinations[i];
        index(target, object.codeSize);
        if(!boundaries[target]) broken();
    }
}
}

void validateBytecode(const std::uint8_t* bytes, std::size_t length) {
    KrkrCompilerScope work(5);
    BinaryInput input(bytes, length, TJSByteCodeBroken);
    if(input.u32() != 0x32534a54 || input.u32() != 0x00303031 || input.u32() != length ||
       input.u32() != 0x41544144) broken();
    const auto dataLength = input.u32();
    if(dataLength < 8) broken();
    auto data = input.chunk(dataLength - 8);
    const auto pools = readPools(data);
    if(input.u32() != 0x534a424f) broken();
    const auto objectLength = input.u32();
    if(objectLength < 16) broken();
    auto area = input.chunk(objectLength - 8);
    input.finish();
    const int top = area.i32();
    const auto count = poolCount(area);
    index(top, count, true);
    if(count > area.remaining() / 8 || (count && top < 0)) broken();
    std::vector<Object> objects;
    objects.reserve(count);
    for(unsigned i = 0; i < count; ++i) {
        krkr_compiler_work(i);
        if(area.u32() != 0x32534a54) broken();
        auto object = area.chunk(area.u32());
        objects.push_back(readObject(object, pools, count));
        instructions(objects.back());
    }
    area.finish();
    std::vector<std::uint8_t> parents(count);
    for(unsigned i = 0; i < count; ++i) {
        krkr_compiler_work(i);
        const auto& object = objects[i];
        if(int(i) == top && (object.type != TJS::ctTopLevel || object.parent != -1)) broken();
        if(object.type == TJS::ctTopLevel && int(i) != top) broken();
        for(const auto& [target, kind, owner] : {
                std::array{object.setter, int(TJS::ctPropertySetter), int(TJS::ctProperty)},
                std::array{object.getter, int(TJS::ctPropertyGetter), int(TJS::ctProperty)},
                std::array{object.superclass, int(TJS::ctSuperClassGetter), int(TJS::ctClass)}}) {
            if(target >= 0 && (object.type != owner || objects[target].type != kind ||
                              objects[target].parent != int(i))) broken();
        }
        // Parent chains must terminate; the native VM walks them without a
        // script checkpoint while resolving ownership and diagnostic names.
        int parent = i;
        while(parent >= 0 && parents[parent] == 0) {
            krkr_compiler_work(parent);
            parents[parent] = 1; parent = objects[parent].parent;
        }
        if(parent >= 0 && parents[parent] == 1) broken();
        parent = i;
        while(parent >= 0 && parents[parent] == 1) {
            parents[parent] = 2; parent = objects[parent].parent;
        }
    }
}
}
