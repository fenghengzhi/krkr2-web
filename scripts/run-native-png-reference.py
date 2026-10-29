"""GitHub-hosted-only libpng1.0.6 reference. Never imports the Web decoder.

Independent fixtures encode PNG chunks with Python's standard zlib; the C
reader executes the pinned upstream library and the fixed loader call order.
Every input, source hash, compiler log and raw child result is retained before
checking contracts. A child exit0 is only a report, never a passing assertion.
"""
from pathlib import Path
import hashlib
import itertools
import json
import os
import platform
import struct
import subprocess
import sys
import urllib.request
import zlib

ROOT = Path(__file__).resolve().parent.parent
OUTPUT = ROOT / 'out/verification/native-png'
SOURCE_MANIFEST = ROOT / 'tests/native/png-reference-source.json'


def sha(data):
    return hashlib.sha256(data).hexdigest()


def save(path, value):
    with path.open('x', encoding='utf-8') as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2)
        stream.write('\n')


def chunk(name, data, bad_crc=False):
    name = name.encode('ascii')
    crc = zlib.crc32(name + data) ^ (1 if bad_crc else 0)
    return struct.pack('>I', len(data)) + name + data + struct.pack('>I', crc)


def png(color, samples, *, depth=8, width=2, before=(), after=()):
    # A single independent noninterlaced row, filter0; no TS encoding/decoding.
    header = struct.pack('>IIBBBBB', width, 1, depth, color, 0, 0, 0)
    return (b'\x89PNG\r\n\x1a\n' + chunk('IHDR', header) + b''.join(before) +
            chunk('IDAT', zlib.compress(b'\0' + samples)) + b''.join(after) + chunk('IEND', b''))


