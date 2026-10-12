/**
 * Prints a command's help in `senu --help`'s colours: a muted usage label and arguments, and gold
 * names in the table. The colours load only when help is asked for, so the watcher stays light.
 */
export async function printHelp(stream: NodeJS.WriteStream, text: string): Promise<void> {
  const [{ paint, write }, { brand }] = await Promise.all([
    import("./banner.ts"),
    import("./theme.ts"),
  ])
  const muted = (s: string) => paint([[s, brand.dusk]])
  const lines = text.split("\n").map((line) => {
    const usage = line.match(/^(usage:| {6}) (senu(?: [a-z]+)*)(.*)$/)
    if (usage) {
      const [, label, command, args] = usage
      return `${label === "usage:" ? `${muted("usage")} ` : label} ${command}${muted(args!)}`
    }
    const row = line.match(/^ {2}(\S.*?)( {2,})(.*)$/)
    if (row) return `  ${paint([[row[1]!, brand.gold]])}${row[2]}${row[3]}`
    return line
  })
  write(stream, lines.join("\n"))
}
