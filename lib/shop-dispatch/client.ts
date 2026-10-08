"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Actor, Board, Brand, Command } from "./model";
export interface DispatchSnapshot {
  board:Board; actor:Actor; serverNow:string; shopId:number;
  enterprise:{id:string;name:string;revision:number;brand:Brand|null;canEdit:boolean}|null;
}
export function useDispatchBoard() {
  const [snapshot,setSnapshot]=useState<DispatchSnapshot|null>(null);
  const [error,setError]=useState("");const [busy,setBusy]=useState(false);
  const [lastReceived,setLastReceived]=useState<number|null>(null);
  const current=useRef(snapshot);current.current=snapshot;
  const inflight=useRef(false);const generation=useRef(0);const mounted=useRef(true);
  const retryRef=useRef<{url:string;body:unknown}|null>(null);
  const accept=(value:DispatchSnapshot)=>{
    const previous=current.current;
    if(mounted.current&&(!previous||(
      value.shopId===previous.shopId&&value.board.revision>=previous.board.revision&&
      (value.enterprise?.revision??0)>=(previous.enterprise?.revision??0)))){
      current.current=value;setSnapshot(value);setLastReceived(Date.now());
    }else if(mounted.current&&previous&&value.shopId!==previous.shopId){
      // A dashboard shop switch must not reuse another location's edit forms.
      window.location.reload();
    }
  };
  const refresh=useCallback(async()=>{
    if(inflight.current)return;
    const gen=generation.current;
    try{
      const response=await fetch("/api/shop-dispatch",{cache:"no-store"});
      const data=await response.json();
      if(!response.ok)throw new Error(data.error||"Could not load workflow");
      if(gen===generation.current){accept(data);if(!retryRef.current)setError("");}
    }catch(e){if(mounted.current)setError(e instanceof Error?e.message:"Connection unavailable");}
  },[]);
  useEffect(()=>{mounted.current=true;void refresh();const timer=setInterval(()=>{if(document.visibilityState==="visible")void refresh();},10000);
    const visible=()=>{if(document.visibilityState==="visible")void refresh();};document.addEventListener("visibilitychange",visible);
    return()=>{mounted.current=false;clearInterval(timer);document.removeEventListener("visibilitychange",visible);};},[refresh]);
  const send=async(url:string,body:unknown):Promise<boolean>=>{
    if(inflight.current)return false;
    inflight.current=true;generation.current++;setBusy(true);setError("");
    // Preserve the exact command/UUID for ambiguous network failure; don't silently submit new work.
    retryRef.current={url,body};
    try{
      const response=await fetch(url,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
      const value=await response.json();
      if(!response.ok){
        if(response.status<500)retryRef.current=null;
        throw new Error(value.error||"Save failed");
      }
      retryRef.current=null;accept(value);return true;
    }catch(e){setError(e instanceof Error?e.message:"Save could not be confirmed. Retry the same request.");return false;}
    finally{inflight.current=false;setBusy(false);}
  };
  const mutate=(command:Command,expectedRevision?:number)=> {
    if(retryRef.current){setError("Retry or resolve the previous unconfirmed save before making another change.");return Promise.resolve(false);}
    if(!snapshot)return Promise.resolve(false);
    return send("/api/shop-dispatch",{requestId:crypto.randomUUID(),revision:expectedRevision ?? snapshot.board.revision,command});
  };
  const saveEnterpriseBrand=(brand:Brand|null,expectedRevision?:number)=>{
    if(retryRef.current){setError("Resolve the previous unconfirmed save first.");return Promise.resolve(false);}
    const enterprise=snapshot?.enterprise;if(!enterprise)return Promise.resolve(false);
    return send("/api/shop-dispatch/enterprise-brand",{requestId:crypto.randomUUID(),revision:expectedRevision ?? enterprise.revision,brand});
  };
  return {snapshot,error,busy,lastReceived,refresh,mutate,saveEnterpriseBrand,
    needsRetry:!!retryRef.current,retry:()=>retryRef.current?send(retryRef.current.url,retryRef.current.body):Promise.resolve(false)};
}
