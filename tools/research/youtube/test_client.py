import sys
from pathlib import Path

import httpx
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))

from tools.research.youtube.client import YouTubeClient


def test_get_transcript_supports_urls_and_negative_time_slices():
    video_id = "abc123def45"
    transcript_xml = """
    <transcript>
      <text start="0.0" dur="5.0">Intro</text>
      <text start="10.0" dur="5.0">Middle</text>
      <text start="20.0" dur="8.0">Wrap up</text>
    </transcript>
    """

    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "GET" and request.url.path == "/watch":
            return httpx.Response(
                200,
                request=request,
                text='{"INNERTUBE_API_KEY":"inner-tube-key"}',
            )
        if request.method == "POST" and request.url.path == "/youtubei/v1/player":
            return httpx.Response(
                200,
                request=request,
                json={
                    "playabilityStatus": {"status": "OK"},
                    "captions": {
                        "playerCaptionsTracklistRenderer": {
                            "captionTracks": [
                                {
                                    "baseUrl": f"https://www.youtube.com/api/timedtext?v={video_id}",
                                    "name": {"simpleText": "English"},
                                    "languageCode": "en",
                                    "isTranslatable": True,
                                }
                            ]
                        }
                    },
                },
            )
        if request.method == "GET" and request.url.path == "/api/timedtext":
            return httpx.Response(200, request=request, text=transcript_xml)
        raise AssertionError(f"unexpected request: {request.method} {request.url}")

    client = YouTubeClient(timeout=5)
    client._client = httpx.Client(transport=httpx.MockTransport(handler), follow_redirects=True)

    try:
        data = client.get_transcript(
            f"https://www.youtube.com/watch?v={video_id}",
            start_time="-00:00:20",
            end_time="-00:00:05",
        )
    finally:
        client.close()

    assert data["video_id"] == video_id
    assert data["window_start"] == 8.0
    assert data["window_end"] == 23.0
    assert [row["text"] for row in data["transcript"]] == ["Middle", "Wrap up"]
    assert data["text"] == "Middle Wrap up"


def test_get_transcript_raises_clear_error_when_no_public_captions_exist():
    video_id = "abc123def45"

    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "GET" and request.url.path == "/watch":
            return httpx.Response(
                200,
                request=request,
                text='{"INNERTUBE_API_KEY":"inner-tube-key"}',
            )
        if request.method == "POST" and request.url.path == "/youtubei/v1/player":
            return httpx.Response(
                200,
                request=request,
                json={"playabilityStatus": {"status": "OK"}},
            )
        raise AssertionError(f"unexpected request: {request.method} {request.url}")

    client = YouTubeClient(timeout=5)
    client._client = httpx.Client(transport=httpx.MockTransport(handler), follow_redirects=True)

    try:
        with pytest.raises(RuntimeError, match="No public captions are available for this video"):
            client.get_transcript(video_id)
    finally:
        client.close()


def test_data_api_host_does_not_collide_with_gsuite_oauth():
    """The Data API base_url must stay off www.googleapis.com.

    gsuite declares www.googleapis.com for its oauth_token secret, so
    iron-proxy attaches that Bearer to anything hitting that host. Google then
    prefers the Bearer over ?key= and rejects on scopes, making every Data API
    call 403 no matter how valid the API key is. Regression guard for that.
    """
    client = YouTubeClient(api_key="test-key")
    assert client.base_url.startswith("https://youtube.googleapis.com/")
    assert "www.googleapis.com" not in client.base_url


def test_declared_secret_host_matches_base_url():
    """A mismatch here means the key silently never gets injected."""
    import tomllib

    manifest = tomllib.loads(
        (Path(__file__).parent / "pyproject.toml").read_text()
    )
    hosts = {
        host
        for secret in manifest["tool"]["centaur"]["secrets"]
        for host in secret.get("hosts", [])
    }
    base_host = YouTubeClient(api_key="x").base_url.split("/")[2]
    assert base_host in hosts, f"{base_host} not declared in {hosts}"
