import { readFile, readdir } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';

// The combined contract is authoritative; module fragments must remain exact subsets.
const directory = new URL('../contracts/', import.meta.url);
const contract = JSON.parse(await readFile(new URL('openapi.json', directory), 'utf8'));
for (const name of await readdir(directory)) {
  if (!name.endsWith('.openapi.json')) continue;
  const fragment = JSON.parse(await readFile(new URL(name, directory), 'utf8'));
  for (const [path, value] of Object.entries(fragment.paths ?? {})) {
    if (!isDeepStrictEqual(contract.paths[path], value)) throw new Error(`${name}: path differs from the combined contract: ${path}`);
  }
  for (const [schema, value] of Object.entries(fragment.components?.schemas ?? {})) {
    if (!isDeepStrictEqual(contract.components.schemas[schema], value)) throw new Error(`${name}: schema differs from the combined contract: ${schema}`);
  }
}
console.log('Module API fragments match the combined contract.');
