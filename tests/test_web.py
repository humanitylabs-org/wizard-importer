"""Screen logic from the owner's real runs, checked by running the real functions out of web/app.js in node.

1. A failed part never shows a raw "[Errno 13] Permission denied: <path>"; the done screen never says All set then.
2. Leaving the guide cancels the export wait; a kept wait has a Cancel on Home.
3. A source already brought in says so and sits under the ones still to do.
4. Miguel's Claude Code import: "0 things about you (3 more are in About me: memory is full)". Facts the small
   always-on memory has no room for go to the fact store and count as saved; "memory is full" never shows.
5. "Reading your export…" gave no idea how long or whether it was stuck: real progress, time left, a heartbeat,
   a slow note with Cancel, and Back/Cancel stop the scan.
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


FMT = ("const fmt = n => Number(n || 0).toLocaleString('en-US');\n"
       "const plural = (n, one, many) => `${fmt(n)} ${n === 1 ? one : (many || one + 's')}`;\n")


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

    def test_about_line_counts_the_fact_store_and_never_says_memory_is_full(self):
        code = FMT + piece('function aboutLine', 'function doneView')
        got = node(code + """
console.log(JSON.stringify([
  aboutLine({memory_added: 0, in_fact_store: 3, already_known: 0, not_added: []}),
  aboutLine({memory_added: 2, already_known: 1, not_added: []}),
  aboutLine({memory_added: 0, already_known: 0, not_added: [{fact: 'a'}, {fact: 'b'}, {fact: 'c'}]}),
  aboutLine({memory_added: 1, in_fact_store: 1, not_added: [{fact: 'a'}], waiting_for_approval: 2})]));""")
        self.assertEqual(got[0], '3 things about you, saved to memory')
        self.assertEqual(got[1], '3 things about you, saved to memory')
        self.assertEqual(got[2], '3 things about you, in Files › Imported › About me')
        self.assertEqual(got[3], '2 things about you, saved to memory, 1 more in Files › Imported › About me, 2 waiting for your approval')
        self.assertNotIn('memory is full', JS)
        self.assertIn('aboutLine(d.about)', piece('function doneView', '/* ---------------- boot'))

    def test_reading_screen_shows_progress_time_left_heartbeat_and_slow_note(self):
        code = FMT + piece('const STEP_TEXT', 'function paintScan')
        got = node(code + """
console.log(JSON.stringify([
  scanText({step: 'chats', done: 140, total: 296, seconds_left: 70}, 42, 1),
  scanText({step: 'chats', done: 1, total: 296, seconds_left: 400}, 5, 0),
  scanText({step: 'chats', done: 140, total: 296, seconds_left: 20}, 200, 61),
  scanText(null, 30, 30), scanText(null, 95, 95),
  scanText({step: 'skills', done: 0, total: 0, seconds_left: null}, 61, 2),
  scanText({step: 'chats', done: 4, total: 5, fraction: 0.1, seconds_left: 30}, 10, 0)]));""")
        self.assertEqual((got[0]['line'], got[0]['left'], got[0]['beat'], got[0]['slow']),
                         ('Reading chats · 140 of 296', 'about 1 minute left', 'Still working · 0:42', False))
        self.assertTrue(0 < got[0]['pct'] < 100)
        self.assertEqual(got[6]['pct'], 5 + 9)  # the bar follows the engine's work fraction (one huge chat left)
        self.assertEqual(got[1]['left'], 'about 7 minutes left')
        self.assertTrue(got[2]['slow'])                      # no movement for a minute
        self.assertEqual((got[3]['slow'], got[3]['pct']), (False, None))  # older agent: heartbeat only
        self.assertTrue(got[4]['slow'])
        self.assertEqual((got[5]['line'], got[5]['left'], got[5]['beat']), ('Reading skills', '', 'Still working · 1:01'))
        view = piece('function scanView', 'function render()')
        self.assertIn('This is taking longer than usual', view)
        self.assertIn('onclick: cancelScan', view)

    def test_back_and_cancel_stop_the_scan_and_a_late_answer_is_ignored(self):
        back = piece('function back()', 'function finish()')
        self.assertIn("if (S.view === 'scanning') { cancelScan(); return true; }", back)
        self.assertIn("'scanning'", piece('const canBack', ';'))
        cancel = piece('function cancelScan', 'const STEP_TEXT')
        self.assertIn("api('api/cancel', { scan_id: id })", cancel)
        self.assertIn('S.scanId = null', cancel)
        start = piece('async function startScan', 'async function runImport')
        self.assertIn('scan_id: id', start)
        self.assertEqual(start.count('if (S.scanId !== id) return'), 2)  # answer and failure of a cancelled scan

    def test_source_rows_show_a_rough_estimate(self):
        code = piece('const estText', 'const doneSub')
        got = node(code + "console.log(JSON.stringify([estText(undefined), estText(30), estText(76), estText(200)]));")
        self.assertEqual(got, ['', ' · under a minute', ' · about 1 min', ' · about 3 min'])
        rows = piece('function readyRows', 'function homeView')
        self.assertEqual(rows.count('estText('), 3)


if __name__ == '__main__':
    unittest.main()
