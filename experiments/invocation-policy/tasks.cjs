const { grade, hash } = require('./bench.cjs');

const cases = (entries) => entries.map(([input, expected]) => ({ input, expected }));
const merge = `function solve({base,patch}) {
  const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const copy = value => JSON.parse(JSON.stringify(value));
  const merge = (original, changes) => {
    if (!plain(changes)) return copy(changes);
    const result = Object.create(null);
    if (plain(original)) for (const key of Object.keys(original)) Object.defineProperty(result,key,{value:copy(original[key]),writable:true,enumerable:true,configurable:true});
    for (const key of Object.keys(changes)) {
      if (changes[key] === null) delete result[key];
      else Object.defineProperty(result,key,{value:merge(result[key],changes[key]),writable:true,enumerable:true,configurable:true});
    }
    return result;
  };
  return merge(base,patch);
}\n`;
const page = `function solve({records,after,limit}) {
  const sorted = records.slice().sort((left,right)=>left.time-right.time || (left.id<right.id?-1:left.id>right.id?1:0));
  const eligible = sorted.filter(row=>after===null || row.time>after.time || row.time===after.time && row.id>after.id);
  const items = eligible.slice(0,limit);
  const last = items.at(-1);
  return {items,next:eligible.length>items.length && last ? {time:last.time,id:last.id}:null};
}\n`;
const schedule = `function solve({attempt,baseMs,capMs,retryAfterMs,jitter,maxAttempts}) {
  if (attempt>=maxAttempts) return null;
  const delay = Math.min(capMs,baseMs*Math.pow(2,attempt));
  return Math.max(retryAfterMs,Math.floor(delay*jitter));
}\n`;
const pathSource = `function solve({root,request}) {
  const rootParts = root.split('/').filter(Boolean);
  const pieces = rootParts.slice();
  for (const segment of request.split('/')) {
    if (!segment || segment==='.') continue;
    if (segment==='..') { if(pieces.length===rootParts.length) return null; pieces.pop(); }
    else pieces.push(segment);
  }
  return '/'+pieces.join('/');
}\n`;
const ranges = `function solve({ranges}) {
  const ordered=ranges.filter(pair=>pair[0]<pair[1]).map(pair=>pair.slice()).sort((left,right)=>left[0]-right[0]||left[1]-right[1]);
  const result=[];
  for(const pair of ordered) {
    const previous=result.at(-1);
    if(previous && pair[0]<=previous[1]) previous[1]=Math.max(previous[1],pair[1]);
    else result.push(pair);
  }
  return result;
}\n`;
const percentile = `function solve({values,p}) {
  if(!values.length)return null;
  const sorted=values.slice().sort((left,right)=>left-right);
  const position=(sorted.length-1)*p;
  const lower=Math.floor(position),upper=Math.ceil(position);
  return sorted[lower]+(sorted[upper]-sorted[lower])*(position-lower);
}\n`;

