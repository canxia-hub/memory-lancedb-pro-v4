import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import entry from '../dist/index.js';
import {getStore,getSearchManager} from '../dist/tools/register.js';
const root=await mkdtemp(join(tmpdir(),'memory-lifecycle-'));
const tools=new Map(),disposers=[];let capability;
const api={id:'memory-lancedb-pro',registrationMode:'full',config:{agents:{defaults:{workspace:root}}},
 pluginConfig:{dbPath:root+'/db',tableName:'memories',embeddingDimension:2560,connectionMode:'embedded',vault:{path:root+'/wiki'},reflection:{enabled:false},dreaming:{enabled:false}},
 logger:{info(){},warn(){},error(){}},lifecycle:{onDispose(fn){disposers.push(fn)}},
 registerTool(factory,options){const t=typeof factory==='function'?factory({agentId:'main'}):factory;if(t)tools.set(t.name,t)},
 registerMemoryCapability(c){capability=c},registerMemoryPromptSupplement(){},registerMemoryCorpusSupplement(){},registerCli(){},on(){}};
entry.register(api);
assert.equal(getStore(),null,'plugin registration must not open LanceDB');
const [a,b]=await Promise.all([tools.get('memory_list').execute('test-a',{limit:1}),tools.get('memory_list').execute('test-b',{limit:1})]);
assert.ok(!a.isError && !b.isError,JSON.stringify([a,b]));
assert.ok(getStore());
const managed=await capability.runtime.getMemorySearchManager();
assert.equal(managed.manager,getSearchManager(),'host and tools must share one search manager');
for(const dispose of disposers)await dispose();
assert.equal(getStore(),null);
console.log(JSON.stringify({registration_lazy:true,concurrent_initialization:true,shared_search_manager:true,disposed:true,production_writes:0}));
