'use strict';
const $ = id => document.getElementById(id);
const NS='http://www.w3.org/2000/svg';
const LABELS={comment:'Замечание',move:'Переместить',delete:'Удалить',add:'Добавить',align:'Выровнять',resize:'Изменить размер',joint:'Исправить стык'};
const DEFAULT_TOOLS={comment:'rect',move:'arrow',delete:'rect',add:'point',align:'line',resize:'line',joint:'rect'};
const ELEMENTS={other:'Элемент',wall:'Стена',window:'Окно',balcony:'Балкон / лоджия',stairs:'Лестница',door:'Дверь',roof:'Крыша'};
const RESULT_LABELS={resolved:'Выполнено',needs_clarification:'Нужно уточнение',not_done:'Не выполнено'};
const HINTS={pan:'Перетащите лист',rect:'Обведите место ошибки',arrow:'Протяните стрелку: откуда → куда',point:'Нажмите в нужном месте',line:'Укажите линию между двумя точками'};
const PLACEHOLDERS={comment:'Что здесь нужно исправить?',move:'Например: перенести окно к концу стрелки',delete:'Например: убрать это окно',add:'Например: добавить дверь в отмеченном месте',align:'Например: выровнять эти стены по одной линии',resize:'Например: ширина проёма должна быть 1200 мм',joint:'Например: соединить стены без выступов и щелей'};
const state={projects:[],meta:null,annotations:[],selected:null,action:'comment',tool:'rect',scale:1,tx:0,ty:0,W:1600,H:1000,drag:null,space:false,history:[],dirty:false,loading:false,loadId:0,view:'drawing',compare:false,savedRevision:null,reports:[],compareRequest:0,compareSource:{W:1600,H:1000,scale:1,tx:0,ty:0,drag:null},compareDrawing:{W:1600,H:1000,scale:1,tx:0,ty:0,drag:null}};
let toastTimer,storageWarning=false;
const deleteSelection=new Set();
function toast(message,error=false){$('toast').textContent=message;$('toast').className='show'+(error?' error':'');clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').className='',5000);}
async function api(url,options){const r=await fetch(url,options);const data=await r.json();if(!r.ok)throw new Error(data.error||'Ошибка запроса');return data;}
function el(tag,cls,text){const e=document.createElement(tag);if(cls)e.className=cls;if(text!==undefined)e.textContent=text;return e;}
function draftKey(){return state.meta?'drawing-review:'+state.meta.object+':'+state.meta.version+':'+state.meta.file+':'+state.meta.sha256:null;}
function persist(){const key=draftKey();if(!key)return;try{localStorage.setItem(key,JSON.stringify({annotations:state.annotations,dirty:state.dirty,updatedAt:Date.now()}));}catch{if(!storageWarning){toast('Браузер не сохранил черновик. Сохраните замечания кнопкой.',true);storageWarning=true;}}}
function history(){state.history.push(JSON.stringify({annotations:state.annotations,selected:state.selected}));if(state.history.length>50)state.history.shift();}
function changed(){state.dirty=true;persist();updateStatus();renderResults();}
function updateStatus(){
 const count=state.annotations.length,saved=state.savedRevision&&!state.dirty,canClear=count===0&&state.dirty&&state.savedRevision;
 $('count').textContent=count;$('empty-comments').hidden=count>0;
 $('draft-status').textContent=state.dirty?'Черновик · не сохранён в папку':saved?'Сохранено · '+state.savedRevision:'Нет несохранённых изменений';
 $('undo').disabled=!state.history.length;
 $('delete-all').disabled=count===0||state.loading;$('delete-selected').disabled=deleteSelection.size===0||state.loading;
 $('delete-selected').textContent=deleteSelection.size?`Удалить выбранные (${deleteSelection.size})`:'Удалить выбранные';
 for(const id of ['save','save-top'])$(id).disabled=!state.meta||(!count&&!canClear)||state.loading;
 for(const b of document.querySelectorAll('[data-tool]'))b.disabled=!state.meta;
 $('compare-toggle').disabled=!state.meta;$('copy-request').disabled=!saved||!state.meta||count===0;
 $('save-hint').textContent=state.dirty&&count===0&&state.savedRevision?'Сохраните, чтобы очистить замечания этой версии.':saved&&count===0?'В этой версии нет замечаний.':saved?`Замечания сохранены для ${state.meta.version} · ${state.meta.file} · ${state.meta.sha256.slice(0,8)}`:'Сначала сохраните замечания для выбранной версии.';
}

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
function resultFor(item){if(state.dirty)return null;for(const report of state.reports){if(report.source_revision===state.savedRevision&&report.source_drawing===state.meta?.version+'/'+state.meta?.file){const result=report.results.find(r=>r.annotation_id===item.id);if(result)return result;}}return null;}
function select(id,focus=false){state.selected=id;renderList();drawOverlay();const item=state.annotations.find(a=>a.id===id);$('editor').hidden=!item;if(!item){$('action-popover').hidden=true;return;}$('editor-title').textContent=`${state.annotations.indexOf(item)+1}. ${ELEMENTS[item.element_type||'other']} · ${LABELS[item.action]}`;$('comment-element').value=item.element_type||'other';$('comment-action').value=item.action;$('comment-text').value=item.text||'';$('comment-text').placeholder=PLACEHOLDERS[item.action];$('comment-value').value=item.value||'';if(focus)$('comment-text').focus();}
function zoomToItem(item){if(!item||!state.meta||state.view==='source')return;const xs=item.points.map(p=>p.x),ys=item.points.map(p=>p.y),x=(Math.min(...xs)+Math.max(...xs))/2,y=(Math.min(...ys)+Math.max(...ys))/2;const compare=state.compare,v=$(compare?'compare-drawing-viewport':'viewport'),d=compare?state.compareDrawing:state;const span=Math.max((Math.max(...xs)-Math.min(...xs))*state.W,(Math.max(...ys)-Math.min(...ys))*state.H,180);d.scale=Math.min(6,Math.max(.03,Math.min(v.clientWidth,v.clientHeight)*.55/span));d.tx=v.clientWidth/2-x*state.W*d.scale;d.ty=v.clientHeight/2-y*state.H*d.scale;transform();}
function renderList(){
 const list=$('comment-list');list.replaceChildren();
 state.annotations.forEach((item,index)=>{
  const card=el('div','comment-card'+(item.id===state.selected?' selected':'')+(item.status==='resolved'?' resolved':''));
  card.tabIndex=0;card.setAttribute('role','button');card.setAttribute('aria-label',`${index+1}. ${ELEMENTS[item.element_type||'other']}: ${LABELS[item.action]}`);
  const selected=document.createElement('input');selected.type='checkbox';selected.checked=deleteSelection.has(item.id);selected.title='Выбрать для удаления';selected.setAttribute('aria-label',`Выбрать для удаления замечание ${index+1}`);
  selected.addEventListener('click',e=>e.stopPropagation());selected.addEventListener('change',()=>{if(selected.checked)deleteSelection.add(item.id);else deleteSelection.delete(item.id);updateStatus();});
  card.append(selected,el('div','comment-number',index+1));const main=el('div','comment-main');
  main.append(el('strong','',`${ELEMENTS[item.element_type||'other']} · ${LABELS[item.action]}`),el('p','',item.text||'Комментарий можно добавить'));
  if(item.value)main.append(el('small','',item.value));const result=resultFor(item);if(result)main.append(el('span','comment-result',`${RESULT_LABELS[result.status]}${result.description?' · '+result.description:''}`));card.append(main);
  const remove=el('button','comment-delete','×');remove.type='button';remove.title='Удалить замечание';remove.setAttribute('aria-label',`Удалить замечание ${index+1}`);remove.addEventListener('click',e=>{e.stopPropagation();deleteAnnotations([item.id]);});card.append(remove);
  card.addEventListener('click',()=>{select(item.id);zoomToItem(item);});card.addEventListener('keydown',e=>{if(e.key==='Enter'&&e.target===card){select(item.id,true);zoomToItem(item);}});list.append(card);
 });updateStatus();
}

function openPopover(item,x,y){const pop=$('action-popover');$('popover-title').textContent=`Замечание ${state.annotations.indexOf(item)+1}`;$('popover-text').value=item.text||'';pop.hidden=false;pop.style.left=Math.max(8,Math.min(innerWidth-285,x+12))+'px';pop.style.top=Math.max(8,Math.min(innerHeight-pop.offsetHeight-8,y+12))+'px';document.querySelectorAll('[data-pop-action]').forEach(b=>{const active=b.dataset.popAction===item.action;b.classList.toggle('active',active);b.setAttribute('aria-pressed',String(active));});document.querySelectorAll('[data-pop-element]').forEach(b=>{const active=b.dataset.popElement===(item.element_type||'other');b.classList.toggle('active',active);b.setAttribute('aria-pressed',String(active));});}
function addAnnotation(shape,points,x,y){history();const item={id:crypto.randomUUID(),element_type:'other',action:'comment',shape,points,text:'',value:'',status:'open'};state.annotations.push(item);changed();select(item.id);openPopover(item,x,y);}

let pendingDeletion=null;
function deleteAnnotations(ids,all=false){
 const requested=new Set(ids),items=state.annotations.filter(a=>requested.has(a.id));
 if(!items.length||$('delete-dialog').open)return;
 pendingDeletion={ids:items.map(a=>a.id),meta:state.meta};
 const question=all?`Удалить все замечания (${items.length})?`:items.length===1?`Удалить замечание № ${state.annotations.indexOf(items[0])+1}?`:`Удалить выбранные замечания (${items.length})?`;
 $('delete-dialog-message').textContent=question;$('delete-dialog').returnValue='';$('delete-dialog').showModal();
}
function applyPendingDeletion(){
 const pending=pendingDeletion;pendingDeletion=null;
 if(!pending||state.meta!==pending.meta)return;
 const targets=new Set(pending.ids);if(!state.annotations.some(a=>targets.has(a.id)))return;
 history();state.annotations=state.annotations.filter(a=>!targets.has(a.id));for(const id of targets)deleteSelection.delete(id);if(targets.has(state.selected))state.selected=null;changed();select(state.selected);
}
function removeSelected(){if(state.selected)deleteAnnotations([state.selected]);}
function undo(){const old=state.history.pop();if(!old)return;const v=JSON.parse(old);state.annotations=v.annotations;state.selected=v.selected;deleteSelection.clear();changed();select(state.selected);}

function editorChanged(){const item=state.annotations.find(a=>a.id===state.selected);if(!item)return;item.text=$('comment-text').value;item.value=$('comment-value').value;$('popover-text').value=item.text;changed();renderList();}
function selectedProject(){return state.projects.find(p=>p.id===$('project').value);}
function selectedVersion(project=selectedProject()){return project?.versions.find(v=>v.id===$('version').value)||project?.versions.at(-1);}
function renderVersions(project,choose){const sel=$('version');sel.replaceChildren();project.versions.slice().reverse().forEach(v=>{const o=document.createElement('option');o.value=v.id;o.textContent=v.id;sel.append(o);});if(!project.versions.length){const o=document.createElement('option');o.value='';o.textContent='Пока нет выпусков';sel.append(o);}else sel.value=project.versions.some(v=>v.id===choose)?choose:project.versions.at(-1).id;}
function renderSources(project){const sel=$('source-file'),compare=$('compare-source-file');sel.replaceChildren();compare.replaceChildren();project.sources.forEach(s=>{const o=document.createElement('option');o.value=s.name;o.dataset.url=s.url;o.dataset.mime=s.mime;o.textContent=s.folder+' / '+s.name+(s.category?' · '+s.category:'');sel.append(o);compare.append(o.cloneNode(true));});$('show-source').disabled=!project.sources.length;}

function renderFiles(project){const files=$('files');files.replaceChildren();const version=selectedVersion(project);if(!version?.drawings.length){files.append(el('div','file-empty','Чертежей пока нет'));return;}version.drawings.forEach(file=>{const b=el('button','file-button'+(state.meta?.file===file.name&&state.meta?.object===project.id&&state.meta?.version===version.id?' active':''));const copy=el('span','file-copy');copy.append(el('span','file-name',file.name),el('span','file-date',new Date(file.modified*1000).toLocaleDateString('ru-RU')));b.append(el('span','file-icon','▧'),copy);b.addEventListener('click',()=>loadDrawing(project.id,version.id,file.name));files.append(b);});}
async function loadDrawing(object,version,file){
 persist();const id=++state.loadId;state.loading=true;$('loading').hidden=false;$('loading').querySelector('span').textContent='Подготавливаем чертёж…';$('editor').hidden=true;updateStatus();
 try{
  const versioned=version+'/'+file,q=new URLSearchParams({object,file:versioned});const meta=await api('/api/drawing?'+q);if(id!==state.loadId)return;
  const latest=await api('/api/latest?'+q);const reports=await api('/api/results?'+q);if(id!==state.loadId)return;state.savedRevision=latest.revision||null;state.reports=reports;
  state.meta=meta;state.W=1600;state.H=1600*meta.viewbox[3]/meta.viewbox[2];
  let local=null;try{local=JSON.parse(localStorage.getItem(draftKey()));}catch{}
  const savedTime=latest.created_at?Date.parse(latest.created_at):0;
  if(local?.annotations&&local.updatedAt>savedTime){state.annotations=local.annotations;state.dirty=Boolean(local.dirty);}else{state.annotations=(latest.annotations||[]).map(a=>({...a,points:a.points.map(p=>p.normalized)}));state.dirty=false;}
  state.selected=null;state.history=[];deleteSelection.clear();state.drag=null;state.view='drawing';$('show-source').textContent='Показать исходник';$('drawing-name').textContent=file;$('revision-tag').textContent=version+' · DXF · '+meta.sha256.slice(0,8);$('sheet-info').textContent=meta.units===4?'Модель в миллиметрах':'Единицы DXF: '+meta.units;$('saved-path').hidden=true;
  const img=$('drawing');await new Promise((resolve,reject)=>{img.onload=resolve;img.onerror=()=>reject(new Error('Не удалось загрузить предпросмотр'));img.src=meta.preview_url;});if(id!==state.loadId)return;$('project-empty').hidden=true;$('source-document').hidden=true;$('source-document').removeAttribute('src');$('drawing').style.display='';
  $('compare-drawing').src=meta.preview_url;$('compare-drawing-title').textContent=version+' · '+file;$('compare-sheet-info').textContent=meta.units===4?'Модель в миллиметрах':'Единицы DXF: '+meta.units;const d=state.compareDrawing;d.W=state.W;d.H=state.H;
  state.loading=false;$('loading').hidden=true;renderFiles(state.projects.find(p=>p.id===object));renderCompareVersions();renderResults();select(null);fit();if(state.compare)syncCompareSource();
  renderFiles(state.projects.find(p=>p.id===object));localStorage.setItem('drawing-review:last',JSON.stringify({object,version,file}));
 }catch(e){if(id!==state.loadId)return;state.loading=false;state.meta=null;$('loading').querySelector('span').textContent=e.message;$('loading').querySelector('.spinner').style.display='none';toast(e.message,true);updateStatus();}
}
function showEmptyProject(project){deleteSelection.clear();state.savedRevision=null;state.reports=[];$('results-panel').hidden=true;state.meta=null;state.annotations=[];state.selected=null;state.history=[];state.dirty=false;state.view='drawing';state.compare=false;$('compare-view').hidden=true;$('viewport').hidden=false;$('compare-toggle').setAttribute('aria-pressed','false');$('compare-toggle').classList.remove('active');$('project-empty').hidden=false;$('overlay').style.display='none';$('drawing').removeAttribute('src');$('source-document').hidden=true;$('source-document').removeAttribute('src');$('drawing-name').textContent=project.name;$('revision-tag').textContent=project.has_brief?'БРИФ СОХРАНЁН':'ОБЪЕКТ';$('sheet-info').textContent=`${project.sources.length} исходных файлов · чертежей пока нет`;$('loading').hidden=true;$('show-source').textContent='Показать исходник';$('saved-path').hidden=true;renderFiles(project);renderList();localStorage.setItem('drawing-review:last',JSON.stringify({object:project.id,version:null,file:null}));}
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
 if(!state.meta||state.loading||(!state.annotations.length&&!(state.dirty&&state.savedRevision)))return;
 const meta=state.meta,annotations=JSON.parse(JSON.stringify(state.annotations)),snapshot=JSON.stringify(annotations);
 for(const id of ['save','save-top'])$(id).disabled=true;
 $('draft-status').textContent='Сохраняем в папку объекта…';
 try{const result=await api('/api/reviews',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({object:meta.object,file:meta.version+'/'+meta.file,sha256:meta.sha256,annotations,clear_all:annotations.length===0})});
  if(state.meta===meta){state.savedRevision=result.revision;renderResults();if(snapshot===JSON.stringify(state.annotations)){state.dirty=false;persist();}$('saved-path').hidden=false;$('saved-path').textContent=result.path;updateStatus();$('draft-status').textContent=state.dirty?'Есть изменения после сохранения':'Сохранено · '+new Date().toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'});}
  toast(result.count?`Сохранено замечаний: ${result.count}. Можно написать в чате «Исправь замечания».`:'Список замечаний этой версии очищен.');
 }catch(e){toast(e.message,true);updateStatus();}
}

