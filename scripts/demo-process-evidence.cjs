const fs = require('node:fs/promises');
const path = require('node:path');
const readline = require('node:readline');
const { startServer } = require('../test/helpers');

async function main() {
  const server = await startServer();
  const id = '01990000-0000-7000-8000-000000000199';
  const directory = path.join(server.home, '.codex/sessions/2026/09/24');
  const file = path.join(directory, `rollout-2026-09-24T08-00-00-${id}.jsonl`);
  let tick = 0;
  const stamp = () => new Date(Date.UTC(2026, 8, 24, 8) + tick++ * 1000).toISOString();
  const record = (payload) => ({ type: 'response_item', timestamp: stamp(), payload });
  const call = (callId, name, args) =>
    record({ type: 'function_call', call_id: callId, name, arguments: JSON.stringify(args) });
  const result = (callId, status) =>
    record({
      type: 'function_call_output',
      call_id: callId,
      output: `Chunk ID: synthetic\nWall time: 1 seconds\n${status}\nFinal output:\nSynthetic result only; no command was executed.`,
    });
  const records = [
    { type: 'session_meta', timestamp: stamp(), payload: { id, cwd: '/synthetic', timestamp: stamp() } },
    record({
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: '[Synthetic] 后台进程：启动不是完成，轮询给出退出证据' }],
    }),
    call('launch-pass', 'exec_command', { cmd: 'npm test', workdir: '/synthetic' }),
    result('launch-pass', 'Process running with session ID 42'),
    call('edit', 'edit', { path: '/synthetic/config.ts', cwd: '/synthetic' }),
    result('edit', 'Process exited with code 0'),
    call('poll-pass', 'write_stdin', { session_id: 42, chars: '' }),
    result('poll-pass', 'Process exited with code 0'),
    call('launch-pending', 'exec_command', { cmd: 'pytest', workdir: '/synthetic' }),
    result('launch-pending', 'Process running with session ID 43'),
    call('launch-fail', 'exec_command', { cmd: 'npm run lint', workdir: '/synthetic' }),
    result('launch-fail', 'Process running with session ID 44'),
    call('poll-fail', 'write_stdin', { session_id: 44, chars: '' }),
    result('poll-fail', 'Process exited with code 2'),
    call('unlinked-poll', 'write_stdin', { session_id: 99, chars: '' }),
    result('unlinked-poll', 'Process exited with code 0'),
  ];
  try {
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(file, `${records.map((item) => JSON.stringify(item)).join('\n')}\n`);
  } catch (error) {
    await server.stop();
    throw error;
  }
  console.log(`Synthetic process evidence demo: ${server.base}`);
  console.log('选择 Codex 中的 [Synthetic] 会话：3 次后台启动，2 次明确退出，1 次未关联轮询。');
  console.log('第一项测试启动早于修改，最终退出仍算重叠。输入 c 为第二个进程追加退出结果；q 或 Ctrl-C 清理。');
  const input = readline.createInterface({ input: process.stdin });
  let completed = false;
  const stop = async () => {
    input.close();
    await server.stop();
    process.exit(0);
  };
  input.on('line', async (line) => {
    if (line.trim() === 'q') return stop();
    if (line.trim() !== 'c' || completed) return;
    completed = true;
    try {
      const extra = [
        call('poll-pending', 'write_stdin', { session_id: 43, chars: '' }),
        result('poll-pending', 'Process exited with code 0'),
      ];
      await fs.appendFile(file, `${extra.map((item) => JSON.stringify(item)).join('\n')}\n`);
      console.log(
        'PASS: appended process completion; third terminal process is visible without changing launch history.'
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
