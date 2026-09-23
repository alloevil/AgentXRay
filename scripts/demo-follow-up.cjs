const fs = require('node:fs/promises');
const path = require('node:path');
const readline = require('node:readline');
const { startServer } = require('../test/helpers');

async function main() {
  const server = await startServer();
  const directory = path.join(server.home, '.omp/agent/sessions/synthetic-follow-up');
  const id = '01990000-0000-7000-8000-000000000177';
  const file = path.join(directory, `2026-09-24T08-00-00_${id}.jsonl`);
  let tick = 0;
  const stamp = () => new Date(Date.UTC(2026, 8, 24, 8) + tick++ * 1000).toISOString();
  const message = (recordId, payload) => ({ type: 'message', id: recordId, timestamp: stamp(), message: payload });
  const operation = (callId, name, args, state) => [
    message(`${callId}-call`, {
      role: 'assistant',
      content: [{ type: 'toolCall', id: callId, name, arguments: args }],
    }),
    message(`${callId}-result`, {
      role: 'toolResult',
      toolCallId: callId,
      toolName: name,
      isError: state === 'failure',
      details:
        state === 'running' || state === 'cancelled'
          ? { async: { state } }
          : state === 'unknown'
            ? {}
            : { exitCode: state === 'success' ? 0 : 1, wallTimeMs: 10 },
      content: [{ type: 'text', text: `Synthetic ${state} result for ${callId}. Nothing was executed.` }],
    }),
  ];
  const bashArgs = { command: 'synthetic test', i: 'initial' };
  const editArgs = { path: '/synthetic/config.ts', oldText: 'before', newText: 'after' };
  const records = [
    { type: 'session', id, timestamp: stamp(), cwd: '/synthetic/project' },
    message('synthetic-user', {
      role: 'user',
      content: [{ type: 'text', text: '[Synthetic] 后续相关操作：候选不等于恢复' }],
    }),
    ...operation('failed-bash', 'bash', bashArgs, 'failure'),
    ...operation('failed-edit', 'edit', editArgs, 'failure'),
    ...operation('same-file', 'edit', { ...editArgs, oldText: 'different anchor' }, 'success'),
    ...operation('unrelated-file', 'edit', { ...editArgs, path: '/synthetic/other.ts' }, 'success'),
  ];
  const states = ['running', 'cancelled', 'unknown', 'success', 'success', 'success', 'failure'];
  states.forEach((state, index) =>
    records.push(...operation(`candidate-${index + 1}`, 'bash', { ...bashArgs, i: `next-${index}` }, state))
  );
  records.push(
    message('next-user', {
      role: 'user',
      content: [{ type: 'text', text: 'Synthetic next turn: same-file changes should not be linked across turns.' }],
    })
  );
  records.push(...operation('other-turn', 'edit', { ...editArgs, newText: 'next turn' }, 'success'));
  try {
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(file, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);
  } catch (error) {
    await server.stop();
    throw error;
  }
  console.log(`Synthetic-only follow-up demo: ${server.base}`);
  console.log(`Session API: ${server.base}/api/omp/sessions/${id}`);
  console.log('OMP 合成会话：3 个自动事件；初始 bash 事件有 7 条不同状态候选，edit 事件有 1 条同文件候选。');
  console.log('输入 n：追加仅 i 不同的成功候选，使旧复核过期；q 或 Ctrl-C 清理退出。');
  const input = readline.createInterface({ input: process.stdin });
  let appended = 0;
  const stop = async () => {
    input.close();
    await server.stop();
    process.exit(0);
  };
  input.on('line', async (line) => {
    if (line.trim() === 'q') return stop();
    if (line.trim() !== 'n') return;
    appended++;
    try {
      const next = operation(`appended-${appended}`, 'bash', { ...bashArgs, i: `new-evidence-${appended}` }, 'success');
      await fs.appendFile(file, `${next.map((record) => JSON.stringify(record)).join('\n')}\n`);
      console.log(
        'PASS: appended candidate evidence; automatic failures unchanged, affected review must become stale.'
      );
    } catch (error) {
      console.error(error.message);
      await stop();
    }
  });
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
