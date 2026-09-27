"""Tiny static dev server for Medura (no-cache, correct MIME types).

Usage (CLI):   .venv\\Scripts\\python.exe tools\\devserver.py [port]
Usage (tests): from devserver import start_server; srv, url = start_server(); ...; srv.shutdown()
               (add C:\\Users\\lidor\\Projects\\medura\\tools to sys.path first)
"""
from __future__ import annotations

import functools
import sys
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

MIME = {
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".webmanifest": "application/manifest+json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".md": "text/plain; charset=utf-8",
    ".sql": "text/plain; charset=utf-8",
}


class _Handler(SimpleHTTPRequestHandler):
    extensions_map = {**SimpleHTTPRequestHandler.extensions_map, **MIME}

    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-store")
        # Local-only server (binds 127.0.0.1): allow the Supabase dashboard tab to fetch schema files.
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Private-Network", "true")
        super().end_headers()

    def do_OPTIONS(self) -> None:  # CORS / private-network preflight
        self.send_response(204)
        self.send_header("Access-Control-Allow-Methods", "GET")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.end_headers()

    def log_message(self, fmt: str, *args) -> None:  # quiet
        pass


class _Server(ThreadingHTTPServer):
    # A cold app load fires ~30 module/CSS requests at once; the default backlog (5) makes
    # Windows refuse some of them (net::ERR_CONNECTION_REFUSED) when several browsers run.
    request_queue_size = 128
    daemon_threads = True


def start_server(root: Path | str = ROOT, port: int = 0) -> tuple[ThreadingHTTPServer, str]:
    """Start a background server; returns (server, base_url ending with '/')."""
    handler = functools.partial(_Handler, directory=str(root))
    srv = _Server(("127.0.0.1", port), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, f"http://127.0.0.1:{srv.server_address[1]}/"


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 5178
    handler = functools.partial(_Handler, directory=str(ROOT))
    print(f"Serving {ROOT} on http://localhost:{port}/")
    _Server(("127.0.0.1", port), handler).serve_forever()
