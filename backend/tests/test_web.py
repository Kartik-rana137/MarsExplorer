"""Tests for the serving layer (app/web.py): text compression and browser caching advice.

The app is called directly through ASGI, so no HTTP client library is needed.
Run from the repository root:  backend/.venv/Scripts/python -m unittest discover -s backend/tests -v
"""
from __future__ import annotations

import asyncio
import gzip
import json
import sys
import tempfile
import unittest
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))

from starlette.applications import Starlette  # noqa: E402
from starlette.responses import JSONResponse, Response  # noqa: E402
from starlette.routing import Mount, Route  # noqa: E402

from app.web import CachedFiles, CompressText  # noqa: E402

# About 30 KB of JSON shaped like the planner's answers: the same field names over and over.
BIG = {"stops": [{"name": f"Stop {i}", "lat": round(-4.8 - i * 1e-4, 6), "lon": round(137.38 + i * 1e-4, 6), "work_min": 60,
                  "ok": True, "problem": None} for i in range(300)]}


def call(app, path: str, headers: dict[str, str] | None = None, method: str = "GET") -> tuple[int, dict[str, str], bytes]:
    """One request through the ASGI app: (status, headers, body)."""
    scope = {
        "type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1", "method": method, "scheme": "http",
        "path": path, "raw_path": path.encode(), "root_path": "", "query_string": b"",
        "headers": [(k.lower().encode(), v.encode()) for k, v in (headers or {}).items()],
        "client": ("127.0.0.1", 1), "server": ("127.0.0.1", 80),
    }
    messages: list[dict] = []

    async def run() -> None:
        # Like a real connection: the request arrives once, then the client is "still there" until the response is
        # complete (a file response listens for the client leaving while it sends).
        done = asyncio.Event()
        sent_request = False

        async def receive() -> dict:
            nonlocal sent_request
            if not sent_request:
                sent_request = True
                return {"type": "http.request", "body": b"", "more_body": False}
            await done.wait()
            return {"type": "http.disconnect"}

        async def send(message: dict) -> None:
            messages.append(message)
            if message["type"] == "http.response.body" and not message.get("more_body", False):
                done.set()

        await app(scope, receive, send)

    asyncio.run(run())
    start = next(m for m in messages if m["type"] == "http.response.start")
    body = b"".join(m.get("body", b"") for m in messages if m["type"] == "http.response.body")
    return start["status"], {k.decode().lower(): v.decode() for k, v in start["headers"]}, body


class Compression(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        async def big(request):
            return JSONResponse(BIG)

        async def small(request):
            return JSONResponse({"ok": True})

        async def image(request):
            return Response(b"\x89PNG" + b"\x00" * 5000, media_type="image/png")

        async def packed(request):
            return Response(gzip.compress(b"x" * 5000), media_type="application/octet-stream", headers={"Content-Encoding": "gzip"})

        async def missing(request):
            return JSONResponse({"detail": "x" * 3000}, status_code=404)

        cls.app = CompressText(Starlette(routes=[Route("/big", big), Route("/small", small), Route("/image", image),
                                                 Route("/packed", packed), Route("/missing", missing)]))

    def test_json_is_compressed_for_browsers_that_accept_it(self):
        status, headers, body = call(self.app, "/big", {"Accept-Encoding": "gzip, deflate, br"})
        self.assertEqual(status, 200)
        self.assertEqual(headers["content-encoding"], "gzip")
        self.assertIn("accept-encoding", headers["vary"].lower())
        self.assertEqual(int(headers["content-length"]), len(body))
        self.assertEqual(json.loads(gzip.decompress(body)), BIG)
        self.assertLess(len(body), len(json.dumps(BIG)) / 3)

    def test_nothing_changes_without_gzip_or_for_small_answers(self):
        _, headers, body = call(self.app, "/big")
        self.assertNotIn("content-encoding", headers)
        self.assertEqual(json.loads(body), BIG)
        _, headers, body = call(self.app, "/small", {"Accept-Encoding": "gzip"})
        self.assertNotIn("content-encoding", headers)
        self.assertEqual(json.loads(body), {"ok": True})

    def test_images_errors_and_compressed_data_pass_through(self):
        _, headers, body = call(self.app, "/image", {"Accept-Encoding": "gzip"})
        self.assertNotIn("content-encoding", headers)
        self.assertTrue(body.startswith(b"\x89PNG"))
        _, headers, body = call(self.app, "/packed", {"Accept-Encoding": "gzip"})
        self.assertEqual(headers["content-encoding"], "gzip")
        self.assertEqual(gzip.decompress(body), b"x" * 5000)  # compressed once, not twice
        status, headers, _ = call(self.app, "/missing", {"Accept-Encoding": "gzip"})
        self.assertEqual(status, 404)
        self.assertNotIn("content-encoding", headers)


class PageFiles(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.folder = tempfile.TemporaryDirectory()
        root = Path(cls.folder.name)
        (root / "assets").mkdir()
        (root / "index.html").write_text("<!doctype html><title>t</title>" + "<p>hello</p>" * 200, encoding="utf-8")
        (root / "assets" / "index-abc123.js").write_text("console.log('x');" * 500, encoding="utf-8")
        (root / "slope.png").write_bytes(b"\x89PNG" + b"\x01" * 3000)
        cls.app = CompressText(Starlette(routes=[
            Mount("/overlays", CachedFiles(directory=root)),
            Mount("/", CachedFiles(directory=root, html=True, page=True)),
        ]))

    @classmethod
    def tearDownClass(cls):
        cls.folder.cleanup()

    def test_hashed_assets_are_kept_for_good_and_the_page_is_checked(self):
        _, headers, body = call(self.app, "/assets/index-abc123.js", {"Accept-Encoding": "gzip"})
        self.assertIn("immutable", headers["cache-control"])
        self.assertEqual(headers["content-encoding"], "gzip")
        self.assertEqual(gzip.decompress(body).decode(), "console.log('x');" * 500)
        _, headers, body = call(self.app, "/", {"Accept-Encoding": "gzip"})
        self.assertEqual(headers["cache-control"], "no-cache")
        self.assertIn(b"hello", gzip.decompress(body))
        _, headers, _ = call(self.app, "/overlays/slope.png", {"Accept-Encoding": "gzip"})
        self.assertEqual(headers["cache-control"], "public, max-age=86400")
        self.assertNotIn("content-encoding", headers)

    def test_a_second_visit_is_answered_without_the_file(self):
        _, headers, _ = call(self.app, "/assets/index-abc123.js", {"Accept-Encoding": "gzip"})
        status, again, body = call(self.app, "/assets/index-abc123.js", {"Accept-Encoding": "gzip", "If-None-Match": headers["etag"]})
        self.assertEqual(status, 304)
        self.assertEqual(body, b"")


if __name__ == "__main__":
    unittest.main()
