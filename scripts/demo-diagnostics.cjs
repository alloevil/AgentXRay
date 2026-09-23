const fs = require('node:fs/promises');
const path = require('node:path');
const readline = require('node:readline');
const { startServer } = require('../test/helpers');

async function main() {
  const server = await startServer();
  const directory = path.join(server.home, '.omp/agent/sessions/synthetic-events');
  const id = '01990000-0000-7000-8000-000000000166';
  const file = path.join(directory, `2026-09-23T08-00-00_${id}.jsonl`);
  let tick = 0;
  const stamp = () => new Date(Date.UTC(2026, 8, 23, 8) + tick++ * 1000).toISOString();
  const record = (message, recordId) => ({ type: 'message', id: recordId, timestamp: stamp(), message });
  const operation = (callId, args, success = false) => [
    record(
      { role: 'assistant', content: [{ type: 'toolCall', id: callId, name: 'edit', arguments: args }] },
      `${callId}-call`
    ),
    record(
      {
        role: 'toolResult',
        toolName: 'edit',
        toolCallId: callId,
        isError: !success,
        content: [
          {
            type: 'text',
            text: success
              ? 'Synthetic edit succeeded; not task acceptance.'
              : `Synthetic edit ${callId}: expected text not found. No command was executed.`,
          },
        ],
      },
      `${callId}-result`
    ),
  ];
  const repeatedArgs = { path: '/synthetic/app.ts', oldText: 'before', newText: 'after' };
  const records = [
    { type: 'session', id, timestamp: stamp(), cwd: '/synthetic/project' },
    record(
      { role: 'user', content: [{ type: 'text', text: '[Synthetic] 66 次失败 → 1 个事件 · 完整证据' }] },
      'synthetic-user'
    ),
    ...operation('earlier-failure', repeatedArgs),
    ...operation('earlier-success', repeatedArgs, true),
  ];
  for (let index = 1; index <= 66; index++) records.push(...operation(`repeat-${index}`, repeatedArgs));
  for (let index = 1; index <= 6; index++) {
    records.push(...operation(`distinct-${index}`, { ...repeatedArgs, path: `/synthetic/other-${index}.ts` }));
  }
  try {
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(file, `${records.map((item) => JSON.stringify(item)).join('\n')}\n`);
  } catch (error) {
    await server.stop();
    throw error;
  }
  console.log(`Synthetic-only demo: ${server.base}`);
  console.log(`Session API: ${server.base}/api/omp/sessions/${id}`);
  console.log('选择 OMP 中的 [Synthetic] 会话：72 条待复查记录 → 7 个事件。');
  console.log('输入 r 并回车：追加同参数成功结果，66 条失败恢复；输入 q 或 Ctrl-C 退出并清理。');
  console.log('复核演示：先在页面记录人工复核，再输入 n 并回车追加同参失败，验证旧标记自动过期。');
  const input = readline.createInterface({ input: process.stdin });
  let recovered = false;
  let extraFailures = 0;
  const stop = async () => {
    input.close();
    await server.stop();
    process.exit(0);
  };
  input.on('line', async (line) => {
    if (line.trim() === 'q') return stop();
    const command = line.trim();
    if (!['r', 'n'].includes(command) || recovered) return;
    const success = command === 'r';
    if (success) recovered = true;
    else extraFailures++;
    try {
      await fs.appendFile(
        file,
        `${operation(success ? 'recovery' : `repeat-extra-${extraFailures}`, repeatedArgs, success)
          .map((item) => JSON.stringify(item))
          .join('\n')}\n`
      );
      console.log(
        success
          ? `PASS: appended synthetic success; expect 6 events / 6 pending records / ${67 + extraFailures} recovered records.`
          : `PASS: appended synthetic failure; expect ${66 + extraFailures} members in the repeated event; previous review is stale.`
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
