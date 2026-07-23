from typer.testing import CliRunner

from gsuite import client
from gsuite.cli import app

runner = CliRunner()


def test_docs_bullets_command_prints_verification_summary(monkeypatch):
    monkeypatch.setattr(
        client,
        "docs_bullets",
        lambda document_id, match_prefix, bullet_preset, tab_id, dry_run: {
            "document_id": document_id,
            "match_prefix": match_prefix,
            "bullet_preset": bullet_preset,
            "matched_paragraphs": 2,
            "updated_paragraphs": 2,
            "verified_paragraphs": 2,
            "already_bulleted_paragraphs": 1,
            "dry_run": dry_run,
            "paragraphs": [
                {
                    "tab_id": None,
                    "paragraph_index": 1,
                    "before": "- First item",
                    "after": "First item",
                },
                {
                    "tab_id": "tab-2",
                    "paragraph_index": 3,
                    "before": "- Second item",
                    "after": "Second item",
                },
            ],
        },
    )

    result = runner.invoke(app, ["docs", "bullets", "doc-123"])

    assert result.exit_code == 0
    assert "Converted 2 paragraph(s) into Google Docs bullets" in result.output
    assert "Verification: matched 2, updated 2, verified 2, already bulleted 1" in result.output
    assert "paragraph 2:" in result.output
    assert "tab tab-2 paragraph 4:" in result.output


def test_drive_upload_share_email_needs_no_slack(monkeypatch, tmp_path):
    """--share-email shares directly and never shells out to the Slack CLI.

    This is the non-Slack (e.g. Google Chat) delivery path: channel/requester are
    omitted, so no `slack` subprocess is spawned and the file is shared by email.
    """
    monkeypatch.setattr(
        client,
        "drive_upload",
        lambda content_base64, name, filename, folder_id, convert_to_sheets: {
            "id": "file-123",
            "name": name or filename,
            "web_view_link": "https://drive.google.com/file/d/file-123/view",
        },
    )

    shares: list[tuple] = []
    monkeypatch.setattr(
        client,
        "drive_share",
        lambda file_id, email, role="writer", send_notification=False: shares.append(
            (file_id, email, role, send_notification)
        ),
    )

    def _fail_if_slack_called(*args, **kwargs):
        raise AssertionError("Slack CLI must not be invoked on the email-share path")

    monkeypatch.setattr("subprocess.run", _fail_if_slack_called)

    f = tmp_path / "chart.png"
    f.write_bytes(b"pngbytes")

    result = runner.invoke(
        app,
        ["drive", "upload", str(f), "-e", "joan@example.com", "--role", "reader"],
    )

    assert result.exit_code == 0
    assert shares == [("file-123", "joan@example.com", "reader", False)]
    assert "Shared with joan@example.com as reader" in result.output
