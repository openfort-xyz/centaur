"""Exercise the ledger checker against synthetic Markdown in an isolated repo."""

from pathlib import Path
import subprocess
import tempfile
import unittest


CHECKER = Path(__file__).with_name("verify-google-chat-parity-ledger.sh").resolve()


class ParityLedgerTest(unittest.TestCase):
    def test_structure_and_immutable_release_gate(self):
        sha = "a" * 40
        rows = [
            [f"TASK-{n:03}", f"TEST-{n:03}", "Passed", "2026-09-07", f"`{sha}`",
             "local", "test command", "passed", "artifact"]
            for n in range(1, 32)
        ]
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            subprocess.run(["git", "init", "-q", directory], check=True)
            (root / "plan").mkdir()
            (root / "docs").mkdir()
            (root / "plan/feature-google-chat-slack-parity-1.md").write_text(
                "\n".join(f"| {row[0]} | Verification: {row[1]}. |" for row in rows)
            )
            ledger = root / "docs/google-chat-parity-verification.md"

            def check(candidate, expected):
                ledger.write_text(
                    "- **CON-001**: excluded\n- **CON-002**: excluded\n"
                    + "\n".join("| " + " | ".join(row) + " |" for row in candidate)
                    + "\n"
                )
                result = subprocess.run(
                    ["bash", str(CHECKER)], cwd=root, capture_output=True, text=True
                )
                self.assertEqual(result.returncode == 0, expected, result.stderr)

            check(rows, True)
            escaped = [row.copy() for row in rows]
            escaped[0][6] = r"printf result \| cat"
            check(escaped, True)
            for column, value in [(2, "Unknown"), (4, "working-tree"), (7, "")]:
                with self.subTest(column=column, value=value):
                    changed = [row.copy() for row in rows]
                    changed[0][column] = value
                    check(changed, False)
            check([rows[0][:-1], *rows[1:]], False)
            check([rows[0], *rows], False)
            check(rows[1:], False)
            changed = [row.copy() for row in rows]
            changed[0][4] = "b" * 40
            check(changed, False)
            changed[0][2] = changed[-1][2] = "Provisional"
            changed[0][4] = changed[-1][4] = "working-tree"
            check(changed, True)
            for row in changed:
                row[2], row[4] = "Passed", "sha256:" + "c" * 64
            check(changed, True)


if __name__ == "__main__":
    unittest.main()
