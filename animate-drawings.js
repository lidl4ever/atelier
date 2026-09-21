'use strict';

/*
 * Atelier Lab
 * - Camera images are processed locally; no image leaves the device.
 * - A lightweight matte separates marks from paper.
 * - Characters get an automatic skeleton (drawing-rig.js); press and hold to drag joints.
 * - Anything the rig can't read falls back to whole-drawing or ribbon motion, never an error.
 */
(() => {
  const lab = document.querySelector('#magicLab');
  const openButton = document.querySelector('#animateBtn');
  if (!lab || !openButton) return;

  const els = {
    back: document.querySelector('#magicBack'),
    close: document.querySelector('#magicClose'),
    error: document.querySelector('#magicError'),
    source: document.querySelector('#magicSourceView'),
    camera: document.querySelector('#magicCameraView'),
    processing: document.querySelector('#magicProcessingView'),
    play: document.querySelector('#magicPlayView'),
    actions: document.querySelector('#magicActions'),
    cameraSource: document.querySelector('#magicCameraSource'),
    canvasSource: document.querySelector('#magicCanvasSource'),
    video: document.querySelector('#magicVideo'),
    shutter: document.querySelector('#magicShutter'),
    file: document.querySelector('#magicFile'),
    stage: document.querySelector('#magicStage'),
  };
  const views = {
    source: els.source,
    camera: els.camera,
    processing: els.processing,
    play: els.play,
  };
  const stageContext = els.stage.getContext('2d', {alpha:false, desynchronized:true}) || els.stage.getContext('2d');
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const state = {
    view: 'source',
    stream: null,
    frame: 0,
    lastFrame: 0,
    scene: null,
    previousFocus: null,
    press: null,
    audio: null,
  };

  function setView(name){
    state.view = name;
    Object.entries(views).forEach(([key, view]) => { view.hidden = key !== name; });
    els.back.hidden = name === 'source';
    els.actions.hidden = name !== 'play';
  }

  function clearError(){ els.error.textContent = ''; }

  function showError(message){
    stopCamera();
    stopAnimation();
    setView('source');
    els.error.textContent = message;
  }

  function openLab(){
    state.previousFocus = document.activeElement;
    clearError();
    setView('source');
    lab.classList.add('is-open');
    lab.setAttribute('aria-hidden','false');
    document.querySelectorAll('.panel.show').forEach(panel => panel.classList.remove('show'));
    requestAnimationFrame(() => els.close.focus());
  }

  function closeLab(){
    stopCamera();
    stopAnimation();
    lab.classList.remove('is-open');
    lab.setAttribute('aria-hidden','true');
    disposeScene();
    if (state.previousFocus && document.contains(state.previousFocus)) state.previousFocus.focus();
  }

  function disposeScene(){
    const world = state.scene;
    if (world) world.actors.forEach(actor => { if (actor.rig) actor.rig.renderer.dispose(); });
    state.scene = null;
    state.press = null;
  }

  function goBack(){
    stopCamera();
    stopAnimation();
    disposeScene();
    clearError();
    setView('source');
  }

  async function startCamera(){
    clearError();
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia){
      showError('這個瀏覽器無法直接開啟相機；請使用「選擇照片」，或以 HTTPS 開啟 Atelier。');
      return;
    }
    setView('camera');
    try{
      stopCamera();
      const stream = await navigator.mediaDevices.getUserMedia({
        audio:false,
        video:{
          facingMode:{ideal:'environment'},
          width:{ideal:1920},
          height:{ideal:1440},
        },
      });
      if (state.view !== 'camera'){
        stream.getTracks().forEach(track => track.stop());
        return;
      }
      state.stream = stream;
      els.video.srcObject = stream;
      await els.video.play();
    }catch(error){
      console.warn('Atelier camera unavailable', error);
      showError('沒有取得相機畫面。你可以允許相機權限後重試，或直接選擇一張照片。');
    }
  }

  function stopCamera(){
    if (state.stream){
      state.stream.getTracks().forEach(track => track.stop());
      state.stream = null;
    }
    els.video.pause();
    els.video.srcObject = null;
  }

  function limitedCanvas(width, height, maxSide=1400){
    const scale = Math.min(1, maxSide / Math.max(width, height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    return canvas;
  }

  function captureCamera(){
    const videoWidth = els.video.videoWidth;
    const videoHeight = els.video.videoHeight;
    if (!videoWidth || !videoHeight){
      showError('相機還在準備中，請稍等一下再拍。');
      return;
    }
    // Map the visible guide through object-fit: cover back into video pixels.
    const elementWidth=els.video.clientWidth || videoWidth;
    const elementHeight=els.video.clientHeight || videoHeight;
    const coverScale=Math.max(elementWidth/videoWidth,elementHeight/videoHeight);
    const coverOffsetX=(videoWidth*coverScale-elementWidth)/2;
    const coverOffsetY=(videoHeight*coverScale-elementHeight)/2;
    const sx = (coverOffsetX+elementWidth*.07)/coverScale;
    const sy = (coverOffsetY+elementHeight*.11)/coverScale;
    const sw = elementWidth*.86/coverScale;
    const sh = elementHeight*.74/coverScale;
    const photo = limitedCanvas(sw, sh);
    photo.getContext('2d', {willReadFrequently:true}).drawImage(
      els.video, sx, sy, sw, sh, 0, 0, photo.width, photo.height
    );
    stopCamera();
    processCameraPhoto(photo);
  }

  async function loadPhoto(file){
    if (!file) return;
    stopCamera();
    setView('processing');
    try{
      const decoded = await decodePhoto(file);
      const photo = limitedCanvas(decoded.width, decoded.height);
      try{
        photo.getContext('2d', {willReadFrequently:true}).drawImage(decoded.image,0,0,photo.width,photo.height);
      }finally{
        decoded.release();
      }
      await processCameraPhoto(photo);
    }catch(error){
      console.warn('Atelier photo decode failed', error);
      showError('無法讀取這張照片，請換一張再試。');
    }finally{
      els.file.value = '';
    }
  }

  async function decodePhoto(file){
    if (typeof createImageBitmap === 'function'){
      const bitmap=await createImageBitmap(file,{imageOrientation:'from-image'});
      return {image:bitmap,width:bitmap.width,height:bitmap.height,release:()=>bitmap.close && bitmap.close()};
    }
    const url=URL.createObjectURL(file);
    try{
      const image=await new Promise((resolve,reject)=>{
        const candidate=new Image();
        candidate.onload=()=>resolve(candidate);
        candidate.onerror=reject;
        candidate.src=url;
      });
      return {image,width:image.naturalWidth,height:image.naturalHeight,release:()=>URL.revokeObjectURL(url)};
    }catch(error){
      URL.revokeObjectURL(url);
      throw error;
    }
  }

  function compositeVisibleInk(){
    if (typeof S === 'undefined' || !S.doc) return null;
    const doc = S.doc;
    const ink = document.createElement('canvas');
    ink.width = doc.w;
    ink.height = doc.h;
    const context = ink.getContext('2d', {willReadFrequently:true});
    doc.layers.forEach(layer => {
      if (!layer.visible) return;
      context.globalAlpha = layer.opacity;
      context.drawImage(layer.canvas,0,0);
    });
    context.globalAlpha = 1;
    return ink;
  }

  function makePaperBackground(width, height, color){
    const background = limitedCanvas(width,height);
    const context = background.getContext('2d');
    context.fillStyle = color || '#FBF8F1';
    context.fillRect(0,0,background.width,background.height);
    // A quiet fiber pattern keeps the animated scene feeling like the original sheet.
    context.globalAlpha = .035;
    context.fillStyle = '#3b352b';
    const step = Math.max(4, Math.round(background.width / 220));
    for (let y=step; y<background.height; y+=step){
      for (let x=(y/step%2)*step; x<background.width; x+=step*2){
        if (((x*13+y*17) % 11) < 2) context.fillRect(x,y,1,1);
      }
    }
    context.globalAlpha = 1;
    return background;
  }

  async function processCurrentDrawing(){
    clearError();
    const ink = compositeVisibleInk();
    if (!ink){
      showError('請先開啟一張作品，再讓它動起來。');
      return;
    }
    setView('processing');
    await nextPaint();
    const paper = (S.doc.paper && S.doc.paper.tone) || '#FBF8F1';
    const background = makePaperBackground(ink.width,ink.height,paper);
    try{
      buildScene(ink,background,'canvas');
    }catch(error){
      console.warn('Atelier drawing animation failed', error);
      showError(error.message || '目前畫布上還沒有足夠的線條可以喚醒。');
    }
  }

  function nextPaint(){
    return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }

  async function processCameraPhoto(photo){
    setView('processing');
    await nextPaint();
    try{
      const separated = separateInkFromPaper(photo);
      buildScene(separated.ink,separated.background,'camera');
    }catch(error){
      console.warn('Atelier paper separation failed', error);
      showError(error.message || '沒有找到清楚的筆跡。請靠近一點，並讓紙張平均受光。');
    }
  }

  function median(values){
    values.sort((a,b) => a-b);
    return values[Math.floor(values.length/2)] || 245;
  }

  function estimatePaper(data,width,height){
    const red=[];
    const green=[];
    const blue=[];
    const edge = Math.max(2, Math.round(Math.min(width,height)*.055));
    const step = Math.max(2,Math.round(Math.min(width,height)/180));
    for (let y=0; y<height; y+=step){
      for (let x=0; x<width; x+=step){
        if (x>edge && x<width-edge && y>edge && y<height-edge) continue;
        const i=(y*width+x)*4;
        red.push(data[i]); green.push(data[i+1]); blue.push(data[i+2]);
      }
    }
    return [median(red),median(green),median(blue)];
  }

  function smoothstep(low,high,value){
    const t = Math.max(0,Math.min(1,(value-low)/(high-low)));
    return t*t*(3-2*t);
  }

  function separateInkFromPaper(photo){
    const width=photo.width;
    const height=photo.height;
    const sourceContext=photo.getContext('2d',{willReadFrequently:true});
    const source=sourceContext.getImageData(0,0,width,height);
    const [br,bg,bb]=estimatePaper(source.data,width,height);
    const paperLuma=br*.2126+bg*.7152+bb*.0722;
    const ink=document.createElement('canvas');
    ink.width=width; ink.height=height;
    const inkContext=ink.getContext('2d',{willReadFrequently:true});
    const inkData=inkContext.createImageData(width,height);
    const background=document.createElement('canvas');
    background.width=width; background.height=height;
    const backgroundContext=background.getContext('2d',{willReadFrequently:true});
    const clean=backgroundContext.createImageData(width,height);
    let confidentPixels=0;
    for (let i=0; i<source.data.length; i+=4){
      const r=source.data[i], g=source.data[i+1], b=source.data[i+2];
      const luma=r*.2126+g*.7152+b*.0722;
      const colorDistance=Math.hypot(r-br,g-bg,b-bb);
      const darkening=Math.max(0,paperLuma-luma);
      const score=colorDistance+darkening*.72;
      const alpha=smoothstep(20,76,score);
      inkData.data[i]=r;
      inkData.data[i+1]=g;
      inkData.data[i+2]=b;
      inkData.data[i+3]=Math.round(alpha*255);
      if (alpha>.36) confidentPixels++;
      const repair=alpha*.97;
      clean.data[i]=Math.round(r*(1-repair)+br*repair);
      clean.data[i+1]=Math.round(g*(1-repair)+bg*repair);
      clean.data[i+2]=Math.round(b*(1-repair)+bb*repair);
      clean.data[i+3]=255;
    }
    const minimum=Math.max(80,width*height*.00018);
    if (confidentPixels<minimum) throw new Error('沒有找到清楚的筆跡。請讓紙張填滿框線，並避免強烈陰影。');
    inkContext.putImageData(inkData,0,0);
    backgroundContext.putImageData(clean,0,0);
    return {ink,background};
  }

  function trimForeground(source){
    const context=source.getContext('2d',{willReadFrequently:true});
    const {data}=context.getImageData(0,0,source.width,source.height);
    let left=source.width, top=source.height, right=-1, bottom=-1, count=0;
    for (let y=0; y<source.height; y++){
      for (let x=0; x<source.width; x++){
        if (data[(y*source.width+x)*4+3]<22) continue;
        count++;
        if (x<left) left=x;
        if (x>right) right=x;
        if (y<top) top=y;
        if (y>bottom) bottom=y;
      }
    }
    if (count<60 || right<left || bottom<top) throw new Error('目前還沒有足夠的筆跡可以喚醒。先畫一個角色或幾條大膽的線吧。');
    const pad=Math.max(4,Math.round(Math.max(right-left,bottom-top)*.035));
    left=Math.max(0,left-pad); top=Math.max(0,top-pad);
    right=Math.min(source.width-1,right+pad); bottom=Math.min(source.height-1,bottom+pad);
    const sprite=document.createElement('canvas');
    sprite.width=right-left+1;
    sprite.height=bottom-top+1;
    sprite.getContext('2d').drawImage(source,left,top,sprite.width,sprite.height,0,0,sprite.width,sprite.height);
    return {sprite,count};
  }

  function analyseLines(sprite){
    const size=72;
    const sample=document.createElement('canvas');
    sample.width=size; sample.height=size;
    const context=sample.getContext('2d',{willReadFrequently:true});
    context.drawImage(sprite,0,0,size,size);
    const data=context.getImageData(0,0,size,size).data;
    const filled=new Uint8Array(size*size);
    let total=0;
    for (let i=0; i<filled.length; i++){
      if (data[i*4+3]>12){ filled[i]=1; total++; }
    }
    const seen=new Uint8Array(filled.length);
    const queue=new Int32Array(filled.length);
    const components=[];
    for (let start=0; start<filled.length; start++){
      if (!filled[start] || seen[start]) continue;
      let head=0,tail=0,componentSize=0;
      queue[tail++]=start; seen[start]=1;
      while (head<tail){
        const index=queue[head++]; componentSize++;
        const x=index%size, y=(index/size)|0;
        const neighbours=[index-1,index+1,index-size,index+size];
        for (let n=0;n<4;n++){
          const next=neighbours[n];
          if (next<0 || next>=filled.length || seen[next] || !filled[next]) continue;
          if (n===0 && x===0 || n===1 && x===size-1 || n===2 && y===0 || n===3 && y===size-1) continue;
          seen[next]=1; queue[tail++]=next;
        }
      }
      if (componentSize>1) components.push(componentSize);
    }
    components.sort((a,b)=>b-a);
    const dominance=total ? (components[0]||0)/total : 0;
    const meaningful=components.filter(value=>value>Math.max(2,total*.012)).length;
    const occupancy=total/(size*size);
    const kind=dominance>.44 && meaningful<=12 && occupancy<.62 ? 'character' : 'abstract';
    return {kind,dominance,meaningful,occupancy};
  }

  function scaleBackground(source,maxSide=1400){
    const output=limitedCanvas(source.width,source.height,maxSide);
    output.getContext('2d').drawImage(source,0,0,output.width,output.height);
    return output;
  }

  // Split a drawing into separate characters. Marks close together (eyes, buttons)
  // join their body; big separate groups become their own actor; small leftovers
  // (a sun, some grass) stay painted on the paper.
  function splitCharacters(source){
    const W=source.width, H=source.height;
    const cell=Math.max(W,H)/160;
    const gw=Math.ceil(W/cell), gh=Math.ceil(H/cell);
    const data=source.getContext('2d',{willReadFrequently:true}).getImageData(0,0,W,H).data;
    const ink=new Uint8Array(gw*gh);
    for (let y=0;y<H;y++){
      const row=((y/cell)|0)*gw;
      for (let x=0;x<W;x++) if (data[(y*W+x)*4+3]>8) ink[row+((x/cell)|0)]=1;
    }
    const reach=Math.max(1,Math.round(Math.max(gw,gh)*.012));
    const grown=new Uint8Array(gw*gh);
    for (let i=0;i<ink.length;i++){
      if (!ink[i]) continue;
      const cx=i%gw, cy=(i/gw)|0;
      for (let y=Math.max(0,cy-reach);y<=Math.min(gh-1,cy+reach);y++)
        for (let x=Math.max(0,cx-reach);x<=Math.min(gw-1,cx+reach);x++) grown[y*gw+x]=1;
    }
    const label=new Int32Array(gw*gh).fill(-1);
    const queue=new Int32Array(gw*gh);
    const groups=[];
    for (let start=0;start<grown.length;start++){
      if (!grown[start] || label[start]>=0) continue;
      const group={id:groups.length,area:0,minX:gw,minY:gh,maxX:-1,maxY:-1};
      let head=0,tail=0;
      queue[tail++]=start; label[start]=group.id;
      while (head<tail){
        const i=queue[head++], x=i%gw, y=(i/gw)|0;
        if (ink[i]){
          group.area++;
          group.minX=Math.min(group.minX,x); group.maxX=Math.max(group.maxX,x);
          group.minY=Math.min(group.minY,y); group.maxY=Math.max(group.maxY,y);
        }
        if (x>0 && grown[i-1] && label[i-1]<0){ label[i-1]=group.id; queue[tail++]=i-1; }
        if (x<gw-1 && grown[i+1] && label[i+1]<0){ label[i+1]=group.id; queue[tail++]=i+1; }
        if (y>0 && grown[i-gw] && label[i-gw]<0){ label[i-gw]=group.id; queue[tail++]=i-gw; }
        if (y<gh-1 && grown[i+gw] && label[i+gw]<0){ label[i+gw]=group.id; queue[tail++]=i+gw; }
      }
      groups.push(group);
    }
    groups.sort((a,b)=>b.area-a.area);
    const biggest=groups.length?groups[0].area:0;
    const chosen=groups.filter(g=>g.area>=biggest*.18 && g.area>=24).slice(0,4);
    if (chosen.length<2) return null;

    const slot=new Int32Array(groups.length+1).fill(-1);
    chosen.forEach((g,k)=>{
      slot[g.id]=k;
      const pad=4;
      g.left=Math.max(0,Math.floor(g.minX*cell)-pad);
      g.top=Math.max(0,Math.floor(g.minY*cell)-pad);
      g.width=Math.min(W,Math.ceil((g.maxX+1)*cell)+pad)-g.left;
      g.height=Math.min(H,Math.ceil((g.maxY+1)*cell)+pad)-g.top;
      g.pixels=new ImageData(g.width,g.height);
    });
    const props=new ImageData(W,H);
    for (let y=0;y<H;y++){
      const row=((y/cell)|0)*gw;
      for (let x=0;x<W;x++){
        const i=(y*W+x)*4;
        if (!data[i+3]) continue;
        const id=label[row+((x/cell)|0)];
        const k=id>=0?slot[id]:-1;
        const g=k>=0?chosen[k]:null;
        let out=props.data, o=i;
        if (g && x>=g.left && y>=g.top && x<g.left+g.width && y<g.top+g.height){
          out=g.pixels.data; o=((y-g.top)*g.width+(x-g.left))*4;
        }
        out[o]=data[i]; out[o+1]=data[i+1]; out[o+2]=data[i+2]; out[o+3]=data[i+3];
      }
    }
    const propsCanvas=document.createElement('canvas');
    propsCanvas.width=W; propsCanvas.height=H;
    propsCanvas.getContext('2d').putImageData(props,0,0);
    return {
      props:propsCanvas,
      actors:chosen.map(g=>{
        const sprite=document.createElement('canvas');
        sprite.width=g.width; sprite.height=g.height;
        sprite.getContext('2d').putImageData(g.pixels,0,0);
        return {sprite,x:g.left+g.width/2,y:g.top+g.height/2};
      }),
    };
  }

  // Actors inherit the world (size, background, chosen action) through their
  // prototype and keep their own position, sprite, skeleton and moods.
  function makeActor(world,sprite,x,y){
    const analysis=analyseLines(sprite);
    // The skeleton gets the first say: two or more limbs means it's a character,
    // even when thin or faint lines made the connectivity test call it abstract.
    let rig=buildRig(sprite);
    if (rig && rig.leafCount>=2) analysis.kind='character';
    else if (rig && analysis.kind!=='character'){ rig.renderer.dispose(); rig=null; }
    const actor=Object.create(world);
    const heading=Math.random()<.5?-1:1;
    // Which way the drawing looks: a head left of the body means it faces left,
    // so it gets mirrored the other way and never walks backwards.
    const head=rig && rig.bones.find(bone=>bone.role==='head');
    const facing=head && head.tip.x<rig.joints[0].x-rig.W*.05 ? -1 : 1;
    return Object.assign(actor,{
      sprite,
      facing,
      kind:analysis.kind,
      rig,
      editing:false,
      popAt:-1e9,
      surpriseAction:'walk',
      surpriseAt:0,
      x, y,
      vx:heading*world.width*.085,
      vy:world.height*.045,
      direction:heading,
      target:null,
      seed:Math.random()*1000,
      greetUntil:0,
      parting:false,
    });
  }

  function buildScene(foreground,background,sourceType){
    const sceneForeground=scaleBackground(foreground);
    const sceneBackground=scaleBackground(background);
    const world={
      width:sceneBackground.width,
      height:sceneBackground.height,
      background:sceneBackground,
      sourceType,
      action:'surprise',
      actors:[],
      hearts:[],
      visitAt:0,
    };
    state.scene=world;
    const split=splitCharacters(sceneForeground);
    if (split){
      sceneBackground.getContext('2d').drawImage(split.props,0,0);
      world.actors=split.actors.map(a=>makeActor(world,a.sprite,a.x,a.y));
      const tallest=Math.max(...world.actors.map(a=>a.sprite.height));
      const widest=Math.max(...world.actors.map(a=>a.sprite.width));
      const scale=Math.min(1.6,world.height*.46/tallest,world.width*.3/widest);
      world.actors.forEach(actor=>sizeActor(actor,scale));
    }else{
      const trimmed=trimForeground(sceneForeground);
      const actor=makeActor(world,trimmed.sprite,world.width*.5,world.height*.64);
      const widthLimit=actor.kind==='character'?.34:.52;
      const heightLimit=actor.kind==='character'?.48:.58;
      sizeActor(actor,Math.min(world.width*widthLimit/actor.sprite.width,world.height*heightLimit/actor.sprite.height,1.8));
      world.actors=[actor];
    }
    els.stage.width=world.width;
    els.stage.height=world.height;
    updateActionButtons();
    setView('play');
    startAnimation();
  }

  function sizeActor(actor,scale){
    actor.drawWidth=Math.max(28,actor.sprite.width*scale);
    actor.drawHeight=Math.max(28,actor.sprite.height*scale);
    if (actor.rig) window.AtelierRig.setScale(actor.rig,actor.drawWidth/actor.sprite.width);
    actor.x=Math.max(actor.drawWidth*.55,Math.min(actor.width-actor.drawWidth*.55,actor.x));
    actor.y=Math.max(actor.drawHeight*.55,Math.min(actor.height-actor.drawHeight*.55,actor.y));
  }

  function buildRig(sprite){
    if (!window.AtelierRig) return null;
    try{
      const rig=window.AtelierRig.build(sprite);
      if (rig && rig.limbCount>0) return rig;
      if (rig) rig.renderer.dispose();
    }catch(error){
      console.warn('Atelier rig failed', error);
    }
    return null;
  }

  function updateActionButtons(){
    const scene=state.scene;
    if (!scene) return;
    els.actions.querySelectorAll('[data-action]').forEach(button => {
      const active=button.dataset.action===scene.action;
      button.classList.toggle('is-active',active);
      button.setAttribute('aria-pressed',active?'true':'false');
    });
  }

  function selectAction(action){
    const world=state.scene;
    if (!world) return;
    world.action=action;
    world.actors.forEach(actor=>{
      actor.target=null;
      actor.surpriseAt=0;
      if (action==='walk' || action==='hop') actor.vx=(actor.direction||1)*world.width*.085;
    });
    updateActionButtons();
  }

  function activeAction(scene,time){
    if (scene.action!=='surprise') return scene.action;
    if (time>=scene.surpriseAt){
      const options=['walk','hop','dance','float'].filter(item=>item!==scene.surpriseAction);
      scene.surpriseAction=options[Math.floor(Math.random()*options.length)];
      scene.surpriseAt=time+3200+Math.random()*2600;
    }
    return scene.surpriseAction;
  }

  function keepInBounds(scene){
    const halfW=scene.drawWidth*.55;
    const halfH=scene.drawHeight*.55;
    if (scene.x<halfW){ scene.x=halfW; scene.vx=Math.abs(scene.vx); }
    if (scene.x>scene.width-halfW){ scene.x=scene.width-halfW; scene.vx=-Math.abs(scene.vx); }
    if (scene.y<halfH){ scene.y=halfH; scene.vy=Math.abs(scene.vy); }
    if (scene.y>scene.height-halfH){ scene.y=scene.height-halfH; scene.vy=-Math.abs(scene.vy); }
    if (Math.abs(scene.vx)>1) scene.direction=scene.vx<0?-1:1;
  }

  function updateScene(scene,action,time,delta){
    const motionScale=reduceMotion?.28:1;
    const halfH=scene.drawHeight*.5;
    const floor=scene.height-halfH-scene.height*.055;
    if (scene.target && (action==='walk' || action==='hop' || action==='float')){
      const dx=scene.target.x-scene.x;
      const dy=scene.target.y-scene.y;
      const distance=Math.hypot(dx,dy);
      if (distance<scene.width*.018) scene.target=null;
      else{
        const speed=scene.width*(action==='float'?.07:.105)*motionScale;
        scene.vx=dx/distance*speed;
        if (action==='float') scene.vy=dy/distance*speed;
      }
    }
    if (action==='walk'){
      scene.x+=scene.vx*delta*motionScale;
      scene.y+=(floor-scene.y)*Math.min(1,delta*7);
    }else if (action==='hop'){
      scene.x+=scene.vx*delta*.72*motionScale;
      const jump=Math.abs(Math.sin(time*.0042))*scene.height*.14*motionScale;
      scene.y+=(floor-jump-scene.y)*Math.min(1,delta*11);
    }else if (action==='float'){
      scene.x+=scene.vx*delta*motionScale;
      scene.y+=scene.vy*delta*motionScale;
    }else if (action==='dance'){
      scene.y+=(scene.height*.58-scene.y)*Math.min(1,delta*4);
    }
    keepInBounds(scene);
  }

  function drawShadow(context,scene,action,time){
    if (action==='float') return;
    const jump=action==='hop'?Math.abs(Math.sin(time*.0042)):0;
    context.save();
    context.globalAlpha=.13*(1-jump*.5);
    context.filter=`blur(${Math.max(2,scene.width*.004)}px)`;
    context.fillStyle='#28251f';
    context.beginPath();
    context.ellipse(scene.x,Math.min(scene.height*.94,scene.y+scene.drawHeight*.48),scene.drawWidth*.34*(1-jump*.22),scene.drawHeight*.055,0,0,Math.PI*2);
    context.fill();
    context.restore();
  }

  function popOffset(scene,time){
    const t=(time-scene.popAt)/620;
    return t>=0 && t<1 ? Math.sin(Math.PI*t)*scene.drawHeight*.22 : 0;
  }

  function drawCharacter(context,scene,action,time){
    const phase=time*.006+scene.seed;
    const amount=reduceMotion?.24:1;
    const squash=scene.rig?.5:1;
    let bob=0,rotation=0,scaleX=1,scaleY=1;
    if (scene.editing){
      // Rest pose so the joints line up with the drawing.
    }else if (action==='walk'){
      bob=Math.abs(Math.sin(phase*1.35))*scene.drawHeight*.022*amount;
      rotation=Math.sin(phase*.68)*.025*amount;
      scaleX=1+Math.sin(phase*1.35)*.018*amount*squash;
      scaleY=1-Math.sin(phase*1.35)*.018*amount*squash;
    }else if (action==='hop'){
      rotation=Math.sin(phase*.7)*.045*amount;
      scaleX=1+Math.sin(phase)*.045*amount*squash;
      scaleY=1-Math.sin(phase)*.045*amount*squash;
    }else if (action==='dance'){
      bob=Math.abs(Math.sin(phase*1.6))*scene.drawHeight*.045*amount;
      rotation=Math.sin(phase*.95)*.12*amount*squash;
      scaleX=1+Math.sin(phase*1.9)*.055*amount*squash;
      scaleY=1-Math.sin(phase*1.9)*.035*amount*squash;
    }else if (action==='float'){
      bob=Math.sin(phase*.55)*scene.drawHeight*.035*amount;
      rotation=Math.sin(phase*.36)*.07*amount;
    }else if (action==='wave'){
      bob=Math.abs(Math.sin(time*.009))*scene.drawHeight*.03*amount;
      rotation=(scene.rig?0:Math.sin(time*.012)*.06)*amount;
    }
    if (!scene.editing) bob+=popOffset(scene,time);
    drawShadow(context,scene,action,time);
    context.save();
    context.translate(scene.x,scene.y-bob);
    context.rotate(rotation);
    context.scale(scene.direction*scene.facing*scaleX,scaleY);
    if (scene.rig){
      const rig=scene.rig;
      const angles=scene.editing ? new Float32Array(rig.bones.length) : window.AtelierRig.pose(rig,action,time,reduceMotion?.35:1);
      const out=window.AtelierRig.render(rig,angles);
      const s=scene.drawWidth/scene.sprite.width;
      context.drawImage(out.canvas,(-rig.W/2-out.pad)*s,(-rig.H/2-out.pad)*s,(rig.W+out.pad*2)*s,(rig.H+out.pad*2)*s);
    }else{
      context.drawImage(scene.sprite,-scene.drawWidth/2,-scene.drawHeight/2,scene.drawWidth,scene.drawHeight);
    }
    context.restore();
    if (scene.editing) drawJoints(context,scene);
  }

  function jointToStage(scene,joint){
    const s=scene.drawWidth/scene.sprite.width;
    return {x:scene.x+scene.direction*scene.facing*(joint.x-scene.sprite.width/2)*s, y:scene.y+(joint.y-scene.sprite.height/2)*s};
  }

  function stageToSprite(scene,point){
    const s=scene.drawWidth/scene.sprite.width;
    return {x:(point.x-scene.x)*scene.direction*scene.facing/s+scene.sprite.width/2, y:(point.y-scene.y)/s+scene.sprite.height/2};
  }

  function drawJoints(context,scene){
    const rig=scene.rig;
    const unit=stageUnit();
    context.save();
    context.lineCap='round';
    context.strokeStyle='rgba(255,255,255,.85)';
    context.lineWidth=5*unit;
    rig.bones.forEach((bone,index)=>{
      if (!index) return;
      const a=jointToStage(scene,rig.joints[bone.a]), b=jointToStage(scene,rig.joints[bone.b]);
      context.beginPath(); context.moveTo(a.x,a.y); context.lineTo(b.x,b.y); context.stroke();
    });
    context.strokeStyle='rgba(224,120,60,.9)';
    context.lineWidth=2.5*unit;
    rig.bones.forEach((bone,index)=>{
      if (!index) return;
      const a=jointToStage(scene,rig.joints[bone.a]), b=jointToStage(scene,rig.joints[bone.b]);
      context.beginPath(); context.moveTo(a.x,a.y); context.lineTo(b.x,b.y); context.stroke();
    });
    rig.joints.forEach((joint,index)=>{
      const p=jointToStage(scene,joint);
      const active=state.press && state.press.joint===index;
      context.beginPath();
      context.arc(p.x,p.y,(active?13:index?10:7)*unit,0,Math.PI*2);
      context.fillStyle=index?'#ff8a3d':'rgba(255,255,255,.9)';
      context.fill();
      context.lineWidth=3*unit;
      context.strokeStyle='#fff';
      context.stroke();
    });
    context.restore();
  }

  // Stage pixels per CSS pixel.
  function stageUnit(){
    const rect=els.stage.getBoundingClientRect();
    return rect.width ? els.stage.width/rect.width : 1;
  }

  // Thin overlapping strips with a smooth wave: neighbours differ by a fraction of a
  // pixel, so lines bend like cloth instead of breaking into steps.
  function drawAbstract(context,scene,action,time){
    const phase=time*.004+scene.seed;
    const amount=reduceMotion?.2:1;
    const strips=Math.max(24,Math.min(90,Math.round(scene.drawWidth/6)));
    const sourceWidth=scene.sprite.width/strips;
    const stripWidth=scene.drawWidth/strips;
    const pop=popOffset(scene,time);
    const rotation=action==='dance'?Math.sin(phase*.8)*.09*amount:0;
    const waveHeight=scene.drawHeight*(action==='dance'?.065:.032)*amount;
    drawShadow(context,scene,action,time);
    context.save();
    context.translate(scene.x,scene.y-pop);
    context.rotate(rotation);
    for (let i=0;i<strips;i++){
      const u=(i+.5)/strips;
      const wave=Math.sin(phase*1.25+u*7.2)*waveHeight;
      const sway=Math.cos(phase*.83+u*4.8)*scene.drawWidth*.022*amount;
      const stretch=1+Math.sin(phase*.9+u*5.5)*.035*amount;
      context.drawImage(
        scene.sprite,
        i*sourceWidth,0,sourceWidth+1,scene.sprite.height,
        -scene.drawWidth/2+i*stripWidth+sway,-scene.drawHeight*stretch/2+wave,
        stripWidth+1,scene.drawHeight*stretch
      );
    }
    context.restore();
  }

  function drawSparkles(context,scene,time){
    if (scene.action!=='surprise' || reduceMotion) return;
    context.save();
    context.fillStyle='rgba(201,174,61,.72)';
    for (let i=0;i<5;i++){
      const angle=time*.00055+i*1.7+scene.seed;
      const radius=scene.drawWidth*(.56+i*.035);
      const x=scene.x+Math.cos(angle)*radius;
      const y=scene.y+Math.sin(angle*1.23)*scene.drawHeight*.62;
      const size=2+(i%3);
      context.translate(x,y);
      context.rotate(angle);
      context.fillRect(-size*.5,-size*2,size,size*4);
      context.fillRect(-size*2,-size*.5,size*4,size);
      context.setTransform(1,0,0,1,0,0);
    }
    context.restore();
  }

  // Characters notice each other: they meet and wave with a floating heart,
  // politely bump instead of walking through each other, and visit friends.
  function interact(world,time){
    const actors=world.actors;
    for (let i=0;i<actors.length;i++) for (let j=i+1;j<actors.length;j++){
      const a=actors[i], b=actors[j];
      if (a.editing || b.editing) continue;
      const dx=b.x-a.x, dy=b.y-a.y;
      const reach=(a.drawWidth+b.drawWidth)*.5;
      const level=Math.abs(dy)<(a.drawHeight+b.drawHeight)*.35;
      if (level && Math.abs(dx)<reach*1.15 && world.action!=='dance' &&
          time>a.greetUntil+5000 && time>b.greetUntil+5000){
        a.greetUntil=b.greetUntil=time+1700;
        a.direction=dx>=0?1:-1; b.direction=-a.direction;
        a.vx=a.direction*.5; b.vx=b.direction*.5;
        a.target=b.target=null;
        a.parting=b.parting=true;
        world.hearts.push({x:(a.x+b.x)/2,y:Math.min(a.y-a.drawHeight*.5,b.y-b.drawHeight*.5),born:time});
        chime();
      }
      const overlap=reach*.62-Math.abs(dx);
      if (level && overlap>0){
        const push=Math.min(overlap*.5,world.width*.004)*(dx>=0?1:-1);
        a.x-=push; b.x+=push;
      }
    }
    for (const actor of actors){
      if (actor.parting && time>=actor.greetUntil){
        actor.parting=false;
        actor.vx=-actor.direction*world.width*.085;   // wave goodbye, walk on
      }
    }
    if (world.action==='dance' && actors.length>1){
      const center=actors.reduce((sum,a)=>sum+a.x,0)/actors.length;
      actors.forEach(a=>{ a.vx=(center>=a.x?1:-1)*.5; });   // dance facing each other
    }
    if (actors.length>1 && time>world.visitAt){
      world.visitAt=time+4500+Math.random()*4000;
      if (world.visitAt>0 && world.action!=='dance'){
        const visitor=actors[Math.floor(Math.random()*actors.length)];
        const friends=actors.filter(a=>a!==visitor);
        const friend=friends[Math.floor(Math.random()*friends.length)];
        if (!visitor.editing && time>visitor.greetUntil) visitor.target={x:friend.x,y:friend.y};
      }
    }
  }

  function drawHearts(context,world,time){
    world.hearts=world.hearts.filter(h=>time-h.born<1600);
    for (const h of world.hearts){
      const t=(time-h.born)/1600;
      const s=world.width*.03*(.6+t*.6);
      context.save();
      context.globalAlpha=Math.min(1,(1-t)*1.6);
      context.translate(h.x+Math.sin(t*7)*s*.3,h.y-t*world.height*.09);
      context.fillStyle='#ec6a74';
      context.beginPath();
      context.moveTo(0,s*.35);
      context.bezierCurveTo(-s*.1,s*.2,-s*.5,s*.15,-s*.5,-s*.1);
      context.bezierCurveTo(-s*.5,-s*.4,-s*.1,-s*.45,0,-s*.2);
      context.bezierCurveTo(s*.1,-s*.45,s*.5,-s*.4,s*.5,-s*.1);
      context.bezierCurveTo(s*.5,s*.15,s*.1,s*.2,0,s*.35);
      context.fill();
      context.restore();
    }
  }

  function actorAction(actor,time){
    return time<actor.greetUntil ? 'wave' : activeAction(actor,time);
  }

  function drawFrame(time){
    const world=state.scene;
    if (!world || state.view!=='play') return;
    const delta=state.lastFrame?Math.min(.05,(time-state.lastFrame)/1000):0;
    state.lastFrame=time;
    for (const actor of world.actors){
      actor.current=actorAction(actor,time);
      updateScene(actor,actor.current,time,delta);
    }
    interact(world,time);
    stageContext.setTransform(1,0,0,1,0,0);
    stageContext.globalAlpha=1;
    stageContext.filter='none';
    stageContext.drawImage(world.background,0,0,world.width,world.height);
    const byDepth=[...world.actors].sort((a,b)=>(a.y+a.drawHeight/2)-(b.y+b.drawHeight/2));
    for (const actor of byDepth){
      if (actor.kind==='character') drawCharacter(stageContext,actor,actor.current,time);
      else drawAbstract(stageContext,actor,actor.current,time);
    }
    drawHearts(stageContext,world,time);
    world.actors.forEach(actor=>drawSparkles(stageContext,actor,time));
    state.frame=requestAnimationFrame(drawFrame);
  }

  function startAnimation(){
    stopAnimation();
    state.lastFrame=0;
    state.frame=requestAnimationFrame(drawFrame);
  }

  function stopAnimation(){
    if (state.frame) cancelAnimationFrame(state.frame);
    state.frame=0;
    state.lastFrame=0;
  }

  function stagePoint(event){
    const rect=els.stage.getBoundingClientRect();
    const scene=state.scene;
    return {x:(event.clientX-rect.left)/rect.width*scene.width, y:(event.clientY-rect.top)/rect.height*scene.height};
  }

  function onCharacter(scene,point){
    const local=stageToSprite(scene,point);
    if (scene.rig) return window.AtelierRig.maskAt(scene.rig,local.x,local.y);
    return local.x>=0 && local.y>=0 && local.x<=scene.sprite.width && local.y<=scene.sprite.height;
  }

  function nearestJoint(scene,point){
    const reach=26*stageUnit();
    let best=-1,bestDistance=reach;
    scene.rig.joints.forEach((joint,index)=>{
      if (!index) return;
      const p=jointToStage(scene,joint);
      const d=Math.hypot(p.x-point.x,p.y-point.y);
      if (d<bestDistance){ best=index; bestDistance=d; }
    });
    return best;
  }

  function setEditing(scene,on){
    scene.editing=on;
    clearTimeout(scene.editTimer);
  }

  function scheduleEditExit(scene){
    clearTimeout(scene.editTimer);
    scene.editTimer=setTimeout(()=>setEditing(scene,false),1600);
  }

  function tone(from,peak,to,length,volume=.2,type='sine'){
    try{
      const Audio=window.AudioContext||window.webkitAudioContext;
      if (!Audio) return;
      state.audio=state.audio||new Audio();
      const ctx=state.audio, t=ctx.currentTime;
      if (ctx.state==='suspended') ctx.resume();
      const osc=ctx.createOscillator(), gain=ctx.createGain();
      osc.type=type;
      osc.frequency.setValueAtTime(from,t);
      osc.frequency.exponentialRampToValueAtTime(peak,t+length*.35);
      osc.frequency.exponentialRampToValueAtTime(to,t+length*.85);
      gain.gain.setValueAtTime(.0001,t);
      gain.gain.exponentialRampToValueAtTime(volume,t+.02);
      gain.gain.exponentialRampToValueAtTime(.0001,t+length);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t); osc.stop(t+length+.02);
    }catch(error){ /* sound is optional */ }
  }

  function boing(){ tone(300,760,430,.34); }
  function chime(){ tone(880,1320,1180,.28,.12,'triangle'); setTimeout(()=>tone(1180,1560,1400,.3,.1,'triangle'),140); }

  function actorAt(point){
    const world=state.scene;
    const front=[...world.actors].sort((a,b)=>(b.y+b.drawHeight/2)-(a.y+a.drawHeight/2));
    return front.find(actor=>onCharacter(actor,point)) || null;
  }

  function stageDown(event){
    const world=state.scene;
    if (!world) return;
    const point=stagePoint(event);
    els.stage.setPointerCapture(event.pointerId);
    const press={id:event.pointerId,start:point,moved:false,joint:-1,timer:0,actor:null};
    state.press=press;
    const editing=world.actors.find(actor=>actor.editing);
    if (editing){
      press.actor=editing;
      press.joint=nearestJoint(editing,point);
      if (press.joint>0) clearTimeout(editing.editTimer);
      return;
    }
    const actor=actorAt(point);
    press.actor=actor;
    if (actor && actor.rig){
      // Press and hold a character to reveal its joints.
      press.timer=setTimeout(()=>{
        if (state.press!==press || press.moved) return;
        setEditing(actor,true);
        press.joint=nearestJoint(actor,press.start);
        press.held=true;
      },480);
    }
  }

  function stageMove(event){
    const press=state.press;
    if (!state.scene || !press || press.id!==event.pointerId) return;
    const point=stagePoint(event);
    if (Math.hypot(point.x-press.start.x,point.y-press.start.y)>12*stageUnit()) press.moved=true;
    const actor=press.actor;
    if (actor && actor.editing && press.joint>0){
      const local=stageToSprite(actor,point);
      window.AtelierRig.moveJoint(actor.rig,press.joint,local.x,local.y);
    }
  }

  function stageUp(event){
    const world=state.scene, press=state.press;
    if (!world || !press || press.id!==event.pointerId) return;
    clearTimeout(press.timer);
    state.press=null;
    const point=stagePoint(event);
    const actor=press.actor;
    if (actor && actor.editing){
      if (press.joint>0 && press.moved){ window.AtelierRig.refresh(actor.rig); scheduleEditExit(actor); }
      else if (press.held) scheduleEditExit(actor);
      else if (press.joint<0) setEditing(actor,false);
      else scheduleEditExit(actor);
      return;
    }
    if (press.moved) return;
    const now=performance.now();
    if (actor){
      // One hops, and its friends hop along right after.
      actor.popAt=now;
      boing();
      world.actors.filter(other=>other!==actor).forEach((other,index)=>{ other.popAt=now+200+index*130; });
      return;
    }
    if (world.action==='dance') selectAction('walk');
    const spread=world.actors.reduce((sum,a)=>sum+a.drawWidth,0)/world.actors.length*.9;
    world.actors.forEach((a,index)=>{
      a.target={x:point.x+(index-(world.actors.length-1)/2)*spread,y:point.y};
    });
  }

  openButton.addEventListener('click',openLab);
  els.close.addEventListener('click',closeLab);
  els.back.addEventListener('click',goBack);
  els.cameraSource.addEventListener('click',startCamera);
  els.canvasSource.addEventListener('click',processCurrentDrawing);
  els.shutter.addEventListener('click',captureCamera);
  els.file.addEventListener('change',event=>loadPhoto(event.target.files && event.target.files[0]));
  els.stage.addEventListener('pointerdown',stageDown);
  els.stage.addEventListener('pointermove',stageMove);
  els.stage.addEventListener('pointerup',stageUp);
  els.stage.addEventListener('pointercancel',stageUp);
  els.stage.addEventListener('contextmenu',event=>event.preventDefault());
  els.actions.addEventListener('click',event=>{
    const button=event.target.closest('[data-action]');
    if (button) selectAction(button.dataset.action);
  });
  document.addEventListener('keydown',event=>{
    if (event.key==='Escape' && lab.classList.contains('is-open')) closeLab();
  });
  document.addEventListener('visibilitychange',()=>{
    if (document.hidden && lab.classList.contains('is-open')) stopCamera();
  });
})();
