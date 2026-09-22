(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const uid = () => crypto.randomUUID();
  const clone = value => JSON.parse(JSON.stringify(value));
  const bound = (x,a,b) => Math.max(a,Math.min(b,x));
  const finite = (x,fallback=0) => Number.isFinite(+x) ? +x : fallback;
  const EN = {
    title:'Editing studio',intro:'Precise editing, transitions and replacement clips. Your sources stay intact.',
    load:'Import audio',new:'New project',save:'Save project file',open:'Open project',restore:'Restore local save',
    empty:'Import a song, recording or vocal stem to begin',emptyHelp:'Add clips, select any clip to edit, and save a project containing all its audio.',
    projectName:'Project name',undo:'Undo',redo:'Redo',sourceSafe:'Source preserved',zoomIn:'Zoom in',zoomOut:'Zoom out',zoomSelection:'Zoom to selection',zoomAll:'Entire clip',scroll:'Scroll',
    selectionStart:'Start · seconds',selectionEnd:'End · seconds',nudgeStep:'Nudge step',startMinus:'Start −',startPlus:'Start +',endMinus:'End −',endPlus:'End +',zero:'Find quiet edit points',
    playSelection:'Play selection',loop:'Loop',playAll:'Play result',stop:'Stop',trim:'Keep selection',deleteSelection:'Delete selection',split:'Split at selection end',copy:'Use as replacement clip',
    gain:'Clip gain · dB',fadeIn:'Fade in · ms',fadeOut:'Fade out · ms',match:'Match levels to selected clip',trimSilence:'Trim edge silence',
    replacement:'Replace a word or phrase',replacementHelp:'Select a source region and keep it as a replacement, or import an alternate file. Select the target word, audition both recordings, then replace.',
    donorLoad:'Import replacement source',donorStart:'Replacement source start · seconds',donorEnd:'Replacement source end · seconds',fitDonor:'Set source selection length to target length',playDonor:'Play replacement source',
    fitHelp:'Matching selection length moves the end boundary only. It does not stretch time or change the singer’s voice.',replacementMode:'Result timing',preserve:'Preserve timing — equal duration required',ripple:'Use source duration and shift subsequent audio',seamMs:'Boundary crossfade · ms',replace:'Replace selection',
    replacementNote:'A separate vocal stem gives better control. Every replacement can be undone. Boundary fades cannot guarantee matching pitch, breath or pronunciation.',
    clips:'Clips and transitions',clipsHelp:'Select any clip to edit it. Overlap applies between the selected clip and the preceding clip.',add:'Add clip',overlap:'Overlap with preceding clip · seconds',curve:'Transition curve',linear:'Linear — similar material',equalPower:'Equal power — different material',audition:'Audition transition',
    backing:'Separate instrumental / Suno stem',backingHelp:'Import an instrumental without vocals here, and edit vocals in the timeline. Importing a complete song does not remove its singer.',loadBacking:'Import instrumental',backingGain:'Instrumental gain · dB',backingOffset:'Instrumental start · seconds',removeBacking:'Remove instrumental from project',
    export:'Preview and export',protect:'Attenuate when sample peaks exceed −1 dBFS',protectHelp:'Uses uniform gain reduction to protect sample peaks. This is not true-peak measurement or automatic mastering.',format:'Format',bitrate:'MP3 bitrate',exportButton:'Export and save to library',cancel:'Cancel processing',
    sunoTitle:'Voice and song in Suno',sunoHelp:'To combine existing performances, export separate vocal and instrumental stems from Suno. Changing only the singer’s identity requires a dedicated voice-conversion engine. This editor does not clone voices.',personasLink:'Personas and Voices in Suno',stemsLink:'Export separate stems from Suno'
  };
  class Editor {
    constructor(host) {
      this.host=host; this.sources=new Map(); this.project=this.blank(); this.undo=[];this.redo=[];this.donor=null;
      this.playToken=0;this.previewPeaks=new Map();
      this.view={start:0,span:1};this.peakCache=new WeakMap();this.revision=0;this.cache=null;this.playing=null;this.loop=false;this.busy=false;
      this.worker=null;this.sentSources=new Set();this.pending=new Map();this.requestId=0;this.saveQueue=Promise.resolve();this.saveTimer=null;
      this.saveRevision=0;this.pendingSaves=0;this.saving=false;this.dirty=false;this.exportedRevision=-1;
      this.heLabels=new Map([...document.querySelectorAll('[data-sp]')].map(el=>[el.dataset.sp,el.textContent]));
      this.bind();this.refresh();
    }
    blank(){return {version:1,id:uid(),name:this.text('פרויקט חדש','New project'),clips:[],activeId:null,selection:{a:0,b:0},master:{protectPeaks:true},backing:null};}
    text(he,en){return this.host.language()==='he'?he:en;}
    label(key){return this.host.language()==='he'?this.heLabels.get(key):(EN[key]||this.heLabels.get(key));}
    active(){return this.project.clips.find(c=>c.id===this.project.activeId)||null;}
    duration(c=this.active()){return c?c.out-c.in:0;}
    buffer(c=this.active()){return c?this.sources.get(c.sourceId).buffer:null;}
    stamp(s){return Math.max(0,s).toFixed(3);}
    say(he,en){this.host.toast(this.text(he,en));}
    fail(error){console.error(error);const message=this.text('לא ניתן להשלים: ','Could not complete: ')+(error.message||error);$('spStatus').textContent=message;this.host.toast?.(message);}
    async task(fn){if(this.busy)return;this.setBusy(true);try{return await fn();}catch(e){this.fail(e);}finally{this.setBusy(false);}}
    setBusy(value){this.busy=value;document.querySelectorAll('#screen-editor button,#screen-editor input,#screen-editor select').forEach(el=>{if(el.id!=='spCancel'&&el.id!=='edStop')el.disabled=value;});$('spCancel').classList.toggle('hide',!value);if(!value)this.updateDisabled();}
    bind(){
      const click=(id,fn)=>$(id).addEventListener('click',()=>{try{const result=fn();if(result&&result.catch)result.catch(e=>this.fail(e));}catch(e){this.fail(e);}});
      click('edLoadFile',()=>this.pick(file=>this.importAudio(file)));click('edAddClip',()=>this.pick(file=>this.importAudio(file)));
      click('spNew',()=>{if((this.project.clips.length||this.project.backing||this.dirty)&&!confirm(this.text('לפתוח פרויקט חדש? שמור קודם קובץ פרויקט אם תרצה לחזור לעבודה הזו.','Start a new project? Save a project file first to keep this work.')))return;this.reset(this.blank(),new Map());});
      click('spSave',()=>this.task(()=>this.saveProjectFile()));
      click('spOpen',()=>this.pick(file=>this.task(async()=>{const loaded=await StudioProjects.importProject(file,(...a)=>this.host.actx().createBuffer(...a));this.reset(loaded.project,loaded.sources);}),'.appnest'));
      click('spRestore',()=>this.task(()=>this.restoreLatest()));
      $('spProjectName').addEventListener('change',()=>this.mutate(()=>{this.project.name=$('spProjectName').value.trim()||this.text('פרויקט','Project');}));
      click('edUndo',()=>this.travel(this.undo,this.redo));click('spRedo',()=>this.travel(this.redo,this.undo));
      click('spZoomIn',()=>this.zoom(.5));click('spZoomOut',()=>this.zoom(2));click('spZoomAll',()=>{this.fitView();this.draw();});
      click('spZoomSel',()=>{const s=this.project.selection;if(s.b>s.a){this.view={start:s.a,span:Math.max(.005,s.b-s.a)};this.clampView();this.draw();}});
      $('spPan').addEventListener('input',()=>{this.view.start=(this.duration()-this.view.span)*finite($('spPan').value)/1000;this.draw();});
      for(const [id,key]of [['spSelA','a'],['spSelB','b']])$(id).addEventListener('change',()=>{this.project.selection[key]=finite($(id).value);this.clampSelection(key);this.draw();this.updateDonor();this.scheduleSave();});
      document.querySelectorAll('#nudgeRow [data-edge]').forEach(el=>el.addEventListener('click',()=>{const edge=el.dataset.edge;this.project.selection[edge]+=finite($('spNudgeStep').value,.01)*finite(el.dataset.dir);this.clampSelection(edge);this.draw();this.updateDonor();this.scheduleSave();}));
      click('spZero',()=>{const c=this.active();if(!c)return;const s=this.project.selection;for(const k of ['a','b'])s[k]=StudioAudio.nearestZero(this.buffer(),c.in+s[k],{windowMs:5})-c.in;this.clampSelection();this.draw();this.scheduleSave();});
      click('edPlay',()=>this.togglePlay());click('edPlayAll',()=>this.task(()=>this.playResult()));click('edStop',()=>{this.stop();if(this.busy)this.cancelRender();});
      click('edLoop',()=>{this.loop=!this.loop;$('edLoop').setAttribute('aria-pressed',String(this.loop));$('edLoop').classList.toggle('on',this.loop);if(this.playing)this.stop();});
      click('edTrim',()=>this.trim());click('edDelSel',()=>this.removeSelection());click('edSplit',()=>this.split());
      click('spCopy',()=>this.copySelection());
      for(const [id,key,scale]of [['spGain','gainDb',1],['spFadeIn','fadeIn',.001],['spFadeOut','fadeOut',.001]])$(id).addEventListener('change',()=>this.mutate(()=>{const c=this.active();if(c)c[key]=key==='gainDb'?bound(finite($(id).value),-60,18):bound(finite($(id).value)*scale,0,this.duration(c));}));
      click('edNorm',()=>this.matchLevels());click('edTrimSilence',()=>this.trimSilence());
      $('spOverlap').addEventListener('change',()=>this.mutate(()=>{const c=this.active();if(c)c.join.duration=Math.max(0,finite($('spOverlap').value));}));
      $('spCurve').addEventListener('change',()=>this.mutate(()=>{const c=this.active();if(c)c.join.curve=$('spCurve').value;}));
      click('spAudition',()=>this.task(()=>this.audition()));
      click('spDonorLoad',()=>this.pick(file=>this.task(async()=>{const id=await this.addSource(file);const b=this.sources.get(id).buffer;this.donor={sourceId:id,name:file.name,in:0,out:b.duration,gainDb:0};this.updateDonor();})));
      for(const [id,key]of [['spDonorA','in'],['spDonorB','out']])$(id).addEventListener('change',()=>{if(!this.donor)return;this.donor[key]=finite($(id).value);this.clampDonor(key);this.updateDonor();});
      click('spDonorFit',()=>{if(!this.donor)return;const len=this.project.selection.b-this.project.selection.a,source=this.sources.get(this.donor.sourceId).buffer;if(len<=0||this.donor.in+len>source.duration){this.say('אין מספיק אודיו במקור החלופי לאורך הזה','Replacement source is too short for this duration');return;}this.donor.out=this.donor.in+len;this.updateDonor();});
      click('spDonorPlay',()=>this.task(()=>this.playDonor()));click('spReplace',()=>this.replaceSelection());
      click('spBackingLoad',()=>this.pick(file=>this.task(async()=>{const sourceId=await this.addSource(file);const buffer=this.sources.get(sourceId).buffer;this.mutate(()=>{this.project.backing={sourceId,in:0,out:buffer.duration,offset:0,gainDb:-6,fadeIn:0,fadeOut:0};});})));
      click('spBackingRemove',()=>this.mutate(()=>{this.project.backing=null;}));
      for(const [id,key]of [['spBackingGain','gainDb'],['spBackingOffset','offset']])$(id).addEventListener('change',()=>this.mutate(()=>{if(this.project.backing)this.project.backing[key]=key==='gainDb'?bound(finite($(id).value),-60,18):Math.max(0,finite($(id).value));}));
      $('spProtect').addEventListener('change',()=>this.mutate(()=>{this.project.master.protectPeaks=$('spProtect').checked;}));
      click('edExport',()=>this.task(()=>this.exportAudio()));click('spCancel',()=>{this.cancelRender();this.host.cancelMP3();this.stop();});
      const canvas=$('waveC');let dragging=null;
      canvas.addEventListener('pointerdown',e=>{if(!this.active()||this.busy)return;canvas.setPointerCapture(e.pointerId);const t=this.pointerTime(e),s=this.project.selection,tolerance=this.view.span*14/canvas.clientWidth;dragging=Math.abs(t-s.a)<tolerance?'a':Math.abs(t-s.b)<tolerance?'b':'new';if(dragging==='new'){s.a=t;s.b=t;dragging='b';}this.draw();});
      canvas.addEventListener('pointermove',e=>{if(!dragging)return;this.project.selection[dragging]=this.pointerTime(e);this.draw();});
      const end=()=>{if(!dragging)return;dragging=null;this.clampSelection();this.draw();this.updateDonor();this.scheduleSave();};canvas.addEventListener('pointerup',end);canvas.addEventListener('pointercancel',end);
      document.addEventListener('keydown',e=>{if($('screen-editor').classList.contains('hide')||this.busy||/INPUT|TEXTAREA|SELECT/.test(e.target.tagName)||e.target.isContentEditable)return;if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='z'){e.preventDefault();e.shiftKey?this.travel(this.redo,this.undo):this.travel(this.undo,this.redo);}else if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='y'){e.preventDefault();this.travel(this.redo,this.undo);}else if(e.code==='Space'){e.preventDefault();this.togglePlay();}});
      window.addEventListener('beforeunload',e=>{if(this.dirty){e.preventDefault();e.returnValue='';}});
    }
    safeName(name){return (name||'project').replace(/[^\p{L}\p{N} _.-]/gu,'_').slice(0,150);}
    pick(fn,accept='audio/*,video/*'){
      const input=document.createElement('input');input.type='file';input.accept=accept;input.hidden=true;
      input.addEventListener('change',()=>{const file=input.files?.[0];input.remove();if(file)Promise.resolve().then(()=>fn(file)).catch(e=>this.fail(e));},{once:true});
      input.addEventListener('cancel',()=>input.remove(),{once:true});document.body.append(input);
      try{input.click();}catch(e){input.remove();throw e;}
    }
    async addSource(file){const buffer=await this.host.decodeFile(file);return this.storeSource(buffer,file.name);}
    storeSource(buffer,name){if(buffer.numberOfChannels>2)throw Error(this.text('ייבוא העורך תומך במונו ובסטריאו','The editor supports mono and stereo imports'));const id=uid();this.sources.set(id,{buffer,name});return id;}
    makeClip(sourceId,name,from=0,to){const b=this.sources.get(sourceId).buffer;return {id:uid(),sourceId,name,in:from,out:to??b.duration,gainDb:0,fadeIn:0,fadeOut:0,join:{duration:0,curve:'linear'}};}
    async importAudio(file){return this.task(async()=>{const sourceId=await this.addSource(file);this.append(this.makeClip(sourceId,file.name));});}
    openBuffer(buffer,name){const id=this.storeSource(buffer,name);this.append(this.makeClip(id,name));}
    append(c){this.mutate(()=>{if(!this.project.clips.length)this.project.name=c.name.replace(/\.[^.]+$/,'');this.project.clips.push(c);this.project.activeId=c.id;this.project.selection={a:0,b:this.duration(c)};});this.fitView();this.draw();}
    snapshot(){return clone(this.project);}
    mutate(fn){this.stop();this.undo.push(this.snapshot());if(this.undo.length>100)this.undo.shift();this.redo=[];fn();this.changed();}
    changed(){this.revision++;this.cache=null;this.normalize();this.refresh();this.scheduleSave();}
    normalize(){for(const c of this.project.clips){const b=this.sources.get(c.sourceId).buffer;c.in=bound(c.in,0,b.duration);c.out=bound(c.out,c.in,b.duration);c.fadeIn=bound(c.fadeIn||0,0,this.duration(c));c.fadeOut=bound(c.fadeOut||0,0,this.duration(c));}if(!this.active())this.project.activeId=this.project.clips[0]?.id||null;this.clampSelection();this.clampView();}
    travel(from,to){if(!from.length)return;this.stop();to.push(this.snapshot());this.project=from.pop();this.changed();this.fitView();this.draw();}
    reset(project,sources,save=true){
      const next=clone(project);next.selection=next.selection||{a:0,b:0};next.master={protectPeaks:true,...next.master};next.backing=next.backing||null;
      for(const clip of next.clips)clip.join=clip.join||{duration:0,curve:'linear'};
      this.stop();clearTimeout(this.saveTimer);this.saveTimer=null;this.cancelRender();this.project=next;this.sources=sources;this.undo=[];this.redo=[];this.donor=null;this.cache=null;this.revision++;this.saveRevision++;this.dirty=false;this.exportedRevision=-1;
      this.normalize();this.fitView();this.refresh();
      if(save)this.scheduleSave();else $('spSaveStatus').textContent=this.text('שוחזרה השמירה המקומית','Local save restored');
    }
    usedSources(){const ids=new Set(this.project.clips.map(c=>c.sourceId));if(this.project.backing)ids.add(this.project.backing.sourceId);return new Map([...this.sources].filter(([id])=>ids.has(id)));}
    scheduleSave(){clearTimeout(this.saveTimer);this.saveRevision++;this.dirty=true;$('spSaveStatus').textContent=this.text('שינויים ממתינים לשמירה','Changes awaiting save');this.saveTimer=setTimeout(()=>{this.saveTimer=null;const rev=this.saveRevision;this.flushSave().catch(e=>{if(rev===this.saveRevision)this.fail(e);});},900);}
    async flushSave(){
      clearTimeout(this.saveTimer);this.saveTimer=null;
      const snapshot=this.snapshot(),sources=this.usedSources(),rev=this.saveRevision;
      this.pendingSaves++;this.saving=true;
      const operation=this.saveQueue.catch(()=>{}).then(()=>StudioProjects.save(snapshot,sources));this.saveQueue=operation;
      try{const result=await operation;if(rev===this.saveRevision){this.dirty=false;$('spSaveStatus').textContent=this.text('נשמר במכשיר ✓','Saved on this device ✓');}return result;}
      catch(e){if(rev===this.saveRevision)$('spSaveStatus').textContent=this.exportedRevision===rev?this.text('שמירה מקומית נכשלה; קובץ הפרויקט יוצא','Local save failed; project file exported'):this.text('שמירה מקומית נכשלה — שמור קובץ פרויקט','Local save failed — save a project file');throw e;}
      finally{this.pendingSaves--;this.saving=this.pendingSaves>0;}
    }
    async saveProjectFile(){
      const rev=this.saveRevision,blob=StudioProjects.exportProject(this.project,this.usedSources());
      await this.host.download(blob,this.safeName(this.project.name)+'.appnest');
      if(rev===this.saveRevision){this.dirty=false;this.exportedRevision=rev;$('spSaveStatus').textContent=this.text('קובץ הפרויקט יוצא ✓','Project file exported ✓');}
    }
    async restoreLatest(){
      const hadPendingTimer=this.saveTimer!==null;clearTimeout(this.saveTimer);this.saveTimer=null;let restored=false;
      try{
        await this.saveQueue.catch(()=>{});
        const loaded=await StudioProjects.loadLatest((...a)=>this.host.actx().createBuffer(...a));
        if(!loaded){this.say('לא נמצאה שמירה מקומית','No local save found');return false;}
        this.reset(loaded.project,loaded.sources,false);restored=true;return true;
      }finally{if(!restored&&(hadPendingTimer||this.dirty)&&this.saveTimer===null)this.scheduleSave();}
    }
    select(id){this.stop();this.project.activeId=id;this.project.selection={a:0,b:this.duration()};this.fitView();this.refresh();this.scheduleSave();}
    clampSelection(edge){const s=this.project.selection,d=this.duration();s.a=bound(finite(s.a),0,d);s.b=bound(finite(s.b),0,d);if(s.a>s.b){if(edge==='a')s.a=s.b;else if(edge==='b')s.b=s.a;else [s.a,s.b]=[s.b,s.a];}const rate=this.buffer()?.sampleRate||48000;s.a=Math.round(s.a*rate)/rate;s.b=Math.round(s.b*rate)/rate;}
    fitView(){this.view={start:0,span:Math.max(.001,this.duration())};}
    clampView(){const d=this.duration();this.view.span=bound(this.view.span,.001,Math.max(.001,d));this.view.start=bound(this.view.start,0,Math.max(0,d-this.view.span));}
    zoom(scale){const middle=this.view.start+this.view.span/2;this.view.span*=scale;this.view.start=middle-this.view.span/2;this.clampView();this.draw();}
    pointerTime(e){const rect=$('waveC').getBoundingClientRect();return bound(this.view.start+(e.clientX-rect.left)/rect.width*this.view.span,0,this.duration());}
    refresh(){
      document.querySelectorAll('[data-sp]').forEach(el=>{el.textContent=this.label(el.dataset.sp);});
      const c=this.active(),has=!!c;this.host.setActive(c?{...c,buffer:this.buffer(c)}:null);
      $('editorEmpty').classList.toggle('hide',has);$('editorMain').classList.toggle('hide',!has);$('spProjectName').value=this.project.name;
      if(c){$('edName').textContent=c.name;$('spGain').value=c.gainDb;$('spFadeIn').value=Math.round(c.fadeIn*1000);$('spFadeOut').value=Math.round(c.fadeOut*1000);$('spOverlap').value=c.join.duration;$('spCurve').value=c.join.curve;}
      $('spProtect').checked=this.project.master.protectPeaks;
      this.renderClips();this.renderTimeline();this.updateDonor();this.updateBacking();this.draw();this.updateDisabled();
    }
    updateDisabled(){
      if(this.busy){document.querySelectorAll('#screen-editor button,#screen-editor input,#screen-editor select').forEach(el=>{if(el.id!=='spCancel'&&el.id!=='edStop')el.disabled=true;});return;}
      $('edUndo').disabled=!this.undo.length;$('spRedo').disabled=!this.redo.length;$('spSave').disabled=false;for(const id of ['spDonorA','spDonorB','spDonorFit','spDonorPlay','spReplace'])$(id).disabled=!this.donor;$('spBackingRemove').disabled=!this.project.backing;for(const id of ['spBackingGain','spBackingOffset'])$(id).disabled=!this.project.backing;const first=this.project.clips[0]?.id===this.project.activeId;for(const id of ['spOverlap','spCurve','spAudition'])$(id).disabled=first||!this.active();
      document.querySelectorAll('#clipList [data-clip-action]').forEach(button=>{const i=this.project.clips.findIndex(c=>c.id===button.dataset.clipId),action=button.dataset.clipAction;button.disabled=i<0||(action==='up'&&i===0)||(action==='down'&&i===this.project.clips.length-1);});
    }
    renderClips(){
      const list=$('clipList');list.replaceChildren();this.project.clips.forEach((c,i)=>{
        const row=document.createElement('div');row.className='studio-clip'+(c.id===this.project.activeId?' selected':'');
        const choose=document.createElement('button');choose.className='studio-clip-name';choose.textContent=(i+1)+'. '+c.name+' · '+this.stamp(this.duration(c))+' s';choose.disabled=this.busy;choose.setAttribute('aria-pressed',String(c.id===this.project.activeId));choose.onclick=()=>{if(!this.busy&&this.project.clips.some(clip=>clip.id===c.id))this.select(c.id);};row.append(choose);
        for(const [key,label,disabled]of [['up','↑',i===0],['down','↓',i===this.project.clips.length-1],['remove','×',false]]){
          const b=document.createElement('button');b.className='mini';b.textContent=label;b.dataset.clipAction=key;b.dataset.clipId=c.id;b.disabled=this.busy||disabled;b.setAttribute('aria-label',this.text(key==='up'?'העבר למעלה':key==='down'?'העבר למטה':'הסר קטע',key==='up'?'Move up':key==='down'?'Move down':'Remove clip')+' '+c.name);
          b.onclick=()=>{if(this.busy)return;const index=this.project.clips.findIndex(clip=>clip.id===c.id);if(index<0)return;const j=index+(key==='up'?-1:1);if(key!=='remove'&&(j<0||j>=this.project.clips.length))return;this.mutate(()=>{if(key==='remove')this.project.clips.splice(index,1);else [this.project.clips[index],this.project.clips[j]]=[this.project.clips[j],this.project.clips[index]];});};row.append(b);
        }
        list.append(row);
      });
    }
    renderTimeline(){const box=$('spTimeline');box.replaceChildren();if(!this.project.clips.length)return;try{const layout=StudioAudio.layout(this.project.clips,this.sources),total=Math.max(layout.duration,this.project.backing?this.project.backing.offset+this.project.backing.out-this.project.backing.in:0);for(const [i,s]of layout.segments.entries()){const b=document.createElement('button');b.type='button';b.className='studio-block'+(s.clip.id===this.project.activeId?' selected':'');b.style.left=(s.start/total*100)+'%';b.style.width=Math.max(.5,s.duration/total*100)+'%';b.style.top=(i%2)*34+'px';b.textContent=s.clip.name;b.title=this.stamp(s.start)+'–'+this.stamp(s.end);b.onclick=()=>this.select(s.clip.id);box.append(b);}const current=layout.segments.find(s=>s.clip.id===this.project.activeId);$('spProjectInfo').textContent=this.text('משך התוצאה: ','Result duration: ')+this.stamp(total)+' s · '+this.project.clips.length+' '+this.text('קטעים','clips');$('spJoinInfo').textContent=current?this.text('חפיפה בפועל: ','Actual overlap: ')+this.stamp(current.overlap)+' s'+(Math.abs(current.overlap-this.active().join.duration)>.001?this.text(' · הוגבלה לאורך הקטעים',' · Limited by clip lengths'):''):'';}catch(e){this.fail(e);}}
    peaks(buffer){if(this.peakCache.has(buffer))return this.peakCache.get(buffer);const channels=[];for(let ch=0;ch<Math.min(2,buffer.numberOfChannels);ch++){const data=buffer.getChannelData(ch),n=Math.ceil(data.length/128);let level={size:128,min:new Float32Array(n),max:new Float32Array(n)};for(let i=0;i<n;i++){let lo=1,hi=-1;for(let j=i*128;j<Math.min(data.length,(i+1)*128);j++){lo=Math.min(lo,data[j]);hi=Math.max(hi,data[j]);}level.min[i]=lo;level.max[i]=hi;}const levels=[level];while(level.min.length>2){const n2=Math.ceil(level.min.length/2),next={size:level.size*2,min:new Float32Array(n2),max:new Float32Array(n2)};for(let i=0;i<n2;i++){next.min[i]=Math.min(level.min[i*2],level.min[Math.min(i*2+1,level.min.length-1)]);next.max[i]=Math.max(level.max[i*2],level.max[Math.min(i*2+1,level.max.length-1)]);}levels.push(next);level=next;}channels.push(levels);}this.peakCache.set(buffer,channels);return channels;}
    draw(){const c=this.active(),canvas=$('waveC');if(!c||!canvas.clientWidth)return;const buffer=this.buffer(c),ctx=canvas.getContext('2d'),w=canvas.clientWidth,h=190,dpr=devicePixelRatio||1;canvas.width=Math.round(w*dpr);canvas.height=h*dpr;ctx.setTransform(dpr,0,0,dpr,0,0);const css=getComputedStyle(document.body),gold=css.getPropertyValue('--gold').trim()||'#e8b923',muted=css.getPropertyValue('--muted').trim()||'#999';ctx.clearRect(0,0,w,h);const peaks=this.peaks(buffer),rate=buffer.sampleRate,samplesPerPx=this.view.span*rate/w;for(let ch=0;ch<peaks.length;ch++){const mid=(ch+.5)*(h-24)/peaks.length,amp=(h-24)/peaks.length*.42;let level=null;for(const l of peaks[ch])if(l.size<=samplesPerPx)level=l;ctx.strokeStyle=muted;ctx.lineWidth=1;ctx.beginPath();const data=buffer.getChannelData(ch);for(let x=0;x<w;x++){const from=Math.max(0,Math.floor((c.in+this.view.start+x/w*this.view.span)*rate)),to=Math.min(data.length,Math.max(from+1,Math.floor((c.in+this.view.start+(x+1)/w*this.view.span)*rate)));let lo=1,hi=-1;if(level){for(let j=Math.floor(from/level.size);j<Math.ceil(to/level.size);j++){lo=Math.min(lo,level.min[j]??0);hi=Math.max(hi,level.max[j]??0);}}else{for(let j=from;j<to;j++){lo=Math.min(lo,data[j]);hi=Math.max(hi,data[j]);}}ctx.moveTo(x+.5,mid-lo*amp);ctx.lineTo(x+.5,mid-hi*amp);}ctx.stroke();ctx.fillStyle=muted;ctx.font='11px system-ui';ctx.fillText(ch===0?'L / Mono':'R',8,14+ch*(h-24)/peaks.length);}
      ctx.fillStyle=muted;ctx.font='11px system-ui';ctx.direction='ltr';for(let i=0;i<=4;i++)ctx.fillText(this.stamp(this.view.start+this.view.span*i/4),bound(w*i/4,3,w-52),h-5);
      const s=this.project.selection,xa=(s.a-this.view.start)/this.view.span*w,xb=(s.b-this.view.start)/this.view.span*w;ctx.save();ctx.beginPath();ctx.rect(0,0,w,h-23);ctx.clip();ctx.fillStyle=gold;ctx.globalAlpha=.15;ctx.fillRect(Math.min(xa,xb),0,Math.abs(xb-xa),h-23);ctx.globalAlpha=1;ctx.fillRect(xa-1,0,2,h-23);ctx.fillRect(xb-1,0,2,h-23);ctx.restore();
      $('spSelA').value=this.stamp(s.a);$('spSelB').value=this.stamp(s.b);$('selInfo').textContent=this.text('בחירה: ','Selection: ')+this.stamp(Math.abs(s.b-s.a))+' s · '+this.text('הקטע המקורי: ','Source range: ')+this.stamp(c.in)+'–'+this.stamp(c.out)+' s';$('spPan').value=this.duration()>this.view.span?Math.round(this.view.start/(this.duration()-this.view.span)*1000):0;
    }
    subclip(c,from,to){return {...clone(c),id:uid(),in:c.in+from,out:c.in+to,fadeIn:from===0?Math.min(c.fadeIn,to-from):0,fadeOut:to===this.duration(c)?Math.min(c.fadeOut,to-from):0,join:from===0?clone(c.join):{duration:0,curve:'linear'}};}
    trim(){const c=this.active(),s=this.project.selection;if(!c||s.b-s.a<1/48000)return;this.mutate(()=>{const replacement=this.subclip(c,s.a,s.b),index=this.project.clips.indexOf(c);this.project.clips[index]=replacement;this.project.activeId=replacement.id;this.project.selection={a:0,b:this.duration(replacement)};});this.fitView();this.draw();}
    split(){
      const c=this.active();if(!c)return;
      const layout=StudioAudio.layout(this.project.clips,this.sources),index=this.project.clips.indexOf(c),segment=layout.segments[index],rate=layout.sampleRate;
      const frames=Math.round((c.in+this.project.selection.b)*rate)-segment.sourceStart,remaining=segment.durationFrames-frames;
      if(frames<1||remaining<1)return;
      const incoming=segment.overlapFrames,outgoing=layout.segments[index+1]?.overlapFrames||0;
      const fadeIn=Math.min(segment.durationFrames,Math.round((c.fadeIn||0)*rate)),fadeOut=Math.min(segment.durationFrames,Math.round((c.fadeOut||0)*rate));
      if(frames<Math.max(incoming,fadeIn)||remaining<Math.max(outgoing,fadeOut)){
        this.say('נקודת הפיצול נמצאת בתוך חפיפה או פייד. בחר נקודה מחוץ לאזורים האלה כדי לשמור על הצליל והתזמון.','The split point is inside a transition or fade. Choose a point outside these regions to preserve the sound and timing.');return;
      }
      const p=(segment.sourceStart+frames)/rate-c.in,left=this.subclip(c,0,p),right=this.subclip(c,p,this.duration(c)),candidate=this.project.clips.slice();
      candidate.splice(index,1,left,right);
      if(StudioAudio.layout(candidate,this.sources).length!==layout.length){this.say('הפיצול משנה את החפיפות הקיימות. בחר נקודת פיצול אחרת.','This split changes the existing overlaps. Choose another split point.');return;}
      this.mutate(()=>{this.project.clips=candidate;this.project.activeId=right.id;this.project.selection={a:0,b:this.duration(right)};});this.fitView();this.draw();
    }
    removeSelection(){const c=this.active(),{a,b}=this.project.selection;if(!c||b-a<1/48000)return;this.mutate(()=>{const pieces=[];if(a>1/48000)pieces.push(this.subclip(c,0,a));if(b<this.duration(c)-1/48000){const right=this.subclip(c,b,this.duration(c));if(pieces.length)right.join.duration=Math.min(.005,this.duration(right),this.duration(pieces[0])/2);pieces.push(right);}const i=this.project.clips.indexOf(c);this.project.clips.splice(i,1,...pieces);this.project.activeId=pieces[0]?.id||this.project.clips[0]?.id||null;this.project.selection={a:0,b:0};});this.fitView();this.draw();}
    trimSilence(){const c=this.active();if(!c)return;const found=StudioAudio.findSound(this.buffer(c),{from:c.in,to:c.out,thresholdDb:-50,windowMs:10,paddingMs:40});if(!found.found){this.say('לא נמצא צליל מעל הסף; הקטע נשמר','No sound above the threshold; clip kept');return;}this.mutate(()=>{c.in=found.in;c.out=found.out;this.project.selection={a:0,b:this.duration(c)};});this.fitView();this.draw();}
    matchLevels(){const selected=this.active();if(!selected)return;const reference=StudioAudio.analyze(this.buffer(selected),selected.in,selected.out);if(reference.rms<1e-6)return;this.mutate(()=>{const target=reference.dbRms+selected.gainDb;for(const c of this.project.clips){const stats=StudioAudio.analyze(this.buffer(c),c.in,c.out);if(stats.rms>1e-6)c.gainDb=bound(target-stats.dbRms,-12,12);}});$('spClipLevel').textContent=this.text('התאמת RMS מוגבלת ל־±12 dB; בדוק בהאזנה','RMS matching limited to ±12 dB; audition the result');}
    copySelection(){const c=this.active(),s=this.project.selection;if(!c||s.b-s.a<1/48000)return;this.donor={sourceId:c.sourceId,name:c.name,in:c.in+s.a,out:c.in+s.b,gainDb:c.gainDb};this.updateDonor();this.updateDisabled();this.say('המקטע מוכן להחלפה','Replacement clip is ready');}
    clampDonor(edge){const d=this.donor;if(!d)return;const dur=this.sources.get(d.sourceId).buffer.duration;d.in=bound(d.in,0,dur);d.out=bound(d.out,0,dur);if(d.in>d.out){if(edge==='in')d.in=d.out;else d.out=d.in;}}
    updateDonor(){const d=this.donor;if(!d){$('spDonorInfo').textContent=this.text('לא נבחר מקור חלופי','No replacement source selected');return;}$('spDonorA').value=this.stamp(d.in);$('spDonorB').value=this.stamp(d.out);const target=this.project.selection.b-this.project.selection.a,delta=d.out-d.in-target;$('spDonorInfo').textContent=d.name+' · '+this.stamp(d.out-d.in)+' s · '+this.text('הפרש מהיעד: ','Difference from target: ')+(delta>=0?'+':'')+delta.toFixed(3)+' s';}
    replaceSelection(){
      const c=this.active(),d=this.donor,s=this.project.selection;if(!c||!d)return;
      const original=StudioAudio.layout(this.project.clips,this.sources),index=this.project.clips.indexOf(c),segment=original.segments[index],rate=original.sampleRate,db=this.sources.get(d.sourceId).buffer;
      if(db.sampleRate!==rate){this.say('למקור החלופי קצב דגימה שונה. ייבא אותו מחדש לעורך לפני ההחלפה.','The replacement uses a different sample rate. Import it again through the editor before replacing.');return;}
      const startFrame=bound(Math.round((c.in+s.a)*rate),segment.sourceStart,segment.sourceEnd),endFrame=bound(Math.round((c.in+s.b)*rate),segment.sourceStart,segment.sourceEnd);
      const donorStart=bound(Math.round(d.in*rate),0,db.length),donorEnd=bound(Math.round(d.out*rate),0,db.length),targetFrames=endFrame-startFrame,donorFrames=donorEnd-donorStart;
      if(targetFrames<1||donorFrames<1)return;
      const preserve=$('spReplaceMode').value==='preserve';
      if(preserve&&targetFrames!==donorFrames){this.say('כדי לשמור תזמון, כוון קודם את אורך המקור לאורך היעד בדיוק.','To preserve timing, first match the replacement selection to the target duration exactly.');return;}
      const leftFrames=startFrame-segment.sourceStart,rightFrames=segment.sourceEnd-endFrame,desired=Math.round(bound(finite($('spSeamMs').value),0,100)*rate/1000);
      const beforeFrames=Math.min(desired,leftFrames,donorStart,Math.floor(donorFrames/2)),afterFrames=Math.min(desired,rightFrames,db.length-donorEnd,Math.floor(donorFrames/2));
      const before=beforeFrames/rate,after=afterFrames/rate,a=startFrame/rate-c.in,b=endFrame/rate-c.in,pieces=[];
      if(leftFrames)pieces.push(this.subclip(c,0,a));
      const replacement={...this.makeClip(d.sourceId,d.name,(donorStart-beforeFrames)/rate,(donorEnd+afterFrames)/rate),gainDb:d.gainDb||0,join:pieces.length?{duration:before,curve:'linear'}:clone(c.join),fadeIn:0,fadeOut:0};
      pieces.push(replacement);
      if(rightFrames){const right=this.subclip(c,b,this.duration(c));right.join={duration:after,curve:'linear'};pieces.push(right);}
      const candidate=this.project.clips.slice();candidate.splice(index,1,...pieces);
      const result=StudioAudio.layout(candidate,this.sources),expected=original.length+(preserve?0:donorFrames-targetFrames);
      if(result.length!==expected){this.say('ההחלפה הזו תשנה גם חפיפה קיימת ולכן לא תשמור על התזמון שנבחר. קצר את החפיפה החיצונית או בחר אזור החלפה מחוץ לה.','This replacement also changes an existing overlap, so it cannot keep the chosen timing. Shorten the surrounding transition or select a replacement region outside it.');return;}
      const replacementIndex=candidate.indexOf(replacement),replacementSegment=result.segments[replacementIndex],microFrames=Math.max(1,Math.round(.003*rate));
      const fadeAt=(clip,segment,key)=>{clip[key]=Math.max(clip[key]||0,Math.min(microFrames,segment.durationFrames)/rate);};
      if(!replacementSegment.overlapFrames){
        fadeAt(replacement,replacementSegment,'fadeIn');
        if(replacementIndex>0){candidate[replacementIndex-1]=clone(candidate[replacementIndex-1]);fadeAt(candidate[replacementIndex-1],result.segments[replacementIndex-1],'fadeOut');}
      }
      const following=result.segments[replacementIndex+1];
      if(!following?.overlapFrames){
        fadeAt(replacement,replacementSegment,'fadeOut');
        if(following){candidate[replacementIndex+1]=clone(candidate[replacementIndex+1]);fadeAt(candidate[replacementIndex+1],following,'fadeIn');}
      }
      this.mutate(()=>{this.project.clips=candidate;this.project.activeId=replacement.id;this.project.selection={a:before,b:before+donorFrames/rate};});
      this.fitView();this.draw();this.say('ההחלפה בוצעה — האזן לשני הגבולות','Replacement applied — audition both boundaries');
    }
    updateBacking(){const b=this.project.backing;$('spBackingInfo').textContent=b?this.sources.get(b.sourceId).name:this.text('ללא ליווי נפרד','No separate instrumental');$('spBackingGain').value=b?.gainDb??0;$('spBackingOffset').value=b?.offset??0;}
    ensureWorker(){if(this.worker)return;this.worker=new Worker('studio-render-worker.js');this.worker.onmessage=({data})=>{const pending=this.pending.get(data.id);if(!pending)return;this.pending.delete(data.id);data.error?pending.reject(Error(data.error)):pending.resolve(data.result);};this.worker.onerror=e=>{const error=Error(e.message||'Audio rendering failed');for(const p of this.pending.values())p.reject(error);this.pending.clear();this.worker?.terminate();this.worker=null;this.sentSources.clear();};}
    cancelRender(){this.worker?.terminate();this.worker=null;this.sentSources.clear();for(const p of this.pending.values())p.reject(Error(this.text('העיבוד בוטל','Processing cancelled')));this.pending.clear();}
    async render(clips=this.project.clips,backing=this.project.backing,cache=true){if(cache&&this.cache?.revision===this.revision)return this.cache.result;this.ensureWorker();const requiredSources=new Set(clips.map(clip=>clip.sourceId));if(backing)requiredSources.add(backing.sourceId);for(const id of requiredSources){if(this.sentSources.has(id))continue;const source=this.sources.get(id);if(!source)throw Error('Audio source is missing: '+id);const b=source.buffer,channels=Array.from({length:b.numberOfChannels},(_,ch)=>b.getChannelData(ch).slice());this.worker.postMessage({type:'source',id,name:source.name,sampleRate:b.sampleRate,channels},channels.map(c=>c.buffer));this.sentSources.add(id);}const id=++this.requestId,rev=this.revision,result=await new Promise((resolve,reject)=>{this.pending.set(id,{resolve,reject});this.worker.postMessage({type:'render',id,clips:clone(clips),options:{protectPeaks:this.project.master.protectPeaks,ceilingDb:-1,backing:backing?clone(backing):null}});});if(cache&&rev===this.revision)this.cache={revision:rev,result};this.outputInfo(result);return result;}
    outputInfo(result){const db=result.peak>0?20*Math.log10(result.peak):-Infinity;$('spOutputInfo').textContent=this.text('שיא דגימות: ','Sample peak: ')+(Number.isFinite(db)?db.toFixed(1):'−∞')+' dBFS · '+this.text('הנמכה: ','Attenuation: ')+(result.scale<1?(-20*Math.log10(result.scale)).toFixed(1):'0')+' dB';$('spMeter').firstElementChild.style.width=(bound(result.peak,0,1)*100)+'%';$('spMeter').classList.toggle('over',result.rawPeak>1&&!this.project.master.protectPeaks);}
    audioBuffer(result){const b=this.host.actx().createBuffer(result.channels.length,result.length,result.sampleRate);result.channels.forEach((samples,ch)=>b.copyToChannel(samples,ch));return b;}
    stop(){
      this.playToken=(this.playToken||0)+1;
      if(this.playing){const previous=this.playing;this.playing=null;try{previous.node.stop();}catch(e){}previous.cleanup?.();}
      cancelAnimationFrame(this.playFrame);$('spCursor').classList.add('hide');
    }
    preparePlayback(){
      this.stop();const session={token:this.playToken,context:this.host.actx()};
      // resume() is called synchronously on the Play gesture, before worker or file awaits.
      session.ready=this.activateAudio(session.context);session.ready.catch(()=>{});return session;
    }
    async activateAudio(ctx){
      if(ctx.state==='closed')throw Error(this.text('מנוע השמע נסגר. לחץ שוב על נגן.','The audio engine closed. Press Play again.'));
      let timer;
      try{
        const resume=ctx.resume();
        await Promise.race([resume,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error(this.text('הדפדפן לא הפעיל את השמע. לחץ שוב על נגן ואפשר שמע לאתר.','The browser did not activate audio. Press Play again and allow sound for this site.'))),4000);})]);
        if(ctx.state!=='running')throw Error(this.text('השמע מושהה בדפדפן. לחץ שוב על נגן.','Audio is suspended in the browser. Press Play again.'));
      }finally{clearTimeout(timer);}
    }
    startNode(node,ctx,from,to,loop,cursor,extraNodes=[]){
      node.loop=loop;node.loopStart=from;node.loopEnd=to;
      const started=ctx.currentTime,cleanup=()=>{for(const n of [node,...extraNodes])try{n.disconnect();}catch(e){}};
      this.playing={node,started,from,to,cursor,cleanup};
      node.onended=()=>{cleanup();if(this.playing?.node===node){this.playing=null;$('spCursor').classList.add('hide');}};
      try{if(loop)node.start(0,from);else node.start(0,from,to-from);}catch(e){cleanup();this.playing=null;throw e;}
      if(cursor){const tick=()=>{if(this.playing?.node!==node)return;const elapsed=ctx.currentTime-started,position=cursor.from+(loop?elapsed%(to-from):elapsed);const x=(position-this.view.start)/this.view.span;$('spCursor').classList.toggle('hide',x<0||x>1);$('spCursor').style.left=(bound(x,0,1)*100)+'%';this.playFrame=requestAnimationFrame(tick);};tick();}
    }
    async play(result,from=0,to=result.duration,loop=false,cursor=null,session=this.preparePlayback()){
      await session.ready;if(session.token!==this.playToken)return;
      const ctx=session.context;from=bound(from,0,result.duration);to=bound(to,from,result.duration);if(to-from<1/result.sampleRate)return;
      const node=ctx.createBufferSource();node.buffer=this.audioBuffer(result);node.connect(ctx.destination);this.startNode(node,ctx,from,to,loop,cursor);
    }
    async playSimpleClip(c,from,to,loop,cursor,session){
      await session.ready;if(session.token!==this.playToken)return;
      const buffer=this.buffer(c),ctx=session.context;from=bound(from,0,this.duration(c));to=bound(to,from,this.duration(c));if(to-from<1/buffer.sampleRate)return;
      // Reuse decoded PCM for unfaded previews. No worker or full-song PCM copy is needed.
      const key=c.sourceId+':'+c.in+':'+c.out;
      if(!this.previewPeaks)this.previewPeaks=new Map();
      let peak=this.previewPeaks.get(key);if(peak===undefined){peak=StudioAudio.analyze(buffer,c.in,c.out).peak;this.previewPeaks.set(key,peak);}
      const gain=Math.pow(10,(c.gainDb||0)/20),rawPeak=peak*gain,ceiling=Math.pow(10,-1/20),scale=this.project.master.protectPeaks&&rawPeak>ceiling?ceiling/rawPeak:1;
      const node=ctx.createBufferSource(),volume=ctx.createGain();node.buffer=buffer;volume.gain.value=gain*scale;node.connect(volume);volume.connect(ctx.destination);this.outputInfo({peak:rawPeak*scale,rawPeak,scale});
      this.startNode(node,ctx,c.in+from,c.in+to,loop,cursor,[volume]);
    }
    togglePlay(){
      if(this.playing){this.stop();return;}
      return this.task(async()=>{const c=this.active(),s={...this.project.selection};if(!c)return;const session=this.preparePlayback(),a=s.b>s.a?s.a:0,b=s.b>s.a?s.b:this.duration(c);
        if(!c.fadeIn&&!c.fadeOut){await this.playSimpleClip(c,a,b,this.loop,{from:a},session);return;}
        const result=await this.render([{...clone(c),join:{duration:0,curve:'linear'}}],null,false);await this.play(result,a,b,this.loop,{from:a},session);
      });
    }
    async playResult(){const session=this.preparePlayback(),result=await this.render();await this.play(result,0,result.duration,this.loop,null,session);}
    async audition(){const session=this.preparePlayback(),result=await this.render(),segment=result.segments.find(s=>s.clip.id===this.project.activeId);if(!segment)return;await this.play(result,Math.max(0,segment.start-1),Math.min(result.duration,segment.start+segment.overlap+1),true,null,session);}
    async playDonor(){const d=this.donor;if(!d)return;const session=this.preparePlayback(),clip={...this.makeClip(d.sourceId,d.name,d.in,d.out),gainDb:d.gainDb||0,fadeIn:.003,fadeOut:.003},result=await this.render([clip],null,false);await this.play(result,0,result.duration,false,null,session);}
    async exportAudio(){this.stop();$('edProg').classList.remove('hide');$('edProg').firstElementChild.style.width='10%';try{const result=await this.render(),format=$('spExportFormat').value;let blob,ext;if(format==='mp3'){if(result.channels.length>2)throw Error('MP3 supports mono/stereo only');blob=await this.host.encodeMP3(this.audioBuffer(result),p=>{$('edProg').firstElementChild.style.width=(20+p*80)+'%';},finite($('spBitrate').value,320));ext='mp3';}else{blob=new Blob([StudioAudio.encodeWav(result,{bitDepth:+format.slice(3)})],{type:'audio/wav'});ext='wav';}this.host.download(blob,this.safeName(this.project.name)+'_studio.'+ext);try{await this.host.saveAudio(blob,this.project.name);}catch(e){this.say('הקובץ יוצא, אך השמירה לספרייה נכשלה','File exported, but library save failed');throw e;}$('spStatus').textContent=this.text('יוצא ונשמר בספרייה ✓','Exported and saved to library ✓');}finally{$('edProg').classList.add('hide');}}
  }
  window.studioEditor=new Editor(window.studioHost);
})();
