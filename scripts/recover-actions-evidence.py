"""One hosted-only archival pass over fixed119 IDs; never execute old artifacts."""
from pathlib import Path
import collections
import datetime
import hashlib
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile

REPOSITORY = 'fenghengzhi/krkr2-web'
REQUEST = Path('.github/evidence-recovery/119-request.json')
OUTPUT = Path('out/verification/evidence-recovery-119')
EXPECTED_RUNS = {
    40791060043: '2f38ee94b686cbfa487f6137ea44d026af53cd16',
    40794100263: 'cfd4ed7cc893aba8d17932d6bc84f8c85ddef96f',
    40798634885: '5784993da5a6e5d48fc0e7cd92ad133ddab57930',
    40801785412: '2f22e878502353c9c8e93e72e78c34c7d306ae1e',
    40805119639: '32a1945fc88b0acccf3aab90ab7f1d7e9548d0fd',
    45469186113: '0ff9f1080ac82bb37258ddb96aa6045b40e284e0',
}
MAX_ARTIFACT = 128 * 1024 * 1024
MAX_LOG = 8 * 1024 * 1024
MAX_TOTAL = 896 * 1024 * 1024
ERROR_BODY = 64 * 1024


def save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('x', encoding='utf-8') as output:
        json.dump(value, output, ensure_ascii=False, indent=2)
        output.write('\n')


def scrub(value):
    # Redirect URLs may contain signed query strings. Never log them, including
    # when a transport exception or an HTTP error body happens to repeat one.
    text = str(value)
    token = os.environ.get('GITHUB_TOKEN')
    if token:
        text = text.replace(token, '[credential omitted]')
    text = re.sub(r'https?://[^\s<>"\']+', '[URL omitted]', text)
    text = re.sub(r'(?i)\b(?:Bearer|Basic)\s+\S+', '[authorization omitted]', text)
    text = re.sub(r'\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)', '[credential omitted]', text)
    return ''.join(character for character in text if character in '\n\t' or ord(character) >= 32 and ord(character) != 127)


class Redirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, url):
        if urllib.parse.urlsplit(url).scheme != 'https':
            raise ValueError('Non-HTTPS evidence redirect rejected')
        redirected = super().redirect_request(request, response, code, message, headers, url)
        if redirected is not None and urllib.parse.urlsplit(url).netloc != 'api.github.com':
            redirected.remove_header('Authorization')
        return redirected


def validated_request(raw):
    value = json.loads(raw)
    if (value.get('schema'), value.get('batch'), value.get('repository')) != (1, 119, REPOSITORY):
        raise ValueError('Request identity differs from the fixed recovery')
    if {entry['runId']: entry['headSha'] for entry in value['snapshots']} != EXPECTED_RUNS:
        raise ValueError('Request source commits differ from frozen119')
    if len(value['artifacts']) != 75 or len(value['jobLogs']) != 20:
        raise ValueError('Request must contain exactly75 artifacts and20 failed-job logs')
    if value.get('artifactCount') != 75 or value.get('jobLogCount') != 20:
        raise ValueError('Request counts disagree')
    ids = set()
    for entry in value['artifacts'] + value['jobLogs']:
        if EXPECTED_RUNS.get(entry['runId']) != entry['headSha'] or not isinstance(entry['id'], int) or entry['id'] <= 0:
            raise ValueError('Evidence ID or source commit is outside the allowlist')
        identity = ('artifact' if 'sha256' in entry else 'job-log', entry['id'])
        if identity in ids:
            raise ValueError('Duplicate evidence request')
        ids.add(identity)
    for entry in value['artifacts']:
        if not re.fullmatch(r'[A-Za-z0-9._-]+', entry['name']) or not re.fullmatch(r'[0-9a-f]{64}', entry['sha256']):
            raise ValueError('Unsafe artifact name or invalid frozen digest')
        if not isinstance(entry['bytes'], int) or not 0 < entry['bytes'] <= MAX_ARTIFACT:
            raise ValueError('Artifact exceeds the fixed per-original budget')
    if any(entry['snapshotConclusion'] not in ('failure', 'cancelled') for entry in value['jobLogs']):
        raise ValueError('Job log request is not from a frozen failed job')
    if sum(entry['bytes'] for entry in value['artifacts']) != 629040186 or value.get('expectedArtifactBytes') != 629040186:
        raise ValueError('Frozen artifact byte total differs')
    if value['limits'] != {'perArtifactBytes': MAX_ARTIFACT, 'perJobLogBytes': MAX_LOG,
                           'totalDownloadedBytes': MAX_TOTAL, 'httpErrorBodyBytes': ERROR_BODY}:
        raise ValueError('Request cannot enlarge archival limits')
    return value


