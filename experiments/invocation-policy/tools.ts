import fs from 'node:fs';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {createBench}=require('./bench.cjs');

export default function(pi){
  const schema=pi.zod;
  const spec=JSON.parse(fs.readFileSync(process.env.AXR_POLICY_SPEC!,'utf8'));
  const bench=createBench(spec);
  const enabled=spec.arm!=='baseline';
  const fields={action:schema.enum(enabled?['read','write','test','inspect','evidence','finish']:['read','write','test','finish']),
    file:schema.string().optional(),content:schema.string().optional(),status:schema.enum(['done','blocked']).optional()};
  if(enabled)Object.assign(fields,{view:schema.enum(['full','summary']).optional(),sha256:schema.string().optional(),line:schema.number().optional(),offset:schema.number().optional(),maxBytes:schema.number().optional()});
  pi.on('session_start',async()=>{
    await pi.setActiveTools(['bench']);
    fs.appendFileSync(spec.receipt,JSON.stringify({type:'active-tools',tools:pi.getActiveTools(),cliEnabled:enabled})+'\n',{mode:0o600});
  });
  pi.registerTool({name:'bench',label:'Recovery workspace',
    description:'Read solution.js, public-tests.json, workspace.json or immutable synthetic session.jsonl. Write only solution.js (24000 bytes max). Test runs all frozen public cases and returns source/suite SHA-256. Finish done or blocked. No shell/network/other files. 20 calls maximum.'+
      (enabled?' Optional inspect (view full or summary) runs AgentXRay on history. Optional evidence requires source sha256, physical line, optional byte offset and maxBytes (4..16384, default 4096). These are log observations, not task verdicts.':''),
    parameters:schema.object(fields),async execute(_id,params,_onUpdate,context){return bench.execute(params,context);}});
}