document.querySelectorAll('[data-tool]').forEach(b=>b.addEventListener('click',()=>setTool(b.dataset.tool)));
$('start-comment').addEventListener('click',()=>{setAction('comment');$('viewport').focus();});
function openSelectedDrawing(){const p=selectedProject(),v=selectedVersion(p),f=v?.drawings.find(d=>d.name==='plan_and_facade.dxf')||v?.drawings[0];if(f)loadDrawing(p.id,v.id,f.name);else showEmptyProject(p);}
$('project').addEventListener('change',()=>{const p=selectedProject();renderVersions(p);renderSources(p);renderFiles(p);openSelectedDrawing();});
$('version').addEventListener('change',()=>{const p=selectedProject();renderFiles(p);openSelectedDrawing();});
$('source-file').addEventListener('change',()=>{$('compare-source-file').value=$('source-file').value;if(state.view==='source')showSource();if(state.compare)syncCompareSource();});$('compare-source-file').addEventListener('change',()=>{$('source-file').value=$('compare-source-file').value;syncCompareSource();});
$('show-source').addEventListener('click',()=>{if(state.view==='source'){state.view='drawing';$('show-source').textContent='Показать исходник';$('source-document').hidden=true;$('source-document').removeAttribute('src');$('drawing').style.display='';if(state.meta){state.W=1600;state.H=1600*state.meta.viewbox[3]/state.meta.viewbox[2];$('drawing').src=state.meta.preview_url;$('overlay').style.display='';$('drawing-name').textContent=state.meta.file;$('revision-tag').textContent=state.meta.version+' · DXF · '+state.meta.sha256.slice(0,8);$('sheet-info').textContent=state.meta.units===4?'Модель в миллиметрах':'Единицы DXF: '+state.meta.units;}else{$('overlay').style.display='none';$('project-empty').hidden=false;}fit();}else showSource();});
function showSource(){const option=$('source-file').selectedOptions[0];if(!option)return;state.view='source';const url=option.dataset.url,img=$('drawing'),isImage=option.dataset.mime.startsWith('image/');$('project-empty').hidden=true;$('overlay').style.display='none';$('drawing-name').textContent=option.textContent;$('revision-tag').textContent='ИСХОДНИК';$('sheet-info').textContent='Просмотр источника · отметки относятся к DXF';$('show-source').textContent='Вернуться к чертежу';if(isImage){$('source-document').hidden=true;$('source-document').removeAttribute('src');img.style.display='';img.onload=()=>{state.W=1600;state.H=1600*img.naturalHeight/img.naturalWidth;fit();};img.src=url;}else{img.style.display='none';const frame=$('source-document');frame.hidden=false;frame.src=url;state.W=1600;state.H=1000;fit();}}
function renderCompareVersions(){const project=selectedProject(),versionSelect=$('compare-version'),fileSelect=$('compare-file');if(!project)return;const oldVersion=versionSelect.value,oldFile=fileSelect.value;versionSelect.replaceChildren();project.versions.slice().reverse().forEach(v=>{const o=document.createElement('option');o.value=v.id;o.textContent=v.id;versionSelect.append(o);});versionSelect.value=project.versions.some(v=>v.id===oldVersion)?oldVersion:(project.versions.find(v=>v.id!==state.meta?.version)?.id||project.versions.at(-1)?.id||'');renderCompareFiles(oldFile||state.meta?.file);}
function renderCompareFiles(preferred){const project=selectedProject(),version=project?.versions.find(v=>v.id===$('compare-version').value),sel=$('compare-file');sel.replaceChildren();for(const file of version?.drawings||[]){const o=document.createElement('option');o.value=file.name;o.textContent=file.name;sel.append(o);}if(version?.drawings.some(f=>f.name===preferred))sel.value=preferred;}
async function syncCompareSource(){const seq=++state.compareRequest,img=$('source-image'),frame=$('source-frame'),isVersion=$('compare-kind').value==='version';$('compare-version').hidden=!isVersion;$('compare-file').hidden=!isVersion;$('compare-source-file').hidden=isVersion;let url='',mime='';if(isVersion){if(!$('compare-version').value||!$('compare-file').value){$('source-title').textContent='Нет чертежа для сравнения';img.hidden=true;frame.hidden=true;return;}try{const q=new URLSearchParams({object:state.meta.object,file:$('compare-version').value+'/'+$('compare-file').value});const meta=await api('/api/drawing?'+q);if(seq!==state.compareRequest)return;url=meta.preview_url;mime='image/svg+xml';$('source-title').textContent=$('compare-version').value+' · '+$('compare-file').value;}catch(e){toast(e.message,true);return;}}else{const option=$('source-file').selectedOptions[0];if(!option){$('source-title').textContent='Нет исходных материалов';img.hidden=true;frame.hidden=true;return;}url=option.dataset.url;mime=option.dataset.mime;$('source-title').textContent=option.textContent;}
 if(mime.startsWith('image/')){frame.hidden=true;frame.removeAttribute('src');img.hidden=false;img.onload=()=>{if(seq!==state.compareRequest)return;state.compareSource.W=1600;state.compareSource.H=1600*img.naturalHeight/img.naturalWidth;fitCompare('source');};img.src=url;}else{img.hidden=true;img.removeAttribute('src');frame.hidden=false;frame.src=url;state.compareSource.W=1600;state.compareSource.H=1000;fitCompare('source');}}
