"""Local drawing review server. Bind only to loopback; never edits original drawings."""
import argparse
import hashlib
import json
import math
import mimetypes
import shutil
import threading
import uuid
import xml.etree.ElementTree as ET
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlencode, urlparse

ROOT = Path(__file__).resolve().parents[1]
STATIC = Path(__file__).resolve().parent / 'static'
OBJECTS = ROOT / 'objects'
LOCK = threading.RLock()
KINDS = {'comment':'Замечание','move':'Переместить','delete':'Удалить','add':'Добавить',
         'align':'Выровнять','resize':'Изменить размер','joint':'Исправить стык'}
ELEMENTS = {'other':'Элемент','wall':'Стена','window':'Окно','balcony':'Балкон / лоджия',
            'stairs':'Лестница','door':'Дверь','roof':'Крыша'}
SVG = 'http://www.w3.org/2000/svg'
ET.register_namespace('', SVG)


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def scoped_pointer(project, sha, drawing):
    key=hashlib.sha256(drawing.encode('utf-8')).hexdigest()[:16]
    return project/'review'/f'latest-{sha}-{key}.json'


def drawing_path(obj, name):
    if not isinstance(obj, str) or not isinstance(name, str):
        raise ValueError('Не выбран чертёж')
    project = (OBJECTS / obj).resolve()
    if project.parent != OBJECTS.resolve() or not project.is_dir():
        raise ValueError('Объект не найден')
    version = 'v1'
    if isinstance(name, str) and name.startswith('v') and '/' in name:
        version, name = name.split('/', 1)
    out = (project / 'output' / version).resolve()
    if version.startswith('v') and version[1:].isdigit() and out.is_dir():
        base = out
        path = (base / name).resolve()
    elif version == 'v1' and not any((project/'output').glob('v[0-9]*')):
        base = (project / 'output').resolve()
        path = (base / name).resolve()
    else:
        raise ValueError('Версия чертежа не найдена')
    if path.parent != base or path.suffix.lower() != '.dxf' or not path.is_file():
        raise ValueError('Чертёж не найден')
    return project, path, version


def source_path(obj, name):
    project=(OBJECTS/obj).resolve()
    if project.parent!=OBJECTS.resolve() or not project.is_dir(): raise ValueError('Объект не найден')
    for folder in ('sources','references'):
        base=(project/folder).resolve(); candidate=(base/name).resolve()
        if candidate.parent==base and candidate.is_file(): return candidate
    raise ValueError('Исходный файл не найден')


def catalog():
    result = []
    for project in sorted(OBJECTS.iterdir()):
        if not project.is_dir():
            continue
        versions=[]
        for folder in sorted((project/'output').glob('v[0-9]*'),key=lambda p:int(p.name[1:]) if p.name[1:].isdigit() else -1):
            if folder.is_dir() and folder.name[1:].isdigit():
                drawings=[{'name':p.name,'modified':p.stat().st_mtime} for p in sorted(folder.glob('*.dxf'))]
                if drawings: versions.append({'id':folder.name,'drawings':drawings})
        if not versions:
            drawings=[{'name':p.name,'modified':p.stat().st_mtime} for p in sorted((project/'output').glob('*.dxf'))]
            if drawings: versions=[{'id':'v1','drawings':drawings}]
        sources=[];source_categories={}
        brief_path=project/'models'/'brief.json'
        if brief_path.is_file():
            try:source_categories={x.get('filename'):x.get('category','') for x in json.loads(brief_path.read_text(encoding='utf-8')).get('sources',[])}
            except (OSError,json.JSONDecodeError):pass
        for folder in ('sources','references'):
            for p in sorted((project/folder).glob('*')):
                if p.is_file() and p.suffix.lower() in ('.png','.jpg','.jpeg','.webp','.pdf','.tif','.tiff','.bmp','.dxf','.dwg','.doc','.docx','.xls','.xlsx','.csv','.txt','.rtf','.json','.zip'):
                    sources.append({'name':p.name,'folder':folder,'category':source_categories.get(p.name,''),'url':'/api/source?'+urlencode({'object':project.name,'file':p.name}), 'mime':mimetypes.guess_type(p.name)[0] or 'application/octet-stream'})
        brief_path=project/'models'/'brief.json'
        if versions or brief_path.is_file():
            title=project.name.replace('_',' ')
            if brief_path.is_file():
                try:title=json.loads(brief_path.read_text(encoding='utf-8')).get('title') or title
                except (OSError,json.JSONDecodeError):pass
            result.append({'id':project.name,'name':title,'versions':versions,'sources':sources,
                           'has_brief':brief_path.is_file()})
    return result


