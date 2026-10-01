import { createHash } from 'node:crypto';
import { ValidationError } from '../../../utils/errors.js';
import { validateLayoutSpec } from './layoutSpecSchema.js';
import { reading5x8 } from './packs/reading5x8.js';
import { stableJson } from '../../../utils/object.js';

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
}

export class LayoutRegistry {
  constructor(packs = []) {
    this.layouts = new Map();
    packs.forEach((pack) => this.register(pack));
  }

  register(pack) {
    const validated = validateLayoutSpec(pack);
    if (this.layouts.has(validated.id)) {
      throw new ValidationError(`Duplicate PDF layout pack: ${validated.id}`);
    }
    const fingerprint = createHash('sha256').update(stableJson(validated)).digest('hex');
    const resolved = deepFreeze({ ...validated, fingerprint });
    this.layouts.set(resolved.id, resolved);
    return resolved;
  }

  resolve(id) {
    if (!id) return null;
    const layout = this.layouts.get(id);
    if (!layout) throw new ValidationError(`Unknown PDF layout preset: ${id}`);
    return layout;
  }
}

export const defaultLayoutRegistry = new LayoutRegistry([reading5x8]);

export function resolvePdfLayout(config) {
  return defaultLayoutRegistry.resolve(config?.pdf?.layoutPreset);
}