def fixtures():
    cases = []
    def add(name, data, rgba, metadata=(), *, key=-1, observe=False, error=None, warning=None, native_leak=None):
        cases.append({'id': name, 'data': data, 'keyidx': key, 'observeOnly': observe,
                      'expected': {'rgba': rgba, 'metadata': list(metadata),
                                   'error': error, 'warning': warning, 'nativeErrorLeak': native_leak}})
    def m(key, value, phase='header_metadata'):
        return {'key': key, 'value': str(value), 'phase': phase}
    def offs(x, y, unit='pixel'):
        return [m('offs_x', x), m('offs_y', y), m('offs_unit', unit)]
    def phys(x, y, unit='meter'):
        return [m('reso_x', x), m('reso_y', y), m('reso_unit', unit)]
    def vp(w, h, unit='pixel', phase='read_info'):
        return [m('vpag_w', w, phase), m('vpag_h', h, phase), m('vpag_unit', unit, phase)]
    base = lambda **kw: png(2, bytes([10, 20, 30]), width=1, **kw)
    rgb = [10, 20, 30, 255, 40, 50, 60, 255]
    add('rgb-control', png(2, bytes([10, 20, 30, 40, 50, 60])), rgb)
    add('rgb-trns-stays-opaque', png(2, bytes([10, 20, 30, 40, 50, 60]),
        before=[chunk('tRNS', struct.pack('>HHH', 10, 20, 30))]), rgb)
    add('rgb16-trns-stays-opaque', png(2, struct.pack('>6H', 0x1234, 0x5678, 0x9abc, 0x1200, 0x5600, 0x9a00), depth=16,
        before=[chunk('tRNS', struct.pack('>HHH', 0x1234, 0x5678, 0x9abc))]), [18, 86, 154, 255] * 2)
    add('gray8-trns-expands-alpha', png(0, bytes([17, 18]), before=[chunk('tRNS', struct.pack('>H', 17))]),
        [17, 17, 17, 0, 18, 18, 18, 255])
    add('gray1-trns-expands-alpha', png(0, bytes([0x40]), depth=1, width=3,
        before=[chunk('tRNS', struct.pack('>H', 0))]), [0, 0, 0, 0, 255, 255, 255, 255, 0, 0, 0, 0])
    add('gray16-trns-matches-before-strip', png(0, struct.pack('>HH', 0x1234, 0x1200), depth=16,
        before=[chunk('tRNS', struct.pack('>H', 0x1234))]), [18, 18, 18, 0, 18, 18, 18, 255])
    palette = chunk('PLTE', bytes([10, 20, 30, 40, 50, 60, 70, 80, 90]))
    palette_alpha = png(3, bytes([0, 1, 2]), width=3, before=[palette, chunk('tRNS', bytes([13, 127]))])
    palette_opaque = png(3, bytes([0, 1, 2]), width=3, before=[palette])
    add('palette-original-trns', palette_alpha, [10, 20, 30, 13, 40, 50, 60, 127, 70, 80, 90, 255])
    add('palette-no-trns-control', palette_opaque, [10, 20, 30, 255, 40, 50, 60, 255, 70, 80, 90, 255])
    for key in [0, 1, 255]:
        add('palette-original-trns-key-' + str(key), palette_alpha, None, key=key, observe=True)
        # No padding/uninitialized destination byte may be read as a result.
        add('palette-no-trns-key-' + str(key), palette_opaque, None, key=key, observe=True)
    rgb_one = [10, 20, 30, 255]
    off = chunk('oFFs', struct.pack('>IIB', 0xfffffffe, 0x80000000, 0))
    phy = chunk('pHYs', struct.pack('>IIB', 0x80000000, 0xffffffff, 1))
    add('known-meta-before-reverse-order', base(before=[phy, off]), rgb_one,
        offs(-2, -2147483648) + phys(-2147483648, -1))
    add('known-meta-after-idat', base(after=[off, phy]), rgb_one)
    first_off = chunk('oFFs', struct.pack('>IIB', 1, 2, 1))
    first_phy = chunk('pHYs', struct.pack('>IIB', 3, 4, 0))
    add('known-meta-duplicate-first-wins', base(before=[first_off, first_phy, off, phy]), rgb_one,
        offs(1, 2, 'micrometer') + phys(3, 4, 'unknown'))
    add('known-meta-invalid-length-then-valid', base(before=[chunk('oFFs', b'12345678'),
        chunk('pHYs', b'1234567890'), off, phy]), rgb_one, offs(-2, -2147483648) + phys(-2147483648, -1))
    add('known-meta-unknown-units', base(before=[chunk('oFFs', struct.pack('>IIB', 5, 6, 7)),
        chunk('pHYs', struct.pack('>IIB', 7, 8, 7))]), rgb_one, offs(5, 6, 'unknown') + phys(7, 8, 'unknown'))
    for name in ['oFFs', 'pHYs']:
        add(name + '-bad-crc-no-metadata', base(before=[chunk(name, struct.pack('>IIB', 1, 2, 0), True)]),
            rgb_one, warning={'phase': 'read_info', 'contains': 'CRC error'})
    for index, letters in enumerate(itertools.product(*[(a, a.upper()) for a in 'vpag'])):
        name = ''.join(letters)
        add('vpag-case-' + name, base(before=[chunk(name, struct.pack('>IIB', 0xffffffff, 0x80000000, index % 3))]),
            rgb_one, vp(-1, -2147483648, ['pixel', 'micrometer', 'unknown'][index % 3]))
    add('vpag-long-payload', base(before=[chunk('vpAg', struct.pack('>IIB', 7, 8, 1) + b'extra')]),
        rgb_one, vp(7, 8, 'micrometer'))
    add('vpag-before-and-after', base(before=[chunk('vpAg', struct.pack('>IIB', 1, 2, 0))],
        after=[chunk('VpAG', struct.pack('>IIB', 3, 4, 1))]), rgb_one,
        vp(1, 2) + vp(3, 4, 'micrometer', 'read_end'))
    add('vpag-short-ancillary', base(before=[chunk('vpAg', b'12345678')]), rgb_one)
    add('vpag-short-critical', base(before=[chunk('VpAg', b'12345678')]), [],
        error={'phase': 'read_info', 'kind': 'libpng', 'contains': 'unknown critical chunk'},
        native_leak={'liveAllocations': 1, 'liveBytes': 8})
    for phase in ['read_info', 'read_end']:
        where = 'before' if phase == 'read_info' else 'after'
        add('vpag-bad-ancillary-crc-' + phase, base(**{where: [chunk('vpAg', struct.pack('>IIB', 9, 10, 0), True)]}),
            rgb_one, vp(9, 10, phase=phase), warning={'phase': phase, 'contains': 'CRC error', 'afterMetadata': True})
    add('vpag-bad-critical-crc', base(before=[chunk('VpAg', struct.pack('>IIB', 9, 10, 0), True)]), [],
        vp(9, 10), error={'phase': 'read_info', 'kind': 'libpng', 'contains': 'CRC error', 'afterMetadata': True})
    add('tail-critical-error-preserves-complete-row', base(after=[chunk('XxXX', b'x')]), rgb_one,
        error={'phase': 'read_end', 'kind': 'libpng', 'contains': 'unknown critical chunk'},
        native_leak={'liveAllocations': 1, 'liveBytes': 1})
    add('short-signature', b'\x89PNG', [], error={'phase': 'read_info', 'kind': 'stream-short-read', 'contains': 'ReadBuffer'})
    complete = base(); at = complete.index(b'IDAT') + 4
    add('short-idat-payload', complete[:at + 1], [], error={'phase': 'read_row', 'kind': 'stream-short-read', 'contains': 'ReadBuffer'})
    return cases