def prepare(obj, name):
    import ezdxf
    from ezdxf.addons.drawing import Frontend, RenderContext, config, layout, svg
    project, path, version = drawing_path(obj, name)
    sha = digest(path)
    cache = project/'review'/'previews'/sha
    with LOCK:
        cache.mkdir(parents=True, exist_ok=True)
        if not (cache/'mapping.json').is_file():
            doc = ezdxf.readfile(path)
            backend = svg.SVGBackend()
            conf = config.Configuration(color_policy=config.ColorPolicy.BLACK,
                                        background_policy=config.BackgroundPolicy.WHITE)
            Frontend(RenderContext(doc),backend,config=conf).draw_layout(doc.modelspace(),finalize=True)
            bounds = backend.player().bbox()
            if not bounds.has_data:
                raise ValueError('Чертёж пуст')
            size = bounds.size
            page = layout.Page(420,20+400*max(size.y,1)/max(size.x,1),layout.Units.mm,
                               margins=layout.Margins.all(10))
            markup = backend.get_string(page)
            # Invert the actual export transform, not a guessed image-to-CAD ratio.
            transform = backend.transformation_matrix.copy()
            transform.inverse()
            p0, px, py = [transform.transform(v) for v in [(0,0,0),(1,0,0),(0,1,0)]]
            root = ET.fromstring(markup)
            viewbox = list(map(float,root.attrib['viewBox'].split()))
            metadata = {'sha256':sha,'viewbox':viewbox,
                        'svg_to_cad':[px.x-p0.x,px.y-p0.y,py.x-p0.x,py.y-p0.y,p0.x,p0.y],
                        'units':int(doc.units),'generated_at':datetime.now().astimezone().isoformat()}
            (cache/'source.svg').write_text(markup,encoding='utf-8')
            (cache/'mapping.json').write_text(json.dumps(metadata,ensure_ascii=False),encoding='utf-8')
        metadata = json.loads((cache/'mapping.json').read_text(encoding='utf-8'))
    metadata.update({'object':obj,'file':path.name,'version':version,'preview_url':'/api/preview?'+urlencode({'object':obj,'file':version+'/'+path.name,'sha':sha})})
    return project,path,cache,metadata


def coordinate(point, meta):
    if not isinstance(point,dict):
        raise ValueError('Некорректная точка')
    nx,ny = float(point['x']),float(point['y'])
    if not (math.isfinite(nx) and math.isfinite(ny) and 0<=nx<=1 and 0<=ny<=1):
        raise ValueError('Отметка выходит за пределы листа')
    x0,y0,w,h = meta['viewbox']; x,y = x0+nx*w,y0+ny*h
    a,b,c,d,e,f = meta['svg_to_cad']
    return {'normalized':{'x':nx,'y':ny},'svg':{'x':x,'y':y},
            'cad':{'x':a*x+c*y+e,'y':b*x+d*y+f,'units':meta['units']}}


def validate_annotations(items,meta):
    if not isinstance(items,list) or len(items)>300:
        raise ValueError('Можно сохранить не более 300 замечаний')
    result=[]; seen=set()
    for i,item in enumerate(items,1):
        ident=str(item.get('id',''))
        if not ident or len(ident)>100 or ident in seen:
            raise ValueError('Некорректный идентификатор замечания')
        seen.add(ident)
        kind=item.get('action');shape=item.get('shape')
        if kind not in KINDS or shape not in ('rect','arrow','point','line'):
            raise ValueError('Неизвестный инструмент')
        text=str(item.get('text','')).strip()
        value=str(item.get('value','')).strip()
        if len(text)>4000 or len(value)>200:
            raise ValueError('Слишком длинное замечание')
        status=item.get('status','open')
        if status not in ('open','resolved'):raise ValueError('Неизвестный статус')
        element=item.get('element_type','other')
        if element not in ELEMENTS:raise ValueError('Неизвестный тип элемента')
        pts=item.get('points',[])
        if len(pts)!=(1 if shape=='point' else 2):raise ValueError('Недостаточно точек')
        result.append({'id':ident,'number':i,'action':kind,'action_label':KINDS[kind],
                       'element_type':element,'element_label':ELEMENTS[element],
                       'shape':shape,'text':text,'value':value,'status':status,
                       'points':[coordinate(p,meta) for p in pts]})
    return result


