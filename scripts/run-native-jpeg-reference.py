#!/usr/bin/env python3
"""Hosted-only fixed-source JPEG fixtures and independent C caller observations.

--fixtures-only is a build prerequisite, not a decoder compatibility verdict.
--reference consumes that exact generated pack and records the native caller.
"""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import platform
import subprocess
import sys
import tarfile
import urllib.request
from native_jpeg_fixtures import create_cases

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'native/image-jpeg/source.json'
CASES = ROOT / 'tests/native/jpeg-cases.json'
PROBE = ROOT / 'tests/native/jpeg-reference.c'
ENCODER = ['jcapimin.c', 'jcapistd.c', 'jccoefct.c', 'jccolor.c', 'jcdctmgr.c', 'jchuff.c',
           'jcinit.c', 'jcmainct.c', 'jcmarker.c', 'jcmaster.c', 'jcparam.c', 'jcphuff.c',
           'jcprepct.c', 'jcsample.c', 'jctrans.c', 'jdatadst.c', 'jfdctflt.c', 'jfdctfst.c']


def sha(value):
    return hashlib.sha256(value).hexdigest()


def save(path, value):
    with path.open('x', encoding='utf-8') as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2)
        stream.write('\n')


def verified(value, expected, name):
    if len(value) != expected['bytes'] or sha(value) != expected['sha256']:
        raise RuntimeError('Pinned bytes differ: ' + name)
    return value


def bounded_download(entry):
    with urllib.request.urlopen(entry['url'], timeout=45) as response:
        data = response.read(4 * 1024 * 1024 + 1)
    return verified(data, entry, entry['url'])


def materialize_sources(output, source, fixture_pack=None):
    directory = output / 'source'
    directory.mkdir()
    if fixture_pack is None:
        archive = bounded_download(source['archive'])
        (output / 'jpegsrc.v6b.tar.gz').write_bytes(archive)
        wanted = {entry['file']: entry for entry in source['files']}
        with tarfile.open(fileobj=io.BytesIO(archive), mode='r:gz') as packed:
            for item in packed.getmembers():
                name = item.name.removeprefix('jpeg-6b/')
                if name not in wanted:
                    continue
                if not item.isfile() or '/' in name or item.size > 2 * 1024 * 1024:
                    raise RuntimeError('Unsafe JPEG source member: ' + name)
                stream = packed.extractfile(item)
                if stream is None:
                    raise RuntimeError('Missing source member: ' + name)
                with stream:
                    data = verified(stream.read(), wanted[name], name)
                with (directory / name).open('xb') as target:
                    target.write(data)
        for name in wanted:
            if not (directory / name).is_file():
                raise RuntimeError('Missing pinned source: ' + name)
        for entry in source['originalHeaders']:
            (directory / entry['file']).write_bytes(bounded_download(entry))
    else:
        effective = {entry['file']: entry for entry in source['files']}
        effective.update({entry['file']: entry for entry in source['originalHeaders']})
        for name, entry in effective.items():
            if '/' in name or name in ('.', '..'):
                raise RuntimeError('Unsafe pinned source path')
            data = verified((fixture_pack / 'source' / name).read_bytes(), entry, name)
            with (directory / name).open('xb') as target:
                target.write(data)
    files = {}
    for path in sorted(directory.iterdir()):
        data = path.read_bytes()
        files[path.name] = {'bytes': len(data), 'sha256': sha(data)}
    save(output / 'effective-source.json', {'archive': source['archive'], 'files': files,
        'originalHeaders': source['originalHeaders'], 'configuration': 'Pinned original jconfig.h/jmorecfg.h; 32bit gcc, -fwrapv -fno-strict-aliasing -ffp-contract=off. Native float execution is not a claim about Borland/x87 binary identity.'})
    return directory


