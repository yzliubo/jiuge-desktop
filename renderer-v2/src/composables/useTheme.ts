import { ref } from 'vue';
import { getConfig, setConfig } from '../bridge';
import type { SkinId } from '../types';

const VALID: SkinId[] = ['forest', 'night', 'sakura', 'candy'];
const skin = ref<SkinId>('forest');

export function useTheme() {
  async function load(): Promise<void> {
    try {
      const res = await getConfig(['skin_theme']);
      const value = res.values['skin_theme'];
      if (typeof value === 'string' && VALID.indexOf(value as SkinId) >= 0) {
        skin.value = value as SkinId;
      }
    } catch {
      // 桥接不可用时保持默认皮肤
    }
  }

  async function set(id: SkinId): Promise<void> {
    skin.value = id;
    try {
      await setConfig({ skin_theme: id });
    } catch {
      // 本地视图仍即时生效，不阻塞交互
    }
  }

  return { skin, load, set };
}
