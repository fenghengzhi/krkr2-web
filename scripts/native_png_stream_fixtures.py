"""Independent stored-DEFLATE PNG corpus, executed only by the hosted driver.

No product PNG/zlib code is imported. Each stored block normally holds exactly
one PNG pass row; the input manifest records the chosen corruption, not a guess
about how many destination rows the original library will write or complete.
"""
import struct
import zlib

PASSES = [(0, 0, 8, 8), (4, 0, 8, 8), (0, 4, 4, 8), (2, 0, 4, 4),
          (0, 2, 2, 4), (1, 0, 2, 2), (0, 1, 1, 2)]


def chunk(kind, payload, bad_crc=False):
    name = kind.encode('ascii')
    return (struct.pack('>I', len(payload)) + name + payload +
            struct.pack('>I', zlib.crc32(name + payload) ^ int(bad_crc)))


def sample(color, x, y):
    if color == 0:
        return bytes([12 + y * 17 + x * 3])
    rgb = [20 + x * 7, 30 + y * 13, 40 + x + y]
    return bytes(rgb + ([255 - ((x + y) % 5) * 17] if color == 6 else []))


def stored(rows, finish_block=False):
    raw = b''.join(rows)
    stream = bytearray(b'\x78\x01')
    boundaries = []
    for index, row in enumerate(rows):
        if len(row) > 65535:
            raise ValueError('Stored fixture block too large')
        stream += bytes([int(index == len(rows) - 1 and not finish_block)])
        stream += struct.pack('<HH', len(row), len(row) ^ 0xffff) + row
        boundaries.append(len(stream))
    if finish_block:
        stream += b'\x01\x00\x00\xff\xff'
    stream += struct.pack('>I', zlib.adler32(raw))
    return stream, boundaries


def create_stream_cases(manifest):
    if manifest.get('schema') != 1 or manifest.get('sentinel') != 165:
        raise ValueError('Unknown PNG stream fixture manifest')
    cases = []
    for definition in manifest['cases']:
        interlace = bool(definition.get('interlace'))
        width, height = (9, 9) if interlace else (3, 4)
        color = definition['color']
        if color not in (0, 2, 6):
            raise ValueError('Unsupported fixture color')
        rows = []
        for sx, sy, dx, dy in PASSES if interlace else [(0, 0, 1, 1)]:
            columns = list(range(sx, width, dx))
            if not columns:
                continue
            for y in range(sy, height, dy):
                rows.append(b'\0' + b''.join(sample(color, x, y) for x in columns))
        fault = definition.get('fault')
        if fault == 'filter':
            rows[2] = b'\x05' + rows[2][1:]
        elif fault == 'short-row':
            rows[-1] = rows[-1][:-2]
        elif fault == 'extra-output':
            rows.append(b'\x7f')
        finish_block = bool(definition.get('finishBlock'))
        stream, ends = stored(rows, finish_block)
        if fault == 'adler':
            stream[-1] ^= 1
        elif fault == 'block-length':
            stream[ends[0] + 3] ^= 1
        elif fault == 'final-block-length' and finish_block:
            stream[ends[-1] + 3] ^= 1
        elif fault == 'short-block':
            start = ends[-2] if len(ends) > 1 else 2
            stream = stream[:start + 5 + len(rows[-1]) // 2]
        elif fault == 'short-trailer':
            stream = stream[:-2]
        elif fault == 'compressed-tail':
            stream += b'\x99\x88'
        elif fault not in (None, 'filter', 'short-row', 'extra-output'):
            raise ValueError('Unknown PNG stream fixture fault: ' + str(fault))
        stream = bytes(stream)
        mode = definition.get('idat')
        parts = [stream]
        # End the last data-bearing IDAT precisely at a non-final stored block.
        # The empty final block/checksum is only available in the next IDAT.
        # This observes read_finish_row separately without guessing its result.
        if finish_block:
            if mode is not None:
                raise ValueError('finishBlock owns its separate IDAT layout')
            parts = [stream[:ends[-1]], stream[ends[-1]:]]
        if mode in ('split-first', 'zero-middle', 'bad-first-crc', 'bad-second-crc', 'wrong-next-type', 'short-crc'):
            parts = [stream[:ends[0]], stream[ends[0]:]]
        elif mode == 'split-rows':
            cuts = [0] + ends + [len(stream)]
            parts = [stream[a:b] for a, b in zip(cuts, cuts[1:])]
        elif mode == 'empty':
            parts = [b'']
        elif mode not in (None, 'zero-first', 'bad-first-crc', 'after-end'):
            raise ValueError('Unknown PNG IDAT layout: ' + str(mode))
        if mode == 'zero-first':
            parts.insert(0, b'')
        if mode == 'zero-middle':
            parts.insert(1, b'')
        if mode == 'after-end':
            parts.append(b'\0')
        chunks = [chunk('tEXt' if mode == 'wrong-next-type' and index == 1 else 'IDAT', payload,
                        mode == 'bad-first-crc' and index == 0 or mode == 'bad-second-crc' and index == 1)
                  for index, payload in enumerate(parts)]
        header = chunk('IHDR', struct.pack('>IIBBBBB', width, height, 8, color, 0, 0, int(interlace)))
        tail = chunk('IEND', b'', definition.get('tail') == 'bad-crc')
        if definition.get('tail') == 'short-crc':
            tail = tail[:-2]
        elif definition.get('tail') not in (None, 'bad-crc'):
            raise ValueError('Unknown PNG read-end fixture')
        data = b'\x89PNG\r\n\x1a\n' + header + (chunks[0][:-2] if mode == 'short-crc' else b''.join(chunks) + tail)
        expected = []
        for y in range(height):
            for x in range(width):
                value = sample(color, x, y)
                expected.extend([value[0]] * 3 + [255] if color == 0 else list(value) + ([255] if color == 2 else []))
        cases.append({'id': definition['id'], 'data': data, 'keyidx': -1, 'observeOnly': False,
                      'streamReference': True, 'width': width, 'height': height,
                      'definition': definition, 'scope': manifest['scope'],
                      'expected': {'rgba': expected if definition.get('control') else None,
                                   'metadata': [], 'error': None, 'warning': None, 'nativeErrorLeak': None}})
    return cases
