import { describe, expect, it } from 'vitest';

import { flagList, parseArgv, run, type Io } from '../src/cli.js';

/** Collects everything a command would have printed. */
function capture(): Io & { stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    out: (line) => stdout.push(line),
    err: (line) => stderr.push(line),
  };
}

describe('parseArgv', () => {
  it('splits the command from its positional arguments', () => {
    const parsed = parseArgv(['map', 'smtp', 'port']);
    expect(parsed.command).toBe('map');
    expect(parsed.args).toEqual(['smtp', 'port']);
    expect(parsed.flags).toEqual({});
  });

  it('returns an empty command when there is nothing to do', () => {
    expect(parseArgv([])).toEqual({ command: '', args: [], flags: {} });
  });

  it('parses --flag=value', () => {
    const { flags } = parseArgv(['open', '/settings', '--workspace=/tmp/app']);
    expect(flags['workspace']).toBe('/tmp/app');
  });

  it('parses --flag=value where the value itself contains "="', () => {
    const { flags } = parseArgv(['skill', 'run', 'login', '--param=token=abc=123']);
    expect(flagList(flags, 'param')).toEqual(['token=abc=123']);
  });

  it('parses --flag value for flags that take a value', () => {
    const { command, args, flags } = parseArgv(['index', '--workspace', '/tmp/app', '--timeout', '5000']);
    expect(command).toBe('index');
    expect(args).toEqual([]);
    expect(flags['workspace']).toBe('/tmp/app');
    expect(flags['timeout']).toBe('5000');
  });

  it('treats unlisted flags as booleans so positionals are never swallowed', () => {
    // The whole point: `--headed` must not eat `/settings`.
    const { args, flags } = parseArgv(['open', '--headed', '/settings']);
    expect(flags['headed']).toBe(true);
    expect(args).toEqual(['/settings']);
  });

  it('parses standalone boolean flags', () => {
    const { flags } = parseArgv(['index', '--force', '--json']);
    expect(flags['force']).toBe(true);
    expect(flags['json']).toBe(true);
  });

  it('accepts an explicit false for a boolean flag', () => {
    const { flags } = parseArgv(['open', '/x', '--headless=false']);
    expect(flags['headless']).toBe('false');
  });

  it('maps -h to --help and -v to --version', () => {
    expect(parseArgv(['-h']).flags['help']).toBe(true);
    expect(parseArgv(['doctor', '-h']).flags['help']).toBe(true);
    expect(parseArgv(['-v']).flags['version']).toBe(true);
  });

  it('expands short flag clusters', () => {
    const { flags } = parseArgv(['-hv']);
    expect(flags['help']).toBe(true);
    expect(flags['version']).toBe(true);
  });

  it('collects repeated --param k=v pairs', () => {
    const { flags } = parseArgv([
      'skill',
      'run',
      'login',
      '--param',
      'user=ada',
      '--param',
      'password=hunter2',
      '--param=otp=000000',
    ]);
    expect(flagList(flags, 'param')).toEqual(['user=ada', 'password=hunter2', 'otp=000000']);
  });

  it('returns an empty list for a flag that was never given', () => {
    expect(flagList(parseArgv(['skill', 'list']).flags, 'param')).toEqual([]);
  });

  it('normalises camelCase flag names to kebab-case', () => {
    expect(parseArgv(['open', '/x', '--logLevel', 'debug']).flags['log-level']).toBe('debug');
    expect(parseArgv(['open', '/x', '--log-level', 'debug']).flags['log-level']).toBe('debug');
  });

  it('leaves a value flag as `true` when nothing follows it', () => {
    // Reported as a usage error by the command, not swallowed here.
    expect(parseArgv(['index', '--workspace']).flags['workspace']).toBe(true);
  });

  it('treats everything after `--` as positional', () => {
    const { args, flags } = parseArgv(['act', '--', '--json', '@steps.json']);
    expect(args).toEqual(['--json', '@steps.json']);
    expect(flags).toEqual({});
  });

  it('does not mistake a bare "-" for a flag', () => {
    const { command, args } = parseArgv(['act', '-']);
    expect(command).toBe('act');
    expect(args).toEqual(['-']);
  });

  it('keeps negative numbers attached to their flag', () => {
    expect(parseArgv(['map', 'x', '--limit', '-1']).flags['limit']).toBe('-1');
  });
});