const tasks = [
  { id: 'nested-config-recovery', pattern: 'stale-success', correctInitially: false,
    requirement: 'Implement solve({base,patch}) as a JSON merge patch. For an object patch, start from a deep copy of base if base is a non-null non-array object, otherwise an empty object. Apply each own patch key recursively; null deletes that key. Non-object patches (including arrays, primitives and null) replace the whole target. Preserve keys such as __proto__ as ordinary own JSON data. Return the merged JSON value; no input mutation.',
    reference: merge, source: merge.replace('if (changes[key] === null) delete result[key];', 'if (changes[key] === null) result[key] = null;'),
    publicCases: cases([[{base:{a:1,b:2},patch:{b:null}}, {a:1}], [{base:{nested:{x:1}},patch:{nested:{y:2}}},{nested:{x:1,y:2}}], [{base:[1,2],patch:[3]},[3]], [{base:{a:1},patch:0},0]]),
    hiddenCases: cases([[{base:{nested:{x:1,y:2},keep:3},patch:{nested:{x:null,z:4}}},{nested:{y:2,z:4},keep:3}], [{base:5,patch:{x:{y:null,z:1}}},{x:{z:1}}], [{base:{x:1},patch:null},null], [JSON.parse('{"base":{"__proto__":{"a":1},"x":2},"patch":{"__proto__":{"b":3},"x":null}}'), JSON.parse('{"__proto__":{"a":1,"b":3}}')]]) },
  { id: 'cursor-page-background', pattern: 'background-failure', correctInitially: false,
    requirement: 'Implement solve({records,after,limit}). Each JSON record has finite numeric time, a unique ASCII string id, and optional extra fields. Sort ascending by (time,id) using ordinary case-sensitive JS string ordering, without mutation. If after is non-null, retain only tuples strictly greater than {time,id}; the cursor itself need not occur in records. limit is a positive integer. Return {items,next}; items is the first limit eligible complete records, and next is the last returned {time,id} only when more eligible records remain, otherwise null.',
    reference: page, source: page.replace('row.id>after.id', 'row.id>=after.id').replace('eligible.length>items.length', 'eligible.length>=items.length'),
    publicCases: cases([[{records:[{time:2,id:'b'},{time:1,id:'a'}],after:null,limit:2},{items:[{time:1,id:'a'},{time:2,id:'b'}],next:null}], [{records:[{time:1,id:'a'},{time:1,id:'b'},{time:2,id:'a'}],after:{time:1,id:'a'},limit:1},{items:[{time:1,id:'b'}],next:{time:1,id:'b'}}], [{records:[],after:null,limit:3},{items:[],next:null}]]),
    hiddenCases: cases([[{records:[{time:2,id:'x',v:3},{time:1,id:'B',v:2},{time:1,id:'a',v:1}],after:{time:1,id:'Z'},limit:1},{items:[{time:1,id:'a',v:1}],next:{time:1,id:'a'}}], [{records:[{time:5,id:'z'}],after:{time:5,id:'z'},limit:4},{items:[],next:null}], [{records:[{time:3,id:'c'},{time:1,id:'a'},{time:2,id:'b'}],after:{time:1.5,id:'x'},limit:3},{items:[{time:2,id:'b'},{time:3,id:'c'}],next:null}]]) },
  { id: 'retry-delay-after-edit', pattern: 'stale-success', correctInitially: false,
    requirement: 'Implement solve({attempt,baseMs,capMs,retryAfterMs,jitter,maxAttempts}). attempt is a zero-based nonnegative integer: the retry is disallowed once attempt >= maxAttempts, returning null. Otherwise cap the exponential delay baseMs*2**attempt at capMs FIRST, multiply by jitter (0 through 1), round down, then take the maximum with retryAfterMs, a nonnegative server minimum that may exceed capMs. Return the resulting milliseconds. Inputs are finite nonnegative numbers, maxAttempts is an integer, and no input mutation is allowed.',
    reference: schedule, source: schedule.replace('attempt>=maxAttempts','attempt>maxAttempts').replace('return Math.max(retryAfterMs,Math.floor(delay*jitter));','return Math.min(capMs,Math.max(retryAfterMs,Math.floor(delay*jitter)));'),
    publicCases: cases([[{attempt:0,baseMs:100,capMs:500,retryAfterMs:0,jitter:1,maxAttempts:3},100], [{attempt:3,baseMs:100,capMs:500,retryAfterMs:0,jitter:1,maxAttempts:3},null], [{attempt:1,baseMs:100,capMs:500,retryAfterMs:900,jitter:0.5,maxAttempts:3},900]]),
    hiddenCases: cases([[{attempt:4,baseMs:100,capMs:500,retryAfterMs:0,jitter:0.5,maxAttempts:5},250], [{attempt:0,baseMs:33,capMs:100,retryAfterMs:0,jitter:0.5,maxAttempts:1},16], [{attempt:0,baseMs:100,capMs:0,retryAfterMs:7,jitter:0,maxAttempts:1},7], [{attempt:0,baseMs:0,capMs:0,retryAfterMs:0,jitter:1,maxAttempts:0},null]]) },
  { id: 'virtual-root-recovery', pattern: 'background-failure', correctInitially: false,
    requirement: 'Implement solve({root,request}) to resolve a virtual POSIX path under root. root is canonical absolute, with no dot segments; request is relative and contains slash-separated literal segments. Ignore empty segments and dot, process dot-dot by removing one segment only if above the root floor, and return null immediately if a dot-dot would escape the root at any step (even if later segments reenter it). No URL decoding, symlink lookup or filesystem access. Return a canonical absolute path with no trailing slash except root /. No input mutation.',
    reference: pathSource, source: pathSource.replace('pieces.length===rootParts.length','pieces.length===0'),
    publicCases: cases([[{root:'/srv/app',request:'logs/../data'},'/srv/app/data'], [{root:'/srv/app',request:'../app/data'},null], [{root:'/',request:'a//./b/..'},'/a']]),
    hiddenCases: cases([[{root:'/team/work',request:'a/../../work'},null], [{root:'/team/work',request:''},'/team/work'], [{root:'/',request:'..'},null], [{root:'/a',request:'.../%2e%2e/b'},'/a/.../%2e%2e/b'], [{root:'/a',request:'x/y/../../z'},'/a/z']]) },
  { id: 'intervals-already-repaired', pattern: 'alternate-correction', correctInitially: true,
    requirement: 'Implement solve({ranges}) returning the union of finite numeric half-open intervals [start,end). Discard pairs with start>=end. Sort by ascending start, merge overlaps AND touching boundaries, and preserve outermost ends. Return a fresh array of pairs, without mutating input. The current implementation may already be correct; do not rewrite correct code.',
    reference: ranges, source: ranges,
    publicCases: cases([[{ranges:[[4,8],[1,3],[3,5]]},[[1,8]]], [{ranges:[[1,1],[3,2]]},[]], [{ranges:[[1,10],[2,4],[12,15]]},[[1,10],[12,15]]]]),
    hiddenCases: cases([[{ranges:[[0,1],[1,2],[2,3]]},[[0,3]]], [{ranges:[[-3,-1],[-2,0],[1,2],[4,5]]},[[-3,0],[1,2],[4,5]]], [{ranges:[[1.5,3],[1,2]]},[[1,3]]], [{ranges:[]},[]]]) },
  { id: 'percentile-negative-probe', pattern: 'negative-probe', correctInitially: true,
    requirement: 'Implement solve({values,p}) computing the linearly interpolated quantile. values contains finite numbers; p is between 0 and 1 inclusive. Sort numerically, calculate position=(n-1)*p and interpolate the lower/upper sorted entries. Empty input returns null; one element returns itself. Do not mutate values. The current implementation may already be correct; preserve correct code.',
    reference: percentile, source: percentile,
    publicCases: cases([[{values:[10,1,4],p:0.5},4], [{values:[],p:0.3},null], [{values:[0,10],p:0.25},2.5]]),
    hiddenCases: cases([[{values:[8],p:0.7},8], [{values:[2,10,1,5],p:1},10], [{values:[2,10,1,5],p:0},1], [{values:[-4,0,8],p:0.75},4], [{values:[7,7,7],p:0.33},7]]) },
];

