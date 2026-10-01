import path from 'node:path';

/**
 * True when `target` is `root` itself or a path below it.
 * Unlike a string prefix check, `/repo-evil` is not inside `/repo`.
 */
export function isPathInside(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  if (relative === '') return true;
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
