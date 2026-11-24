"""Prepare exact Emscripten port archives from codeload, with failure evidence.

Shared by the main font build and the independent PNG inflater build. This
does not compile a port or run a codec; emcc remains the build authority.
"""
import argparse
import ast
import hashlib
import json
import os
import pathlib
import shutil
import subprocess
import tempfile
import urllib.request


def main():
    if os.environ.get('GITHUB_ACTIONS') != 'true' or os.environ.get('RUNNER_ENVIRONMENT') != 'github-hosted':
        raise RuntimeError('Prepare Emscripten ports only on GitHub-hosted Actions')
    parser = argparse.ArgumentParser()
    parser.add_argument('--evidence', required=True)
    parser.add_argument('ports', nargs='+', choices=['zlib', 'freetype'])
    args = parser.parse_args()
    destination = pathlib.Path(args.evidence)
    destination.parent.mkdir(parents=True, exist_ok=True)
    record = {'schema': 1, 'commit': os.environ.get('GITHUB_SHA'), 'requested': args.ports,
              'toolchain': None, 'ports': [], 'status': 'preparing'}

    def save():
        # Keep the existing font-ports.json array contract for archived-run
        # reporting; the sibling retains setup/failure state even before a
        # first download can complete.
        destination.write_text(json.dumps(record['ports'], indent=2) + '\n')
        destination.with_suffix('.status.json').write_text(json.dumps(record, indent=2) + '\n')

    save()
    try:
        emscripten = pathlib.Path(os.environ['EMSDK']) / 'upstream/emscripten'
        version_file = emscripten / 'emscripten-version.txt'
        record['toolchain'] = version_file.read_text().strip().replace('"', '')
        shutil.copyfile(version_file, destination.with_suffix('.emscripten-version.txt'))
        if record['toolchain'] != '6.0.9':
            raise RuntimeError('Unexpected Emscripten toolchain version')
        configured = subprocess.check_output([str(emscripten / 'em-config'), 'PORTS'], text=True).strip()
        if not configured:
            raise RuntimeError('Emscripten did not report its port cache directory')
        ports = pathlib.Path(configured)
        ports.mkdir(parents=True, exist_ok=True)
        recipes = {'zlib': ('madler/zlib', 'tar.gz'), 'freetype': ('freetype/freetype', 'zip')}
        for name in args.ports:
            repo, extension = recipes[name]
            source = (emscripten / 'tools/ports' / (name + '.py')).read_bytes()
            destination.with_suffix('.' + name + '-port.py').write_bytes(source)
            values = {}
            for item in ast.parse(source).body:
                if isinstance(item, ast.Assign) and len(item.targets) == 1 and isinstance(item.targets[0], ast.Name):
                    key = item.targets[0].id
                    if key in ('VERSION', 'TAG', 'HASH'):
                        values[key] = ast.literal_eval(item.value)
            tag = 'v' + values['VERSION'] if name == 'zlib' else values['TAG']
            original = (f'https://github.com/{repo}/archive/refs/tags/{tag}.tar.gz'
                        if name == 'zlib' else f'https://github.com/{repo}/archive/{tag}.zip')
            url = f'https://codeload.github.com/{repo}/{extension}/refs/tags/{tag}'
            entry = {'name': name, 'tag': tag, 'url': url, 'originalUrl': original,
                     'portSha256': hashlib.sha256(source).hexdigest(), 'expectedSha512': values['HASH'],
                     'status': 'downloading'}
            record['ports'].append(entry)
            save()
            with urllib.request.urlopen(url, timeout=90) as response:
                data = response.read()
            actual = hashlib.sha512(data).hexdigest()
            entry.update(bytes=len(data), sha512=actual)
            if actual != values['HASH']:
                raise RuntimeError(f'{name} archive differs from pinned Emscripten SHA-512: {actual}')
            with tempfile.TemporaryDirectory(dir=ports) as temporary:
                archive = pathlib.Path(temporary) / ('source.' + extension)
                archive.write_bytes(data)
                unpacked = pathlib.Path(temporary) / 'unpacked'
                shutil.unpack_archive(archive, unpacked)
                (unpacked / '.emscripten_url').write_text(original + '\n')
                target = ports / name
                if target.exists():
                    shutil.rmtree(target)
                os.replace(unpacked, target)
            entry['status'] = 'prepared'
            save()
            print(f'Prepared {name} {tag}: {actual}', flush=True)
        record['status'] = 'prepared'
    except BaseException as error:
        record['status'] = 'failed'
        record['error'] = repr(error)
        raise
    finally:
        save()


if __name__ == '__main__':
    main()
