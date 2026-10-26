export function normalizePath(p: string): string
export function resolveSpecifier(from: string, spec: string, files: Record<string, string>): string
export function blankComments(src: string): string
export function specifiersOf(source: string): { spec: string; at: number; len: number }[]
export function linkModules(files: Record<string, string>, entry: string, makeUrl: (source: string) => string): string