function renderResults(){const panel=$('results-panel'),list=$('results-list');list.replaceChildren();if(!state.meta){panel.hidden=true;return;}const current=state.meta.version+'/'+state.meta.file;let count=0;for(const report of state.reports){if(report.target_drawing!==current&&!(report.source_drawing===current&&report.source_revision===state.savedRevision&&!state.dirty))continue;const head=el('div','result-row',`${report.source_drawing} → ${report.target_drawing} · ${report.source_revision}`);list.append(head);for(const item of report.results){const row=el('div','result-row');row.append(el('strong','',`№ ${item.number||'?'} · ${RESULT_LABELS[item.status]}`));if(item.description)row.append(el('div','',item.description));list.append(row);count++;}}panel.hidden=!count;}
$('compare-toggle').addEventListener('click',()=>{$('action-popover').hidden=true;state.compare=!state.compare;$('compare-toggle').setAttribute('aria-pressed',String(state.compare));$('compare-toggle').classList.toggle('active',state.compare);$('compare-view').hidden=!state.compare;$('viewport').hidden=state.compare;state.view='drawing';$('overlay').style.display='';$('show-source').textContent='Показать исходник';$('source-document').hidden=true;$('source-document').removeAttribute('src');$('drawing').style.display='';if(state.meta){state.W=1600;state.H=1600*state.meta.viewbox[3]/state.meta.viewbox[2];$('drawing').src=state.meta.preview_url;}if(state.compare){syncCompareSource();$('compare-drawing').src=state.meta?.preview_url||'';requestAnimationFrame(()=>fit());}else fit();});
$('source-fit').addEventListener('click',()=>fitCompare('source'));$('drawing-fit').addEventListener('click',()=>fitCompare('drawing'));
$('compare-kind').addEventListener('change',syncCompareSource);$('compare-version').addEventListener('change',()=>{renderCompareFiles(state.meta?.file);syncCompareSource();});$('compare-file').addEventListener('change',syncCompareSource);
for(const [id,which,factor] of [['source-zoom-in','source',1.25],['source-zoom-out','source',.8],['drawing-zoom-in','drawing',1.25],['drawing-zoom-out','drawing',.8]])$(id).addEventListener('click',()=>zoomCompare(which==='source'?state.compareSource:state.compareDrawing,which==='source'?'source-viewport':'compare-drawing-viewport',which==='source'?'source-stage':'compare-drawing-stage',factor));
let split=50;function setSplit(value){split=Math.max(15,Math.min(85,value));$('compare-view').style.gridTemplateRows=`minmax(90px, ${split}fr) 8px minmax(90px, ${100-split}fr)`;$('compare-divider').setAttribute('aria-valuenow',String(Math.round(split)));}const divider=$('compare-divider');divider.addEventListener('pointerdown',e=>{divider.setPointerCapture(e.pointerId);e.preventDefault();});divider.addEventListener('pointermove',e=>{if(!divider.hasPointerCapture(e.pointerId))return;const r=$('compare-view').getBoundingClientRect();setSplit((e.clientY-r.top)/r.height*100);});divider.addEventListener('pointerup',e=>{if(divider.hasPointerCapture(e.pointerId))divider.releasePointerCapture(e.pointerId);});divider.addEventListener('keydown',e=>{if(e.key==='ArrowUp'||e.key==='ArrowDown'){e.preventDefault();setSplit(split+(e.key==='ArrowUp'?-5:5));}});