def run_bounded(command, output, name, timeout):
    save(output / (name + '.command.json'), [str(part) for part in command])
    try:
        result = subprocess.run(command, capture_output=True, check=False, timeout=timeout)
    except subprocess.TimeoutExpired as error:
        (output / (name + '.stdout')).write_bytes(error.stdout or b'')
        (output / (name + '.stderr')).write_bytes(error.stderr or b'')
        save(output / (name + '.result.json'), {'exitCode': None, 'timeoutSeconds': timeout})
        raise RuntimeError(name + ' exceeded its explicit deadline') from error
    (output / (name + '.stdout')).write_bytes(result.stdout)
    (output / (name + '.stderr')).write_bytes(result.stderr)
    save(output / (name + '.result.json'), {'exitCode': result.returncode})
    if result.returncode:
        raise RuntimeError(name + ' exited ' + str(result.returncode))
    if len(result.stdout) > 16 * 1024 * 1024:
        raise RuntimeError(name + ' output exceeded 16MiB')
    return result.stdout


def compile_reference(output, source, directory):
    binary = output / 'jpeg-reference'
    sources = list(dict.fromkeys(source['decoderSources'] + ENCODER))
    command = ['gcc', '-m32', '-std=c11', '-O0', '-g', '-fwrapv', '-fno-strict-aliasing', '-ffp-contract=off',
               '-msse2', '-mfpmath=sse', '-I' + str(directory), str(PROBE)]
    command += [str(directory / name) for name in sources]
    command += ['-lm', '-o', str(binary)]
    run_bounded(['gcc', '--version'], output, 'compiler', 15)
    run_bounded(command, output, 'compile', 180)
    return binary


def environment(route):
    return {'schema': 1, 'route': route, 'commit': os.environ.get('GITHUB_SHA'),
        'runId': os.environ.get('GITHUB_RUN_ID'), 'attempt': os.environ.get('GITHUB_RUN_ATTEMPT'),
        'runner': os.environ.get('RUNNER_ENVIRONMENT'), 'platform': platform.platform(), 'python': sys.version,
        'probeSha256': sha(PROBE.read_bytes()), 'driverSha256': sha(Path(__file__).read_bytes()),
        'fixtureSourceSha256': sha((ROOT / 'scripts/native_jpeg_fixtures.py').read_bytes()),
        'sourceManifestSha256': sha(SOURCE.read_bytes()), 'caseManifestSha256': sha(CASES.read_bytes())}


def generate(output, source, manifest, binary):
    # Enum metadata only; fixtures-only never calls the native decoder.
    save(output / 'codes.json', json.loads(run_bounded([str(binary), '--codes'], output, 'codes', 10)))
    base_directory = output / 'bases'
    base_directory.mkdir()
    logs = output / 'encoder'; logs.mkdir()
    bases, encoder_records = {}, []
    for name, recipe in manifest['bases'].items():
        if not name.replace('-', '').isalnum():
            raise RuntimeError('Unsafe JPEG base name')
        path = base_directory / (name + '.jpg')
        command = [str(binary), '--encode', str(path), recipe['kind'], str(recipe['width']), str(recipe['height']),
            str(int(recipe.get('progressive', False))), str(recipe.get('restart', 0)), str(int(recipe.get('padding', False)))]
        run_bounded(command, logs, name, 15)
        data = path.read_bytes()
        if not 4 <= len(data) <= 1048576 or not data.startswith(b'\xff\xd8') or not data.endswith(b'\xff\xd9'):
            raise RuntimeError('Independent encoder emitted an invalid bounded envelope')
        bases[name] = data
        encoder_records.append({'name': name, 'recipe': recipe, 'bytes': len(data), 'sha256': sha(data)})
    save(output / 'encoder-manifest.json', encoder_records)
    cases = create_cases(manifest, bases)
    inputs = output / 'inputs'; inputs.mkdir()
    inventory = []
    for case in cases:
        data = case.pop('data'); path = inputs / (case['id'] + '.jpg')
        path.write_bytes(data)
        inventory.append({**case, 'path': 'inputs/' + path.name, 'bytes': len(data), 'sha256': sha(data)})
    save(output / 'case-manifest.json', inventory)
    save(output / 'summary.json', {'schema': 1, 'status': 'fixtures-generated', 'planned': 43, 'generated': len(inventory),
        'decoderExecuted': False, 'sourceCommit': os.environ.get('GITHUB_SHA'),
        'scope': 'Independent fixed-source encoder and authored byte mutations only. No native decoding or product compatibility verdict.'})