describe('run', () => {
  it('rejects an unknown command with the usage exit code', async () => {
    const io = capture();
    const code = await run(['definitely-not-a-command'], io);
    expect(code).toBe(2);
    expect(io.stdout).toEqual([]);
    expect(io.stderr.join('\n')).toContain('unknown command');
    // The error should tell the user what *is* available.
    expect(io.stderr.join('\n')).toContain('doctor');
  });

  it('rejects `help` for an unknown topic', async () => {
    const io = capture();
    expect(await run(['help', 'nope'], io)).toBe(2);
    expect(io.stderr.join('\n')).toContain('unknown command');
  });

  it('prints general help and exits 2 when given no command at all', async () => {
    const io = capture();
    expect(await run([], io)).toBe(2);
    expect(io.stdout.join('\n')).toContain('USAGE');
  });

  it('prints general help and exits 0 for --help', async () => {
    const io = capture();
    expect(await run(['--help'], io)).toBe(0);
    expect(io.stdout.join('\n')).toContain('COMMANDS');
  });

  it('prints per-command help for `help <command>` and `<command> --help`', async () => {
    const viaHelp = capture();
    expect(await run(['help', 'open'], viaHelp)).toBe(0);
    const viaFlag = capture();
    expect(await run(['open', '--help'], viaFlag)).toBe(0);
    expect(viaFlag.stdout).toEqual(viaHelp.stdout);
    expect(viaHelp.stdout.join('\n')).toContain('fba open');
  });

  it('prints the version for --version', async () => {
    const io = capture();
    expect(await run(['--version'], io)).toBe(0);
    expect(io.stdout).toHaveLength(1);
    expect(io.stdout[0]).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('reports an unknown flag as a usage error without running anything', async () => {
    const io = capture();
    expect(await run(['doctor', '--nope'], io)).toBe(2);
    expect(io.stderr.join('\n')).toContain('--nope');
  });

  it('rejects an invalid --log-level before touching the browser', async () => {
    const io = capture();
    expect(await run(['warm', '--log-level', 'chatty'], io)).toBe(2);
    expect(io.stderr.join('\n')).toContain('--log-level');
  });

  it('rejects a non-numeric --timeout', async () => {
    const io = capture();
    expect(await run(['warm', '--timeout', 'soon'], io)).toBe(2);
    expect(io.stderr.join('\n')).toContain('--timeout');
  });

  it('rejects a malformed --param', async () => {
    const io = capture();
    expect(await run(['skill', 'run', 'login', '--param', 'nope'], io)).toBe(2);
    expect(io.stderr.join('\n')).toContain('key=value');
  });

  it('rejects an action program that is not valid JSON', async () => {
    const io = capture();
    expect(await run(['act', '{not json'], io)).toBe(2);
    expect(io.stderr.join('\n')).toContain('not valid JSON');
  });

  it('rejects an action program containing an unknown step', async () => {
    const io = capture();
    expect(await run(['act', '[{"do":"teleport"}]'], io)).toBe(2);
    expect(io.stderr.join('\n')).toContain('unknown action');
  });

  it('rejects a --limit that would silently truncate the output', async () => {
    const io = capture();
    expect(await run(['map', 'x', '--limit', '0'], io)).toBe(2);
    expect(io.stderr.join('\n')).toContain('--limit');
  });

  it('rejects an unknown subcommand', async () => {
    const io = capture();
    expect(await run(['skill', 'frobnicate'], io)).toBe(2);
    expect(io.stderr.join('\n')).toContain('unknown skill subcommand');
  });
});
