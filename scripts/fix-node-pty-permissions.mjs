import { chmod, readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = fileURLToPath(new URL('../node_modules/node-pty/', import.meta.url))
let updated = 0

async function visit(directory) {
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') return
    throw error
  }

  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      await visit(fullPath)
    } else if (entry.isFile() && entry.name === 'spawn-helper') {
      await chmod(fullPath, 0o755)
      updated += 1
    }
  }
}

await visit(packageRoot)
if (updated > 0) console.log(`NEXUS AI: restored executable permissions on ${updated} node-pty spawn-helper file(s).`)
else if (process.env.CI === 'true') console.log('NEXUS AI: no node-pty spawn-helper found (dependency may use another platform layout).')
