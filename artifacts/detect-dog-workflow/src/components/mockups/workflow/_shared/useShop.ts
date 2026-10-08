import { useCallback, useEffect, useRef, useState } from 'react';
import { applyAction, createDemoState, type DemoMode, type Result, type ShopAction } from './model';

export function useShop() {
  const [state, setState] = useState(()=>createDemoState('burnett'));
  const stateRef = useRef(state);
  stateRef.current = state;
  const [notice, setNotice] = useState('');
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(noticeTimer.current), []);
  const act = useCallback((action: ShopAction): Result => {
    const result = applyAction(stateRef.current, action);
    if (result.ok) {
      stateRef.current = result.state;
      setState(result.state);
      setNotice(result.message);
      clearTimeout(noticeTimer.current);
      noticeTimer.current = setTimeout(() => setNotice(''), 4500);
    }
    return result;
  }, []);
  const changeDemo = useCallback((mode: DemoMode) => {
    const next=createDemoState(mode);
    stateRef.current=next;
    setState(next);
    clearTimeout(noticeTimer.current);
    setNotice('');
  }, []);
  return { state, act, notice, changeDemo };
}
