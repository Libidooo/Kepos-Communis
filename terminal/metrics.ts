/** Bounded local measurements. No telemetry and no provider/model requests. */
export class TimingWindow {
 private samples:number[]=[];
 private position=0;
 private total=0;
 constructor(private capacity=256) {}
 observe(milliseconds:number) {if(!Number.isFinite(milliseconds)||milliseconds<0)return;this.samples[this.position]=milliseconds;this.position=(this.position+1)%this.capacity;this.total++;}
 snapshot() {const sorted=[...this.samples].sort((a,b)=>a-b);const q=(p:number)=>sorted.length?sorted[Math.min(sorted.length-1,Math.floor((sorted.length-1)*p))]:null;return {count:this.total,windowCount:sorted.length,p50Ms:q(.5),p95Ms:q(.95),maxMs:q(1)};}
}
