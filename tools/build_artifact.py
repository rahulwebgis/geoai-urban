"""Bundle the site into one self-contained HTML page (all CSS and app JS inlined).
Used for the sandboxed GeoVision build, which runs without outside network access:
data comes from uploaded files or the built-in example city.

    python tools/build_artifact.py out/geovision.html path/to/leaflet.css path/to/leaflet.draw.css
"""
import re, sys
from pathlib import Path

root = Path(__file__).resolve().parent.parent
out, leaflet_css, draw_css = sys.argv[1], sys.argv[2], sys.argv[3]
html = (root / "index.html").read_text()
head = re.search(r"<head>(.*?)</head>", html, re.S).group(1)
body = re.search(r"<body>(.*?)</body>", html, re.S).group(1)

fonts = re.search(r'<link href="https://fonts.googleapis.com[^>]+>', head).group(0)
strip_urls = lambda css: re.sub(r"url\((?!data:)[^)]*\)", "none", css)
css = strip_urls(Path(leaflet_css).read_text()) + "\n" + strip_urls(Path(draw_css).read_text()) + "\n" + (root / "css/style.css").read_text()
css += "\n:root { color-scheme: light; }\nhtml, body { background: var(--paper); }\n#map { background: #E4EAF1; }\n"

def inline(m):
    src = m.group(1)
    if src.startswith("http"):
        return m.group(0)
    return "<script>\n" + (root / src).read_text().replace("</script", "<\\/script") + "\n</script>"

body = re.sub(r'<script src="([^"]+)"></script>', inline, body)
body = body.replace('<img src="assets/logo.svg"', '<img src="data:image/svg+xml;base64,' + __import__("base64").b64encode((root / "assets/logo.svg").read_bytes()).decode() + '"')
body = body.replace("<strong>GeoAI Urban Mapping Platform</strong>", "<strong>GeoVision</strong>", 1)
body = body.replace("<small>Transforming geospatial data into intelligent urban insights</small>", "<small>GeoAI Urban Mapping Platform</small>", 1)
page = f"""<title>GeoVision</title>
{fonts}
<style>
{css}
</style>
<script>window.GEOAI_ENV = 'artifact';</script>
{body}"""
Path(out).parent.mkdir(parents=True, exist_ok=True)
Path(out).write_text(page)
print("wrote", out, len(page) // 1024, "KB")
