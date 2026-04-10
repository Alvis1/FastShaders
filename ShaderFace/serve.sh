#!/bin/bash
# Serve ShaderFace on port 8080, accessible from LAN, no caching, correct MIME types
cd "$(dirname "$0")"
IP=$(ipconfig getifaddr en0 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}')
echo "ShaderFace serving at:"
echo "  Local:   http://localhost:8080"
echo "  Network: http://${IP}:8080"
echo ""
python3 -c "
import http.server
import mimetypes

# Ensure .js and .mjs are served with correct MIME type
mimetypes.add_type('application/javascript', '.js')
mimetypes.add_type('application/javascript', '.mjs')

class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()

    def guess_type(self, path):
        t = super().guess_type(path)
        if path.endswith('.js') or path.endswith('.mjs'):
            return 'application/javascript'
        return t

http.server.HTTPServer(('0.0.0.0', 8080), Handler).serve_forever()
"
