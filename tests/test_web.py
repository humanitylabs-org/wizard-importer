"""Screen logic from the owner's real runs, checked by running the real functions out of web/app.js in node.

1. A failed part never shows a raw "[Errno 13] Permission denied: <path>"; the done screen never says All set then.
2. Leaving the guide cancels the export wait; a kept wait has a Cancel on Home.
3. A source already brought in says so and sits under the ones still to do.
"""
import json
import shutil
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
JS = (ROOT / 'web/app.js').read_text('utf-8')


def piece(start, end):
    i = JS.index(start)
    return JS[i:JS.index(end, i)]


def node(script):
    out = subprocess.run(['node', '-e', script], capture_output=True, text=True, timeout=30)
    if out.returncode:
        raise AssertionError(out.stderr)
    return json.loads(out.stdout)


@unittest.skipUnless(shutil.which('node'), 'node not installed')
class WebLogicTests(unittest.TestCase):
    def test_raw_errno_never_reaches_the_owner(self):
        code = piece('function plainError', 'const PART_NAME')
        got = node(code + """
console.log(JSON.stringify([
  plainError("[Errno 13] Permission denied: '/home/oscar/runtipi/media/Imported'"),
  plainError("[Errno 28] No space left on device: '/x'"),
  plainError('Scan the export first.')]));""")
        self.assertIn('Files › Imported', got[0])
        self.assertIn('Try again', got[0])
        for text in got[:2]:
            self.assertNotIn('Errno', text)
            self.assertNotIn('/home/', text)
        self.assertEqual(got[2], 'Scan the export first.')

    def test_done_with_errors_is_not_all_set_and_offers_try_again(self):
        done = piece('function doneView', '/* ---------------- boot')
        errors_branch = done[done.index('const head = errors.length'):done.index(': [h(')]
        self.assertIn('Some of it didn’t come in', errors_branch)
        self.assertNotIn('All set', errors_branch)
        self.assertIn('retryFailed', done)
        self.assertIn('plainError(v)', done)
        retry = piece('function retryFailed', 'function pickDest')
        self.assertIn("failed.includes('chats')", retry)

    def test_back_from_the_guide_cancels_the_wait_and_home_can_cancel_it(self):
        back = piece('function back()', 'function finish()')
        self.assertIn("if (S.view === 'guide') { S.waiting = null; saveWaiting();", back)
        home = piece('function homeView', 'function pastSheet')
        self.assertIn('data-cancel-wait', home)
        self.assertIn('S.waiting = null; saveWaiting()', home)

    def test_sources_already_brought_in_say_so_and_go_last(self):
        code = piece('/* An import that already came', 'function readyRows')
        got = node("const S = {imports: [{source: '/home/u/.claude', imported_at: Date.now() / 1000, kind: 'claude-code'},"
                   " {source: '/srv/media/Inbox/c.zip', archived_at: 1, kind: 'chatgpt'},"
                   " {source: '/home/u/.hermes', imported_at: 5, dest: 'oscar-os', into: 'Oscar in Wizard OS'},"
                   " {source: '/home/u/.hermes', scanned_at: 9}]};\n" + code + """
console.log(JSON.stringify([!!broughtIn('/home/u/.claude'), !!broughtIn('Inbox/c.zip'), !!broughtIn('/home/u/.hermes/profiles/x'),
  doneSub(broughtIn('/home/u/.claude')), !!broughtIn('/home/u/.hermes', true), doneSub(broughtIn('/home/u/.hermes', true))]));""")
        self.assertEqual(got[:3], [True, True, False])
        self.assertEqual(got[3], 'Brought in today · tap to bring in again')
        self.assertTrue(got[4])
        self.assertIn('to Oscar in Wizard OS', got[5])
        rows = piece('function readyRows', 'function homeView')
        self.assertIn("(a.hit ? 1 : 0) - (b.hit ? 1 : 0)", rows)


if __name__ == '__main__':
    unittest.main()
