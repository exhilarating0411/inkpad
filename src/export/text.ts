/** Text layout shared by PDF export and the clipboard picture: wraps text the way a text box does. */

export const fontFamily = () => getComputedStyle(document.documentElement).fontFamily || 'system-ui, sans-serif'

/** text box geometry, matching the editor: 10px grab bar, 1px border, 4px/6px padding */
export const TB = { top: 10 + 1 + 4, left: 1 + 6, extra: 10 + 2 + 8, sides: 14 }

/** Breaks text into lines the way a text box does: at spaces, and between any two CJK characters. */
export function wrapLines(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const lines: string[] = []
  for (const para of text.split('\n')) {
    const tokens = para.match(/[⺀-鿿가-힯豈-﫿＀-￯]|[^\s⺀-鿿가-힯豈-﫿＀-￯]+\s*|\s+/g) ?? ['']
    let line = ''
    for (const tok of tokens) {
      if (ctx.measureText(line + tok).width <= maxWidth || !line) {
        if (ctx.measureText(tok).width > maxWidth && !line) {
          // one word wider than the box: break it anywhere
          for (const ch of tok) {
            if (line && ctx.measureText(line + ch).width > maxWidth) {
              lines.push(line)
              line = ''
            }
            line += ch
          }
        } else line += tok
      } else {
        lines.push(line.trimEnd())
        line = tok.trimStart()
      }
    }
    lines.push(line.trimEnd())
  }
  return lines
}

export interface TextLayout {
  lines: string[]
  lineHeight: number
  font: string
}

let measureCtx: CanvasRenderingContext2D | null = null

export function layoutText(text: string, fontSize: number, width: number, bold = false): TextLayout {
  const font = `${bold ? '700 ' : ''}${fontSize}px ${fontFamily()}`
  measureCtx ??= document.createElement('canvas').getContext('2d')!
  measureCtx.font = font
  return { lines: wrapLines(measureCtx, text, width), lineHeight: fontSize * 1.5, font }
}
