import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {createHash} from 'node:crypto';
import {TASK_TAG_GROUPS,COMMON_TASK_TAGS,MAX_TASK_TAGS,TASK_TAGS,normalizeItem,normalizeTags} from '../cloudflare/site/lib/task-catalog.mjs';

function browserHarness(){
 class Element{
  constructor(dataset={}){this.dataset=dataset;this.innerHTML='';this.textContent='';this.value='';this.fields={};this.classes=new Set();this.classList={add:name=>this.classes.add(name),remove:name=>this.classes.delete(name),toggle:(name,on)=>on?this.classes.add(name):this.classes.delete(name)};}
  addEventListener(){} querySelectorAll(){return [];} querySelector(){return new Element();}
 }
 const nodes=new Map(),nav=[new Element({nav:'task'}),new Element({nav:'bug'}),new Element({nav:'idea'})],pages=[new Element({page:'work'}),new Element({page:'team'}),new Element({page:'notifications'})];
 const document={querySelector(selector){if(!nodes.has(selector))nodes.set(selector,new Element());return nodes.get(selector);},querySelectorAll(selector){return selector==='[data-nav]'?nav:selector==='[data-nav],[data-page]'?[...nav,...pages]:[];}};
 // Mirrors an old running API: both [] and JSON-encoded tag arrays, mixed legacy IDs.
 const records=[{id:'a'.repeat(32),kind:'task',title:'猫-待机状态-动画',body:'',status:'todo',assignee:'',tags:'[]',version:1,images:[]},{id:'b'.repeat(48),kind:'task',title:'猫-待机-动作',body:'',status:'todo',assignee:'',tags:'["动画"]',version:1,images:[]}];
 const fetch=async(url,options={})=>{let data;if(url==='/api/items'&&options.method==='POST'){const payload=JSON.parse(options.body);data={...payload,id:'new-task',version:1,images:[]};records.push({...data,tags:JSON.stringify(payload.tags)});}else if(url==='/api/items')data=structuredClone(records);else throw new Error('Unexpected request '+url);return {ok:true,status:200,json:async()=>data};};
 class FormData{constructor(form){this.fields=form.fields;}*[Symbol.iterator](){yield*Object.entries(this.fields);}}
 const context=vm.createContext({document,window:{addEventListener(){}},console,fetch,FormData,Date,JSON,URLSearchParams,setTimeout:()=>1,clearTimeout(){},TASK_TAG_GROUPS,COMMON_TASK_TAGS,MAX_TASK_TAGS,normalizeItem});
 const source=readFileSync('public/app.js','utf8').replace(/^import[^\n]+\n/,'').replace('\nboot();','\n');vm.runInContext(source,context);
 return {nodes,nav,pages,context,run:code=>vm.runInContext(code.includes('await ')?`(async()=>{${code}})()`:code,context),document};
}

test('前端回归：旧版字符串标签不隐藏任务，主页与任务列表切换正确',async()=>{
 const ui=browserHarness();await ui.run("user={id:'member',name:'测试成员',role:'member'};users=[];items=await api('/api/items');kind='task';renderList();");
 assert.match(ui.nodes.get('#rows').innerHTML,/猫-待机状态-动画/);assert.match(ui.nodes.get('#rows').innerHTML,/猫-待机-动作/);assert.match(ui.nodes.get('#total').textContent,/显示 2 条 \/ 共 2 条/);
 ui.run('renderWork()');assert.match(ui.nodes.get('#content').innerHTML,/<h1>任务广场<\/h1>/);assert.doesNotMatch(ui.nodes.get('#content').innerHTML,/class="toolbar"/);assert.match(ui.nodes.get('#content').innerHTML,/猫-待机-动作/);assert.ok(ui.pages[0].classes.has('active'));assert.ok(!ui.nav[0].classes.has('active'));
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
