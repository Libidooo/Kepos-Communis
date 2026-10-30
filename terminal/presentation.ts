export const PRODUCT_NAME='Kepos Communis';
export const PRODUCT_SHORT='Kepos';
export function sessionUsage(entries:any[]){let estimatedCost=0,input=0,output=0,cacheRead=0;for(const entry of entries){const m=entry.message;const u=entry.type==='usage'?entry.usage:m&&['assistant','toolResult'].includes(m.role)?m.usage:undefined;if(!u)continue;estimatedCost+=Number(u.cost?.total)||0;input+=Number(u.input)||0;output+=Number(u.output)||0;cacheRead+=Number(u.cacheRead)||0;}return{estimatedCost,input,output,cacheRead};}
export const formatTokens=(n:number)=>n>=1000000?(n/1000000).toFixed(1)+'M':n>=1000?(n/1000).toFixed(1)+'k':String(Math.round(n));
// 伪图形组件：上下文/预算等进度条，配色由调用方用 scrollbarThumb/Track 前景化。
export const meter=(percent:number,width=10)=>{const filled=Math.max(0,Math.min(width,Math.round(percent/100*width)));return '▓'.repeat(filled)+'░'.repeat(width-filled);};
export function usageText(usage:ReturnType<typeof sessionUsage>,context:any,model:any){const window=context?.contextWindow||model?.contextWindow;const known=context?.tokens!==null&&context?.tokens!==undefined;const cacheShare=usage.cacheRead>0?Math.round(usage.cacheRead/Math.max(1,usage.cacheRead+usage.input)*100):0;return `  计价估算 ~$${usage.estimatedCost.toFixed(4)}  ·  上下文 ${known?formatTokens(context.tokens):'待返回'} / ${window?formatTokens(window):'未知'}${context?.percent!==null&&context?.percent!==undefined?' ('+context.percent.toFixed(1)+'%)':''}  ·  ↑${formatTokens(usage.input)} ↓${formatTokens(usage.output)}${cacheShare>0?` · 缓存命中${cacheShare}%`:''}${model?.provider==='openai-codex'?' · 非订阅账单':''}`;}

// Keep oversized tool responses parseable and mark the preview explicitly.
export function boundedJson(value:unknown,max=12000):string{
 const full=JSON.stringify(value)??'null';
 if(full.length<=max)return full;
 const encode=(length:number)=>JSON.stringify({truncated:true,totalCharacters:full.length,preview:full.slice(0,length)});
 let low=0,high=Math.min(full.length,max);
 while(low<high){const middle=Math.ceil((low+high)/2);if(encode(middle).length<=max)low=middle;else high=middle-1;}
 return encode(low);
}

export function boundedText(value:unknown,max=6000):string{const text=String(value??'');if(text.length<=max)return text;const head=Math.floor(max*0.75),tail=Math.max(0,max-head);return text.slice(0,head)+'\n… [摘要截断；完整证据按 taskId / orbital_worker result 读取] …\n'+text.slice(-tail);}
