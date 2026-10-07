from pathlib import Path

path = Path('tampermonkey/facebook-posts-to-wordpress.user.js')
src = path.read_text(encoding='utf-8')

old_version = '// @version      1.4.17'
new_version = '// @version      1.4.18'
if old_version not in src:
    raise SystemExit('Expected collector version 1.4.17 not found')
src = src.replace(old_version, new_version, 1)

old = "        let s = normalize(value).replace(/\\u202f/g, ' ');"
new = """        let s = normalize(value)\n            .replace(/[\\u200B-\\u200F\\u2060\\uFEFF]/g, '')\n            .replace(/\\u202f/g, ' ')\n            .trim();"""
if old not in src:
    raise SystemExit('parseFbDate normalization line not found')
src = src.replace(old, new, 1)

path.write_text(src, encoding='utf-8')