def acquire(entry, kind, token, accounting, deadline):
    identifier = entry['id']
    base = OUTPUT / str(entry['runId'])
    base.mkdir(parents=True, exist_ok=True)
    name = f'{identifier}-{entry["name"]}.zip' if kind == 'artifact' else f'{identifier}.log'
    path = base / name
    partial = base / (name + '.partial')
    suffix = f'artifacts/{identifier}/zip' if kind == 'artifact' else f'jobs/{identifier}/logs'
    url = f'https://api.github.com/repos/{REPOSITORY}/actions/{suffix}'
    result = {'kind': kind, **entry, 'status': 'requested', 'apiPath': f'/repos/{REPOSITORY}/actions/{suffix}',
              'startedUtc': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'bytes': 0}
    if kind == 'artifact':
        result['expectedBytes'] = entry['bytes']
        result['expectedSha256'] = entry['sha256']
        del result['sha256']
    save(base / f'{kind}-{identifier}-request.json', result)
    request = urllib.request.Request(url, headers={
        'Authorization': 'Bearer ' + token, 'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'krkr2-web-fixed119-evidence-recovery',
    })
    digest = hashlib.sha256()
    limit = entry['bytes'] if kind == 'artifact' else MAX_LOG
    try:
        remaining_seconds = deadline - time.monotonic()
        if remaining_seconds <= 0:
            raise TimeoutError('Recovery wall-clock deadline reached')
        with urllib.request.build_opener(Redirect()).open(request, timeout=min(45, remaining_seconds)) as response:
            result['httpStatus'] = response.status
            if response.status != 200:
                raise ValueError('Original evidence did not return HTTP200')
            with partial.open('xb') as output:
                while True:
                    if time.monotonic() >= deadline:
                        raise TimeoutError('Recovery wall-clock deadline reached')
                    remaining = min(limit - result['bytes'], MAX_TOTAL - accounting['downloadedBytes'])
                    if remaining < 0:
                        raise ValueError('Evidence download exceeded its byte budget')
                    block = response.read(min(1024 * 1024, remaining + 1))
                    if not block:
                        break
                    output.write(block)
                    digest.update(block)
                    result['bytes'] += len(block)
                    accounting['downloadedBytes'] += len(block)
                    if len(block) > remaining:
                        raise ValueError('Evidence download exceeded its byte budget')
                    if time.monotonic() >= deadline:
                        raise TimeoutError('Recovery wall-clock deadline reached')
        result['sha256'] = digest.hexdigest()
        if kind == 'artifact':
            result['sizeMatches'] = result['bytes'] == entry['bytes']
            result['digestMatches'] = result['sha256'] == entry['sha256']
            if not result['sizeMatches'] or not result['digestMatches']:
                result['status'] = 'integrity-mismatch'
            else:
                result['status'] = 'verified-original'
        else:
            result['status'] = 'retrieved-original-log' if result['bytes'] else 'empty-log-response'
            result['integrityNote'] = 'New SHA256 records the original response; no prior log digest was available.'
        partial.rename(path)
        result['path'] = str(path.relative_to(OUTPUT))
    except urllib.error.HTTPError as error:
        try:
            body = error.read(ERROR_BODY + 1)
        except Exception as body_error:
            body = b''
            result['errorBodyReadFailure'] = type(body_error).__name__
        # Preserve status, capture length and body digest, but emit only known
        # GitHub error categories. Never republish an untrusted HTTP body.
        try:
            message = json.loads(body[:ERROR_BODY]).get('message', '')
        except (ValueError, AttributeError):
            message = ''
        category = 'HTTP failure; original body suppressed'
        for prefix in ('Not Found', 'Bad credentials', 'Must have admin rights',
                       'Resource not accessible by integration', 'API rate limit exceeded',
                       'Artifact has expired', 'This artifact has expired'):
            if isinstance(message, str) and message.startswith(prefix):
                category = prefix
                break
        result.update({'status': 'http-error', 'httpStatus': error.code,
                       'errorBodyTruncated': len(body) > ERROR_BODY,
                       'capturedErrorBytes': min(len(body), ERROR_BODY),
                       'capturedErrorSha256': hashlib.sha256(body[:ERROR_BODY]).hexdigest(),
                       'errorCategory': category})
    except Exception as error:
        result.update({'status': 'acquisition-error', 'errorType': type(error).__name__, 'error': scrub(error)[:500]})
    finally:
        if partial.exists():
            result['partialPath'] = str(partial.relative_to(OUTPUT))
            result['partialBytes'] = partial.stat().st_size
            result['partialSha256'] = digest.hexdigest()
        result['finishedUtc'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
        save(base / f'{kind}-{identifier}-result.json', result)
    return result


def compiler_excerpt(text):
    # Only known project compiler coordinates and a finite error-kind label go
    # to the public step summary. Original diagnostic text/context stays solely
    # in the same-repository ZIP/log artifact; arbitrary messages are not safe.
    source = r'(?P<file>(?:src|native|third_party|tests|scripts)/[A-Za-z0-9_./-]+\.(?:c|cc|cpp|cxx|h|hpp|ts|tsx|mts|mjs|js))'
    patterns = [
        (re.compile(source + r'\((?P<line>\d+),(?P<column>\d+)\):\s*error\s+(?P<code>TS\d+):'), 'TypeScript'),
        (re.compile(source + r':(?P<line>\d+)(?::(?P<column>\d+))?:\s*(?P<code>fatal error|error):'), 'C/C++'),
        (re.compile(source + r'\((?P<line>\d+)(?:,(?P<column>\d+))?\):\s*(?:fatal\s+)?error\s+(?P<code>C\d+):'), 'MSVC'),
    ]
    selected = []
    for line in text.splitlines():
        line = re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]', '', line)
        for pattern, language in patterns:
            match = pattern.search(line)
            if match and '..' not in match['file'].split('/') and Path(match['file']).is_file():
                coordinate = f'{match["file"]}:{match["line"]}'
                if match['column']:
                    coordinate += ':' + match['column']
                safe = f'{coordinate}: {language} {match["code"]}'
                if len(safe) <= 300 and scrub(safe) == safe and safe not in selected:
                    selected.append(safe)
                break
        if len(selected) >= 20:
            break
    return '\n'.join(selected)


