"""Source-only authored mutations of independently encoded IJG6b fixtures.

Only the hosted driver invokes the C encoder. This module never decodes JPEG
and never imports the product's codec. Mutations operate on marker framing.
"""


def markers(data):
    if data[:2] != b'\xff\xd8':
        raise ValueError('Expected encoder SOI')
    at = 2
    while at < len(data):
        start = at
        if data[at] != 255:
            raise ValueError('Expected marker before first scan')
        while at < len(data) and data[at] == 255:
            at += 1
        if at == len(data):
            raise ValueError('Truncated encoder marker')
        code = data[at]
        at += 1
        if code in (0xd8, 0xd9) or 0xd0 <= code <= 0xd7:
            yield code, start, at, at
            continue
        if at + 2 > len(data):
            raise ValueError('Truncated encoder marker length')
        length = int.from_bytes(data[at:at + 2], 'big')
        if length < 2 or at + length > len(data):
            raise ValueError('Invalid encoder marker length')
        yield code, start, at + 2, at + length
        at += length
        if code == 0xda:
            return


def mutate(data, operation):
    if operation == 'empty':
        return b''
    if operation == 'not-jpeg':
        return b'not a JPEG stream'
    if operation == 'soi-only':
        return b'\xff\xd8'
    if not operation:
        return data
    if not data.endswith(b'\xff\xd9'):
        raise ValueError('Independent encoder did not end at EOI')
    if operation == 'missing-eoi':
        return data[:-2]
    if operation == 'duplicate-soi':
        return data[:-2] + b'\xff\xd8\xff\xd9'
    if operation == 'trailing-bytes':
        return data + b'not another image\x00\xff\xd8'
    parsed = list(markers(data))
    if operation == 'cut-entropy':
        entropy = next(end for code, start, payload, end in parsed if code == 0xda)
        return data[:entropy + max(1, (len(data) - entropy - 2) // 2)]
    if operation == 'cut-padding':
        code, start, payload, end = next(item for item in parsed if item[0] == 0xe3)
        # Still crosses the real8192-byte fill boundary. Leave only a small
        # missing suffix so original skip_input_data's 2-byte synthetic EOI
        # fills remain inside the reference's explicit evidence budget.
        return data[:end - 3]
    selected = {'bad-precision': 0xc0, 'bad-dqt': 0xdb, 'bad-huffman': 0xc4, 'unsupported-sof': 0xc0}
    if operation not in selected:
        raise ValueError('Unknown JPEG mutation: ' + operation)
    code, start, payload, end = next(item for item in parsed if item[0] == selected[operation])
    changed = bytearray(data)
    if operation == 'bad-precision':
        changed[payload] = 12
    elif operation == 'bad-dqt':
        changed[payload] = 4
    elif operation == 'bad-huffman':
        changed[payload + 1] = 255
    else:
        changed[start + 1] = 0xc3
    return bytes(changed)


def create_cases(manifest, bases):
    if manifest.get('schema') != 1 or manifest.get('sentinel') != 165:
        raise ValueError('Unknown JPEG fixture manifest')
    cases = []
    for definition in manifest['cases']:
        recipe = manifest['bases'].get(definition.get('base'), {})
        data = mutate(bases.get(definition.get('base'), b''), definition.get('mutation'))
        cases.append({**definition, 'data': data, 'mode': definition.get('mode', 'normal'),
            'precision': definition.get('precision', 'normal'),
            'width': recipe.get('width'), 'height': recipe.get('height'),
            'recipe': recipe, 'encodingScope': 'Independent fixed IJG6b compressor; authored component pattern, not a product encoder or original game file.'})
    if len(cases) != 43 or len({case['id'] for case in cases}) != 43:
        raise ValueError('JPEG corpus must contain all 43 unique definitions')
    return cases
