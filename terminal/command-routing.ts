// Classifies ownership only. Expansion and execution of skills/templates/extensions
// stay in Pi's dispatcher; this is not a second skill/template parser.
export const localCommands=[{name:'help',description:'工作台帮助 · 本地执行'},{name:'copy',description:'复制完整的最新 Kepos 回答 · 本地执行'},{name:'reload',description:'真正重载 Pi 扩展，保留会话和草稿'},{name:'model',description:'选择主模型 · 本地对话框'},{name:'new',description:'新建会话 · 本地对话框'},{name:'tasks',description:'查看子任务 · 本地执行'},{name:'pi',description:'进入 Pi 命令行 · 本地执行'},{name:'settings',description:'在 Kepos 中打开设置菜单'},{name:'login',description:'在 Kepos 中打开登录流程'}];
const native=new Set(['settings','login','logout','resume','session','tree','fork','clone','compact','export','share','hotkeys','name','quit','exit','config','theme']);
export type CommandRoute={kind:'chat'|'local'|'registered'|'native'|'unknown';name?:string;text:string;source?:string};
export function routeCommand(text:string,commands:{name:string;source?:string}[]):CommandRoute{
 if(text.startsWith('//'))return{kind:'chat',text:text.slice(1)};
 if(!text.startsWith('/'))return{kind:'chat',text};
 const name=text.slice(1).split(/\s/,1)[0];
 if(['help','copy','reload','model','new','tasks','pi'].includes(name))return{kind:'local',name,text};
 const registered=commands.find(c=>c.name===name);if(registered)return{kind:'registered',name,text,source:registered.source};
 if(native.has(name))return{kind:'native',name,text};
 return{kind:'unknown',name,text};
}
