#!/usr/bin/env python3
"""
Spotify OAuth 一次性授权脚本
运行后会打开浏览器，用户授权后自动获取 refresh_token
"""

import os
import sys
import json
import base64
import webbrowser
import urllib.parse
from http.server import HTTPServer, BaseHTTPRequestHandler

CLIENT_ID = os.environ.get("SPOTIFY_CLIENT_ID", "")
CLIENT_SECRET = os.environ.get("SPOTIFY_CLIENT_SECRET", "")
REDIRECT_URI = "http://127.0.0.1:8888/callback"
SCOPES = " ".join([
    "user-read-playback-state",
    "user-modify-playback-state",
    "user-read-currently-playing",
    "user-read-recently-played",
    "user-library-read",
    "user-library-modify",
    "playlist-read-private",
    "playlist-read-collaborative",
    "playlist-modify-public",
    "playlist-modify-private",
    "user-top-read",
])

TOKEN_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".spotify_tokens.json")

auth_code = None


class CallbackHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        global auth_code
        query = urllib.parse.urlparse(self.path).query
        params = urllib.parse.parse_qs(query)

        if "code" in params:
            auth_code = params["code"][0]
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.end_headers()
            self.wfile.write("✅ 授权成功！可以关闭此页面。".encode("utf-8"))
        elif "error" in params:
            self.send_response(400)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.end_headers()
            self.wfile.write(f"❌ 授权失败: {params['error'][0]}".encode("utf-8"))
        else:
            self.send_response(400)
            self.end_headers()

    def log_message(self, format, *args):
        pass  # suppress logs


def exchange_code_for_tokens(code):
    import urllib.request

    auth_header = base64.b64encode(f"{CLIENT_ID}:{CLIENT_SECRET}".encode()).decode()
    data = urllib.parse.urlencode({
        "grant_type": "authorization_code",
        "code": code,
        "redirect_uri": REDIRECT_URI,
    }).encode()

    req = urllib.request.Request(
        "https://accounts.spotify.com/api/token",
        data=data,
        headers={
            "Authorization": f"Basic {auth_header}",
            "Content-Type": "application/x-www-form-urlencoded",
        },
    )

    with urllib.request.urlopen(req) as resp:
        return json.loads(resp.read().decode())


def main():
    # Build auth URL
    auth_params = urllib.parse.urlencode({
        "client_id": CLIENT_ID,
        "response_type": "code",
        "redirect_uri": REDIRECT_URI,
        "scope": SCOPES,
        "show_dialog": "true",
    })
    auth_url = f"https://accounts.spotify.com/authorize?{auth_params}"

    print("🎵 Spotify OAuth 授权")
    print(f"正在打开浏览器...\n")

    # Start local server
    server = HTTPServer(("localhost", 8888), CallbackHandler)
    webbrowser.open(auth_url)

    print("等待授权回调...")
    while auth_code is None:
        server.handle_request()

    server.server_close()
    print(f"✅ 获取到 authorization code")

    # Exchange for tokens
    print("正在换取 tokens...")
    tokens = exchange_code_for_tokens(auth_code)

    if "refresh_token" not in tokens:
        print(f"❌ 获取 token 失败: {json.dumps(tokens, indent=2)}")
        sys.exit(1)

    # Save tokens
    token_data = {
        "access_token": tokens["access_token"],
        "refresh_token": tokens["refresh_token"],
        "expires_in": tokens.get("expires_in", 3600),
    }

    with open(TOKEN_FILE, "w") as f:
        json.dump(token_data, f, indent=2)

    print(f"\n✅ 授权完成！")
    print(f"   refresh_token 已保存到: {TOKEN_FILE}")
    print(f"   refresh_token: {tokens['refresh_token'][:20]}...")


if __name__ == "__main__":
    main()
