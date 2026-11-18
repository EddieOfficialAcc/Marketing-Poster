import {requestSignal} from './request-signal.js';
const form=document.querySelector('#login-form'),button=document.querySelector('#login-submit'),error=document.querySelector('#login-error');
form.addEventListener('submit',async event=>{
 event.preventDefault();button.disabled=true;error.textContent='';
 try{
  const response=await fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:form.username.value.trim(),password:form.password.value}),signal:requestSignal(15000)});
  const data=await response.json();if(!response.ok)throw new Error(data.detail||'登入失敗');
  form.password.value='';location.replace('/#tasks');
 }catch(e){error.textContent=e.message||'無法連線，請稍後重試';}finally{button.disabled=false;}
});
