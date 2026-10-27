'use strict';
const $ = id => document.getElementById(id);
const NS='http://www.w3.org/2000/svg';
const LABELS={comment:'Замечание',move:'Переместить',delete:'Удалить',add:'Добавить',align:'Выровнять',resize:'Изменить размер',joint:'Исправить стык'};
const DEFAULT_TOOLS={comment:'rect',move:'arrow',delete:'rect',add:'point',align:'line',resize:'line',joint:'rect'};
const HINTS={pan:'Перетащите лист',rect:'Обведите место ошибки',arrow:'Протяните стрелку: откуда → куда',point:'Нажмите в нужном месте',line:'Укажите линию между двумя точками'};
const PLACEHOLDERS={comment:'Что здесь нужно исправить?',move:'Например: перенести окно к концу стрелки',delete:'Например: убрать это окно',add:'Например: добавить дверь в отмеченном месте',align:'Например: выровнять эти стены по одной линии',resize:'Например: ширина проёма должна быть 1200 мм',joint:'Например: соединить стены без выступов и щелей'};
const state={projects:[],meta:null,annotations:[],selected:null,action:'comment',tool:'rect',scale:1,tx:0,ty:0,W:1600,H:1000,drag:null,space:false,history:[],dirty:false,loading:false,loadId:0,view:'drawing',compare:false,compareSource:{W:1600,H:1000,scale:1,tx:0,ty:0,drag:null},compareDrawing:{W:1600,H:1000,scale:1,tx:0,ty:0,drag:null}};
let toastTimer,storageWarning=false;
function toast(message,error=false){$('toast').textContent=message;$('toast').className='show'+(error?' error':'');clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').className='',5000);}
async function api(url,options){const r=await fetch(url,options);const data=await r.json();if(!r.ok)throw new Error(data.error||'Ошибка запроса');return data;}
function el(tag,cls,text){const e=document.createElement(tag);if(cls)e.className=cls;if(text!==undefined)e.textContent=text;return e;}
function draftKey(){return state.meta?'drawing-review:'+state.meta.object+':'+state.meta.version+':'+state.meta.file+':'+state.meta.sha256:null;}
function persist(){const key=draftKey();if(!key)return;try{localStorage.setItem(key,JSON.stringify({annotations:state.annotations,dirty:state.dirty,updatedAt:Date.now()}));}catch{if(!storageWarning){toast('Браузер не сохранил черновик. Сохраните замечания кнопкой.',true);storageWarning=true;}}}
function history(){state.history.push(JSON.stringify({annotations:state.annotations,selected:state.selected}));if(state.history.length>50)state.history.shift();}
function changed(){state.dirty=true;persist();updateStatus();}
function updateStatus(){const count=state.annotations.length;$('count').textContent=count;$('empty-comments').hidden=count>0;$('draft-status').textContent=state.dirty?'Черновик · не сохранён в папку':'Нет несохранённых изменений';$('undo').disabled=!state.history.length;for(const id of ['save','save-top'])$(id).disabled=!state.meta||count===0||state.loading;for(const b of document.querySelectorAll('[data-action],[data-tool]'))b.disabled=!state.meta;$('compare-toggle').disabled=!state.meta;}
function setTool(tool){state.tool=tool;document.querySelectorAll('[data-tool]').forEach(b=>{const active=b.dataset.tool===tool;b.classList.toggle('active',active);b.setAttribute('aria-pressed',String(active));});$('tool-hint').textContent=HINTS[tool];$('viewport').classList.toggle('pan',tool==='pan'||state.space);}
function setAction(action){state.action=action;setTool(DEFAULT_TOOLS[action]);document.querySelectorAll('[data-action]').forEach(b=>{const active=b.dataset.action===action;b.classList.toggle('active',active);b.setAttribute('aria-pressed',String(active));});}
function transform(){const stage=$('stage');stage.style.width=state.W+'px';stage.style.height=state.H+'px';stage.style.transform=`translate(${state.tx}px,${state.ty}px) scale(${state.scale})`;$('zoom-value').textContent=Math.round(state.scale*100)+'%';if(state.compare){const d=state.compareDrawing,s=$('compare-drawing-stage');s.style.width=d.W+'px';s.style.height=d.H+'px';s.style.transform=`translate(${d.tx}px,${d.ty}px) scale(${d.scale})`;}drawOverlay();}
function fitCompare(which){if(!state.meta)return;const isSource=which==='source',v=$(isSource?'source-viewport':'compare-drawing-viewport'),d=isSource?state.compareSource:state.compareDrawing;d.W=isSource?d.W:state.W;d.H=isSource?d.H:state.H;d.scale=Math.max(.03,Math.min((v.clientWidth-35)/d.W,(v.clientHeight-35)/d.H));d.tx=(v.clientWidth-d.W*d.scale)/2;d.ty=(v.clientHeight-d.H*d.scale)/2;if(isSource){const s=$('source-stage');s.style.width=d.W+'px';s.style.height=d.H+'px';s.style.transform=`translate(${d.tx}px,${d.ty}px) scale(${d.scale})`;}else transform();}
function fit(){if(!state.meta&&state.view!=='source')return;if(state.compare&&state.meta){fitCompare('source');fitCompare('drawing');return;}const v=$('viewport');state.scale=Math.min((v.clientWidth-55)/state.W,(v.clientHeight-60)/state.H);state.scale=Math.max(.03,state.scale);state.tx=(v.clientWidth-state.W*state.scale)/2;state.ty=(v.clientHeight-state.H*state.scale)/2;transform();}
function zoom(factor,cx,cy){if(!state.meta&&state.view!=='source')return;if(state.compare&&state.meta){zoomCompare(state.compareDrawing,'compare-drawing-viewport','compare-drawing-stage',factor,cx,cy);return;}const v=$('viewport');cx??=v.clientWidth/2;cy??=v.clientHeight/2;const old=state.scale;state.scale=Math.max(.03,Math.min(6,old*factor));state.tx=cx-(cx-state.tx)*state.scale/old;state.ty=cy-(cy-state.ty)*state.scale/old;transform();}
function zoomCompare(d,viewportId,stageId,factor,cx,cy){const v=$(viewportId);cx??=v.clientWidth/2;cy??=v.clientHeight/2;const old=d.scale;d.scale=Math.max(.03,Math.min(6,old*factor));d.tx=cx-(cx-d.tx)*d.scale/old;d.ty=cy-(cy-d.ty)*d.scale/old;const s=$(stageId);s.style.transform=`translate(${d.tx}px,${d.ty}px) scale(${d.scale})`;if(d===state.compareDrawing){$('zoom-value').textContent=Math.round(d.scale*100)+'%';drawOverlay();}}
function point(evt,clamp=false){const r=$('viewport').getBoundingClientRect();let x=(evt.clientX-r.left-state.tx)/(state.scale*state.W),y=(evt.clientY-r.top-state.ty)/(state.scale*state.H);if(clamp){x=Math.max(0,Math.min(1,x));y=Math.max(0,Math.min(1,y));}return{x,y};}
function inSheet(p){return p.x>=0&&p.x<=1&&p.y>=0&&p.y<=1;}
function svg(tag,attrs){const e=document.createElementNS(NS,tag);for(const [k,v] of Object.entries(attrs))e.setAttribute(k,String(v));return e;}
function renderAnnotations(overlay,W,H,scale,drag=state.drag){
 overlay.replaceChildren();overlay.setAttribute('viewBox',`0 0 ${W} ${H}`);
 const all=[...state.annotations];if(drag?.mode==='draw')all.push({id:'temporary',shape:drag.shape,points:[drag.start,drag.end],status:'open'});
 all.forEach((item,index)=>{
  const g=svg('g',{'class':'annotation'+(item.id===state.selected?' selected':'')+(item.status==='resolved'?' resolved':''),'data-id':item.id});
  const p=item.points.map(p=>({x:p.x*W,y:p.y*H}));const a=p[0],b=p[p.length-1];let shape;
  if(item.shape==='rect')shape=svg('rect',{x:Math.min(a.x,b.x),y:Math.min(a.y,b.y),width:Math.max(Math.abs(b.x-a.x),1),height:Math.max(Math.abs(b.y-a.y),1)});
  else if(item.shape==='point')shape=svg('circle',{cx:a.x,cy:a.y,r:8/scale});
  else shape=svg('line',{x1:a.x,y1:a.y,x2:b.x,y2:b.y});
  shape.setAttribute('class','shape');const hit=shape.cloneNode();hit.setAttribute('class','hit');g.append(hit,shape);
  if(item.shape==='arrow'){
   const angle=Math.atan2(b.y-a.y,b.x-a.x),len=16/scale;
   const pts=[-.48,.48].map(s=>[b.x-len*Math.cos(angle+s),b.y-len*Math.sin(angle+s)]);
   g.append(svg('polyline',{points:`${pts[0].join(',')} ${b.x},${b.y} ${pts[1].join(',')}`,class:'shape'}));
  }
  if(item.id!=='temporary'){
   const r=11/scale,cy=a.y-15/scale;
   g.append(svg('circle',{cx:a.x,cy,r,class:'badge'}));const text=svg('text',{x:a.x,y:cy,'font-size':12/scale,class:'number'});text.textContent=index+1;g.append(text);
  }
  overlay.append(g);
 });
}
function drawOverlay(){renderAnnotations($('overlay'),state.W,state.H,state.scale);if(state.compare)renderAnnotations($('compare-overlay'),state.W,state.H,state.compareDrawing.scale,state.compareDrawing.drag);}
function select(id,focus=false){state.selected=id;renderList();drawOverlay();const item=state.annotations.find(a=>a.id===id);$('editor').hidden=!item;if(!item)return;$('editor-title').textContent=`${state.annotations.indexOf(item)+1}. ${LABELS[item.action]}`;$('comment-text').value=item.text;$('comment-text').placeholder=PLACEHOLDERS[item.action];$('comment-value').value=item.value||'';if(focus)$('comment-text').focus();}
function renderList(){const list=$('comment-list');list.replaceChildren();state.annotations.forEach((item,index)=>{const card=el('div','comment-card'+(item.id===state.selected?' selected':'')+(item.status==='resolved'?' resolved':''));card.tabIndex=0;card.setAttribute('role','button');card.setAttribute('aria-label',`${index+1}. ${LABELS[item.action]}`);card.append(el('div','comment-number',index+1));const main=el('div','comment-main');main.append(el('strong','',LABELS[item.action]),el('p','',item.text||'Комментарий можно добавить'));if(item.value)main.append(el('small','',item.value));card.append(main);const checkbox=document.createElement('input');checkbox.type='checkbox';checkbox.checked=item.status==='resolved';checkbox.setAttribute('aria-label',`Замечание ${index+1} выполнено`);checkbox.addEventListener('click',e=>e.stopPropagation());checkbox.addEventListener('change',()=>{history();item.status=checkbox.checked?'resolved':'open';changed();renderList();drawOverlay();});card.append(checkbox);card.addEventListener('click',()=>select(item.id));card.addEventListener('keydown',e=>{if(e.key==='Enter'&&e.target===card)select(item.id,true);});list.append(card);});updateStatus();}
function addAnnotation(shape,points){history();const item={id:crypto.randomUUID(),action:state.action,shape,points,text:'',value:'',status:'open'};state.annotations.push(item);changed();select(item.id,true);}
function removeSelected(){if(!state.selected)return;history();state.annotations=state.annotations.filter(a=>a.id!==state.selected);state.selected=null;changed();select(null);}
function undo(){const old=state.history.pop();if(!old)return;const v=JSON.parse(old);state.annotations=v.annotations;state.selected=v.selected;changed();select(state.selected);}
function editorChanged(){const item=state.annotations.find(a=>a.id===state.selected);if(!item)return;item.text=$('comment-text').value;item.value=$('comment-value').value;changed();renderList();}
function selectedProject(){return state.projects.find(p=>p.id===$('project').value);}
function selectedVersion(project=selectedProject()){return project?.versions.find(v=>v.id===$('version').value)||project?.versions.at(-1);}
function renderVersions(project,choose){const sel=$('version');sel.replaceChildren();project.versions.slice().reverse().forEach(v=>{const o=document.createElement('option');o.value=v.id;o.textContent=v.id;sel.append(o);});if(!project.versions.length){const o=document.createElement('option');o.value='';o.textContent='Пока нет выпусков';sel.append(o);}else sel.value=project.versions.some(v=>v.id===choose)?choose:project.versions.at(-1).id;}
function renderSources(project){const sel=$('source-file');sel.replaceChildren();project.sources.forEach(s=>{const o=document.createElement('option');o.value=s.name;o.dataset.url=s.url;o.dataset.mime=s.mime;o.textContent=s.folder+' / '+s.name+(s.category?' · '+s.category:'');sel.append(o);});$('show-source').disabled=!project.sources.length;}
function renderFiles(project){const files=$('files');files.replaceChildren();const version=selectedVersion(project);if(!version?.drawings.length){files.append(el('div','file-empty','Чертежей пока нет'));return;}version.drawings.forEach(file=>{const b=el('button','file-button'+(state.meta?.file===file.name&&state.meta?.object===project.id&&state.meta?.version===version.id?' active':''));const copy=el('span','file-copy');copy.append(el('span','file-name',file.name),el('span','file-date',new Date(file.modified*1000).toLocaleDateString('ru-RU')));b.append(el('span','file-icon','▧'),copy);b.addEventListener('click',()=>loadDrawing(project.id,version.id,file.name));files.append(b);});}
async function loadDrawing(object,version,file){
 persist();const id=++state.loadId;state.loading=true;$('loading').hidden=false;$('loading').querySelector('span').textContent='Подготавливаем чертёж…';$('editor').hidden=true;updateStatus();
 try{
  const versioned=version+'/'+file,q=new URLSearchParams({object,file:versioned});const meta=await api('/api/drawing?'+q);if(id!==state.loadId)return;
  const latest=await api('/api/latest?'+q);if(id!==state.loadId)return;
  state.meta=meta;state.W=1600;state.H=1600*meta.viewbox[3]/meta.viewbox[2];
  let local=null;try{local=JSON.parse(localStorage.getItem(draftKey()));}catch{}
  const savedTime=latest.created_at?Date.parse(latest.created_at):0;
  if(local?.annotations&&local.updatedAt>savedTime){state.annotations=local.annotations;state.dirty=Boolean(local.dirty);}else{state.annotations=(latest.annotations||[]).map(a=>({...a,points:a.points.map(p=>p.normalized)}));state.dirty=false;}
  state.selected=null;state.history=[];state.drag=null;state.view='drawing';$('show-source').textContent='Показать исходник';$('drawing-name').textContent=file;$('revision-tag').textContent=version+' · DXF · '+meta.sha256.slice(0,8);$('sheet-info').textContent=meta.units===4?'Модель в миллиметрах':'Единицы DXF: '+meta.units;$('saved-path').hidden=true;
  const img=$('drawing');await new Promise((resolve,reject)=>{img.onload=resolve;img.onerror=()=>reject(new Error('Не удалось загрузить предпросмотр'));img.src=meta.preview_url;});if(id!==state.loadId)return;$('project-empty').hidden=true;$('source-document').hidden=true;$('source-document').removeAttribute('src');$('drawing').style.display='';
  $('compare-drawing').src=meta.preview_url;$('compare-drawing-title').textContent=version+' · '+file;$('compare-sheet-info').textContent=meta.units===4?'Модель в миллиметрах':'Единицы DXF: '+meta.units;const d=state.compareDrawing;d.W=state.W;d.H=state.H;
  state.loading=false;$('loading').hidden=true;renderFiles(state.projects.find(p=>p.id===object));select(null);fit();
  renderFiles(state.projects.find(p=>p.id===object));localStorage.setItem('drawing-review:last',JSON.stringify({object,version,file}));
 }catch(e){if(id!==state.loadId)return;state.loading=false;state.meta=null;$('loading').querySelector('span').textContent=e.message;$('loading').querySelector('.spinner').style.display='none';toast(e.message,true);updateStatus();}
}
function showEmptyProject(project){state.meta=null;state.annotations=[];state.selected=null;state.history=[];state.dirty=false;state.view='drawing';state.compare=false;$('compare-view').hidden=true;$('viewport').hidden=false;$('compare-toggle').setAttribute('aria-pressed','false');$('compare-toggle').classList.remove('active');$('project-empty').hidden=false;$('overlay').style.display='none';$('drawing').removeAttribute('src');$('source-document').hidden=true;$('source-document').removeAttribute('src');$('drawing-name').textContent=project.name;$('revision-tag').textContent=project.has_brief?'БРИФ СОХРАНЁН':'ОБЪЕКТ';$('sheet-info').textContent=`${project.sources.length} исходных файлов · чертежей пока нет`;$('loading').hidden=true;$('show-source').textContent='Показать исходник';$('saved-path').hidden=true;renderFiles(project);renderList();localStorage.setItem('drawing-review:last',JSON.stringify({object:project.id,version:null,file:null}));}
async function loadCatalog(keep=true,preferredId=null){
 try{state.projects=await api('/api/projects');const old=$('project').value;$('project').replaceChildren();state.projects.forEach(p=>{const o=document.createElement('option');o.value=p.id;o.textContent=p.name;$('project').append(o);});
  if(!state.projects.length){$('loading').querySelector('span').textContent='Пока нет объектов. Создайте объект в чате.';$('loading').querySelector('.spinner').style.display='none';return;}
  let last=null;try{last=JSON.parse(localStorage.getItem('drawing-review:last'));}catch{}
  const chosen=state.projects.find(p=>p.id===(preferredId||(keep&&state.meta?state.meta.object:old||last?.object)))||state.projects[0];$('project').value=chosen.id;renderVersions(chosen,keep&&state.meta?state.meta.version:last?.object===chosen.id?last.version:null);renderSources(chosen);renderFiles(chosen);
  const version=selectedVersion(chosen),current=keep&&state.meta?state.meta.file:last?.object===chosen.id?last.file:null;
  const file=version?.drawings.find(d=>d.name===current)||version?.drawings.find(d=>d.name==='plan_and_facade.dxf')||version?.drawings[0];if(file)await loadDrawing(chosen.id,version.id,file.name);else showEmptyProject(chosen);
 }catch(e){toast(e.message,true);$('loading').querySelector('span').textContent=e.message;}
}
async function save(){
 if(!state.meta||!state.annotations.length||state.loading)return;
 const meta=state.meta,annotations=JSON.parse(JSON.stringify(state.annotations)),snapshot=JSON.stringify(annotations);
 for(const id of ['save','save-top'])$(id).disabled=true;
 $('draft-status').textContent='Сохраняем в папку объекта…';
 try{const result=await api('/api/reviews',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({object:meta.object,file:meta.version+'/'+meta.file,sha256:meta.sha256,annotations})});
  if(state.meta===meta){if(snapshot===JSON.stringify(state.annotations)){state.dirty=false;persist();}$('saved-path').hidden=false;$('saved-path').textContent=result.path;updateStatus();$('draft-status').textContent=state.dirty?'Есть изменения после сохранения':'Сохранено · '+new Date().toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'});}
  toast(`Сохранено замечаний: ${result.count}. Можно написать в чате «Исправь замечания».`);
 }catch(e){toast(e.message,true);updateStatus();}
}

document.querySelectorAll('[data-tool]').forEach(b=>b.addEventListener('click',()=>setTool(b.dataset.tool)));
document.querySelectorAll('[data-action]').forEach(b=>b.addEventListener('click',()=>setAction(b.dataset.action)));
$('start-comment').addEventListener('click',()=>{setAction('comment');$('viewport').focus();});
function openSelectedDrawing(){const p=selectedProject(),v=selectedVersion(p),f=v?.drawings.find(d=>d.name==='plan_and_facade.dxf')||v?.drawings[0];if(f)loadDrawing(p.id,v.id,f.name);else showEmptyProject(p);}
$('project').addEventListener('change',()=>{const p=selectedProject();renderVersions(p);renderSources(p);renderFiles(p);openSelectedDrawing();});
$('version').addEventListener('change',()=>{const p=selectedProject();renderFiles(p);openSelectedDrawing();});
$('source-file').addEventListener('change',()=>{if(state.view==='source')showSource();if(state.compare)syncCompareSource();});
$('show-source').addEventListener('click',()=>{if(state.view==='source'){state.view='drawing';$('show-source').textContent='Показать исходник';$('source-document').hidden=true;$('source-document').removeAttribute('src');$('drawing').style.display='';if(state.meta){state.W=1600;state.H=1600*state.meta.viewbox[3]/state.meta.viewbox[2];$('drawing').src=state.meta.preview_url;$('overlay').style.display='';$('drawing-name').textContent=state.meta.file;$('revision-tag').textContent=state.meta.version+' · DXF · '+state.meta.sha256.slice(0,8);$('sheet-info').textContent=state.meta.units===4?'Модель в миллиметрах':'Единицы DXF: '+state.meta.units;}else{$('overlay').style.display='none';$('project-empty').hidden=false;}fit();}else showSource();});
function showSource(){const option=$('source-file').selectedOptions[0];if(!option)return;state.view='source';const url=option.dataset.url,img=$('drawing'),isImage=option.dataset.mime.startsWith('image/');$('project-empty').hidden=true;$('overlay').style.display='none';$('drawing-name').textContent=option.textContent;$('revision-tag').textContent='ИСХОДНИК';$('sheet-info').textContent='Просмотр источника · отметки относятся к DXF';$('show-source').textContent='Вернуться к чертежу';if(isImage){$('source-document').hidden=true;$('source-document').removeAttribute('src');img.style.display='';img.onload=()=>{state.W=1600;state.H=1600*img.naturalHeight/img.naturalWidth;fit();};img.src=url;}else{img.style.display='none';const frame=$('source-document');frame.hidden=false;frame.src=url;state.W=1600;state.H=1000;fit();}}
function syncCompareSource(){const option=$('source-file').selectedOptions[0];if(!option)return;$('source-title').textContent=option.textContent;const img=$('source-image'),frame=$('source-frame');if(option.dataset.mime.startsWith('image/')){frame.hidden=true;frame.removeAttribute('src');img.hidden=false;img.onload=()=>{state.compareSource.W=1600;state.compareSource.H=1600*img.naturalHeight/img.naturalWidth;fitCompare('source');};img.src=option.dataset.url;}else{img.hidden=true;img.removeAttribute('src');frame.hidden=false;frame.src=option.dataset.url;state.compareSource.W=1600;state.compareSource.H=1000;fitCompare('source');}}
$('compare-toggle').addEventListener('click',()=>{state.compare=!state.compare;$('compare-toggle').setAttribute('aria-pressed',String(state.compare));$('compare-toggle').classList.toggle('active',state.compare);$('compare-view').hidden=!state.compare;$('viewport').hidden=state.compare;state.view='drawing';$('overlay').style.display='';$('show-source').textContent='Показать исходник';$('source-document').hidden=true;$('source-document').removeAttribute('src');$('drawing').style.display='';if(state.meta){state.W=1600;state.H=1600*state.meta.viewbox[3]/state.meta.viewbox[2];$('drawing').src=state.meta.preview_url;}if(state.compare){syncCompareSource();$('compare-drawing').src=state.meta?.preview_url||'';requestAnimationFrame(()=>fit());}else fit();});
$('source-fit').addEventListener('click',()=>fitCompare('source'));$('drawing-fit').addEventListener('click',()=>fitCompare('drawing'));
$('source-viewport').addEventListener('wheel',e=>{e.preventDefault();const r=e.currentTarget.getBoundingClientRect();zoomCompare(state.compareSource,'source-viewport','source-stage',Math.exp(-e.deltaY*.0012),e.clientX-r.left,e.clientY-r.top);},{passive:false});
$('compare-drawing-viewport').addEventListener('wheel',e=>{e.preventDefault();const r=e.currentTarget.getBoundingClientRect();zoomCompare(state.compareDrawing,'compare-drawing-viewport','compare-drawing-stage',Math.exp(-e.deltaY*.0012),e.clientX-r.left,e.clientY-r.top);},{passive:false});
function comparePoint(e,d,viewport,clamp=false){const r=$(viewport).getBoundingClientRect();let x=(e.clientX-r.left-d.tx)/(d.scale*d.W),y=(e.clientY-r.top-d.ty)/(d.scale*d.H);if(clamp){x=Math.max(0,Math.min(1,x));y=Math.max(0,Math.min(1,y));}return{x,y};}
for(const [viewportId,d,source] of [['source-viewport',state.compareSource,true],['compare-drawing-viewport',state.compareDrawing,false]]){
 const v=$(viewportId);v.addEventListener('pointerdown',e=>{if(!state.compare||!state.meta||e.button!==0)return;const group=e.target.closest?.('[data-id]');if(!source&&group&&!state.space&&state.tool!=='pan'){select(group.dataset.id);return;}v.setPointerCapture(e.pointerId);const pan=source||state.tool==='pan'||state.space;d.drag=pan?{mode:'pan',x:e.clientX,y:e.clientY,tx:d.tx,ty:d.ty}: {mode:'draw',shape:state.tool,start:comparePoint(e,d,viewportId),end:comparePoint(e,d,viewportId)};if(!pan)drawOverlay();});
 v.addEventListener('pointermove',e=>{if(!state.compare||!d.drag)return;if(d.drag.mode==='pan'){d.tx=d.drag.tx+e.clientX-d.drag.x;d.ty=d.drag.ty+e.clientY-d.drag.y;const stage=$(source?'source-stage':'compare-drawing-stage');stage.style.transform=`translate(${d.tx}px,${d.ty}px) scale(${d.scale})`;return;}d.drag.end=comparePoint(e,d,viewportId,true);drawOverlay();});
 v.addEventListener('pointerup',e=>{const drag=d.drag;d.drag=null;if(v.hasPointerCapture(e.pointerId))v.releasePointerCapture(e.pointerId);if(source||!drag||drag.mode!=='draw')return;const end=comparePoint(e,d,viewportId,true),distance=Math.hypot((end.x-drag.start.x)*d.W,(end.y-drag.start.y)*d.H)*d.scale;if(distance<5)addAnnotation('point',[drag.start]);else addAnnotation(drag.shape,[drag.start,end]);});
 v.addEventListener('pointercancel',()=>{d.drag=null;drawOverlay();});
}
$('refresh').addEventListener('click',()=>loadCatalog());$('fit').addEventListener('click',fit);$('zoom-in').addEventListener('click',()=>zoom(1.25));$('zoom-out').addEventListener('click',()=>zoom(.8));
$('save').addEventListener('click',save);$('save-top').addEventListener('click',save);$('undo').addEventListener('click',undo);$('remove-comment').addEventListener('click',removeSelected);$('close-editor').addEventListener('click',()=>select(null));$('done-comment').addEventListener('click',()=>select(null));
for(const id of ['comment-text','comment-value']){$(id).addEventListener('input',editorChanged);$(id).addEventListener('focus',()=>{if(state.selected)history();});}
const vp=$('viewport');
vp.addEventListener('wheel',e=>{e.preventDefault();const r=vp.getBoundingClientRect();zoom(Math.exp(-e.deltaY*.0012),e.clientX-r.left,e.clientY-r.top);},{passive:false});
vp.addEventListener('pointerdown',e=>{
 if((!state.meta&&state.view!=='source')||state.loading||state.view==='drawing'&&!state.meta)return;
 if(e.button!==0&&e.button!==1)return;
 const group=e.target.closest?.('[data-id]');if(group&&e.button===0&&!state.space&&state.tool!=='pan'){select(group.dataset.id);return;}
 vp.setPointerCapture(e.pointerId);
 if(!state.meta||state.tool==='pan'||state.space||e.button===1){state.drag={mode:'pan',x:e.clientX,y:e.clientY,tx:state.tx,ty:state.ty};vp.classList.add('dragging');return;}
 const p=point(e);if(!inSheet(p))return;
 if(state.tool==='point'){addAnnotation('point',[p]);return;}
 state.drag={mode:'draw',shape:state.tool,start:p,end:p};drawOverlay();
});
vp.addEventListener('pointermove',e=>{
 if((!state.meta&&state.view!=='source')||state.view==='drawing'&&!state.meta)return;
 const p=point(e,true);if(state.meta){const v=state.meta.viewbox,t=state.meta.svg_to_cad,sx=v[0]+p.x*v[2],sy=v[1]+p.y*v[3];$('coordinate').textContent=`X ${Math.round(t[0]*sx+t[2]*sy+t[4])} · Y ${Math.round(t[1]*sx+t[3]*sy+t[5])}${state.meta.units===4?' мм':''}`;}
 if(!state.drag)return;
 if(state.drag.mode==='pan'){state.tx=state.drag.tx+e.clientX-state.drag.x;state.ty=state.drag.ty+e.clientY-state.drag.y;transform();}
 else{state.drag.end=p;drawOverlay();}
});
vp.addEventListener('pointerup',e=>{
 const drag=state.drag;state.drag=null;vp.classList.remove('dragging');if(vp.hasPointerCapture(e.pointerId))vp.releasePointerCapture(e.pointerId);
 if(!drag||drag.mode!=='draw')return;
 const end=point(e,true),distance=Math.hypot((end.x-drag.start.x)*state.W,(end.y-drag.start.y)*state.H)*state.scale;
 if(distance<5)addAnnotation('point',[drag.start]);else addAnnotation(drag.shape,[drag.start,end]);
 drawOverlay();
});
vp.addEventListener('pointercancel',()=>{state.drag=null;vp.classList.remove('dragging');drawOverlay();});
window.addEventListener('keydown',e=>{
 const editing=['INPUT','TEXTAREA','SELECT'].includes(document.activeElement?.tagName);
 if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='s'){e.preventDefault();save();return;}
 if(editing)return;
 if(e.code==='Space'){e.preventDefault();state.space=true;vp.classList.add('pan');}
 if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='z'){e.preventDefault();undo();}
 if(e.key==='Escape'){state.drag=null;select(null);}
 if(e.key==='Delete'||e.key==='Backspace'){if(state.selected){e.preventDefault();removeSelected();}}
});
window.addEventListener('keyup',e=>{if(e.code==='Space'){state.space=false;vp.classList.toggle('pan',state.tool==='pan');}});
window.addEventListener('blur',()=>{state.space=false;state.drag=null;vp.classList.remove('dragging');vp.classList.toggle('pan',state.tool==='pan');});
window.addEventListener('beforeunload',persist);
new ResizeObserver(()=>{if(state.meta)fit();}).observe(vp);
setAction('comment');loadCatalog(false);
