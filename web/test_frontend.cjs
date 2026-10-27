const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const source = fs.readFileSync(__dirname + '/dist/app.js', 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));

test('RDA login replaces registration and existing accounts have an explicit linking action', async()=>{
  const p=await page();
  try {
    p.run('state.user=null;state.sso={enabled:true};state.authMode="register";render()');
    assert.match(p.dom.window.document.querySelector('#app').textContent, /Entrar com RDA/);
    assert(![...p.dom.window.document.querySelectorAll('button')].some(b=>b.textContent==='Criar conta'));
    assert.match(p.dom.window.document.querySelector('#app').textContent, /vincule sua conta RDA em Ajustes/);
    p.run('state.user={id:"me"};state.view="settings";state.settings={};state.providers=[];render()');
    assert.match(p.dom.window.document.querySelector('#app').textContent, /Vincular conta RDA/);
    p.run('state.ssoLinked=true;render()');
    assert(![...p.dom.window.document.querySelectorAll('button')].some(b=>b.textContent==='Vincular conta RDA'));
  }finally{p.dom.window.close();}
});

async function page() {
  const dom = new JSDOM('<div id="app"></div><div id="notifications"></div><dialog id="modal"></dialog>', {url:'http://localhost/', runScripts:'outside-only'});
  const requests = [];
  dom.window.TextDecoder = TextDecoder;
  dom.window.AbortController = AbortController;
  dom.window.HTMLDialogElement.prototype.showModal = function(){this.open=true;};
  dom.window.HTMLDialogElement.prototype.close = function(){this.open=false;};
  dom.window.fetch = async (url, options={}) => {
    requests.push({url, ...options});
    const data = url === '/api/me' ? {error:'login_required'} : url === '/api/proposals' ? {proposals:[]} : url === '/api/conversations' ? {conversations:[]} : {ok:true};
    return {ok:url!=='/api/me',status:url==='/api/me'?401:200,json:async()=>data};
  };
  const context = dom.getInternalVMContext();
  vm.runInContext(source, context);
  await tick();
  vm.runInContext('state.user={id:"me",display_name:"Teste",username:"test"}; state.status={spotify:{authenticated:true}}; render();', context);
  return {dom, requests, run:code=>vm.runInContext(code,context)};
}

test('review has no stray zero and all sections are available', async()=>{
  const p=await page();
  try {
    const review=p.dom.window.document.querySelector('.review');
    assert(!Array.from(review.childNodes).some(n=>n.nodeType===3&&n.textContent==='0'));
    assert.equal(p.dom.window.document.querySelectorAll('nav button').length,5);
  }finally{p.dom.window.close();}
});

test('playlist names and agent messages render as text, never executable HTML', async()=>{
  const p=await page();
  try {
    p.run('state.messages=[{role:"assistant",content:"<img src=x onerror=alert(1)>"}]; render();');
    const body=p.dom.window.document.querySelector('.message-text');
    assert.equal(body.querySelectorAll('img').length,0);
    assert.match(body.textContent, /<img/);
  }finally{p.dom.window.close();}
});

test('draft preserves duplicate counts and keyboard order controls', async()=>{
  const p=await page();
  try {
    p.run('newDraft(); state.draft.tracks=[{uri:"spotify:track:a",name:"A"},{uri:"spotify:track:b",name:"B"},{uri:"spotify:track:a",name:"A"}]; renderReview();');
    assert.equal(p.run('duplicateCount(state.draft.tracks)'),1);
    p.dom.window.document.querySelector('button[aria-label="Mover B para cima"]').click();
    await tick();
    assert.equal(p.run('state.draft.tracks[0].name'),'B');
    assert.equal(p.run('diffCounts([{uri:"a"},{uri:"a"}],[{uri:"a"}]).remove'),1);
    assert.equal(p.run('diffCounts([{uri:"a"},{uri:"b"}],[{uri:"b"},{uri:"a"}]).add'),0);
  }finally{p.dom.window.close();}
});

test('proposal preview never approves until the explicit approve button is clicked', async()=>{
  const p=await page();
  try {
    await p.run('reviewProposal({proposalId:"proposal-id",name:"create_playlist",args:{name:"Test",tracks:[]}})');
    assert.equal(p.requests.filter(r=>r.url.includes('/proposals/')).length,0);
    const approve=[...p.dom.window.document.querySelectorAll('#modal button')].find(b=>b.textContent==='Aprovar alteração');
    assert(approve);
    approve.click(); await tick();
    const request=p.requests.find(r=>r.url==='/api/proposals/proposal-id');
    assert.equal(JSON.parse(request.body).decision,'approve');
  }finally{p.dom.window.close();}
});

test('stop sends a cancellation to the server before dropping the stream', async()=>{
  const p=await page();
  try {
    p.run('state.conversation="conversation-id";state.controller=new AbortController();');
    await p.run('stopChat()');
    assert.equal(JSON.parse(p.requests.find(r=>r.url==='/api/chat/cancel').body).conversation_id,'conversation-id');
    assert.equal(p.run('state.controller.signal.aborted'),true);
  }finally{p.dom.window.close();}
});

test('unchanged proposal polling preserves the draft input and focus', async()=>{
  const p=await page();
  try {
    p.run('newDraft()');
    const input=p.dom.window.document.querySelector('.draft-fields input');
    input.focus();
    await p.run('refreshProposals()');
    assert.equal(p.dom.window.document.querySelector('.draft-fields input'),input);
    assert.equal(p.dom.window.document.activeElement,input);
  }finally{p.dom.window.close();}
});

test('chat reads fragmented SSE including UTF-8 and keeps the final answer', async()=>{
  const p=await page();
  try {
    const fallback=p.dom.window.fetch;
    p.dom.window.fetch=async(url,options)=>{
      if(url!=='/api/chat')return fallback(url,options);
      const data=new TextEncoder().encode('event: status\ndata: {"status":"thinking"}\n\nevent: stream\ndata: {"delta":"Olá, música!"}\n\nevent: done\ndata: {"sessionId":"conversation-id","suggestions":[]}\n\n');
      return {ok:true,body:new ReadableStream({start(controller){for(let i=0;i<data.length;i+=3)controller.enqueue(data.slice(i,i+3));controller.close();}})};
    };
    p.run('state.conversation="conversation-id"');
    await p.run('sendMessage("Teste do streaming")');
    assert.equal(p.run('state.messages[1].content'),'Olá, música!');
    assert.equal(p.run('state.messages[1].interrupted'),undefined);
    assert.equal(p.run('state.streaming'),false);
    assert.match(p.dom.window.document.querySelector('.message.assistant').textContent,/Olá, música!/);
  }finally{p.dom.window.close();}
});