$('source-viewport').addEventListener('dblclick',e=>{const r=e.currentTarget.getBoundingClientRect();zoomCompare(state.compareSource,'source-viewport','source-stage',1.8,e.clientX-r.left,e.clientY-r.top);});
$('source-viewport').addEventListener('wheel',e=>{e.preventDefault();const r=e.currentTarget.getBoundingClientRect();zoomCompare(state.compareSource,'source-viewport','source-stage',Math.exp(-e.deltaY*.0012),e.clientX-r.left,e.clientY-r.top);},{passive:false});
$('compare-drawing-viewport').addEventListener('wheel',e=>{e.preventDefault();const r=e.currentTarget.getBoundingClientRect();zoomCompare(state.compareDrawing,'compare-drawing-viewport','compare-drawing-stage',Math.exp(-e.deltaY*.0012),e.clientX-r.left,e.clientY-r.top);},{passive:false});
function comparePoint(e,d,viewport,clamp=false){const r=$(viewport).getBoundingClientRect();let x=(e.clientX-r.left-d.tx)/(d.scale*d.W),y=(e.clientY-r.top-d.ty)/(d.scale*d.H);if(clamp){x=Math.max(0,Math.min(1,x));y=Math.max(0,Math.min(1,y));}return{x,y};}
for(const [viewportId,d,source] of [['source-viewport',state.compareSource,true],['compare-drawing-viewport',state.compareDrawing,false]]){
 const v=$(viewportId);v.addEventListener('pointerdown',e=>{if(!state.compare||!state.meta||e.button!==0)return;$('action-popover').hidden=true;const group=e.target.closest?.('[data-id]');if(!source&&group&&!state.space&&state.tool!=='pan'){select(group.dataset.id);const item=state.annotations.find(a=>a.id===state.selected);if(item)openPopover(item,e.clientX,e.clientY);return;}v.setPointerCapture(e.pointerId);const pan=source||state.tool==='pan'||state.space;d.drag=pan?{mode:'pan',x:e.clientX,y:e.clientY,tx:d.tx,ty:d.ty}: {mode:'draw',shape:state.tool,start:comparePoint(e,d,viewportId),end:comparePoint(e,d,viewportId)};if(!pan)drawOverlay();});
 v.addEventListener('pointermove',e=>{if(!state.compare||!d.drag)return;if(d.drag.mode==='pan'){d.tx=d.drag.tx+e.clientX-d.drag.x;d.ty=d.drag.ty+e.clientY-d.drag.y;const stage=$(source?'source-stage':'compare-drawing-stage');stage.style.transform=`translate(${d.tx}px,${d.ty}px) scale(${d.scale})`;return;}d.drag.end=comparePoint(e,d,viewportId,true);drawOverlay();});
 v.addEventListener('pointerup',e=>{const drag=d.drag;d.drag=null;if(v.hasPointerCapture(e.pointerId))v.releasePointerCapture(e.pointerId);if(source||!drag||drag.mode!=='draw')return;const end=comparePoint(e,d,viewportId,true),distance=Math.hypot((end.x-drag.start.x)*d.W,(end.y-drag.start.y)*d.H)*d.scale;if(distance<5)addAnnotation('point',[drag.start],e.clientX,e.clientY);else addAnnotation(drag.shape,[drag.start,end],e.clientX,e.clientY);});
 v.addEventListener('pointercancel',()=>{d.drag=null;drawOverlay();});
}
for(const [button,cls] of [['toggle-library','library-hidden'],['toggle-comments','comments-hidden']])$(button).addEventListener('click',()=>{const workspace=document.querySelector('.workspace');const hidden=workspace.classList.toggle(cls);$(button).setAttribute('aria-pressed',String(hidden));requestAnimationFrame(()=>{if(state.meta)fit();});});
$('zoom-selected').addEventListener('click',()=>zoomToItem(state.annotations.find(a=>a.id===state.selected)));
for(const [id,property] of [['comment-element','element_type'],['comment-action','action']])$(id).addEventListener('change',()=>{const item=state.annotations.find(a=>a.id===state.selected);if(!item)return;history();item[property]=$(id).value;changed();select(item.id);if(!$('action-popover').hidden)openPopover(item,parseFloat($('action-popover').style.left)-12,parseFloat($('action-popover').style.top)-12);});
$('copy-request').addEventListener('click',async()=>{if(!state.meta||!state.savedRevision||state.dirty)return;const project=selectedProject();const message=`Исправь замечания по объекту «${project?.name||state.meta.object}», версия ${state.meta.version}, чертёж ${state.meta.file}. Ревизия ${state.savedRevision}.`;try{await navigator.clipboard.writeText(message);toast('Запрос скопирован. Вставьте его в чат.');}catch{toast('Не удалось скопировать автоматически: '+message,true);}});
for(const [selector,property,key] of [['[data-pop-element]','element_type','popElement'],['[data-pop-action]','action','popAction']])document.querySelectorAll(selector).forEach(b=>b.addEventListener('click',()=>{const item=state.annotations.find(a=>a.id===state.selected);if(!item)return;history();item[property]=b.dataset[key];changed();select(item.id);openPopover(item,parseFloat($('action-popover').style.left)-12,parseFloat($('action-popover').style.top)-12);}));
$('popover-text').addEventListener('focus',()=>{if(state.selected)history();});$('popover-text').addEventListener('input',()=>{const item=state.annotations.find(a=>a.id===state.selected);if(!item)return;item.text=$('popover-text').value;$('comment-text').value=item.text;changed();renderList();});$('popover-close').addEventListener('click',()=>$('action-popover').hidden=true);$('popover-done').addEventListener('click',()=>$('action-popover').hidden=true);
$('refresh').addEventListener('click',()=>loadCatalog());$('fit').addEventListener('click',fit);$('zoom-in').addEventListener('click',()=>zoom(1.25));$('zoom-out').addEventListener('click',()=>zoom(.8));
$('delete-selected').addEventListener('click',()=>deleteAnnotations([...deleteSelection]));$('delete-all').addEventListener('click',()=>deleteAnnotations(state.annotations.map(a=>a.id),true));
$('delete-cancel').addEventListener('click',()=>$('delete-dialog').close('cancel'));$('delete-confirm').addEventListener('click',()=>$('delete-dialog').close('confirm'));$('delete-dialog').addEventListener('close',()=>{if($('delete-dialog').returnValue==='confirm')applyPendingDeletion();else pendingDeletion=null;});
$('save').addEventListener('click',save);$('save-top').addEventListener('click',save);$('undo').addEventListener('click',undo);$('remove-comment').addEventListener('click',removeSelected);$('close-editor').addEventListener('click',()=>select(null));$('done-comment').addEventListener('click',()=>select(null));
for(const id of ['comment-text','comment-value']){$(id).addEventListener('input',editorChanged);$(id).addEventListener('focus',()=>{if(state.selected)history();});}
const vp=$('viewport');
vp.addEventListener('wheel',e=>{e.preventDefault();const r=vp.getBoundingClientRect();zoom(Math.exp(-e.deltaY*.0012),e.clientX-r.left,e.clientY-r.top);},{passive:false});
vp.addEventListener('pointerdown',e=>{
 if((!state.meta&&state.view!=='source')||state.loading||state.view==='drawing'&&!state.meta)return;
 if(e.button!==0&&e.button!==1)return;
 $('action-popover').hidden=true;const group=e.target.closest?.('[data-id]');if(group&&e.button===0&&!state.space&&state.tool!=='pan'){select(group.dataset.id);const item=state.annotations.find(a=>a.id===state.selected);if(item)openPopover(item,e.clientX,e.clientY);return;}
 vp.setPointerCapture(e.pointerId);
 if(!state.meta||state.tool==='pan'||state.space||e.button===1){state.drag={mode:'pan',x:e.clientX,y:e.clientY,tx:state.tx,ty:state.ty};vp.classList.add('dragging');return;}
 const p=point(e);if(!inSheet(p))return;
 if(state.tool==='point'){addAnnotation('point',[p],e.clientX,e.clientY);return;}
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
 if(distance<5)addAnnotation('point',[drag.start],e.clientX,e.clientY);else addAnnotation(drag.shape,[drag.start,end],e.clientX,e.clientY);
 drawOverlay();
});
vp.addEventListener('pointercancel',()=>{state.drag=null;vp.classList.remove('dragging');drawOverlay();});
window.addEventListener('keydown',e=>{
 if($('delete-dialog').open)return;
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
setTool('rect');loadCatalog(false);
