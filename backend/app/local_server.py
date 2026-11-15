"""Runs the planner on this device, for the desktop and Android apps: the API and the built frontend on one local port.

Set MARS_EVA_DATA_DIR, MARS_EVA_FRONTEND_DIST and MARS_EVA_CACHE_DIR (see main.py) before calling start_in_background,
because the server reads them when it loads.
"""
from __future__ import annotations

import os
import socket
import threading
import time

_lock = threading.Lock()
_url: str | None = None


def start_in_background(preferred_port: int = 0, timeout_s: float = 300) -> str:
    """Start the server in a background thread (once) and return its address once it answers.

    The same port each time keeps the page's saved settings, which the browser files under the address. If the port
    is taken, any free one is used instead.
    """
    global _url
    with _lock:
        if _url:
            return _url
        import uvicorn

        from .main import app

        sock = _bind(preferred_port)
        # No logging set-up: a windowed desktop app has no console for uvicorn's coloured log output.
        config = uvicorn.Config(app, log_config=None, loop="asyncio", http="h11", ws="none", lifespan="off")
        server = uvicorn.Server(config)
        thread = threading.Thread(target=server.run, kwargs={"sockets": [sock]}, name="planner-server", daemon=True)
        thread.start()
        deadline = time.monotonic() + timeout_s
        while not server.started:
            if not thread.is_alive() or time.monotonic() > deadline:
                raise RuntimeError("The planner's server did not start.")
            time.sleep(0.05)
        _url = f"http://127.0.0.1:{sock.getsockname()[1]}/"
        return _url


def _bind(port: int) -> socket.socket:
    for candidate in dict.fromkeys((port, 0)):
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        if os.name != "nt":  # lets a restarted app take its port back straight away (on Windows it means sharing)
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            sock.bind(("127.0.0.1", candidate))
            return sock
        except OSError:
            sock.close()
    raise RuntimeError("No free local port for the planner's server.")