def marked_svg(source,annotations):
    root=ET.fromstring(source)
    _,_,w,h=map(float,root.attrib['viewBox'].split())
    unit=max(w,h)/1600
    group=ET.SubElement(root,f'{{{SVG}}}g',{'id':'review-annotations','stroke-linecap':'round','stroke-linejoin':'round'})
    def add(tag,**attrs):return ET.SubElement(group,f'{{{SVG}}}{tag}',{k.replace('_','-'):str(v) for k,v in attrs.items()})
    for item in annotations:
        pts=[p['svg'] for p in item['points']];a=pts[0];b=pts[-1]
        color='#6b7280' if item['status']=='resolved' else '#d33b31'
        attr={'stroke':color,'stroke_width':3*unit,'fill':'none'}
        if item['shape']=='rect':
            add('rect',x=min(a['x'],b['x']),y=min(a['y'],b['y']),width=max(abs(b['x']-a['x']),unit),height=max(abs(b['y']-a['y']),unit),**attr)
        elif item['shape'] in ('line','arrow'):
            add('line',x1=a['x'],y1=a['y'],x2=b['x'],y2=b['y'],**attr)
            if item['shape']=='arrow':
                angle=math.atan2(b['y']-a['y'],b['x']-a['x']);length=16*unit
                q=[(b['x']-length*math.cos(angle+s),b['y']-length*math.sin(angle+s)) for s in (-.48,.48)]
                add('polyline',points=f"{q[0][0]},{q[0][1]} {b['x']},{b['y']} {q[1][0]},{q[1][1]}",**attr)
        else:add('circle',cx=a['x'],cy=a['y'],r=9*unit,**attr)
        cy=a['y']-15*unit
        add('circle',cx=a['x'],cy=cy,r=13*unit,fill=color,stroke='white',stroke_width=unit)
        label=add('text',x=a['x'],y=cy+4*unit,fill='white',font_size=14*unit,font_family='Arial',text_anchor='middle',stroke='none')
        label.text=str(item['number'])
    return ET.tostring(root,encoding='unicode')


