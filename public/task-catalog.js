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
  return {...item,body:typeof item.body==='string'?item.body:'',assignee:item.assignee||'',due:item.due||'',status:item.status||'todo',priority:item.priority||'normal',tags:normalizeTags(item.tags),dependencies:Array.isArray(item.dependencies)?item.dependencies:[]};
}