def excerpts(result):
    if result['status'] not in ('verified-original', 'retrieved-original-log'):
        return []
    path = OUTPUT / result['path']
    sources = []
    if result['kind'] == 'job-log':
        sources.append((result['path'], path.read_text(encoding='utf-8', errors='replace')))
    elif result['name'] == 'build-logs' or result['name'].startswith('object-identity-'):
        # Read bounded text members directly; never extract or execute ZIP paths.
        with zipfile.ZipFile(path) as archive:
            remaining = 16 * 1024 * 1024
            for member in archive.infolist():
                if not member.filename.endswith(('.log', '.txt')) or member.is_dir():
                    continue
                if not re.fullmatch(r'[A-Za-z0-9_./-]+', member.filename) or '..' in member.filename.split('/'):
                    continue
                if member.file_size > MAX_LOG or member.file_size > remaining:
                    continue
                with archive.open(member) as source:
                    raw = source.read(member.file_size + 1)
                if len(raw) != member.file_size:
                    raise ValueError('ZIP text member length differs')
                remaining -= len(raw)
                sources.append((result['path'] + ':' + member.filename, raw.decode('utf-8', errors='replace')))
    return [{'source': source, 'excerpt': excerpt} for source, text in sources if (excerpt := compiler_excerpt(text))]


