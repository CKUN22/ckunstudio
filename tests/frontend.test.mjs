import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {createHash} from 'node:crypto';
import {TASK_CATEGORIES,TASK_TAG_GROUPS,COMMON_TASK_TAGS,MAX_TASK_TAGS,TASK_TAGS,normalizeItem,normalizeTags,tagGroupsFor} from '../cloudflare/site/lib/task-catalog.mjs';

function browserHarness(){
 class Element{
  constructor(dataset={}){this.checkedTags=[];this.dataset=dataset;this.innerHTML='';this.textContent='';this.value='';this.fields={};this.classes=new Set();this.classList={add:name=>this.classes.add(name),remove:name=>this.classes.delete(name),toggle:(name,on)=>on?this.classes.add(name):this.classes.delete(name)};}
  addEventListener(){} querySelectorAll(selector){return selector.includes('name=tags')?this.checkedTags.map(value=>({value})):[];} querySelector(){return new Element();}
 }
 const nodes=new Map(),nav=[new Element({nav:'task'}),new Element({nav:'bug'}),new Element({nav:'idea'})],pages=[new Element({page:'work'}),new Element({page:'team'}),new Element({page:'notifications'})];
 const document={querySelector(selector){if(!nodes.has(selector))nodes.set(selector,new Element());return nodes.get(selector);},querySelectorAll(selector){return selector==='[data-nav]'?nav:selector==='[data-nav],[data-page]'?[...nav,...pages]:[];}};
 // Mirrors an old running API: both [] and JSON-encoded tag arrays, mixed legacy IDs.
 const records=[{id:'a'.repeat(32),kind:'task',title:'猫-待机状态-动画',body:'',status:'todo',assignee:'',tags:'[]',version:1,images:[]},{id:'b'.repeat(48),kind:'task',title:'猫-待机-动作',body:'',status:'todo',assignee:'',tags:'["动画"]',version:1,images:[]}];
 const fetch=async(url,options={})=>{let data;if(url==='/api/items'&&options.method==='POST'){const payload=JSON.parse(options.body);data={...payload,id:'new-task',version:1,images:[]};records.push({...data,tags:JSON.stringify(payload.tags)});}else if(url==='/api/items')data=structuredClone(records);else if(url.startsWith('/api/items/')){const item=records.find(x=>x.id===url.split('/').pop());if(!item)throw new Error('Fixture not found');if(options.method==='PUT')Object.assign(item,JSON.parse(options.body),{version:item.version+1});data=structuredClone(item);}else throw new Error('Unexpected request '+url);return {ok:true,status:200,json:async()=>data};};
 class FormData{constructor(form){this.fields=form.fields;}*[Symbol.iterator](){yield*Object.entries(this.fields);}}
 const context=vm.createContext({document,window:{addEventListener(){}},console,fetch,FormData,Date,JSON,URLSearchParams,setTimeout:()=>1,clearTimeout(){},TASK_CATEGORIES,TASK_TAG_GROUPS,COMMON_TASK_TAGS,MAX_TASK_TAGS,normalizeItem,tagGroupsFor});
 const source=readFileSync('public/app.js','utf8').replace(/^import[^\n]+\n/,'').replace('\nboot();','\n');vm.runInContext(source,context);
 return {nodes,nav,pages,records,context,run:code=>vm.runInContext(code.includes('await ')?`(async()=>{${code}})()`:code,context),document};
}

test('前端回归：旧版字符串标签不隐藏任务，主页与任务列表切换正确',async()=>{
 const ui=browserHarness();await ui.run("user={id:'member',name:'测试成员',role:'member'};users=[];items=await api('/api/items');kind='task';renderList();");
 assert.match(ui.nodes.get('#rows').innerHTML,/猫-待机状态-动画/);assert.match(ui.nodes.get('#rows').innerHTML,/猫-待机-动作/);assert.match(ui.nodes.get('#total').textContent,/显示 2 条 \/ 共 2 条/);
 ui.run('renderWork()');assert.match(ui.nodes.get('#content').innerHTML,/<h1>我的工作台<\/h1>/);assert.doesNotMatch(ui.nodes.get('#content').innerHTML,/class="toolbar"/);assert.doesNotMatch(ui.nodes.get('#content').innerHTML,/猫-待机-动作|主页任务广场|团队任务|publish-task/);assert.ok(ui.pages[0].classes.has('active'));assert.ok(!ui.nav[0].classes.has('active'));
 ui.run('renderList()');assert.match(ui.nodes.get('#content').innerHTML,/<h1>任务协作<\/h1>/);assert.ok(!ui.pages[0].classes.has('active'));assert.ok(ui.nav[0].classes.has('active'));
 ui.run("search='动画';updateList()");assert.match(ui.nodes.get('#total').textContent,/显示 2 条/);
});

