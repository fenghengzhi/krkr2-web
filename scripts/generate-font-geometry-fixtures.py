"""Project-owned outlines with curves, overhang and positive bearings."""
import hashlib, json, pathlib
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen
import fontTools
root = pathlib.Path(__file__).resolve().parents[1]
out = root / 'tests/fixtures/font-geometry'
builder = FontBuilder(1000, isTTF=True)
order = ['.notdef', 'space', 'T', 'Q', 'R']
builder.setupGlyphOrder(order)
builder.setupCharacterMap({32:'space', 84:'T', 81:'Q', 82:'R'})
drawings = {}
for char in order:
    pen = TTGlyphPen(None)
    if char == 'T':
        pen.moveTo((-170,-120)); pen.lineTo((430,810)); pen.lineTo((570,735)); pen.lineTo((-10,-145)); pen.closePath()
    elif char == 'Q':
        pen.moveTo((0,350)); pen.qCurveTo((0,790),(340,790)); pen.qCurveTo((690,790),(690,350)); pen.qCurveTo((690,-130),(340,-130)); pen.qCurveTo((0,-130),(0,350)); pen.closePath()
    elif char != 'space':
        pen.moveTo((125,30)); pen.lineTo((475,30)); pen.lineTo((605,655)); pen.lineTo((125,655)); pen.closePath()
    drawings[char] = pen.glyph()
builder.setupGlyf(drawings)
builder.setupHorizontalMetrics({c:(350 if c=='space' else 1100, -170 if c=='T' else 0 if c in ['Q','space'] else 125) for c in order})
builder.setupHorizontalHeader(ascent=860, descent=-220, lineGap=40)
builder.setupNameTable({'familyName':'Krkr Geometry','styleName':'Regular','uniqueFontIdentifier':'krkr-geometry-1','fullName':'Krkr Geometry','psName':'KrkrGeometry','version':'Version 1.0'})
builder.setupOS2(sTypoAscender=860,sTypoDescender=-220,usWinAscent=860,usWinDescent=220)
builder.setupPost(underlinePosition=-110,underlineThickness=110)
builder.setupMaxp()
builder.font['head'].created=builder.font['head'].modified=3406620153
builder.font.recalcTimestamp=False
builder.save(out/'outlines.ttf')
(out/'outlines.json').write_text(json.dumps({'generator':'scripts/generate-font-geometry-fixtures.py','fontToolsVersion':fontTools.__version__,'license':'Project-owned synthetic outlines; no external glyphs copied.','sha256':hashlib.sha256((out/'outlines.ttf').read_bytes()).hexdigest()},indent=2)+'\n')
