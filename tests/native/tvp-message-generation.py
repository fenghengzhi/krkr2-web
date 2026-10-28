#!/usr/bin/env python3
"""Early source-generation and C++ syntax regression; GitHub-hosted only."""
from pathlib import Path
import importlib.util
import os
import subprocess
import tempfile
import unittest


if os.environ.get("GITHUB_ACTIONS") != "true" or os.environ.get("RUNNER_ENVIRONMENT") != "github-hosted":
    raise SystemExit("TVP generation verification must run on a GitHub-hosted Actions runner")

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("generate_tvp_messages", ROOT / "scripts/generate-tvp-messages.py")
GENERATOR = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(GENERATOR)


def compile_source(path):
    return subprocess.run([
        "c++", "-std=c++20", "-fsyntax-only", "-Wall", "-Wextra", "-pedantic-errors",
        "-I" + str(ROOT / "third_party/tjs2"),
        "-I" + str(ROOT / "native/tjs2/include"), str(path),
    ], cwd=ROOT, capture_output=True, text=True, timeout=30)


def translation_unit(entry):
    return ('#include "tjsTypes.h"\n'
            '#include <string_view>\n'
            '#define TVP_MESSAGE(name, assignable, value) constexpr const tjs_char* name = value;\n'
            + entry + '\n#undef TVP_MESSAGE\n'
            'static_assert(std::u16string_view(TVPFixture) == u"一行目\\n二行目");\n')


class TvpMessageGeneration(unittest.TestCase):
    def test_pinned_sources_regenerate_both_committed_outputs_exactly(self):
        # This also verifies the pinned byte lengths/hashes and 138+6 original
        # inventory. It never writes over the committed outputs during a check.
        generated = GENERATOR.generated_sources()
        self.assertEqual(set(generated), {
            ROOT / "native/tjs2/include/TvpMessages.generated.inc",
            ROOT / "src/engine/system/tvp-message-ids.ts",
        })
        for path, expected in generated.items():
            with self.subTest(path=str(path.relative_to(ROOT))):
                self.assertEqual(path.read_bytes(), expected.encode("utf-8"))

    def test_trailing_line_comment_has_a_separate_closing_delimiter(self):
        body = 'TJS_W("一行目\\n")\nTJS_W("二行目") // original trailing comment'
        rendered = GENERATOR.render_native_entry("TVPFixture", False, body, "fixture.h", 7)
        self.assertEqual(rendered, '// fixture.h:7\nTVP_MESSAGE(TVPFixture, false,\n' + body + '\n)')
        with tempfile.TemporaryDirectory(prefix="tvp-generation-") as directory:
            path = Path(directory) / "comment.cpp"
            path.write_text(translation_unit(rendered), encoding="utf-8")
            result = compile_source(path)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_actual_catalog_is_a_complete_cpp_initializer(self):
        result = compile_source(ROOT / "tests/native/tvp-message-catalog.cpp")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_old_same_line_closing_is_detected_by_the_compiler(self):
        # A negative control proves the early check catches the exact 105/106
        # failure, independently of the generator agreeing with its own output.
        body = 'TJS_W("一行目\\n")\nTJS_W("二行目") // original trailing comment'
        old = '// fixture.h:7\nTVP_MESSAGE(TVPFixture, false,\n' + body + ')'
        with tempfile.TemporaryDirectory(prefix="tvp-generation-negative-") as directory:
            path = Path(directory) / "old-comment.cpp"
            path.write_text(translation_unit(old), encoding="utf-8")
            result = compile_source(path)
            self.assertNotEqual(result.returncode, 0, "Old line-comment macro unexpectedly compiled")
            self.assertIn("TVP_MESSAGE", result.stderr)


if __name__ == "__main__":
    unittest.main(verbosity=2)