def fetch_sources(manifest, target):
    target.mkdir()
    inventory = []
    items = list(manifest['files']) + [dict(manifest['fixedLoader'], file='GraphicsLoaderIntf.cpp'),
                                      dict(manifest['originalHeader'], file='original-PNG.H')]
    for item in items:
        with urllib.request.urlopen(item['url'], timeout=45) as response:
            raw = response.read(2 * 1024 * 1024)
        path = target / item['file']
        with path.open('xb') as stream:
            stream.write(raw)
        row = {'file': item['file'], 'url': item['url'], 'bytes': len(raw), 'sha256': sha(raw)}
        inventory.append(row)
        if row['sha256'] != item['sha256'] or ('bytes' in item and row['bytes'] != item['bytes']):
            save(OUTPUT / 'source-inventory.json', inventory)
            raise RuntimeError('Pinned source mismatch: ' + item['file'])
    save(OUTPUT / 'source-inventory.json', inventory)


def compare(case, record):
    errors = []
    def need(condition, text):
        if not condition:
            errors.append(text)
    need(record.get('schema') == 1 and record.get('libpng') == '1.0.6', 'Wrong reference ABI/version')
    need(record.get('pngLongBytes') == 4 and record.get('pointerBytes') == 4, 'Original32bit ABI not established')
    need(record.get('droppedEvents') == 0, 'Dropped reference events')
    if case['observeOnly']:
        # Unsafe output is evidence, not a successful native rendering result.
        if case['id'].startswith('palette-no-trns-key-'):
            need(record.get('rgba') is None and record.get('bgra') is None, 'Unsafe destination pixels were inspected')
        need(record.get('sizeCallback') is True and record.get('rowbytes', 0) > 0, 'No rowbytes observation')
        need(record.get('status') in ['complete', 'unsafe-cleanup'] and record.get('decodeComplete') is True and
             record.get('rowsComplete') == record.get('height') == 1, 'Palette observation did not finish decoding')
        return errors
    expected = case['expected']
    need(record.get('cleanup', {}).get('unsafeFrees') == 0, 'Library attempted an unsafe free')
    cleanup = expected['nativeErrorLeak'] or {'liveAllocations': 0, 'liveBytes': 0}
    need(all(record.get('cleanup', {}).get(key) == value for key, value in cleanup.items()),
         'Library cleanup differs from declared exact allocation contract')
    error = expected['error']
    if error is None:
        need(record.get('status') == 'complete' and record.get('decodeComplete') is True, 'Decode did not complete')
        need(record.get('sizeCallback') is True and record.get('rowsComplete') == record.get('height') == 1, 'Row publication incomplete')
        need(record.get('rowbytes') == record.get('width', 0) * 4, 'Normal destination rowbytes mismatch')
    else:
        actual = record.get('error') or {}
        need(record.get('status') == 'error' and record.get('decodeComplete') is False, 'Expected decoder failure was not reported')
        need(actual.get('phase') == error['phase'] and actual.get('kind') == error['kind'] and error['contains'] in actual.get('message', ''), 'Wrong error phase/kind/message')
        if error.get('afterMetadata'):
            es = [e['sequence'] for e in record['events'] if e['kind'] == 'error']
            need(bool(es) and bool(record['metadata']) and record['metadata'][-1]['sequence'] < es[0], 'Error did not follow metadata callback')
    need(record.get('rgba') == expected['rgba'], 'Full RGBA bytes differ')
    rgba = expected['rgba']
    bgra = [v for i in range(0, len(rgba), 4) for v in [rgba[i+2], rgba[i+1], rgba[i], rgba[i+3]]]
    need(record.get('bgra') == bgra, 'Full native BGRA bytes differ')
    observed_meta = [{key: m[key] for key in ['key', 'value', 'phase']} for m in record.get('metadata', [])]
    need(observed_meta == expected['metadata'], 'Metadata values/order/callback phases differ')
    warning = expected['warning']
    if warning:
        warnings = [e for e in record['events'] if e['kind'] == 'warning' and e['phase'] == warning['phase'] and warning['contains'] in e['detail']]
        need(bool(warnings), 'Expected ignored warning not observed')
        if warning.get('afterMetadata'):
            need(bool(warnings) and bool(record['metadata']) and record['metadata'][-1]['sequence'] < warnings[0]['sequence'], 'Warning did not follow metadata callback')
    return errors


