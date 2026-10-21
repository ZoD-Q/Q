import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
const source=ts.transpileModule(readFileSync(new URL('./slide-confirm.tsx',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText;
function harness({reduced=false}={}) {
 let cursor=0,dirty=true,effects=[],handlers,tree,confirmations=0;const slots=[];const props={disabled:false,busy:false,onConfirm:()=>{confirmations++;}};
 const useEffect=(fn,deps)=>{const i=cursor++;if(!slots[i]||deps.some((v,j)=>v!==slots[i].deps[j])){const cleanup=slots[i]?.cleanup;slots[i]={deps};effects.push(()=>{cleanup?.();slots[i].cleanup=fn();});}};
 const react={useState(initial){const i=cursor++;if(!slots[i])slots[i]={value:typeof initial==='function'?initial():initial};return[slots[i].value,value=>{slots[i].value=typeof value==='function'?value(slots[i].value):value;dirty=true;}];},useRef(value){const i=cursor++;return slots[i]??={current:value};},useEffect,useLayoutEffect:useEffect,useCallback(fn,deps){const i=cursor++;if(!slots[i]||deps.some((v,j)=>v!==slots[i].deps[j]))slots[i]={fn,deps};return slots[i].fn;}};
 class Value {constructor(value){this.value=value;}setValue(value){this.value=value;}stopAnimation(){}interpolate(){return 1;}}
 const native={ActivityIndicator:'spinner',View:'view',Pressable:'button',Animated:{View:'animated',Value,add:()=>0,spring:(value,{toValue})=>({start:()=>value.setValue(toValue)})},PanResponder:{create:value=>{handlers=value;return{panHandlers:{}};}}};
 const imports={react,'react/jsx-runtime':{jsx:(type,props)=>({type,props}),jsxs:(type,props)=>({type,props})},'react-native':native,'react-native-reanimated':{useReducedMotion:()=>reduced},'lucide-react-native':{ArrowRight:'arrow',Check:'check'},'../design':{Type:'text',useDesign:()=>({colors:{},text:(zh)=>zh})}};
 const module={exports:{}};runInNewContext(source,{module,exports:module.exports,require:name=>{assert.ok(name in imports,name);return imports[name];}});
 const render=()=>{for(let rounds=0;rounds<8&&dirty;rounds++){dirty=false;cursor=0;tree=module.exports.SlideConfirm(props);const todo=effects;effects=[];todo.forEach(f=>f());}return tree;};
 const all=(node,result=[])=>{if(node&&typeof node==='object'){result.push(node);const children=node.props?.children;for(const child of Array.isArray(children)?children:[children])all(child,result);}return result;};
 const flush=()=>render();render();all(tree).find(n=>n.props?.onLayout).props.onLayout({nativeEvent:{layout:{width:320}}});render();
 return {get confirmations(){return confirmations;},flush,gesture(dx,dy=0,touches=1,terminate=false){handlers.onPanResponderGrant();handlers.onPanResponderMove({}, {dx,dy,numberActiveTouches:touches});if(terminate)handlers.onPanResponderTerminate();else handlers.onPanResponderRelease({}, {dx,dy,numberActiveTouches:0});render();},press(){all(tree).find(n=>n.type==='button').props.onPress();render();},set(p){Object.assign(props,p);dirty=true;render();},close(){slots.forEach(s=>s?.cleanup?.());}};
}
test('real confirmation component requires an 85% horizontal release and cancellation never confirms',()=>{const view=harness();view.gesture(100);assert.equal(view.confirmations,0);view.gesture(220,57);assert.equal(view.confirmations,0);view.gesture(220,0,2);assert.equal(view.confirmations,0);view.gesture(220,0,1,true);assert.equal(view.confirmations,0);view.gesture(218);assert.equal(view.confirmations,1);view.close();});
test('gesture and accessible button share the same confirmation latch',()=>{const view=harness();view.gesture(240);view.press();view.gesture(240);assert.equal(view.confirmations,1);view.set({busy:true});view.set({busy:false});view.press();assert.equal(view.confirmations,2);view.close();});
test('disabled and busy controls do not confirm, including reduced motion',()=>{const view=harness({reduced:true});view.set({disabled:true});view.gesture(240);view.press();assert.equal(view.confirmations,0);view.set({disabled:false,busy:true});view.gesture(240);view.press();assert.equal(view.confirmations,0);view.set({busy:false});view.press();assert.equal(view.confirmations,1);view.close();});