def inspect_case(case, record, codes):
    failures = []
    def need(condition, reason):
        if not condition:
            failures.append(reason)
    need(record.get('schema') == 1 and record.get('version') == 62, 'Wrong JPEG reference schema/version')
    need([record.get('pointerBytes'), record.get('longBytes'), record.get('multiplierBytes')] == [4, 4, 2], 'Wrong scalar ABI')
    need(record.get('rgbOffsets') == [2, 1, 0], 'Original BGR configuration absent')
    need(record.get('mode') == case['mode'] and record.get('precision') == case['precision'], 'Wrong selected request')
    need(record.get('dropped') == 0, 'Reference evidence was truncated')
    need(record.get('status') in ('complete', 'error'), 'Reference did not settle')
    if case['expect'] == 'complete':
        need(record.get('status') == 'complete', 'Valid control did not complete')
    if case['expect'] == 'codec-error':
        need(record.get('status') == 'error' and (record.get('error') or {}).get('kind') == 'codec', 'Required native error did not occur')
        need((record.get('error') or {}).get('code') == codes[case['code']], 'Wrong required numeric error')
    if record.get('status') == 'error':
        need((record.get('error') or {}).get('kind') == 'codec', 'Reference infrastructure failed instead of decoding')
    if case.get('eofWarning'):
        need(record.get('syntheticEoi', 0) > 0 and record.get('warnings', {}).get('count', 0) > 0, 'Missing original EOF recovery')
    width, height, count = record.get('width', 0), record.get('height', 0), record.get('rowsComplete', 0)
    rows, batches = record.get('rows', []), record.get('batches', [])
    stride = width * (1 if case['mode'] == 'grayscale' else 4)
    if record.get('sizeCallback'):
        need([width, height] == [case['width'], case['height']], 'Decoded dimensions differ')
        need(isinstance(record.get('destination'), list) and len(record['destination']) == stride * height, 'Destination is missing')
        need(len(rows) == count and 0 <= count <= height, 'Completed-row inventory differs')
        for y, row in enumerate(rows):
            need(row.get('y') == y and len(row.get('bytes', [])) == stride, 'Invalid caller row')
            need(record['destination'][y * stride:(y + 1) * stride] == row['bytes'], 'Final bytes differ from committed row')
            batch = batches[row['batch']] if 0 <= row.get('batch', -1) < len(batches) else {}
            need(not batch.get('failed', True) and batch.get('start', -1) <= y < batch.get('end', -1), 'Row published from a failed/private batch')
        need(record['destination'][count * stride:] == [165] * ((height - count) * stride), 'Uncommitted caller bytes changed')
        if record.get('status') == 'complete':
            need(count == height, 'Successful control did not publish every row')
        if 'constant' in case:
            value = case['constant']
            need(record['destination'] == [value, value, value, 255] * width * height, 'Authored constant DC pixels differ')
        if 'constantRgb' in case:
            need(case['constantRgb'] == [32, 96, 160] and case['mode'] == 'normal' and [width, height] == [3, 2],
                 'Authored direct RGB constant recipe differs')
            # JCS_RGB/null_convert keeps source R,G,B order. The original
            # TVP converter packs those bytes as physical B,G,R,255.
            need(record.get('jpegColorSpace') == 2 and record.get('outColorSpace') == 2 and record.get('components') == 3,
                 'Direct RGB control did not use the original RGB/null-conversion path')
            need(record['destination'] == [32, 96, 160, 255] * 6,
                 'Authored direct RGB DC control differs from literal physical BGRA')
    else:
        need(count == 0 and not rows and record.get('destination') is None, 'Header/start error changed the caller')
    cleanup = record.get('originalCleanup', {})
    need(cleanup.get('badFrees') == 0, 'Original/harness attempted an unowned free')
    phase = (record.get('error') or {}).get('phase')
    protected = phase in ('size', 'rows')
    if record.get('status') == 'complete' or protected:
        need(cleanup.get('destroyed') is True and cleanup.get('liveAllocations') == 0 and cleanup.get('liveBytes') == 0,
             'Protected original cleanup did not release library allocations')
    else:
        need(cleanup.get('destroyed') is False, 'Original outside-try failure was falsely reported as destroyed')
    return failures