def run():
    OUTPUT.mkdir(parents=True, exist_ok=True)
    environment = {'schema': 1, 'scope': 'Pinned upstream libpng1.0.6 and fixed loader normal calls; not original Windows deelibpng binary identity',
                   'platform': platform.platform(), 'machine': platform.machine(), 'python': sys.version,
                   'commit': os.environ.get('GITHUB_SHA'), 'runId': os.environ.get('GITHUB_RUN_ID'),
                   'attempt': os.environ.get('GITHUB_RUN_ATTEMPT'), 'runner': os.environ.get('RUNNER_ENVIRONMENT'),
                   'zlibFixtureRuntime': zlib.ZLIB_RUNTIME_VERSION,
                   'probeSha256': sha((ROOT / 'tests/native/png-reference.c').read_bytes()),
                   'driverSha256': sha(Path(__file__).read_bytes()), 'sourceManifestSha256': sha(SOURCE_MANIFEST.read_bytes())}
    save(OUTPUT / 'environment.json', environment)
    manifest = json.loads(SOURCE_MANIFEST.read_text())
    save(OUTPUT / 'source-manifest.json', manifest)
    cases = fixtures()
    if len({c['id'] for c in cases}) != len(cases):
        raise RuntimeError('Duplicate case ID')
    inputs = OUTPUT / 'inputs'; inputs.mkdir()
    inventory = []
    for case in cases:
        data = case.pop('data'); path = inputs / (case['id'] + '.png')
        with path.open('xb') as stream:
            stream.write(data)
        case.update({'path': str(path.relative_to(OUTPUT)), 'bytes': len(data), 'sha256': sha(data)})
        inventory.append(case)
    save(OUTPUT / 'case-manifest.json', inventory)
    source = OUTPUT / 'source'; fetch_sources(manifest, source)
    binary = OUTPUT / 'png-reference'
    command = ['gcc', '-m32', '-std=gnu11', '-O0', '-g', '-DPNG_USER_MEM_SUPPORTED', '-DPNG_NO_ASSEMBLER_CODE',
               '-I' + str(source), str(ROOT / 'tests/native/png-reference.c')]
    command += [str(source / x['file']) for x in manifest['files'] if x['file'].endswith('.c')]
    command += ['-lz', '-lm', '-o', str(binary)]
    version = subprocess.run(['gcc', '--version'], capture_output=True, check=False, timeout=15)
    (OUTPUT / 'compiler.txt').write_bytes(version.stdout + version.stderr)
    save(OUTPUT / 'build-command.json', command)
    try:
        build = subprocess.run(command, capture_output=True, check=False, timeout=180)
    except subprocess.TimeoutExpired as error:
        (OUTPUT / 'build.stdout').write_bytes(error.stdout or b'')
        (OUTPUT / 'build.stderr').write_bytes(error.stderr or b'')
        save(OUTPUT / 'build-result.json', {'exitCode': None, 'timeoutSeconds': 180})
        raise RuntimeError('Native reference compilation exceeded180s; partial logs retained') from error
    (OUTPUT / 'build.stdout').write_bytes(build.stdout); (OUTPUT / 'build.stderr').write_bytes(build.stderr)
    save(OUTPUT / 'build-result.json', {'exitCode': build.returncode})
    if build.returncode:
        raise RuntimeError('Native reference compilation failed; original logs retained')
    results = []; rawdir = OUTPUT / 'raw'; rawdir.mkdir()
    for case in cases:
        command = [str(binary), str(OUTPUT / case['path']), str(case['keyidx'])]
        result = {'id': case['id'], 'inputSha256': case['sha256'], 'observeOnly': case['observeOnly'], 'command': command}
        try:
            child = subprocess.run(command, capture_output=True, check=False, timeout=10)
            (rawdir / (case['id'] + '.stdout')).write_bytes(child.stdout)
            (rawdir / (case['id'] + '.stderr')).write_bytes(child.stderr)
            result['exitCode'] = child.returncode
            if child.returncode:
                raise RuntimeError('Reference process exited ' + str(child.returncode))
            if len(child.stdout) > 1024 * 1024:
                raise RuntimeError('Reference report exceeds 1MiB')
            record = json.loads(child.stdout)
            result['record'] = record
            result['mismatches'] = compare(case, record)
            result['classification'] = ('reference-mismatch' if result['mismatches'] else
                'observation-only-unsafe' if case['observeOnly'] and (record['cleanup']['unsafeFrees'] or record['cleanup']['liveAllocations'] or record.get('rgba') is None) else
                'observation-only' if case['observeOnly'] else
                'expected-native-error-with-leak' if case['expected']['nativeErrorLeak'] else 'contract-matched')
        except subprocess.TimeoutExpired as error:
            (rawdir / (case['id'] + '.stdout')).write_bytes(error.stdout or b'')
            (rawdir / (case['id'] + '.stderr')).write_bytes(error.stderr or b'')
            result.update({'classification': 'process-timeout', 'mismatches': ['Reference exceeded10s']})
        except Exception as error:
            result.update({'classification': 'process-or-report-error', 'mismatches': [str(error)]})
        results.append(result)
        save(rawdir / (case['id'] + '.json'), result)
        with (OUTPUT / 'observations.jsonl').open('a', encoding='utf-8') as stream:
            stream.write(json.dumps(result, ensure_ascii=False) + '\n')
    control = next((r for r in results if r['id'] == 'palette-original-trns'), None)
    palette_observations = []
    for result in results:
        if not result['observeOnly']:
            continue
        record = result.get('record', {})
        control_rgba = control.get('record', {}).get('rgba') if control else None
        candidate_rgba = record.get('rgba')
        comparable = (control is not None and control['classification'] == 'contract-matched' and
                      isinstance(control_rgba, list) and isinstance(candidate_rgba, list))
        palette_observations.append({'id': result['id'], 'classification': result['classification'],
            'rowbytes': record.get('rowbytes'),
            'sameRgbaAsOriginalTrns': candidate_rgba == control_rgba if comparable else None,
            'comparisonStatus': 'compared' if comparable else 'uncompared',
            'uncomparedReason': None if comparable else
                'Original tRNS control did not match its contract' if not control or control['classification'] != 'contract-matched' else
                'Candidate pixels are absent or deliberately unobserved for unsafe layout',
            'transparencyState': record.get('transparencyState'), 'cleanup': record.get('cleanup')})
    summary = {'schema': 1, 'planned': len(cases), 'reported': len(results),
        'cleanMatchedContracts': sum(r['classification'] == 'contract-matched' for r in results),
        'expectedNativeErrorLeaks': sum(r['classification'] == 'expected-native-error-with-leak' for r in results),
        'expectedNativeErrorLeakCases': [{'id': c['id'], 'expected': c['expected']['nativeErrorLeak'],
            'sourceReason': 'Pinned pngrutil.c png_handle_unknown raises unknown critical chunk after allocating chunk.data and before its png_free; harness reclaims only after recording the original library cleanup state.'}
            for c in cases if c['expected']['nativeErrorLeak']],
        'observationOnly': sum(r['classification'].startswith('observation-only') for r in results),
        'failures': [r['id'] for r in results if r['mismatches']],
        'paletteObservations': palette_observations,
        'scope': environment['scope'], 'productDecoderExecuted': False,
        'unsafePolicy': 'Palette without original tRNS and with keyidx only reports rowbytes; no pixel bytes inspected. Refused unknown frees and retained library allocations are explicit evidence, never silently accepted as native cleanup.'}
    save(OUTPUT / 'summary.json', summary)
    print(json.dumps(summary, ensure_ascii=False))
    return 1 if summary['failures'] or summary['reported'] != summary['planned'] else 0


if __name__ == '__main__':
    if os.environ.get('GITHUB_ACTIONS') != 'true' or os.environ.get('RUNNER_ENVIRONMENT') != 'github-hosted' or sys.platform != 'linux':
        raise SystemExit('Native PNG reference runs only on GitHub-hosted Linux Actions.')
    try:
        status = run()
    except Exception as error:
        OUTPUT.mkdir(parents=True, exist_ok=True)
        save(OUTPUT / 'driver-error.json', {'type': type(error).__name__, 'message': str(error)})
        raise
    raise SystemExit(status)
