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
    p.run('state.user={id:"me",username:"synthetic",display_name:"Synthetic"};state.view="settings";state.settings={};state.providers=[];render()');
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
    assert.equal(p.dom.window.document.querySelectorAll('nav button').length,6);
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

test('curations and visual workflow editor render canvas, nodes, inspector, and approval gates', async()=>{
  const p=await page();
  try {
    // 1. Navigate to curations
    await p.run('navigate("curations")');
    assert.match(p.dom.window.document.querySelector('#app').textContent, /Curadorias/);
    assert.match(p.dom.window.document.querySelector('#app').textContent, /Novo Projeto/);

    // 2. Set active curation with workflow
    p.run(`
      state.curations = [{
        id: "cur-1",
        title: "Sertão Cósmico",
        editorial_model: "escuta-e-imagem-v2",
        dramaturgia: "transe_espiral",
        status: "draft",
        workflow: {
          version: 1,
          steps: [
            { id: "step_1", kind: "briefing", label: "Briefing", role_function: "briefing", model_alias: "rda/reasoning", position: { x: 100, y: 150 } },
            { id: "step_2", kind: "approval_gate", label: "Publicação", role_function: "synthesis", requires_approval: true, position: { x: 340, y: 150 } }
          ],
          edges: [
            { id: "e1", source: "step_1", target: "step_2" }
          ]
        }
      }];
      state.activeCuration = state.curations[0];
      state.curationsTab = "workflow";
      state.workflowSelectedStep = state.activeCuration.workflow.steps[0];
      render();
    `);

    // Verify canvas rendered
    const canvas = p.dom.window.document.querySelector('.workflow-canvas-svg');
    assert.ok(canvas, "Canvas SVG must be present");
    const nodes = p.dom.window.document.querySelectorAll('.workflow-node');
    assert.equal(nodes.length, 2, "2 workflow step nodes must be rendered");
    assert.match(p.dom.window.document.querySelector('#app').textContent, /rda\/reasoning/);

    // Verify property inspector
    assert.match(p.dom.window.document.querySelector('.workflow-inspector').textContent, /Editar: Briefing/);

    // Verify accessible list mode toggle
    p.run('state.workflowMode = "list"; render();');
    assert.ok(p.dom.window.document.querySelector('.workflow-list-container'), "Accessible list container must be rendered");
    assert.match(p.dom.window.document.querySelector('.workflow-list-container').textContent, /Modo Acessível/);

    // Verify human approval gate banner
    p.run(`
      state.workflowExecution = {
        status: "awaiting_approval",
        pending_approval: {
          step_id: "step_2",
          approval_id: "app-1",
          action_type: "publish_curation",
          payload_hash: "hash_canonical_123456"
        }
      };
      render();
    `);
    const banner = p.dom.window.document.querySelector('.approval-gate-banner');
    assert.ok(banner, "Approval gate banner must be present");
    assert.match(banner.textContent, /Confirmação Humana Obrigatória/);
    assert.match(banner.textContent, /hash_canonical_123456/);
  }finally{p.dom.window.close();}
});

test('RDA Design System canonical classes, tokens, and data attributes are genuinely utilized across the UI', async()=>{
  const p = await page();
  try {
    // 1. App Shell and Layout structure
    const shell = p.dom.window.document.querySelector('.rda-app-shell');
    assert.ok(shell, "Root shell must use rda-app-shell");
    assert.equal(shell.getAttribute('data-layout'), 'console', "App shell must use console layout");

    const sidebar = p.dom.window.document.querySelector('.rda-app-shell__sidebar.rda-sidebar');
    assert.ok(sidebar, "Sidebar must use rda-app-shell__sidebar and rda-sidebar");

    const main = p.dom.window.document.querySelector('.rda-app-shell__main');
    assert.ok(main, "Workspace must use rda-app-shell__main");

    const header = p.dom.window.document.querySelector('.rda-app-shell__header');
    assert.ok(header, "Header must use rda-app-shell__header");

    const content = p.dom.window.document.querySelector('.rda-app-shell__content');
    assert.ok(content, "Content area must use rda-app-shell__content");

    // 2. Sidebar Navigation Items
    const navItems = p.dom.window.document.querySelectorAll('.rda-sidebar__item');
    assert.ok(navItems.length >= 6, "Sidebar items must use rda-sidebar__item");
    const activeItem = p.dom.window.document.querySelector('.rda-sidebar__item--active');
    assert.ok(activeItem, "Active navigation item must have rda-sidebar__item--active");

    // 3. RDA Buttons with data-color and data-style
    const buttons = p.dom.window.document.querySelectorAll('.rda-button');
    assert.ok(buttons.length > 5, "Buttons must genuinely use rda-button");
    const primaryButton = Array.from(buttons).find(b => b.getAttribute('data-color') === 'primary');
    assert.ok(primaryButton, "RDA button with data-color='primary' must be present");

    // 4. Segmented Controls on tabbed views
    p.run('state.view="library"; state.playlists=[]; render();');
    const segmentedControl = p.dom.window.document.querySelector('.rda-segmented-control');
    assert.ok(segmentedControl, "Library tabs must use rda-segmented-control");
    const activeSegment = segmentedControl.querySelector('.rda-segmented-control__item[aria-pressed="true"]');
    assert.ok(activeSegment, "Active tab must have rda-segmented-control__item[aria-pressed='true']");

    // 5. RDA Cards & Badges in Curations
    p.run(`
      state.curations = [{
        id: "cur-1",
        title: "Sertão Cósmico",
        editorial_model: "escuta-e-imagem-v2",
        dramaturgia: "transe_espiral",
        status: "draft"
      }];
      state.view = "curations";
      state.curationsTab = "projects";
      render();
    `);
    const card = p.dom.window.document.querySelector('.curation-card.rda-card');
    assert.ok(card, "Curation card must use rda-card");
    const badges = p.dom.window.document.querySelectorAll('.rda-badge');
    assert.ok(badges.length >= 1, "RDA badges must be rendered");

    // 6. RDA Form Fields and Inputs
    p.run('state.view="settings"; state.settings={}; state.providers=[]; render();');
    const formFields = p.dom.window.document.querySelectorAll('.rda-form-field');
    assert.ok(formFields.length >= 2, "Settings must render rda-form-field");
    const rdaInputs = p.dom.window.document.querySelectorAll('.rda-input, .rda-select__field, .rda-textarea__field');
    assert.ok(rdaInputs.length >= 2, "Inputs must use rda-input / rda-select__field / rda-textarea__field");
  } finally {
    p.dom.window.close();
  }
});