def main():
    OUTPUT.mkdir(parents=True, exist_ok=True)
    results, snippets = [], []
    accounting = {'downloadedBytes': 0}
    fatal = None
    started = time.monotonic()
    deadline = started + 20 * 60
    try:
        raw = REQUEST.read_bytes()
        with (OUTPUT / 'request.json').open('xb') as output:
            output.write(raw)
        request = validated_request(raw)
        save(OUTPUT / 'acquisition-plan.json', {'requestSha256': hashlib.sha256(raw).hexdigest(),
             'artifacts': request['artifacts'], 'jobLogs': request['jobLogs'], 'expectedOriginals': 95,
             'scope': 'Only frozen original IDs; no list/status query, rerun or execution. Missing items remain unreported.'})
        if (os.environ.get('GITHUB_ACTIONS') != 'true' or os.environ.get('RUNNER_ENVIRONMENT') != 'github-hosted'
                or os.environ.get('GITHUB_REPOSITORY') != REPOSITORY or os.environ.get('GITHUB_EVENT_NAME') != 'push'
                or os.environ.get('GITHUB_RUN_ATTEMPT') != '1'):
            raise ValueError('This one-shot archival script requires its first GitHub-hosted push run')
        token = os.environ.get('GITHUB_TOKEN')
        if not token:
            raise ValueError('Same-repository built-in Actions token is unavailable')
        work = [('job-log', entry) for entry in request['jobLogs']]
        work.sort(key=lambda item: (item[1]['runId'] != 45469186113, 'build' not in item[1]['name'].lower()))
        work += [('artifact', entry) for entry in sorted(request['artifacts'],
                 key=lambda entry: (entry['name'] != 'build-logs', entry['runId'] != 45469186113, entry['id']))]
        for kind, entry in work:
            if time.monotonic() >= deadline:
                raise TimeoutError('Recovery wall-clock deadline reached; remaining originals unattempted')
            result = acquire(entry, kind, token, accounting, deadline)
            results.append(result)
            try:
                snippets.extend(excerpts(result))
            except Exception as error:
                result['excerptError'] = scrub(error)[:300]
            print(f'{kind} {entry["id"]}: {result["status"]}; {result["bytes"]} bytes', flush=True)
    except Exception as error:
        fatal = {'type': type(error).__name__, 'message': scrub(error)[:500]}
    counts = dict(collections.Counter(item['status'] for item in results))
    complete = fatal is None and len(results) == 95 and all(item['status'] in
                ('verified-original', 'retrieved-original-log') for item in results)
    summary = {'batch': 119, 'complete': complete, 'expectedOriginals': 95, 'attempted': len(results),
               'unattempted': 95 - len(results), 'statuses': counts, **accounting, 'fatal': fatal,
               'elapsedSeconds': round(time.monotonic() - started, 3), 'downloadDeadlineSeconds': 1200,
               'productVerification': False, 'results': results}
    save(OUTPUT / 'summary.json', summary)
    save(OUTPUT / 'compiler-excerpts.json', snippets)
    lines = ['# Frozen batch119 evidence recovery', '',
             f'Originals attempted: {len(results)}/95. Recovery complete: {complete}.',
             f'States: {counts}. Stored download bytes: {accounting["downloadedBytes"]:,}.', '',
             'This archives existing originals only. It is not a product test result or a crash reproduction.',
             'Unretrieved, mismatched, empty and unattempted originals remain explicitly incomplete.',
             'Compiler listings contain only project file coordinates and error kinds; raw diagnostics stay in the archived originals.', '']
    if fatal:
        lines += ['Recovery error: ' + fatal['message'], '']
    shown = 0
    for item in snippets[:12]:
        selected = item['excerpt'].splitlines()[:min(6, 24 - shown)]
        if not selected:
            break
        shown += len(selected)
        # Both source and emitted diagnostic strings contain only validated
        # ASCII path characters/coordinates and finite compiler-kind labels.
        lines += ['### ' + item['source'], '', '```text', '\n'.join(selected), '```', '']
    text = '\n'.join(lines)
    (OUTPUT / 'summary.md').write_text(text, encoding='utf-8')
    if os.environ.get('GITHUB_STEP_SUMMARY'):
        with open(os.environ['GITHUB_STEP_SUMMARY'], 'a', encoding='utf-8') as output:
            output.write(text)
    return 0 if complete else 1


if __name__ == '__main__':
    sys.exit(main())