test('前端回归：在旧筛选条件下创建任务后，新任务立即可见',async()=>{
 const ui=browserHarness();await ui.run("user={id:'member',name:'测试成员',role:'captain'};users=[];items=await api('/api/items');kind='task';filter='doing';search='不存在';owner='other';renderList();await openEditor();");
 ui.document.querySelector('#editor').fields={title:'新增瓦片素材',body:''};await ui.document.querySelector('#editor').onsubmit({preventDefault(){}});
 assert.equal(ui.run('filter'),'all');assert.equal(ui.run('search'),'');assert.equal(ui.run('owner'),'');assert.match(ui.nodes.get('#rows').innerHTML,/新增瓦片素材/);assert.match(ui.nodes.get('#total').textContent,/显示 3 条 \/ 共 3 条/);
});

test('素材标签：共享分类与浏览器产物一致，旧标签兼容且细分项可选择',()=>{
 assert.equal(readFileSync('public/task-catalog.js','utf8'),readFileSync('cloudflare/site/lib/task-catalog.mjs','utf8'));assert.equal(readFileSync('cloudflare/site/public/ckunstudio/task-catalog.js','utf8'),readFileSync('public/task-catalog.js','utf8'));
 for(const tag of ['程序','2D贴图','动画','音乐','音效','瓦片','背景图','视差背景','角色精灵','场景物件','图标','UI界面','字体','粒子特效','材质','环境音'])assert.ok(TASK_TAGS.includes(tag),tag);
 assert.deepEqual(normalizeTags('["动画","动画"]'),['动画']);assert.deepEqual(normalizeTags(null),[]);assert.deepEqual(normalizeTags('invalid'),[]);
 const ui=browserHarness();const markup=ui.run("tagChoices({tags:['视差背景','2D贴图']})");assert.match(markup,/更多素材标签/);assert.match(markup,/value="瓦片"/);assert.match(markup,/value="背景图"/);assert.match(markup,/value="2D贴图" checked/);assert.match(markup,/class="tag-more" open/);
});


test('发布资源回归：页面与模块使用当前内容哈希，避免旧脚本缓存',()=>{
 const hash=file=>createHash('sha256').update(readFileSync(file)).digest('hex').slice(0,12);
 const html=readFileSync('cloudflare/site/public/ckunstudio/index.html','utf8'),js=readFileSync('cloudflare/site/public/ckunstudio/app.js','utf8');
 assert.ok(html.includes('/ckunstudio/app.js?v='+hash('cloudflare/site/public/ckunstudio/app.js')));
 assert.ok(html.includes('/ckunstudio/style.css?v='+hash('public/style.css')));
 assert.ok(js.includes('./task-catalog.js?v='+hash('cloudflare/site/lib/task-catalog.mjs')));
});


for(const kind of ['bug','idea'])test(`简洁创建：${kind} 不需要分配、状态或时间`,async()=>{
 const ui=browserHarness();await ui.run(`user={id:'member',name:'测试成员',role:'member'};users=[];items=await api('/api/items');kind='${kind}';renderList();await openEditor();`);
 const html=ui.nodes.get('#content').innerHTML;assert.match(html,/name="title"/);assert.match(html,/name="body"/);assert.match(html,/name="tags"/);assert.doesNotMatch(html,/name="(?:status|assignee|due|eta|priority|progress|remaining)"/);
 if(kind==='idea')assert.doesNotMatch(html,/type="file"|图片附件|id="upload"/);else assert.match(html,/type="file"/);
 ui.document.querySelector('#editor').fields={title:kind==='bug'?'角色穿过墙壁':'跳跃玩法草案',body:'简短正文'};ui.document.querySelector('#editor').checkedTags=kind==='bug'?['碰撞/物理']:['玩法设计'];await ui.document.querySelector('#editor').onsubmit({preventDefault(){}});
 assert.equal(ui.records.at(-1).kind,kind);assert.equal(ui.records.at(-1).assignee,'');assert.equal(ui.records.at(-1).due,'');assert.ok(ui.records.at(-1).tags.includes(kind==='bug'?'碰撞/物理':'玩法设计'));
});