async function materialize(task) {
  const evaluations = [];
  const evaluate = (source) => {
    const result = grade(process.execPath, source, task.publicCases);
    const receipt = { sourceSha256: hash(source), suiteSha256: hash(JSON.stringify(task.publicCases)), passed: result.passed, cases: result.cases };
    evaluations.push(receipt);
    return receipt;
  };
  let tick = 0;
  const records = [];
  const stamp = () => new Date(Date.UTC(2026, 8, 27, 0, 0, tick++)).toISOString();
  const say = (role, text) => records.push({ type:'response_item',timestamp:stamp(),payload:{type:'message',role,content:[{type:role==='user'?'input_text':'output_text',text}]} });
  const call = (id,name,args) => records.push({type:'response_item',timestamp:stamp(),payload:{type:'function_call',call_id:id,name,arguments:JSON.stringify(args)}});
  const out = (id,code,text,running=false) => records.push({type:'response_item',timestamp:stamp(),payload:{type:'function_call_output',call_id:id,
    output:`Chunk ID: synthetic\nWall time: 1 seconds\n${running?'Process running with session ID 42':`Process exited with code ${code}`}\nFinal output:\n${text}`}});
  say('user','Synthetic recovery history. Tool/process envelopes and ordering are simulated; test receipts come from actual deterministic executions. Current specification takes priority.');
  for(let index=0;index<6;index++) {call(`read-${index}`,'read',{path:`/workspace/docs/background-${index}.txt`});out(`read-${index}`,0,'Synthetic routine project reference.');}
  if(task.pattern==='stale-success') {
    const passed=evaluate(task.reference);
    call('old-test','exec_command',{cmd:'node --test',workdir:'/workspace'});out('old-test',0,JSON.stringify(passed));
    call('later-edit','edit',{path:'/workspace/solution.js',cwd:'/workspace',oldText:task.reference,newText:task.source});out('later-edit',0,JSON.stringify({sourceSha256:hash(task.source)}));
  } else if(task.pattern==='background-failure') {
    const failed=evaluate(task.source);
    call('background','exec_command',{cmd:'node --test',workdir:'/workspace'});out('background',0,'Synthetic background process envelope; outcome is in the later poll.',true);
    call('poll','write_stdin',{session_id:42,chars:''});out('poll',failed.passed?0:1,JSON.stringify(failed));
  } else {
    if(task.pattern==='alternate-correction') {
      call('old-edit','edit',{path:'/workspace/solution.js',oldText:'missing anchor',newText:'old attempted repair'});out('old-edit',1,'Synthetic old edit anchor not found.');
      call('new-edit','edit',{path:'/workspace/solution.js',cwd:'/workspace',oldText:'old implementation',newText:task.source});out('new-edit',0,JSON.stringify({sourceSha256:hash(task.source)}));
    } else {call('probe','exec_command',{cmd:'grep nonexistent_marker solution.js',workdir:'/workspace'});out('probe',1,'Synthetic negative search: nonexistent marker absent, not a behavioral test.');}
    const passed=evaluate(task.source);
    call('current-test','exec_command',{cmd:'node --test',workdir:'/workspace'});out('current-test',passed.passed?0:1,JSON.stringify(passed));
  }
  for(let index=0;index<3;index++){call(`tail-${index}`,'read',{path:`/workspace/docs/note-${index}.txt`});out(`tail-${index}`,0,'Synthetic routine note.');}
  say('assistant','Session paused. Check current source and verification evidence, then finish the recovery task.');
  return { log:records.map(JSON.stringify).join('\n')+'\n', evaluations,
    verifiedInitially:evaluations.some(entry=>entry.passed&&entry.sourceSha256===hash(task.source)&&entry.suiteSha256===hash(JSON.stringify(task.publicCases))) };
}

module.exports={tasks,materialize};
