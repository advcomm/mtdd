import path from 'node:path'

/** Package root (repo root when running from compiled `dist/src/`). */
export function getPackageRoot(): string {
  return path.join(__dirname, '..', '..')
}

export function getProtoPath(): string {
  return path.join(getPackageRoot(), 'proto', 'mtdd.proto')
}