def reference(output, fixture_pack, source, binary):
    original = json.loads((fixture_pack / 'environment.json').read_text())
    expected_environment = environment('reference')
    for key in ['commit', 'probeSha256', 'driverSha256', 'fixtureSourceSha256', 'sourceManifestSha256', 'caseManifestSha256']:
        if original.get(key) != expected_environment[key]:
            raise RuntimeError('Fixture provenance differs: ' + key)
    inventory = json.loads((fixture_pack / 'case-manifest.json').read_text())
    if len(inventory) != 43 or len({case['id'] for case in inventory}) != 43:
        raise RuntimeError('Incomplete independent JPEG corpus')
    save(output / 'case-manifest.json', inventory)
    codes = json.loads(run_bounded([str(binary), '--codes'], output, 'codes', 10))
    save(output / 'codes.json', codes)
    raw = output / 'raw'; raw.mkdir(); inputs = output / 'inputs'; inputs.mkdir()
    results = []
    for case in inventory:
        if case['path'] != 'inputs/' + case['id'] + '.jpg' or not case['id'].replace('-', '').isalnum():
            raise RuntimeError('Unsafe fixture path')
        data = verified((fixture_pack / case['path']).read_bytes(), case, case['id'])
        path = inputs / (case['id'] + '.jpg'); path.write_bytes(data)
        result = {'id': case['id'], 'inputSha256': case['sha256'], 'status': 'unobserved', 'failures': []}
        try:
            stdout = run_bounded([str(binary), str(path), case['mode'], case['precision']], raw, case['id'], 15)
            record = json.loads(stdout)
            result['record'] = record
            result['failures'] = inspect_case(case, record, codes)
            harness = json.loads((raw / (case['id'] + '.stderr')).read_text())
            if harness != {'harnessCleanup': {'liveAllocations': 0, 'liveBytes': 0, 'badFrees': 0}}:
                result['failures'].append('Reference harness did not reclaim its original residual allocations')
            result['harnessCleanup'] = harness['harnessCleanup']
            result['status'] = 'mismatched' if result['failures'] else 'observed'
            result['cleanupDomain'] = 'original-destroyed' if record['originalCleanup']['destroyed'] else 'outside-original-try; harness-reclaimed-after-report'
        except Exception as error:
            result['failures'].append(str(error))
        save(raw / (case['id'] + '.json'), result)
        results.append(result)
    failed = [r['id'] for r in results if r['status'] != 'observed']
    save(output / 'summary.json', {'schema': 1, 'planned': 43, 'reported': len(results), 'failures': failed,
        'sourceCommit': os.environ.get('GITHUB_SHA'), 'results': results,
        'scope': 'Fixed C loader observations; original outside-try allocations recorded before harness cleanup. Not a product compatibility pass.'})
    return 1 if failed else 0


def main():
    parser = argparse.ArgumentParser()
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--fixtures-only', action='store_true')
    mode.add_argument('--reference', type=Path)
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    output = (args.output or ROOT / ('out/verification/jpeg-fixtures' if args.fixtures_only else 'out/verification/native-jpeg')).resolve()
    output.mkdir(parents=True, exist_ok=True)
    try:
        source = json.loads(SOURCE.read_text())
        if source.get('schema') != 1 or source.get('version') != '6b' or source.get('jpegAbi') != 62:
            raise RuntimeError('Unexpected pinned JPEG source')
        save(output / 'environment.json', environment('fixtures-only' if args.fixtures_only else 'reference'))
        save(output / 'source-manifest.json', source)
        manifest = json.loads(CASES.read_text()); save(output / 'definitions.json', manifest)
        fixture_pack = args.reference.resolve() if args.reference else None
        directory = materialize_sources(output, source, fixture_pack)
        binary = compile_reference(output, source, directory)
        if args.fixtures_only:
            generate(output, source, manifest, binary)
            return 0
        return reference(output, fixture_pack, source, binary)
    except Exception as error:
        save(output / 'driver-error.json', {'type': type(error).__name__, 'message': str(error)})
        raise


if __name__ == '__main__':
    if os.environ.get('GITHUB_ACTIONS') != 'true' or os.environ.get('RUNNER_ENVIRONMENT') != 'github-hosted' or sys.platform != 'linux':
        raise SystemExit('JPEG fixtures/reference run only on GitHub-hosted Linux Actions.')
    raise SystemExit(main())