test('草稿列表：忽略状态和执行人分类，始终显示创建与最后修改时间',async()=>{
 const ui=browserHarness();ui.records.push({id:'idea-old',kind:'idea',title:'已完成状态的旧草稿',body:'旧正文',tags:'[]',status:'done',assignee:'other',priority:'high',due:'2026-12-31',version:1,images:['/api/images/history'],created:'2026-11-01T01:02:03Z',updated:'2026-11-12T04:05:06Z'});
 await ui.run("user={id:'member',role:'member'};users=[];items=await api('/api/items');kind='idea';filter='doing';owner='nobody';renderList();");const html=ui.nodes.get('#content').innerHTML;
 assert.doesNotMatch(html,/状态筛选|data-filter|id="owner"|id="stats"/);assert.match(html,/创建时间/);assert.match(html,/最后修改时间/);assert.match(ui.nodes.get('#rows').innerHTML,/已完成状态的旧草稿/);assert.match(ui.nodes.get('#rows').innerHTML,/2026-11-01T01:02:03Z/);assert.match(ui.nodes.get('#rows').innerHTML,/2026-11-12T04:05:06Z/);assert.equal(ui.nodes.get('#count-idea').textContent,1);
 await ui.run("await openEditor('idea-old');");assert.doesNotMatch(ui.nodes.get('#content').innerHTML,/name="status"|name="assignee"/);ui.document.querySelector('#editor').fields={title:'旧草稿改名',body:'修改后正文'};await ui.document.querySelector('#editor').onsubmit({preventDefault(){}});
 const saved=ui.records.find(x=>x.id==='idea-old');assert.equal(saved.created,'2026-11-01T01:02:03Z');assert.equal(saved.status,'done');assert.equal(saved.assignee,'other');assert.equal(saved.body,'修改后正文');assert.deepEqual(Array.from(saved.keepImages),['/api/images/history']);
});

test('主页只包含四个个人工作区，未认领团队任务不显示',async()=>{
 const ui=browserHarness();await ui.run("user={id:'member',role:'member'};users=[];items=await api('/api/items');renderWork();");const html=ui.nodes.get('#content').innerHTML;
 for(const label of ['我负责的','等待他人的','即将到期','已逾期'])assert.ok(html.includes(label));assert.equal((html.match(/class="work-section"/g)||[]).length,4);assert.doesNotMatch(html,/task-pool|pool-card|团队任务|publish-task/);
});


test('任务与 BUG 显示认领和本人取消入口，其他成员及草稿没有取消按钮',()=>{
 const ui=browserHarness();ui.run("user={id:'member',role:'member'};users=[];");
 for(const kind of ['task','bug']){
  const open=ui.run(`claimButton({id:'sample',kind:'${kind}',status:'doing',assignee:''})`);assert.match(open,/data-claim="sample"/);assert.ok(open.includes(kind==='task'?'认领任务':'认领BUG'));
  assert.match(ui.run(`claimButton({id:'sample',kind:'${kind}',status:'doing',assignee:'member'})`),/data-release="true".*取消认领/);
  assert.equal(ui.run(`claimButton({id:'sample',kind:'${kind}',status:'doing',assignee:'other'})`),'');assert.equal(ui.run(`claimButton({id:'sample',kind:'${kind}',status:'done',assignee:'member'})`),'');
 }
 assert.equal(ui.run("claimButton({id:'idea',kind:'idea',status:'todo',assignee:''})"),'');
 assert.equal(ui.run("ownerClass({assignee:'member',assigneeColor:1})"),'owner-color-1');assert.equal(ui.run("ownerClass({assignee:'',assigneeColor:null})"),'');
 const bug=ui.run("kind='bug';editing={id:'sample'};editorMeta({id:'sample',kind:'bug',assignee:'member',status:'doing',tags:[],priority:'normal',due:''})");assert.match(bug,/取消认领/);assert.match(bug,/type="hidden" name="assignee"/);assert.doesNotMatch(bug,/<select name="assignee"/);
});

test('慢网络切页：团队立即展示、请求并行且合并，离开后不被旧响应拉回',async()=>{
 const ui=browserHarness();ui.run(`user={id:'captain',role:'captain'};users=[];items=[];globalThis.calls=[];globalThis.pending={};api=url=>{calls.push(url);return new Promise(resolve=>pending[url]=resolve);};`);
 const opening=ui.run('await showTeam()');await Promise.resolve();
 assert.match(ui.nodes.get('#content').innerHTML,/<h1>团队管理<\/h1>/);
 assert.deepEqual(Array.from(ui.run('calls')),['/api/users','/api/invites']);
 const repeated=ui.run('await showTeam()');await Promise.resolve();assert.equal(ui.run('calls.length'),2);
 ui.run("renderWork();pending['/api/users']([{id:'captain',name:'队长'}]);pending['/api/invites']([])");await Promise.all([opening,repeated]);
 assert.equal(ui.run('page'),'work');assert.match(ui.nodes.get('#content').innerHTML,/我的工作台/);
 await ui.run('await showTeam()');assert.equal(ui.run('calls.length'),2);assert.match(ui.nodes.get('#content').innerHTML,/队长/);
 const forced=ui.run('await showTeam(true)');await Promise.resolve();assert.equal(ui.run('calls.length'),4);ui.run("pending['/api/users']([]);pending['/api/invites']([])");await forced;
});

