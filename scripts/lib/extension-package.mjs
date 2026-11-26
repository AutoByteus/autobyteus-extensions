// The extension package layout and description rules (AutoByteus extension contract, version 1, §1 and §2).
import fs from 'node:fs/promises'
import path from 'node:path'

export const DESCRIPTION_FIELDS = ['id', 'name', 'description', 'version', 'contractVersion', 'offeredOn', 'platforms', 'translations']

/** Checks an `extension.json` the way AutoByteus reads it; returns the description. */
export function checkDescription(description, where) {
  const problems = []
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(description?.id ?? '')) problems.push('id')
  if (typeof description?.name !== 'string' || !description.name.trim()) problems.push('name')
  if (typeof description?.description !== 'string') problems.push('description')
  if (!/^\d+\.\d+\.\d+$/.test(description?.version ?? '')) problems.push('version')
  if (!Number.isInteger(description?.contractVersion)) problems.push('contractVersion')
  if (!['desktop-node', 'every-node'].includes(description?.offeredOn)) problems.push('offeredOn')
  if (!Array.isArray(description?.platforms) || !description.platforms.every((value) => typeof value === 'string')) problems.push('platforms')
  if (problems.length) throw new Error(`${where}: invalid ${problems.join(', ')}`)
  return description
}

/** The description fields only, in a stable form, for comparing a package with its catalog entry. */
export const canonicalDescription = (value) => JSON.stringify(DESCRIPTION_FIELDS.map((field) => value?.[field] ?? null))

/** Every file of an extension folder that goes into its package: extension.json, server/index.mjs, ui/**. */
export async function packageFiles(folder) {
  const files = [{ name: 'extension.json', data: await fs.readFile(path.join(folder, 'extension.json')) }]
  files.push({ name: 'server/index.mjs', data: await fs.readFile(path.join(folder, 'server', 'index.mjs')) })
  const walk = async (relative) => {
    for (const entry of await fs.readdir(path.join(folder, relative), { withFileTypes: true })) {
      const name = `${relative}/${entry.name}`
      if (entry.isDirectory()) await walk(name)
      else if (entry.isFile()) files.push({ name, data: await fs.readFile(path.join(folder, name)) })
    }
  }
  await walk('ui')
  if (!files.some((file) => file.name === 'ui/index.html')) throw new Error(`${folder}: ui/index.html is missing`)
  return files
}
