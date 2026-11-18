// Older Safari versions have AbortController but no AbortSignal.timeout.
export function requestSignal(milliseconds){
 if(typeof globalThis.AbortSignal?.timeout==='function')return globalThis.AbortSignal.timeout(milliseconds);
 const controller=new AbortController();
 const timer=setTimeout(()=>controller.abort(new DOMException('請求逾時','TimeoutError')),milliseconds);
 timer?.unref?.();
 return controller.signal;
}
