#!/usr/bin/env python3

import requests

from http.server import BaseHTTPRequestHandler
from http.server import HTTPServer
from urllib.parse import parse_qs

class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        params = dict(parse_qs(self.path.split("?")[1])) if "?" in self.path else {}
        params = {k: v[0] for k, v in params.items()}
        url = params.get("url")
        if not url:
            self.send_response(400)
            self.end_headers()
            return
        response = requests.get(url, timeout=10)
        body = response.text.strip() if response.ok else ""
        self.send_response(200)
        self.send_header("Content-Type", "text/plain")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body.encode())

if __name__ == "__main__":
    print("Starting proxy at http://localhost:8001/")
    HTTPServer(("127.0.0.1", 8001), Handler).serve_forever()
