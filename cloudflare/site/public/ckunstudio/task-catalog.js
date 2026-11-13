export const TASK_CATEGORIES = ['角色','地图','物品','机制'];
export function inferTaskCategory(title=''){
 if(/^(?:主角动作|商人动作|木乃伊动作|单只猫动作|角色)-/.test(title))return '角色';
 if(/^(?:关卡|地图)-|^map\d+$/i.test(title))return '地图';
 if(/^(?:道具|物品)-/.test(title))return '物品';
 return '机制';
}
// Shared catalog for local API, Cloudflare API and generated browser modules.
// Taxonomy references: https://itch.io/game-assets and https://kenney.nl/assets
export const TASK_TAG_GROUPS = [
  ['开发与关卡', ['程序', '关卡设计', '测试']],
  ['2D 素材', ['2D贴图', '瓦片', '背景图', '视差背景', '角色精灵', '角色立绘', '场景物件', '道具/物品', '图标', 'UI界面', '字体']],
  ['动画与特效', ['动画', '精灵图集', '骨骼动画', '粒子特效', '着色器']],
  ['3D 素材', ['3D模型', '材质', '骨骼绑定']],
  ['声音', ['音乐', '音效', '环境音', '配音']]
];
export const TASK_TAGS = TASK_TAG_GROUPS.flatMap(([,tags])=>tags);
export const COMMON_TASK_TAGS = ['程序','瓦片','背景图','角色精灵','动画','UI界面','音乐','音效'];
export const MAX_TASK_TAGS = 8;
export function normalizeTags(value){
  if(typeof value==='string'){try{value=JSON.parse(value);}catch{value=[];}}
  return Array.isArray(value)?[...new Set(value.filter(tag=>typeof tag==='string'&&tag.trim()))]:[];
}
export function normalizeItem(item){
  return {...item,category:item.kind==='task'?(TASK_CATEGORIES.includes(item.category)?item.category:inferTaskCategory(item.title)):'',body:typeof item.body==='string'?item.body:'',assignee:item.assignee||'',due:item.due||'',status:item.status||'todo',priority:item.priority||'normal',tags:normalizeTags(item.tags),dependencies:Array.isArray(item.dependencies)?item.dependencies:[]};
}

export const BUG_TAG_GROUPS = [
  ['问题类型', ['逻辑错误','碰撞/物理','显示异常','界面交互','动画异常','音频异常','性能问题','崩溃/卡死','输入控制','存档/读档','网络同步','兼容性']]
];
export const IDEA_TAG_GROUPS = [
  ['草稿标签', ['玩法设计','剧情设定','关卡构思','角色设定','美术参考','音频灵感','系统机制','数值平衡','交互体验','技术方案','待验证','随手记录']]
];
export function tagGroupsFor(kind){return kind==='bug'?BUG_TAG_GROUPS:kind==='idea'?IDEA_TAG_GROUPS:TASK_TAG_GROUPS;}
export function tagsFor(kind){return tagGroupsFor(kind).flatMap(([,tags])=>tags);}
