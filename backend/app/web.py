"""Serving the API and the built page quickly.

* Text responses (JSON, HTML, CSS, JavaScript) are gzip-compressed for browsers that accept it, which makes them
  four to five times smaller. Images and the already-compressed elevation grid pass through untouched.
* The built page's files under assets/ carry a hash of their contents in their names (Vite does this), so a browser
  may keep them for good; index.html is checked on every visit, so a new build is picked up at once.
"""
from __future__ import annotations

import gzip
from collections import OrderedDict

from starlette.datastructures import Headers, MutableHeaders
from starlette.staticfiles import StaticFiles

COMPRESSIBLE = {"application/json", "text/html", "text/css", "text/javascript", "application/javascript",
                "image/svg+xml", "text/plain"}


class CompressText:
    """ASGI middleware: gzip text responses of at least `minimum_size` bytes.

    Compressed copies of files with an ETag (the built page's files) are kept, so each is compressed only once.
    """

    def __init__(self, app, minimum_size: int = 1024, level: int = 6, keep: int = 64) -> None:
        self.app = app
        self.minimum_size = minimum_size
        self.level = level
        self.keep = keep
        self._kept: OrderedDict[tuple[str, str], bytes] = OrderedDict()

    async def __call__(self, scope, receive, send) -> None:
        if scope["type"] != "http" or "gzip" not in Headers(scope=scope).get("accept-encoding", "").lower():
            await self.app(scope, receive, send)
            return
        start: dict | None = None   # the response start, held back while the body is collected
        passing = False
        parts: list[bytes] = []

        async def respond(message: dict) -> None:
            nonlocal start, passing
            if message["type"] == "http.response.start":
                headers = Headers(raw=message["headers"])
                kind = headers.get("content-type", "").split(";")[0].strip().lower()
                if message["status"] != 200 or headers.get("content-encoding") or kind not in COMPRESSIBLE:
                    passing = True
                    await send(message)
                else:
                    start = message
                return
            if passing:
                await send(message)
                return
            if message["type"] != "http.response.body":  # anything unexpected: give up compressing
                passing = True
                await send(start)
                await send(message)
                return
            parts.append(message.get("body", b""))
            if message.get("more_body", False):
                return
            body = b"".join(parts)
            headers = MutableHeaders(raw=start["headers"])
            if len(body) >= self.minimum_size:
                body = self._compress(scope.get("path", ""), headers.get("etag"), body)
                headers["content-encoding"] = "gzip"
                headers["content-length"] = str(len(body))
                headers.add_vary_header("Accept-Encoding")
            await send(start)
            await send({"type": "http.response.body", "body": body})

        await self.app(scope, receive, respond)

    def _compress(self, path: str, etag: str | None, body: bytes) -> bytes:
        if not etag:
            return gzip.compress(body, self.level)
        key = (path, etag)
        packed = self._kept.get(key)
        if packed is None:
            packed = gzip.compress(body, 9)  # files are compressed once, so it pays to compress them well
            self._kept[key] = packed
            while len(self._kept) > self.keep:
                self._kept.popitem(last=False)
        return packed


class CachedFiles(StaticFiles):
    """Static files with caching advice for browsers.

    `page=True` (the built page): files under assets/ are kept for a year, since their names change with their
    contents; everything else (index.html) is checked on every visit. Otherwise every file may be kept for a day.
    """

    def __init__(self, *args, page: bool = False, **kwargs) -> None:
        super().__init__(*args, **kwargs)
        self.page = page

    def file_response(self, full_path, stat_result, scope, status_code: int = 200):
        response = super().file_response(full_path, stat_result, scope, status_code)
        if not self.page:
            response.headers["cache-control"] = "public, max-age=86400"
        elif "/assets/" in str(full_path).replace("\\", "/"):
            response.headers["cache-control"] = "public, max-age=31536000, immutable"
        else:
            response.headers["cache-control"] = "no-cache"
        return response
