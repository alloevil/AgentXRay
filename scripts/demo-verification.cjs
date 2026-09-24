const fs = require('node:fs/promises');
const path = require('node:path');
const readline = require('node:readline');
const { startServer } = require('../test/helpers');

async function main() {
  const server = await startServer();
  const id = '01990000-0000-7000-8000-000000000188';
  const directory = path.join(server.home, '.omp/agent/sessions/synthetic-verification');
  const file = path.join(directory, `2026-09-24T08-00-00_${id}.jsonl`);
  let tick = 0;
  const stamp = () => new Date(Date.UTC(2026, 8, 24, 8) + tick++ * 1000).toISOString();
  const message = (recordId, value) => ({ type: 'message', id: recordId, timestamp: stamp(), message: value });
  const call = (callId, name, args) =>
    message(`${callId}-call`, {
      role: 'assistant',
      content: [{ type: 'toolCall', id: callId, name, arguments: args }],
    });
  const result = (callId, toolName, state) =>
    message(`${callId}-result`, {
      role: 'toolResult',
      toolCallId: callId,
      toolName,
      isError: state === 'failure',
      details: state === 'running' ? { async: { state: 'running' } } : { exitCode: state === 'failure' ? 1 : 0 },
      content: [{ type: 'text', text: `Synthetic ${state} result. No tool command was executed by this demo.` }],
    });
  const records = [
    { type: 'session', id, timestamp: stamp(), cwd: '/synthetic/project' },
    message('user', {
      role: 'user',
      content: [{ type: 'text', text: '[Synthetic] 检查成功之后又修改：先后顺序不是测试覆盖' }],
    }),
    call('passed-check', 'bash', { command: 'npm test', cwd: '/synthetic/project' }),
    result('passed-check', 'bash', 'success'),
    call('overlapping-check', 'bash', { command: 'pytest', cwd: '/synthetic/project' }),
    call('changed-file', 'edit', {
      path: '/synthetic/project/config.ts',
      oldText: 'before',
      newText: 'after',
      cwd: '/synthetic/project',
    }),
    result('changed-file', 'edit', 'success'),
    result('overlapping-check', 'bash', 'success'),
    call('different-directory', 'bash', { command: 'npm run build', cwd: '/synthetic/other' }),
    result('different-directory', 'bash', 'success'),
    call('unclassified', 'bash', { command: 'echo synthetic-check-placeholder', cwd: '/synthetic/project' }),
    result('unclassified', 'bash', 'success'),
  ];
  try {
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(file, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);
  } catch (error) {
    await server.stop();
    throw error;
  }
  console.log(`Synthetic chronology demo: ${server.base}`);
  console.log(`Session API: ${server.base}/api/omp/sessions/${id}`);
  console.log('初始：1 次修改成功返回；先前检查通过、另一个检查与修改重叠、不同目录检查不关联。无人工标注。');
  console.log('输入 f 追加修改后的失败检查；输入 s 追加成功检查；输入 q 或 Ctrl-C 清理退出。');
  const input = readline.createInterface({ input: process.stdin });
  const stop = async () => {
    input.close();
    await server.stop();
    process.exit(0);
  };
  let appended = 0;
  input.on('line', async (line) => {
    const action = line.trim();
    if (action === 'q') return stop();
    if (!['f', 's'].includes(action)) return;
    appended++;
    const callId = `later-check-${appended}`;
    try {
      const extra = [
        call(callId, 'bash', { command: 'npm test', cwd: '/synthetic/project' }),
        result(callId, 'bash', action === 'f' ? 'failure' : 'success'),
      ];
      await fs.appendFile(file, `${extra.map((record) => JSON.stringify(record)).join('\n')}\n`);
      console.log(
        `PASS: appended ${action === 'f' ? 'failure' : 'success'} check result; chronology should update without human labels.`
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