def save_review(payload):
    import resvg_py
    project,path,cache,meta=prepare(payload.get('object'),payload.get('file'))
    if payload.get('sha256')!=meta['sha256']:
        raise FileExistsError('Чертёж изменился. Откройте его заново перед сохранением.')
    if payload.get('annotations')==[] and payload.get('clear_all') is not True:
        raise ValueError('Для удаления всех замечаний требуется явное подтверждение операции')
    items=validate_annotations(payload.get('annotations'),meta)
    revision='revision-'+datetime.now().astimezone().strftime('%Y%m%d-%H%M%S')+'-'+uuid.uuid4().hex[:6]
    destination=project/'review'/revision
    markup=marked_svg((cache/'source.svg').read_text(encoding='utf-8'),items)
    png=resvg_py.svg_to_bytes(svg_string=markup,width=2200,dpi=96)
    # Check once more after rendering; never associate notes with a different source.
    if digest(path)!=meta['sha256']:raise FileExistsError('Чертёж изменился во время сохранения')
    destination.mkdir(parents=True,exist_ok=False)
    record={'schema_version':1,'revision':revision,'created_at':datetime.now().astimezone().isoformat(),
            'object':payload['object'],'drawing':payload['file'],'sha256':meta['sha256'],
            'source_path':path.relative_to(ROOT).as_posix(),'mapping':meta,'annotations':items}
    shutil.copy2(path,destination/'source.dxf')
    shutil.copy2(cache/'source.svg',destination/'source.svg')
    (destination/'marked-preview.svg').write_text(markup,encoding='utf-8')
    (destination/'marked-preview.png').write_bytes(png)
    (destination/'comments.json').write_text(json.dumps(record,ensure_ascii=False,indent=2),encoding='utf-8')
    summary=[f'# Замечания: {payload["file"]}',f'Версия: {revision}',f'SHA256: {meta["sha256"]}','']
    if not items:summary.append('Список замечаний очищен.')
    for item in items:
        summary.append(f'{item["number"]}. {item["element_label"]}: {item["action_label"]} — {item["text"] or "См. отметку на чертеже"}')
        if item['value']:summary.append(f'   Размер/значение: {item["value"]}')
        summary.append(f'   Статус: {item["status"]}; координаты CAD: '+str([p['cad'] for p in item['points']]))
    (destination/'comments.md').write_text('\n'.join(summary),encoding='utf-8')
    # Per-drawing pointer, written only after the complete revision exists.
    canonical=meta['version']+'/'+path.name
    for pointer in (scoped_pointer(project,meta['sha256'],canonical),project/'review'/f'latest-{meta["sha256"]}.json'):
        temporary=pointer.with_suffix('.tmp')
        temporary.write_text(json.dumps({'revision':revision},ensure_ascii=False),encoding='utf-8')
        temporary.replace(pointer)
    return {'revision':revision,'path':str(destination),'count':len(items)}


def review_results(obj, name):
    """Read reports only when their source revision and both drawing hashes match."""
    project, current, current_version = drawing_path(obj, name)
    current_name=current_version+'/'+current.name
    reports=[]
    for report_path in sorted((project/'output').glob('v[0-9]*/review-results*.json')):
        try:
            report=json.loads(report_path.read_text(encoding='utf-8-sig'))
            revision=report['source_revision']
            if not isinstance(revision,str) or not revision.startswith('revision-') or Path(revision).name!=revision:
                continue
            revision_path=(project/'review'/revision/'comments.json').resolve()
            if revision_path.parent.parent!=(project/'review').resolve():continue
            original=json.loads(revision_path.read_text(encoding='utf-8-sig'))
            source=report['source_drawing'];target=report['target_drawing']
            _,source_path,source_version=drawing_path(obj,source)
            _,target_path,target_version=drawing_path(obj,target)
            if target_version!=report_path.parent.name:continue
            if source!=source_version+'/'+source_path.name or target!=target_version+'/'+target_path.name:continue
            original_drawings={source}
            if source_version=='v1':original_drawings.add(source_path.name)
            if original.get('object')!=obj or original.get('revision')!=revision or original.get('drawing') not in original_drawings:continue
            if original.get('sha256')!=report.get('source_sha256') or digest(source_path)!=report.get('source_sha256'):continue
            if digest(target_path)!=report.get('target_sha256'):continue
            if current_name not in (source,target):continue
            valid_items={item['id']:item for item in original.get('annotations',[])}
            items=[]
            for item in report.get('results',[]):
                original_item=valid_items.get(item.get('annotation_id'))
                if original_item and item.get('status') in ('resolved','needs_clarification','not_done'):
                    items.append({'annotation_id':item['annotation_id'],'status':item['status'],
                                  'number':original_item.get('number'),
                                  'description':str(item.get('description',''))[:2000]})
            reports.append({'source_revision':revision,'source_drawing':source,'target_drawing':target,'results':items})
        except (OSError,ValueError,KeyError,TypeError,AttributeError,json.JSONDecodeError):
            continue
    return reports


