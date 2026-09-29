export function parseExplicitDbPath(args: readonly string[], commandName: string): string {
  if (
    args.length !== 2 ||
    args[0] !== '--db' ||
    args[1] === undefined ||
    args[1].length === 0 ||
    args[1].startsWith('--')
  ) {
    throw new Error(`Usage: ${commandName} --db <path> (an explicit database path is required)`)
  }

  return args[1]
}
