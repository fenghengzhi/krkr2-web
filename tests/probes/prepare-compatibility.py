"""Verify preserved release/corpus bytes and unpack them on a hosted runner."""
import hashlib
import json
import pathlib
import re
import tarfile
import zipfile

SOURCE = pathlib.Path('tests/fixtures/compatibility')
OUTPUT = pathlib.Path('out/verification/compatibility-baselines')


def digest(data):
    return hashlib.sha256(data).hexdigest()


def encoded(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':')).encode()


manifest = json.loads((SOURCE / 'manifest.json').read_bytes())
assert manifest['schema'] == 1
results = []
for release in manifest['releases']:
    assert re.fullmatch(r'[a-z0-9-]+', release['id'])
    assert release['archive'] == release['id'] + '.tar.gz'
    archive = SOURCE / release['archive']
    data = archive.read_bytes()
    assert len(data) == release['archiveBytes']
    assert digest(data) == release['archiveSha256']
    root = OUTPUT / release['id']
    count = total = 0
    seen = set()
    with tarfile.open(archive, 'r:gz') as packed:
        for member in packed:
            path = pathlib.PurePosixPath(member.name)
            assert member.isfile() and not path.is_absolute() and '..' not in path.parts
            assert member.name == str(path) and member.name not in seen
            seen.add(member.name)
            count += 1
            total += member.size
            assert count <= release['tree']['files'] and total <= release['tree']['bytes']
            target = root / member.name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(packed.extractfile(member).read())
    rows = []
    for file in sorted(path for path in root.rglob('*') if path.is_file()):
        data = file.read_bytes()
        rows.append([file.relative_to(root).as_posix(), len(data), digest(data)])
    tree = {'files': len(rows), 'bytes': sum(row[1] for row in rows), 'sha256': digest(encoded(rows))}
    assert tree == release['tree'], release['id']

    # Verify the original shell's complete asset graph and build token, without
    # imposing today's font ABI on historical applications that predate it.
    script = (root / 'sw.js').read_bytes().decode()
    prefix = 'self.__KRKR_SHELL__='
    assert script.startswith(prefix)
    end = script.index(';\n')
    shell = json.loads(script[len(prefix):end])
    assert shell['schema'] == 1 and shell['build'] == release['build']
    listed = [asset['path'] for asset in shell['assets']]
    assert len(set(listed)) == len(listed)
    assert sorted(listed + ['sw.js']) == [row[0] for row in rows]
    entries = []
    asset_bytes = 0
    for asset in shell['assets']:
        data = (root / asset['path']).read_bytes()
        assert len(data) == asset['bytes'] and digest(data) == asset['sha256']
        asset_bytes += len(data)
        if asset['path'] == 'index.html':
            data = data.decode().replace(shell['build'], '__KRKR_BUILD_TOKEN__', 1).encode()
        entries.append([asset['path'], digest(data)])
    assert asset_bytes == shell['bytes']
    build = digest(encoded({'schema': 1, 'worker': digest(script[end + 2:].encode()), 'files': entries}))
    assert build == release['build']
    assert json.loads((root / 'wasm/manifest.json').read_bytes())['abi'] == release['tjsAbi']
    font = root / 'fonts/manifest.json'
    assert (json.loads(font.read_bytes())['abi'] if font.exists() else None) == release['fontAbi']
    results.append({'id': release['id'], 'build': build, 'tree': tree})

pair = json.loads((SOURCE / 'kag3_template.zip.json').read_bytes())
assert digest((SOURCE / pair['source']).read_bytes()) == pair['sourceSha256']
assert digest((SOURCE / pair['zip']).read_bytes()) == pair['zipSha256']
with zipfile.ZipFile(SOURCE / pair['zip']) as archive:
    assert sorted(archive.namelist()) == sorted(row['name'] for row in pair['entries'])
    assert len(archive.namelist()) == len(pair['entries'])
    for row in pair['entries']:
        data = archive.read(row['name'])  # Also verifies each ZIP CRC.
        assert len(data) == row['size'] and digest(data) == row['sha256']
assert sum(row['size'] for row in pair['entries']) == pair['decodedBytes']
report = pathlib.Path('out/ci/compatibility-fixtures.json')
report.parent.mkdir(parents=True, exist_ok=True)
report.write_text(json.dumps({'releases': results, 'kag': pair}, ensure_ascii=False, indent=2) + '\n')
print(f'Verified {len(results)} original release trees and the 30-member KAG corpus')