class Handler(BaseHTTPRequestHandler):
    def log_message(self,fmt,*args):print(fmt%args,flush=True)
    def reply(self,body,status=200,mime='application/json; charset=utf-8'):
        if isinstance(body,(dict,list)):body=json.dumps(body,ensure_ascii=False).encode('utf-8')
        elif isinstance(body,str):body=body.encode('utf-8')
        self.send_response(status);self.send_header('Content-Type',mime)
        self.send_header('Content-Length',str(len(body)));self.send_header('Cache-Control','no-store')
        self.send_header('X-Content-Type-Options','nosniff');self.end_headers();self.wfile.write(body)
    def query(self):
        url=urlparse(self.path);return url.path,{k:v[0] for k,v in parse_qs(url.query).items()}
    def do_GET(self):
        try:
            route,q=self.query()
            if route=='/api/projects':return self.reply(catalog())
            if route=='/api/results':return self.reply(review_results(q.get('object'),q.get('file')))
            if route=='/api/brief':
                obj=q.get('object','');project=(OBJECTS/obj).resolve()
                if project.parent!=OBJECTS.resolve():raise ValueError('Объект не найден')
                path=project/'models'/'brief.json'
                if not path.is_file():return self.reply({'error':'Для объекта нет сохранённого брифа'},404)
                return self.reply(json.loads(path.read_text(encoding='utf-8')))
            if route=='/api/source':
                path=source_path(q.get('object'),q.get('file'))
                return self.reply(path.read_bytes(),mime=(mimetypes.guess_type(path.name)[0] or 'application/octet-stream'))
            if route in ('/api/drawing','/api/preview','/api/latest'):
                project,path,cache,meta=prepare(q.get('object'),q.get('file'))
                if route=='/api/drawing':return self.reply(meta)
                if route=='/api/preview':
                    if q.get('sha')!=meta['sha256']:return self.reply({'error':'Чертёж изменился'},409)
                    return self.reply((cache/'source.svg').read_bytes(),mime='image/svg+xml')
                canonical=meta['version']+'/'+path.name
                pointer=scoped_pointer(project,meta['sha256'],canonical)
                if not pointer.exists():pointer=project/'review'/f'latest-{meta["sha256"]}.json'
                if not pointer.exists():return self.reply({'annotations':[]})
                rev=json.loads(pointer.read_text(encoding='utf-8'))['revision']
                record=json.loads((project/'review'/rev/'comments.json').read_text(encoding='utf-8'))
                allowed_drawings={canonical}
                if meta['version']=='v1':allowed_drawings.add(path.name)
                if record.get('drawing') not in allowed_drawings or record.get('sha256')!=meta['sha256'] or record.get('object')!=q.get('object'):
                    return self.reply({'annotations':[]})
                return self.reply(record)
            allowed={'/':'index.html','/app.js':'app.js','/style.css':'style.css'}
            if route not in allowed:return self.reply({'error':'Не найдено'},404)
            asset=STATIC/allowed[route]
            return self.reply(asset.read_bytes(),mime=(mimetypes.guess_type(asset.name)[0] or 'application/octet-stream')+'; charset=utf-8')
        except ValueError as exc:self.reply({'error':str(exc)},400)
        except Exception as exc:
            print(repr(exc),flush=True);self.reply({'error':'Не удалось открыть чертёж: '+str(exc)},500)
    def do_POST(self):
        try:
            if urlparse(self.path).path!='/api/reviews':return self.reply({'error':'Не найдено'},404)
            origin=self.headers.get('Origin')
            if origin and origin!=f'http://{self.headers.get("Host")}':
                return self.reply({'error':'Недопустимый источник запроса'},403)
            if not self.headers.get('Content-Type','').startswith('application/json'):
                return self.reply({'error':'Ожидается JSON'},415)
            size=int(self.headers.get('Content-Length','0'))
            if not 0<size<2_000_000:raise ValueError('Некорректный размер запроса')
            payload=json.loads(self.rfile.read(size))
            with LOCK:result=save_review(payload)
            self.reply(result,201)
        except FileExistsError as exc:self.reply({'error':str(exc)},409)
        except (ValueError,KeyError,TypeError) as exc:self.reply({'error':str(exc)},400)
        except Exception as exc:
            print(repr(exc),flush=True);self.reply({'error':'Не удалось сохранить: '+str(exc)},500)


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--port',type=int,default=8765)
    args=parser.parse_args()
    print(f'Drawing review: http://127.0.0.1:{args.port}',flush=True)
    ThreadingHTTPServer(('127.0.0.1',args.port),Handler).serve_forever()
