"""Build millimetre DXF and SVG from an architectural JSON model."""
import argparse
import json
import math
from pathlib import Path
import ezdxf
from ezdxf import bbox
from ezdxf.enums import TextEntityAlignment
from ezdxf.addons.drawing import Frontend, RenderContext, config, layout, svg
from shapely.geometry import LineString, Polygon, box
from shapely.ops import unary_union


def point(value):
    if len(value) != 2 or not all(math.isfinite(float(x)) for x in value):
        raise ValueError(f"Expected finite [x,y]: {value}")
    return tuple(float(x) for x in value)


def positive(value):
    value = float(value)
    if not math.isfinite(value) or value <= 0:
        raise ValueError("Thickness, radius or text height must be positive")
    return value


def polygon(spec):
    if "box" in spec:
        x1, y1, x2, y2 = map(float, spec["box"])
        if not all(math.isfinite(v) for v in (x1,y1,x2,y2)) or x2<=x1 or y2<=y1:
            raise ValueError("Invalid xmin,ymin,xmax,ymax")
        result = box(x1,y1,x2,y2)
    else:
        result = Polygon([point(p) for p in spec.get('shell',spec.get('points'))],
                         [[point(p) for p in r] for r in spec.get('holes',[])])
    if result.is_empty or not result.is_valid or result.area <= 0:
        raise ValueError("Repair invalid/empty input polygon")
    return result


def build(model, prefix):
    if model.get('units') != 'mm':
        raise ValueError('Convert coordinates and set units to mm')
    prefix = Path(prefix)
    prefix.parent.mkdir(parents=True, exist_ok=True)
    doc = ezdxf.new('R2010'); doc.units = 4
    doc.header['$INSUNITS'] = 4; doc.header['$MEASUREMENT'] = 1
    weights = dict(WALLS=35, WINDOWS=18, BALCONIES=25, STAIRS=18,
                   DETAILS=13, DIMENSIONS=18, AXES=13, NOTES=18)
    for name, weight in weights.items():
        doc.layers.new(name, dxfattribs={'color':7,'true_color':0,'lineweight':weight})
    doc.layers.get('0').dxf.true_color = 0
    doc.styles.new('PLAN', dxfattribs={'font':'arial.ttf'})
    doc.linetypes.new('AXIS', dxfattribs={'description':'Axis dash dot','pattern':[1100,700,-120,120,-160]})
    m = doc.modelspace()
    solids = [polygon(p) for p in model.get('wall_polygons',[])]
    for wall in model.get('walls',[]):
        a,b = point(wall['a']),point(wall['b'])
        if a==b: raise ValueError('Zero-length wall')
        solids.append(LineString([a,b]).buffer(positive(wall['thickness'])/2,cap_style=3,join_style=2))
    walls = unary_union(solids)
    cuts = [polygon(p) for p in model.get('openings',[])]
    if cuts and not walls.is_empty: walls = walls.difference(unary_union(cuts))
    if not walls.is_valid: raise ValueError('Invalid wall geometry')
    for shape in (list(walls.geoms) if hasattr(walls,'geoms') else [walls]):
        if shape.is_empty: continue
        for ring in [shape.exterior,*shape.interiors]:
            m.add_lwpolyline(list(ring.coords)[:-1],close=True,dxfattribs={'layer':'WALLS'})
    for spec in model.get('entities',[]):
        kind = spec['type']
        layer = spec.get('layer',{'axis':'AXES','dimension':'DIMENSIONS','text':'NOTES'}.get(kind,'DETAILS'))
        if layer not in doc.layers:
            doc.layers.new(layer,dxfattribs={'color':7,'true_color':0,'lineweight':18})
        attrs = {'layer':layer}
        if kind=='line':
            a,b = point(spec['a']),point(spec['b'])
            if a==b: raise ValueError('Zero-length line')
            m.add_line(a,b,dxfattribs=attrs)
        elif kind=='polyline':
            pts = [point(p) for p in spec['points']]
            if len(pts)<2: raise ValueError('Polyline requires >=2 points')
            m.add_lwpolyline(pts,close=bool(spec.get('closed',False)),dxfattribs=attrs)
        elif kind=='circle':
            m.add_circle(point(spec['center']),positive(spec['radius']),dxfattribs=attrs)
        elif kind=='text':
            if not model.get('allow_notes',False): raise ValueError('Free text disabled: enable allow_notes explicitly')
            m.add_text(spec['text'],dxfattribs={**attrs,'style':'PLAN','height':positive(spec['height']),'insert':point(spec['at'])})
        elif kind=='axis':
            a,b = point(spec['a']),point(spec['b']); r = positive(spec.get('radius',200))
            length = math.dist(a,b)
            if length<=r: raise ValueError('Axis endpoint is inside circle')
            start = (a[0]+(b[0]-a[0])*r/length,a[1]+(b[1]-a[1])*r/length)
            m.add_circle(a,r,dxfattribs=attrs)
            m.add_line(start,b,dxfattribs={**attrs,'linetype':'AXIS'})
            m.add_text(str(spec['label']),dxfattribs={**attrs,'style':'PLAN','height':positive(spec.get('text_height',220))}).set_placement(a,align=TextEntityAlignment.MIDDLE_CENTER)
        elif kind=='dimension':
            h = positive(spec.get('text_height',200))
            dim = m.add_linear_dim(base=point(spec['base']),p1=point(spec['a']),p2=point(spec['b']),
                angle=float(spec.get('angle',0)),dxfattribs=attrs,
                override={'dimtxt':h,'dimasz':h*.7,'dimexo':h*.3,'dimexe':h*.6,'dimgap':h*.3,
                          'dimtad':1,'dimdec':0,'dimclrd':0,'dimclre':0,'dimclrt':0})
            dim.render()
        else: raise ValueError(f'Unknown entity type: {kind}')
    if not len(m): raise ValueError('Empty model')
    audit = doc.audit()
    if audit.errors: raise ValueError(f'{len(audit.errors)} unresolved DXF errors')
    doc.saveas(prefix.with_suffix('.dxf'))
    loaded = ezdxf.readfile(prefix.with_suffix('.dxf'))
    backend = svg.SVGBackend()
    conf = config.Configuration(color_policy=config.ColorPolicy.BLACK,background_policy=config.BackgroundPolicy.WHITE)
    Frontend(RenderContext(loaded),backend,config=conf).draw_layout(loaded.modelspace(),finalize=True)
    ext = bbox.extents(loaded.modelspace())
    size = ext.size
    page = layout.Page(420,20+400*max(size.y,1)/max(size.x,1),layout.Units.mm,margins=layout.Margins.all(10))
    prefix.with_suffix('.svg').write_text(backend.get_string(page),encoding='utf-8')
    ext = bbox.extents(loaded.modelspace())
    report = dict(units='mm',sources=model.get('sources',[]),assumptions=model.get('assumptions',[]),
                  entities=len(loaded.modelspace()),audit_errors=len(audit.errors),audit_fixes=len(audit.fixes),
                  wall_area_mm2=walls.area,wall_geometry_valid=walls.is_valid,
                  extents={'min':list(ext.extmin),'max':list(ext.extmax)})
    prefix.with_suffix('.report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('model',type=Path)
    parser.add_argument('--out',required=True,type=Path,help='Output prefix without extension')
    args = parser.parse_args()
    report = build(json.loads(args.model.read_text(encoding='utf-8-sig')),args.out)
    print(json.dumps({'dxf':str(args.out.with_suffix('.dxf')),'entities':report['entities'],
                      'audit_errors':report['audit_errors']},ensure_ascii=False))


if __name__=='__main__': main()