test('慢网络通知：立即展示、合并请求、缓存复用，后台响应不打断导航',async()=>{
 const ui=browserHarness();ui.run(`user={id:'member',role:'member'};globalThis.calls=0;globalThis.resolveNotice=null;api=()=>{calls++;return new Promise(resolve=>resolveNotice=resolve);};`);
 const opening=ui.run('await showNotifications()');assert.match(ui.nodes.get('#content').innerHTML,/<h1>通知中心<\/h1>/);
 const repeated=ui.run('await showNotifications()');assert.equal(ui.run('calls'),1);
 ui.run("renderWork();resolveNotice([{id:'n1',title:'新通知',item_id:'x',created:'2026-11-13',read_at:''}])");await Promise.all([opening,repeated]);assert.equal(ui.run('page'),'work');
 await ui.run('await showNotifications()');assert.equal(ui.run('calls'),1);assert.match(ui.nodes.get('#content').innerHTML,/新通知/);
 const forced=ui.run('await loadNotifications(true)');assert.equal(ui.run('calls'),2);ui.run('resolveNotice([])');await forced;assert.equal(ui.run('notifications.length'),0);
});

for(const moduleKind of ['task','bug','idea'])test(`分页：${moduleKind} 每页20条，筛选回首页，同步和详情返回保留页码`,async()=>{
 const ui=browserHarness();ui.records.splice(0);for(let i=0;i<45;i++)ui.records.push({id:String(i).padStart(32,'0'),kind:moduleKind,title:'条目-'+i,body:'正文',category:i<25?'地图':'角色',tags:[],status:'todo',assignee:'',version:1,images:[]});
 await ui.run(`user={id:'member',role:'member'};users=[];items=await api('/api/items');kind='${moduleKind}';renderList();`);
 const count=()=> (ui.nodes.get('#rows').innerHTML.match(/data-id=/g)||[]).length;
 assert.equal(count(),20);ui.run('listPage=2;updateList()');assert.equal(count(),20);assert.match(ui.nodes.get('#rows').innerHTML,/打开 条目-20/);assert.doesNotMatch(ui.nodes.get('#rows').innerHTML,/打开 条目-0"/);
 ui.run('updateList()');assert.equal(ui.run('listPage'),2);await ui.run("await openEditor('00000000000000000000000000000020');returnFromEditor();");assert.equal(ui.run('listPage'),2);
 ui.run('listPage=3;updateList()');assert.equal(count(),5);assert.match(ui.nodes.get('#pagination').innerHTML,/data-list-page="4" disabled/);
 ui.nodes.get('#search').oninput({target:{value:'条目-44'}});assert.equal(ui.run('listPage'),1);assert.equal(count(),1);
 ui.nodes.get('#search').oninput({target:{value:'不存在'}});assert.equal(count(),0);assert.match(ui.nodes.get('#pagination').innerHTML,/1 \/ 1/);
 ui.nodes.get('#search').oninput({target:{value:''}});ui.run('listPage=3;items=items.slice(0,20);updateList()');assert.equal(ui.run('listPage'),1);assert.equal(count(),20);
});
test('任务分类：筛选独立于素材标签，编辑可更改且保留分类',async()=>{
 const ui=browserHarness();await ui.run("user={id:'member',role:'member'};users=[];items=[normalizeItem({id:'role',kind:'task',title:'主角动作-待机',tags:['动画'],status:'todo',images:[]}),normalizeItem({id:'map',kind:'task',title:'关卡-map1',tags:['瓦片'],status:'todo',images:[]})];kind='task';categoryFilter='地图';renderList();");
 assert.match(ui.nodes.get('#rows').innerHTML,/关卡-map1/);assert.doesNotMatch(ui.nodes.get('#rows').innerHTML,/主角动作/);assert.match(ui.nodes.get('#content').innerHTML,/任务分类筛选/);
 await ui.run('await openEditor()');assert.match(ui.nodes.get('#content').innerHTML,/name="category"/);assert.match(ui.nodes.get('#content').innerHTML,/value="地图" selected/);
});
