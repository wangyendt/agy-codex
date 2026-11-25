import process from 'node:process';

const argv = process.argv.slice(2);
if (argv[0] === '--version') {
  process.stdout.write('codex-cli 0.172.0\n');
} else {
  let stdin = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) stdin += chunk;
  const id = stdin === 'fresh' ? 'thread-fresh'
    : argv.includes('resume') ? argv[argv.indexOf('--') + 1] : argv.includes('fork') ? 'thread-fork' : 'thread-mock';
  const event = (value) => process.stdout.write(JSON.stringify(value) + '\n');
  event({ type: 'thread.started', thread_id: id, extra: { safe: true } });
  process.stdout.write('not-json\n');
  event({ type: 'future.event', extra: true });
  event({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify({ argv, stdin, cwd: process.cwd() }) } });
  if (process.env.MOCK_FAIL === 'true') {
    event({ type: 'turn.failed' });
    process.exitCode = 7;
  } else {
    process.stdout.write('{"type":"turn.completed"}');
  }
}
