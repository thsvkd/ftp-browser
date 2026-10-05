import { homedir } from 'os'
import { runFtpb } from './ftpb'

// `ftpb` entry (out/cli/ftpb.cjs). Runs under system Node or the app executable with ELECTRON_RUN_AS_NODE=1.
// End quietly when the reader closes the pipe first (`ftpb tools | head`).
process.stdout.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EPIPE') process.exit(process.exitCode ?? 0)
  throw err
})

const script = process.argv[1]
void runFtpb(process.argv.slice(2), {
  env: process.env,
  platform: process.platform,
  home: homedir(),
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
  fetch: globalThis.fetch,
  self: {
    command: process.execPath,
    args: script ? [script] : [],
    ...(process.versions.electron ? { env: { ELECTRON_RUN_AS_NODE: '1' } } : {})
  }
}).then((code) => {
  process.exitCode = code
})
