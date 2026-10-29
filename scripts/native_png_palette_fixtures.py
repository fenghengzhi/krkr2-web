"""Independent palette/row corpus for the hosted original-loader reference.

Only stored DEFLATE framing/CRC primitives are shared with the existing native
fixture builder. No product encoder, PNG parser or grayscale code is imported.
"""
import struct
from native_png_stream_fixtures import PASSES, chunk, stored

PALETTE = [(10, 20, 30), (40, 50, 60), (70, 80, 90), (100, 110, 120)]
ALPHA = [13, 127, 241, 255]


def create_palette_cases(manifest):
    if manifest.get('schema') != 1 or manifest.get('sentinel') != 165:
        raise ValueError('Unknown PNG palette fixture manifest')
    result = []
    for definition in manifest['cases']:
        width, height, depth = 5, 3, 2
        interlace, trns = bool(definition.get('interlace')), bool(definition.get('trns'))
        mode, key = definition['mode'], definition.get('key', -1)
        if mode not in ('normal', 'grayscale') or key not in (-1, 0, 1, 255) or (mode == 'grayscale' and key != -1):
            raise ValueError('Invalid palette case mode/key')
        rows = []
        for sx, sy, dx, dy in PASSES if interlace else [(0, 0, 1, 1)]:
            columns = list(range(sx, width, dx))
            if not columns:
                continue
            for y in range(sy, height, dy):
                packed = bytearray((len(columns) + 3) // 4)
                for position, x in enumerate(columns):
                    packed[position // 4] |= ((x + y) % 4) << (6 - (position % 4) * 2)
                rows.append(b'\0' + packed)
        fault = definition.get('fault')
        if fault not in (None, 'adler') or definition.get('tail') not in (None, 'bad-crc'):
            raise ValueError('Unknown palette failure')
        stream, boundaries = stored(rows, finish_block=fault == 'adler')
        if fault == 'adler':
            stream[-1] ^= 1
            # Read the empty final block/checksum only after all pass rows have
            # filled their output; native alone determines publication on error.
            parts = [stream[:boundaries[-1]], stream[boundaries[-1]:]]
        else:
            parts = [stream]
        header = struct.pack('>IIBBBBB', width, height, depth, 3, 0, 0, int(interlace))
        data = b'\x89PNG\r\n\x1a\n' + chunk('IHDR', header) + chunk('PLTE', bytes(v for rgb in PALETTE for v in rgb))
        if trns:
            data += chunk('tRNS', bytes(ALPHA))
        data += b''.join(chunk('IDAT', part) for part in parts)
        data += chunk('IEND', b'', definition.get('tail') == 'bad-crc')
        prefix_only = mode == 'normal' and key != -1 and not trns
        stride = width if mode == 'grayscale' else width * 4
        prefix = width * 3 if prefix_only else stride
        expected = []
        for y in range(height):
            native_row = []
            for x in range(width):
                index = (x + y) % 4
                r, g, b = PALETTE[index]
                native_row.extend([b, g, r])
                if trns:
                    native_row.append(ALPHA[index])
                elif mode == 'normal' and key == -1:
                    native_row.append(255)
            if mode == 'grayscale':
                expected.extend((native_row[x * 3] * 19 + native_row[x * 3 + 1] * 183 + native_row[x * 3 + 2] * 54) >> 8
                                for x in range(width))
            else:
                expected.extend(native_row + [165] * (stride - len(native_row)))
        # A literal cross-pixel control guards the independent authored oracle.
        if mode == 'grayscale' and trns and expected[:5] != [18, 54, 112, 106, 108]:
            raise ValueError('Palette-gray authored first row differs from its literal byte contract')
        result.append({'id': definition['id'], 'data': data, 'keyidx': key, 'mode': mode,
            'observeOnly': False, 'paletteReference': True, 'width': width, 'height': height,
            'definition': definition, 'scope': manifest['scope'], 'comparisonPrefixBytes': prefix,
            'destinationStride': stride, 'prefixOnly': prefix_only,
            'expected': {'destination': expected if definition.get('control') else None,
                'rgba': None, 'metadata': [], 'error': None, 'warning': None, 'nativeErrorLeak': None}})
    return result
